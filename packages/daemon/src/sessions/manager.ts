// The session manager (plan section 4.1, task 1.10). It owns every Claude process the daemon starts and is the single place
// where the pure reducer meets the world:
//
//   sources:  hooks (receiver), status line, pty (exit, keys, text), transcript tail, reconciler, user commands, timer
//                 |
//                 v   run(sid, input) = reduce(record, input, now) + apply EVERY effect
//   effects:  hook.respond / audit -> pending registry      spawn       -> pty host (+ run settings file)
//             pty.kill             -> Ctrl+C x2, /exit, 5 s, tree kill     notify -> ws `notify`
//             chat.marker          -> kept in memory for the chat view     transcript.follow -> FileTailer
//             log                  -> events-*.jsonl                       persist -> state.json (debounced by the store)
//   then      session.upsert is published after every change.
//
// `run` is what the receiver and the registry call (they apply hook.respond and audit themselves); `feed` = run plus
// registry.applyEffects, used by every other source.
//
// Rules this file keeps: never spawn without the single-writer check (the reducer refuses when a pty is live or the
// session is open_elsewhere, and resume() also asks the reconciler for another live owner); the hook token lives in
// memory and in the child's env only; the Claude config dir is never written (safe-fs enforces it; this file only
// reads settings.json, read-only, through launch.ts).
import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  isAllowedSlash, isLive,
  type Decision, type PreToolUseInput, type Effect, type MachineInput, type Observation, type PlanetInfo, type SendResult, type SessionRecord,
  type StartOptions, type Usage,
} from '@strategos/shared';
import type { Config } from '../config.ts';
import { createPendingRegistry, type PendingRegistry, type ReleaseWhy, type Result } from '../hooks/pending.ts';
import { createHookReceiver, type GuardVerdict, type HookReceiver } from '../hooks/receiver.ts';
import { removeRunSettings, sweepRunDir, writeRunSettings } from '../hooks/settings-writer.ts';
import { errText, type Logger } from '../logger.ts';
import type { Platform } from '../platform/index.ts';
import { pasteAndSubmit } from '../pty/input.ts';
import type { PtyHandle, PtyHost } from '../pty/pty-host.ts';
import { FileReconciler, type TrackedSession } from '../reconciler/reconciler.ts';
import type { ExecFn } from '../reconciler/agents-cli.ts';
import type { SafeFs } from '../safe-fs.ts';
import type { SnapshotBody, WsHub } from '../server/ws-hub.ts';
import { createStatusLineHandler } from '../statusline/ingest.ts';
import type { AuditLog } from '../store/audit-log.ts';
import type { EventLog } from '../store/event-log.ts';
import type { StateStore } from '../store/state-store.ts';
import { classifyTail } from '../transcript/parse.ts';
import { FileTailer, type Tailer } from '../transcript/tailer.ts';
import type { VersionStatus } from '../claude-version.ts';
import { reduce } from './state-machine.ts';
import {
  assignRingSlot, buildLaunchArgs, buildLaunchEnv, planetColour, planetLabel, resolveRepo, runGit, spiralCell,
  type GitRunner,
} from './launch.ts';

// ---------------------------------------------------------------------------
// public shapes
// ---------------------------------------------------------------------------

export interface ClaudeLauncher {
  exe: string;
  /** Arguments placed before ours. Empty for the real `claude`; tests run `node tools/fake-claude.ts` as the exe. */
  prefixArgs?: string[];
  version?: string;
}

export interface ManagerTiming {
  /** Wait for the first hook or status line before sending the first prompt, then send anyway. Default 8000. */
  readyFallbackMs?: number;
  /** Extra settle time after readiness before pasting. Default 500. */
  readySettleMs?: number;
  /** Pause between the bracketed paste and Enter. Default 400 (spike: safe). */
  pasteDelayMs?: number;
  /** Gap between the two Ctrl+C of a stop. Default 250. */
  stopGapMs?: number;
  /** Whole stop budget before the process tree is killed. Default 5000. */
  stopGraceMs?: number;
  /** Reducer `tick` period (pending expiry, interrupt flag drop). Default 1000. */
  tickMs?: number;
  /** Reconciler period. Default 3000. */
  reconcileMs?: number;
}

export interface ManagerDeps {
  home: string;
  /** The port the server is bound to; read at every spawn because run settings embed it (D14). */
  port: () => number;
  config: Config;
  safeFs: SafeFs;
  store: StateStore;
  events: EventLog;
  audit: AuditLog;
  hub: WsHub;
  platform: Pick<Platform, 'paths' | 'proc'>;
  ptyHost: PtyHost;
  /** Undefined when Claude Code was not found: start/resume then fail with `claudeError`. */
  claude: ClaudeLauncher | undefined;
  claudeError?: string;
  claudeConfigDir: string;
  /** Absolute paths of the node binary, statusline/tap.mjs and tools/hook-relay.mjs. */
  paths: { nodePath: string; tapPath: string; relayPath: string };
  /** Source of the child environment. Default process.env. */
  env?: Record<string, string | undefined>;
  /** The owner's own statusLine command, read once at daemon start. */
  ownerStatusLine?: string;
  git?: GitRunner;
  tailer?: Tailer;
  /** For the reconciler's `claude agents --json` half; omit to run on the sessions folder alone. */
  agentsExec?: ExecFn;
  isDescendant?: (pid: number, ancestorPid: number) => Promise<boolean>;
  version: VersionStatus;
  stateBanner?: string;
  logger: Logger;
  guards?: (sid: string, ev: PreToolUseInput) => GuardVerdict;
  timing?: ManagerTiming;
  now?: () => number;
}

export interface Marker {
  marker: Extract<Effect, { e: 'chat.marker' }>['marker'];
  at: number;
}

export interface SessionManager {
  // plan section 4.1
  start(o: StartOptions): Promise<SessionRecord>;
  stop(id: string): Promise<void>;
  park(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  forget(id: string): Promise<void>;
  archive(id: string, on: boolean): Promise<void>;
  sendReply(id: string, text: string): Promise<SendResult>;
  sendSlash(id: string, cmd: string): Promise<SendResult>;
  get(id: string): SessionRecord | undefined;
  list(): SessionRecord[];
  onChange(cb: (s: SessionRecord) => void): () => void;
  // beyond 4.1
  seen(id: string): void;
  resumeAll(): Promise<{ resumed: string[]; failed: { id: string; error: string }[] }>;
  decide(sid: string, requestId: string, d: Decision, meta: { connId?: string; via?: string }): Result;
  release(sid: string, requestId: string, why: ReleaseWhy, meta: { connId?: string }): Result;
  ptyInput(id: string, data: string): boolean;
  ptyResize(id: string, cols: number, rows: number): boolean;
  /** Scrollback of the live pty, or the last output of the process that ended. */
  ptyScrollback(id: string): string;
  /** D13: the owner focused this session's terminal pane: release its held request. */
  focus(id: string, connId?: string): Result | null;
  markers(id: string): Marker[];
  readonly registry: PendingRegistry;
  readonly receiver: HookReceiver;
  /** `tokenFor` of the server. */
  tokenFor(sid: string): string | undefined;
  statusLineHandler: ReturnType<typeof createStatusLineHandler>;
  /** Load state.json, mark every non-live record stopped (daemon.restart), sweep run/. Call once, before serving. */
  recover(): Promise<void>;
  /** Start the reconciler and the reducer tick. */
  startBackground(): void;
  snapshot(): SnapshotBody;
  planets(): PlanetInfo[];
  /** Stop every process (resumable), release held requests, stop timers, flush state. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

interface Live {
  rec: SessionRecord;
  token?: string;
  pty?: PtyHandle;
  ptyUnsubs: (() => void)[];
  spawnP?: Promise<void>;
  stopping?: 'stop' | 'park';
  exitWaiters: (() => void)[];
  readySeen: boolean;
  readyWaiters: (() => void)[];
  unfollow?: () => void;
  settingsPath?: string;
  lastOutput: string;
  dims: { cols: number; rows: number };
  markers: Marker[];
  trustTail: string;
}

const MARKERS_MAX = 200;
const DEFAULT_DIMS = { cols: 120, rows: 30 };
const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const TRUST_RE = /do you trust|trust the files in this folder|trust this folder|Yes, I trust/i;

export function createSessionManager(deps: ManagerDeps): SessionManager {
  const now = deps.now ?? Date.now;
  const t = {
    readyFallbackMs: deps.timing?.readyFallbackMs ?? 8000,
    readySettleMs: deps.timing?.readySettleMs ?? 500,
    pasteDelayMs: deps.timing?.pasteDelayMs ?? 400,
    stopGapMs: deps.timing?.stopGapMs ?? 250,
    stopGraceMs: deps.timing?.stopGraceMs ?? 5000,
    tickMs: deps.timing?.tickMs ?? 1000,
    reconcileMs: deps.timing?.reconcileMs ?? 3000,
  };
  const { logger, hub, store, safeFs, home } = deps;
  const git = deps.git ?? runGit;
  const tailer: Tailer = deps.tailer ?? new FileTailer({ pollMs: 250, onError: (err, p) => logger.warn(`transcript tail ${p}: ${errText(err)}`) });
  const sessions = new Map<string, Live>();
  const listeners = new Set<(s: SessionRecord) => void>();
  let latestUsage: Usage | undefined;
  let shuttingDown = false;
  let tickTimer: NodeJS.Timeout | undefined;
  let stopReconciler: (() => void) | undefined;

  const logErr = (where: string) => (err: unknown): void => { logger.error(where, err); };

  // ---- records ------------------------------------------------------------

  function persistRec(live: Live): void {
    if (!store.loaded) return;
    store.update((st) => {
      const i = st.sessions.findIndex((s) => s.strategosId === live.rec.strategosId);
      if (i >= 0) st.sessions[i] = live.rec;
      else st.sessions.push(live.rec);
    });
  }

  function publishUpsert(live: Live): void {
    hub.publish({ t: 'session.upsert', session: live.rec });
    for (const cb of listeners) {
      try { cb(live.rec); } catch (err) { logger.error('onChange listener', err); }
    }
  }

  /** Replace the record with a patched copy (manager-owned fields: pty, offset, archived). */
  function patch(live: Live, p: Partial<SessionRecord>, o: { publish?: boolean } = {}): void {
    live.rec = { ...live.rec, ...p, updatedAt: now() };
    persistRec(live);
    if (o.publish !== false) publishUpsert(live);
  }

  function req(id: string): Live {
    const l = sessions.get(id);
    if (l === undefined) throw new Error(`no such session: ${id}`);
    return l;
  }

  // ---- planets ------------------------------------------------------------

  function ensurePlanetCell(key: string): boolean {
    const cells = store.get().layout.planetCells;
    if (cells[key] !== undefined) return false;
    const used = new Set(Object.values(cells).map((c) => `${c.col},${c.row}`));
    let n = 0;
    for (;;) {
      const c = spiralCell(n++);
      if (!used.has(`${c.col},${c.row}`)) {
        store.update((st) => { st.layout.planetCells[key] = c; });
        return true;
      }
    }
  }

  function planets(): PlanetInfo[] {
    const keys: string[] = [];
    for (const l of sessions.values()) if (!keys.includes(l.rec.planetKey)) keys.push(l.rec.planetKey);
    const cells = store.get().layout.planetCells;
    return keys.map((planetKey, i) => ({
      planetKey, label: planetLabel(planetKey), colour: planetColour(planetKey),
      cell: cells[planetKey] ?? spiralCell(i), pinned: false, folded: false,
    }));
  }

  // ---- effects ------------------------------------------------------------

  function logEffect(live: Live, e: Extract<Effect, { e: 'log' }>): void {
    const sid = live.rec.strategosId;
    const d = e.data;
    const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
    let p: Promise<void>;
    if (e.type === 'status') {
      p = deps.events.append('status', { from: s(d['from']), to: s(d['to']), source: s(d['source']), reason: s(d['why']) }, sid);
    } else if (e.type === 'drift') {
      p = deps.events.append('drift', { detail: JSON.stringify(d) }, sid);
    } else {
      p = deps.events.append('error', { message: s(d['why'] ?? d['message']), where: 'reducer' }, sid);
    }
    p.catch(logErr('event log'));
  }

  function applyEffect(live: Live, e: Effect): void {
    const sid = live.rec.strategosId;
    switch (e.e) {
      case 'spawn':
        live.spawnP = spawnProcess(live, e.resume).catch((err: unknown) => failSpawn(live, err));
        live.spawnP.catch(() => undefined); // the awaiting caller sees the error; nobody else may leave it unhandled
        break;
      case 'pty.kill':
        beginStop(live, e.park === true, shuttingDown ? Math.min(t.stopGraceMs, 2500) : t.stopGraceMs);
        break;
      case 'notify': {
        const risk = (e.kind === 'permission' || e.kind === 'question') ? live.rec.pending?.risk : undefined;
        hub.publish({
          t: 'notify', kind: e.kind, strategosId: sid, title: e.title, body: e.body,
          ...(risk === undefined || risk.length === 0 ? {} : { risk }), ...(e.requestId === undefined ? {} : { requestId: e.requestId }),
        });
        deps.events.append('notify', { kind: e.kind, ...(e.requestId === undefined ? {} : { requestId: e.requestId }) }, sid).catch(logErr('event log'));
        break;
      }
      case 'chat.marker':
        live.markers.push({ marker: e.marker, at: now() });
        if (live.markers.length > MARKERS_MAX) live.markers.splice(0, live.markers.length - MARKERS_MAX);
        break;
      case 'transcript.follow':
        follow(live, e.path, e.offset);
        break;
      case 'log':
        logEffect(live, e);
        break;
      case 'hook.respond':
      case 'audit': // carried out by the pending registry
      case 'persist': // the store is updated in run() whenever the record changed
        break;
    }
  }

  function follow(live: Live, file: string, offset: number): void {
    live.unfollow?.();
    const sid = live.rec.strategosId;
    live.unfollow = tailer.follow(file, offset, (records, off, info) => {
      if (sessions.get(sid) !== live) return;
      const next = info.reset ? 0 : off;
      if (live.rec.transcriptOffset !== next) patch(live, { transcriptOffset: next }, { publish: false });
      const v = classifyTail(records);
      if (v !== undefined) feed(sid, { k: 'transcript', signal: v.signal, ...(v.lastIsQuestion === undefined ? {} : { lastIsQuestion: v.lastIsQuestion }), ...(v.at === undefined ? {} : { at: v.at }) });
    });
  }

  // ---- the funnel -----------------------------------------------------------

  function markReady(live: Live): void {
    if (live.readySeen) return;
    live.readySeen = true;
    for (const w of live.readyWaiters.splice(0)) w();
  }

  /** reduce + apply every effect except the two the registry owns. Returns all effects so the caller can hand them on. */
  function run(sid: string, input: MachineInput): Effect[] {
    const live = sessions.get(sid);
    if (live === undefined) return [];
    if (input.k === 'hook' || input.k === 'statusline') markReady(live);
    const before = live.rec;
    let r: ReturnType<typeof reduce>;
    try {
      r = reduce(before, input, now());
    } catch (err) {
      logger.error(`reducer threw on ${input.k}`, err);
      return [];
    }
    const changed = r.next !== before;
    if (changed) {
      live.rec = r.next;
      persistRec(live);
    }
    if (input.k === 'hook') {
      const h = input.hook;
      const tool = 'tool' in h ? h.tool : undefined;
      const summary = 'summary' in h ? h.summary : undefined;
      deps.events.append('hook', { event: h.event, ...(tool === undefined ? {} : { tool }), ...(summary === undefined ? {} : { summary }) }, sid).catch(logErr('event log'));
    }
    for (const e of r.effects) {
      try {
        applyEffect(live, e);
      } catch (err) {
        logger.error(`effect ${e.e}`, err);
      }
    }
    if (changed) publishUpsert(live);
    return r.effects;
  }

  function feed(sid: string, input: MachineInput): Effect[] {
    const fx = run(sid, input);
    registry.applyEffects(sid, fx);
    return fx;
  }

  const registry = createPendingRegistry({
    dispatch: run,
    audit: deps.audit,
    releaseMarginSec: deps.config.portable.thresholds.releaseMarginSec,
    onError: logErr('registry'),
    now,
  });

  const receiver = createHookReceiver({
    registry,
    dispatch: run,
    audit: deps.audit,
    ...(deps.guards === undefined ? {} : { checkGuards: deps.guards }),
    onGuardDeny: (sid, info) => {
      run(sid, { k: 'guard.denied' });
      deps.events.append('guard', { ruleId: info.ruleId, tool: info.tool, reason: info.reason }, sid).catch(logErr('event log'));
    },
    onError: (err, where) => logger.error(`hook receiver (${where})`, err),
    now,
  });

  const statusLineHandler = createStatusLineHandler({
    dispatch: (sid, input) => feed(sid, input),
    onUsage: (_sid, u) => onUsage(u),
    onError: logErr('status line'),
    now,
  });

  function onUsage(u: Usage): void {
    const same = latestUsage !== undefined && JSON.stringify({ ...latestUsage, at: 0 }) === JSON.stringify({ ...u, at: 0 });
    latestUsage = u;
    if (!same) hub.publish({ t: 'usage', usage: u });
  }

  // ---- processes ------------------------------------------------------------

  function failSpawn(live: Live, err: unknown): void {
    logger.error(`spawn failed for ${live.rec.strategosId}`, err);
    live.token = undefined;
    live.pty = undefined;
    if (live.settingsPath !== undefined) removeRunSettings(safeFs, home, live.rec.strategosId).catch(() => undefined);
    feed(live.rec.strategosId, { k: 'pty.exit', code: null });
    for (const w of live.exitWaiters.splice(0)) w();
    throw err instanceof Error ? err : new Error(String(err));
  }

  async function spawnProcess(live: Live, resume: boolean): Promise<void> {
    const rec = live.rec;
    const sid = rec.strategosId;
    const claude = deps.claude;
    if (claude === undefined) throw new Error(deps.claudeError ?? 'Claude Code was not found');
    const port = deps.port();
    live.token = randomBytes(32).toString('hex');
    live.readySeen = false;
    live.stopping = undefined;
    const mode = deps.config.portable.statusLine.mode;
    const settingsPath = await writeRunSettings(safeFs, home, {
      strategosId: sid, port, nodePath: deps.paths.nodePath, tapPath: deps.paths.tapPath, relayPath: deps.paths.relayPath,
      trackerOff: deps.config.portable.conflicts.disableTrackerInStrategos, statusLine: mode !== 'off',
    });
    live.settingsPath = settingsPath;
    const args = [
      ...(claude.prefixArgs ?? []),
      ...buildLaunchArgs({ mode: { kind: resume ? 'resume' : 'new', claudeSessionId: rec.currentSessionId }, settingsPath, name: rec.name, launch: rec.launch }),
    ];
    const env = buildLaunchEnv({
      source: deps.env ?? process.env, keep: deps.config.portable.env.keep, set: deps.config.portable.env.set,
      hookToken: live.token, port, ...(mode === 'chain' && deps.ownerStatusLine !== undefined ? { chainStatusLine: deps.ownerStatusLine } : {}),
    });
    const handle = deps.ptyHost.spawn({ exe: claude.exe, args, cwd: rec.cwd, env, cols: live.dims.cols, rows: live.dims.rows });
    live.pty = handle;
    live.lastOutput = '';
    live.trustTail = '';
    live.ptyUnsubs = [
      handle.onData((d) => {
        hub.publishTo(`pty:${sid}`, { t: 'pty.data', strategosId: sid, data: d });
        checkTrust(live, d);
      }),
      handle.onKey((k) => { feed(sid, { k: 'pty.key', key: k.key, fromStrategos: k.fromStrategos }); }),
    ];
    handle.onExit((code) => onPtyExit(live, handle, code));
    patch(live, { pty: { pid: handle.pid, cols: live.dims.cols, rows: live.dims.rows, dirtyInput: false } });
    if (rec.transcriptPath !== undefined) follow(live, rec.transcriptPath, rec.transcriptOffset);
    if (!resume && rec.launch.firstPrompt !== undefined && rec.launch.firstPrompt !== '') {
      void sendFirstPrompt(live, handle, rec.launch.firstPrompt).catch(logErr('first prompt'));
    }
    logger.info(`spawned ${sid} pid ${handle.pid} (${resume ? 'resume' : 'new'})`);
  }

  function checkTrust(live: Live, chunk: string): void {
    if (live.rec.status !== 'starting') return;
    live.trustTail = (live.trustTail + chunk.replace(ANSI, '')).slice(-600);
    if (TRUST_RE.test(live.trustTail)) feed(live.rec.strategosId, { k: 'pty.trust_dialog' });
  }

  async function sendFirstPrompt(live: Live, handle: PtyHandle, text: string): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      if (live.readySeen) resolve();
      else live.readyWaiters.push(resolve);
    });
    await Promise.race([ready, delay(t.readyFallbackMs)]);
    // A trust dialog is up: hooks are silent and a paste would answer the dialog. Wait for the owner (or for the exit).
    while (!live.readySeen && live.pty === handle && live.rec.status === 'trust_pending') {
      await Promise.race([ready, delay(500)]);
    }
    if (live.pty !== handle) return;
    await delay(t.readySettleMs);
    if (live.pty !== handle) return;
    await pasteAndSubmit(handle, text, { delayMs: t.pasteDelayMs, origin: 'strategos' });
  }

  function onPtyExit(live: Live, handle: PtyHandle, code: number): void {
    if (live.pty !== handle) return;
    const sid = live.rec.strategosId;
    live.lastOutput = handle.scrollback();
    live.pty = undefined;
    for (const u of live.ptyUnsubs.splice(0)) u();
    live.unfollow?.();
    live.unfollow = undefined;
    live.token = undefined;
    const after = live.stopping;
    live.stopping = undefined;
    receiver.forget(sid);
    logger.info(`exit ${sid} code ${code}${after === undefined ? '' : ` after ${after}`}`);
    feed(sid, { k: 'pty.exit', code, ...(after === undefined ? {} : { after }) });
    removeRunSettings(safeFs, home, sid).catch(() => undefined);
    for (const w of live.exitWaiters.splice(0)) w();
  }

  function waitExit(live: Live, ms: number): Promise<boolean> {
    if (live.pty === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      live.exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  /** Ctrl+C x2, then `/exit`, then after the budget the whole process tree. Keys are tagged 'strategos' so they are not an interrupt. */
  function beginStop(live: Live, park: boolean, graceMs: number): void {
    const handle = live.pty;
    if (handle === undefined || live.stopping !== undefined) return;
    live.stopping = park ? 'park' : 'stop';
    const started = now();
    const sid = live.rec.strategosId;
    void (async () => {
      handle.write('\x03', 'strategos');
      await delay(t.stopGapMs);
      if (live.pty !== handle) return;
      handle.write('\x03', 'strategos');
      await delay(t.stopGapMs * 2);
      if (live.pty !== handle) return;
      await pasteAndSubmit(handle, '/exit', { delayMs: 150, origin: 'strategos' });
      const left = Math.max(0, graceMs - (now() - started));
      if (await waitExit(live, left)) return;
      logger.warn(`stop of ${sid}: still running after ${graceMs} ms, killing the process tree`);
      await deps.platform.proc.killTree(handle.pid).catch(logErr('killTree'));
      handle.kill();
    })().catch(logErr('stop sequence'));
  }

  function syncDirty(live: Live): void {
    const h = live.pty;
    if (h === undefined || live.rec.pty === undefined || live.rec.pty.dirtyInput === h.dirtyInput) return;
    patch(live, { pty: { ...live.rec.pty, dirtyInput: h.dirtyInput } });
  }

  // ---- public API -------------------------------------------------------------

  async function canonicalDir(p: string): Promise<string> {
    const abs = path.resolve(p);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`The folder does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`Not a folder: ${abs}`);
    return deps.platform.paths.canonical(abs);
  }

  const api: SessionManager = {
    async start(o) {
      if (deps.claude === undefined) throw new Error(deps.claudeError ?? 'Claude Code was not found');
      if (o.worktree !== undefined) throw new Error('Worktrees arrive in milestone M6; start the session in the repository folder for now.');
      const cwd = await canonicalDir(o.repoPath);
      const repo = await resolveRepo(cwd, deps.platform.paths.canonical, git);
      const strategosId = randomUUID();
      const claudeSessionId = randomUUID();
      const label = planetLabel(repo.planetKey);
      const name = (o.name ?? '').trim() || `${label}-${strategosId.slice(0, 4)}`;
      const at = now();
      const others = [...sessions.values()].map((l) => l.rec);
      const slot = assignRingSlot(others, repo.planetKey, strategosId);
      const rec: SessionRecord = {
        schema: 1, strategosId, name, displayName: name,
        claudeSessionIds: [claudeSessionId], currentSessionId: claudeSessionId, transcriptOffset: 0,
        repoRoot: repo.repoRoot, planetKey: repo.planetKey, cwd, ...(repo.branch === undefined ? {} : { branch: repo.branch }),
        launch: {
          ...(o.model === undefined ? {} : { model: o.model }),
          permissionMode: o.permissionMode ?? 'default',
          addDirs: [...(o.addDirs ?? [])], extraArgs: [...(o.extraArgs ?? [])],
          ...(o.firstPrompt === undefined ? {} : { firstPrompt: o.firstPrompt }),
        },
        status: 'stopped', statusSource: 'user', statusSince: at,
        ...(o.initiativeId === undefined ? {} : { initiativeId: o.initiativeId }),
        ...(o.parentId === undefined ? {} : { parentId: o.parentId }),
        ringSlot: slot, ringSlotByGroup: { [repo.planetKey]: slot },
        cost: { lineageUsd: 0, byClaudeSession: { [claudeSessionId]: 0 } },
        flags: { conflicts: [], contractChanged: [], guardDenials: 0 },
        subagents: [], createdAt: at, updatedAt: at, lastActivityAt: at, archived: false, view: 'term',
      };
      const live: Live = {
        rec, ptyUnsubs: [], exitWaiters: [], readySeen: false, readyWaiters: [], lastOutput: '', dims: { ...DEFAULT_DIMS }, markers: [], trustTail: '',
      };
      sessions.set(strategosId, live);
      persistRec(live);
      const newPlanet = others.every((s) => s.planetKey !== repo.planetKey);
      ensurePlanetCell(repo.planetKey);
      if (newPlanet) hub.publish({ t: 'planets', planets: planets() });
      feed(strategosId, { k: 'user', u: { cmd: 'start' } }); // -> starting + spawn
      try {
        await live.spawnP;
      } catch (err) {
        await api.forget(strategosId).catch(() => undefined);
        throw err;
      }
      return live.rec;
    },

    async stop(id) {
      const live = req(id);
      await live.spawnP?.catch(() => undefined);
      feed(id, { k: 'user', u: { cmd: 'stop' } });
      await waitExit(live, t.stopGraceMs + 5000);
    },

    async park(id) {
      const live = req(id);
      await live.spawnP?.catch(() => undefined);
      feed(id, { k: 'user', u: { cmd: 'park' } });
      await waitExit(live, t.stopGraceMs + 5000);
    },

    async resume(id) {
      const live = req(id);
      if (deps.claude === undefined) throw new Error(deps.claudeError ?? 'Claude Code was not found');
      if (live.pty !== undefined || live.rec.pty !== undefined) throw new Error('The session is already running.');
      if (live.rec.status === 'open_elsewhere') throw new Error('Another Claude process owns this conversation (open elsewhere). Close it first.');
      // Single writer: two processes appending to one transcript interleave. Ask the folder (and the agents CLI) too.
      const other = await otherOwner(live);
      if (other !== undefined) throw new Error(`Another Claude process (pid ${other.pid}) is running this conversation. Close it first.`);
      live.spawnP = undefined;
      feed(id, { k: 'user', u: { cmd: 'resume' } });
      if (live.rec.status !== 'starting') throw new Error(`Cannot resume a session that is ${live.rec.status}.`);
      await live.spawnP;
    },

    async forget(id) {
      const live = sessions.get(id);
      if (live === undefined) return;
      if (live.pty !== undefined || live.spawnP !== undefined) {
        await live.spawnP?.catch(() => undefined);
        if (live.pty !== undefined) {
          feed(id, { k: 'user', u: { cmd: 'stop' } });
          await waitExit(live, t.stopGraceMs + 5000);
        }
      }
      registry.dropSession(id);
      receiver.forget(id);
      live.unfollow?.();
      sessions.delete(id);
      if (store.loaded) store.update((st) => { st.sessions = st.sessions.filter((s) => s.strategosId !== id); });
      await removeRunSettings(safeFs, home, id).catch(() => undefined);
      hub.publish({ t: 'session.removed', strategosId: id });
    },

    async archive(id, on) {
      const live = req(id);
      if (live.rec.archived !== on) patch(live, { archived: on });
    },

    async sendReply(id, text) {
      return sendText(id, text, false);
    },

    async sendSlash(id, cmd) {
      if (!isAllowedSlash(cmd)) return { ok: false, reason: 'not_allowed', message: `${cmd} is not an allowed command` };
      return sendText(id, cmd, true);
    },

    get: (id) => sessions.get(id)?.rec,
    list: () => [...sessions.values()].map((l) => l.rec),
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    seen(id) {
      req(id);
      feed(id, { k: 'user', u: { cmd: 'seen' } });
    },

    async resumeAll() {
      const resumed: string[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const l of [...sessions.values()]) {
        const s = l.rec;
        if (s.archived || (s.status !== 'stopped' && s.status !== 'parked' && s.status !== 'errored') || l.pty !== undefined) continue;
        try {
          await api.resume(s.strategosId);
          resumed.push(s.strategosId);
        } catch (err) {
          failed.push({ id: s.strategosId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { resumed, failed };
    },

    decide(sid, requestId, d, meta) {
      const via = meta.via ?? d.via ?? 'drawer';
      const tool = sessions.get(sid)?.rec.pending?.toolName;
      const r = registry.decide(sid, requestId, { ...d, via }, { ...(meta.connId === undefined ? {} : { connId: meta.connId }) });
      if (r.ok) {
        deps.events.append('decision', { requestId, decision: d.kind, via, ...(tool === undefined ? {} : { tool }) }, sid).catch(logErr('event log'));
      }
      return r;
    },

    release(sid, requestId, why, meta) {
      return registry.release(sid, requestId, why, { ...(meta.connId === undefined ? {} : { connId: meta.connId }) });
    },

    ptyInput(id, data) {
      const l = sessions.get(id);
      if (l?.pty === undefined) return false;
      l.pty.write(data, 'user');
      syncDirty(l);
      return true;
    },

    ptyResize(id, cols, rows) {
      const l = sessions.get(id);
      if (l === undefined) return false;
      l.dims = { cols, rows };
      if (l.pty === undefined) return false;
      l.pty.resize(cols, rows);
      if (l.rec.pty !== undefined) patch(l, { pty: { ...l.rec.pty, cols, rows } }, { publish: false });
      return true;
    },

    ptyScrollback(id) {
      const l = sessions.get(id);
      return l === undefined ? '' : (l.pty?.scrollback() ?? l.lastOutput);
    },

    focus(id, connId) {
      const p = sessions.get(id)?.rec.pending;
      if (p === undefined || !p.held) return null;
      return registry.release(id, p.requestId, 'terminal-focus', { ...(connId === undefined ? {} : { connId }) });
    },

    markers: (id) => [...(sessions.get(id)?.markers ?? [])],
    registry,
    receiver,
    tokenFor: (sid) => sessions.get(sid)?.token,
    statusLineHandler,

    async recover() {
      const loaded = await store.load();
      if (loaded.status === 'failed') {
        store.startEmpty();
        logger.error(`state.json could not be read: ${loaded.banner?.message ?? 'unknown'}; starting empty`);
      } else if (loaded.banner !== null) {
        logger.warn(loaded.banner.message);
      }
      for (const rec of store.get().sessions) {
        sessions.set(rec.strategosId, {
          rec, ptyUnsubs: [], exitWaiters: [], readySeen: false, readyWaiters: [], lastOutput: '', dims: { ...DEFAULT_DIMS }, markers: [], trustTail: '',
        });
      }
      // Restart recovery (task 1.10): the processes died with the previous daemon. Every non-live record becomes stopped
      // (parked stays parked); a pending request is dropped; the conversation can be resumed.
      for (const l of sessions.values()) {
        run(l.rec.strategosId, { k: 'daemon.restart' });
        ensurePlanetCell(l.rec.planetKey);
      }
      const swept = await sweepRunDir(safeFs, home, []);
      logger.info(`recovered ${sessions.size} session(s)${swept.length > 0 ? `, swept ${swept.length} stale run file(s)` : ''}`);
    },

    startBackground() {
      const reconciler = reconcilerFor();
      stopReconciler = reconciler.start({
        onObservation: (o: Observation) => { if (o.strategosId !== undefined) feed(o.strategosId, { k: 'reconciler', obs: o }); },
        onTranscript: (i) => { feed(i.strategosId, i.input); },
      }, t.reconcileMs);
      tickTimer = setInterval(() => {
        for (const l of sessions.values()) if (l.pty !== undefined || l.rec.pending !== undefined) feed(l.rec.strategosId, { k: 'tick' });
      }, t.tickMs);
      tickTimer.unref();
    },

    snapshot() {
      const prefs = { ...store.get().prefs };
      if (!deps.version.inRange) prefs.claudeVersionOutOfRange = true;
      const banner = deps.stateBanner ?? store.banner?.message;
      if (banner !== undefined) prefs.stateBanner = banner;
      return {
        sessions: api.list(), planets: planets(), initiatives: store.get().initiatives,
        ...(latestUsage === undefined ? {} : { usage: latestUsage }), prefs,
      };
    },

    planets,

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      stopReconciler?.();
      if (tickTimer !== undefined) clearInterval(tickTimer);
      registry.releaseAll();
      const live = [...sessions.values()].filter((l) => l.pty !== undefined || l.spawnP !== undefined);
      await Promise.all(live.map(async (l) => {
        await l.spawnP?.catch(() => undefined);
        if (l.pty === undefined) return;
        feed(l.rec.strategosId, { k: 'user', u: { cmd: 'stop' } }); // -> stopped (resumable) after the exit
        await waitExit(l, 4000);
      }));
      for (const l of sessions.values()) l.unfollow?.();
      if (store.loaded) await store.flush();
    },
  };

  async function sendText(id: string, text: string, slash: boolean): Promise<SendResult> {
    const l = sessions.get(id);
    if (l?.pty === undefined) return { ok: false, reason: 'not_live', message: 'The session is not running.' };
    const s = l.rec;
    const turnOver = s.status === 'done' || s.status === 'seen' || s.status === 'interrupted';
    const openQuestion = s.status === 'question' && s.pending !== undefined && !s.pending.held;
    if (!turnOver && !openQuestion) return { ok: false, reason: 'busy', message: `The session is ${s.status}; wait until it has finished its turn.` };
    if (l.pty.dirtyInput) return { ok: false, reason: 'dirty_input', message: 'Something is typed in the terminal prompt; clear it or submit it first.' };
    if (text.trim() === '') return { ok: false, reason: 'not_allowed', message: 'Nothing to send.' };
    try {
      await pasteAndSubmit(l.pty, text, { delayMs: slash ? 150 : t.pasteDelayMs, origin: 'strategos' });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'pty_error', message: errText(err) };
    }
  }

  // ---- reconciler ---------------------------------------------------------------

  function tracked(): TrackedSession[] {
    return [...sessions.values()].map((l) => ({
      strategosId: l.rec.strategosId, claudeSessionIds: l.rec.claudeSessionIds, currentSessionId: l.rec.currentSessionId,
      ...(l.rec.transcriptPath === undefined ? {} : { transcriptPath: l.rec.transcriptPath }),
      ...(l.pty === undefined ? {} : { ptyPid: l.pty.pid }),
      live: l.pty !== undefined && isLive(l.rec.status),
    }));
  }

  let reconciler: FileReconciler | undefined;
  function reconcilerFor(): FileReconciler {
    reconciler ??= new FileReconciler({
      claudeConfigDir: deps.claudeConfigDir,
      sessions: tracked,
      isAlive: deps.platform.proc.isAlive,
      ...(deps.isDescendant === undefined ? {} : { isDescendant: deps.isDescendant }),
      ...(deps.agentsExec !== undefined && deps.claude !== undefined ? { exec: deps.agentsExec, claudeExe: deps.claude.exe } : {}),
      now,
      onError: logErr('reconciler'),
    });
    return reconciler;
  }

  /** Another live process that names one of this session's Claude ids and is not a child of ours. */
  async function otherOwner(l: Live): Promise<Observation | undefined> {
    try {
      const obs = await reconcilerFor().tick();
      return obs.find((o) => o.strategosId === l.rec.strategosId && o.alive && !o.ownedByUs);
    } catch (err) {
      logger.warn(`single-writer check could not read sessions: ${errText(err)}`);
      return undefined;
    }
  }

  return api;
}
