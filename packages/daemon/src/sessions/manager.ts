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
  type Decision, type PreToolUseInput, type Effect, type MachineInput, type Observation, type DigestData, type PlanetInfo, type RiskClass, type SendResult, type SessionRecord,
  type StartOptions, type UiPrefs, type Usage,
} from '@strategos/shared';
import type { Config } from '../config.ts';
import type { UsageTracker } from '../features/usage.ts';
import { expireCache, keepTranscriptCache, mergeTranscriptCache } from '../features/cache.ts';
import { createDigestService, type DigestService } from '../features/digest.ts';
import { isPlanetFolded, pruneLayout } from '../features/retention.ts';
import { createStuckDetector, sameStuck, type StuckDetector } from '../features/stuck.ts';
import { addConflict, createConflictTracker, pruneConflicts } from '../features/conflicts.ts';
import type { Mods } from '../features/mods.ts';
import { createNotifyPolicy, type NotifyOut, type NotifyPolicy } from '../notify/policy.ts';
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
import { createChatService, type ChatService } from '../transcript/chat-service.ts';
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
  /** Gap between two resumes of session.resumeAll (8.04), so a dozen Claude processes do not start at once. Default 1000. */
  resumeGapMs?: number;
}

/** M6 (6.02): create a worktree for session.start; the manager never runs repository writes itself. */
export interface WorktreeProvider {
  create(o: { repoRoot: string; name: string; branch: string; base: string; addExclude?: boolean }): Promise<{ path: string; branch: string; base: string }>;
  /** Undo a worktree this very start created when the spawn failed (it is brand new, so nothing can be lost). */
  discard(w: { path: string; branch: string }): Promise<void>;
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
  worktrees?: WorktreeProvider;
  tailer?: Tailer;
  /** For the reconciler's `claude agents --json` half; omit to run on the sessions folder alone. */
  agentsExec?: ExecFn;
  isDescendant?: (pid: number, ancestorPid: number) => Promise<boolean>;
  version: VersionStatus;
  stateBanner?: string;
  logger: Logger;
  guards?: (sid: string, ev: PreToolUseInput) => GuardVerdict;
  /** Task 4.03: risk classes of a tool call of session `sid` (features/risk.ts, wired in daemon.ts). */
  classifyRisk?: (sid: string, tool: string, input: Record<string, unknown>) => RiskClass[];
  /** Task 6.04: compiled test-command patterns (see test-detect.ts), wired in daemon.ts. */
  testPatterns?: () => readonly RegExp[];
  /** Task 6.06: told about every suggestion the manager publishes (the park suggestion), so it can be answered with suggestion.respond. */
  onSuggestion?: (s: { id: string; kind: 'park'; strategosIds: string[] }) => void;
  /** Task 4.08: burn rate, ETA and the park suggestion (features/usage.ts). Without it usage is published as received. */
  usage?: UsageTracker;
  /** Task 5.05: which owner mods are present (features/mods.ts, read-only). Default: none. */
  mods?: () => Mods;
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
  /** M6: patch manager-side fields (git, pr, worktree, initiativeId, archived...) and publish `session.upsert`. A no-op for an unknown id or an empty patch. */
  update(id: string, p: Partial<SessionRecord>): SessionRecord | undefined;
  /** Merge UI preferences (prefs.set). Unknown keys are refused. Returns an error text or null. */
  setPrefs(p: Partial<UiPrefs>): string | null;
  /** The person dragged a planet (layout.setPlanetCell): remember the cell and pin the planet. Returns an error text or null. */
  setPlanetCell(planetKey: string, col: number, row: number): string | null;
  /** M8 (8.06): forget Map cells of planets gone for 30 days (and past 80). Returns the keys forgotten. */
  pruneLayout(): string[];
  /** M6: daemon-wide facts shown in the snapshot prefs (e.g. `ghNeedsLogin`). Not persisted. */
  setRuntimePrefs(p: Partial<UiPrefs>): void;
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
  /** The digest since a time, built from the event log and the live records (task 8.03). */
  digest(since: number): Promise<DigestData>;
  /** Task 8.03: digest.get and the automatic 'while you were away' digest. */
  readonly digests: DigestService;
  /** Task 5.01: the chat view's feed (transcripts -> ChatItem[]). */
  readonly chat: ChatService;
  readonly registry: PendingRegistry;
  readonly receiver: HookReceiver;
  /** Tasks 2.09/4.05: which `notify` effects reach the UI. Starts disarmed (the daemon arms it a moment after startup). */
  readonly notifications: NotifyPolicy;
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
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const NO_CONVERSATION = "No conversation found: Claude Code has deleted this session's transcript (it keeps them about 30 days). Start a new session in the same folder instead.";
const NO_CONVERSATION_RE = /No conversation found/i;
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
    resumeGapMs: deps.timing?.resumeGapMs ?? 1000,
  };
  const { logger, hub, store, safeFs, home } = deps;
  const git = deps.git ?? runGit;
  const tailer: Tailer = deps.tailer ?? new FileTailer({ pollMs: 250, onError: (err, p) => logger.warn(`transcript tail ${p}: ${errText(err)}`) });
  const sessions = new Map<string, Live>();
  const listeners = new Set<(s: SessionRecord) => void>();
  let latestUsage: Usage | undefined;
  let runtimePrefs: Partial<UiPrefs> = {};
  const costLogged = new Map<string, { usd: number; at: number }>();
  let closeWaitsAt: number | undefined; // set while recover() replays an unclean stop: waits end when state.json was last written, not now
  const stuckBy = new Map<string, StuckDetector>();
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
    store.update((st) => { (st.layout.planetSeen ??= {})[key] = now(); }); // 8.06: a remembered cell lives 30 days past its last session
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
    const pinned = new Set(store.get().layout.pinnedPlanets ?? []);
    const t0 = now();
    return keys.map((planetKey, i) => ({
      planetKey, label: planetLabel(planetKey), colour: planetColour(planetKey),
      cell: cells[planetKey] ?? spiralCell(i), pinned: pinned.has(planetKey),
      folded: isPlanetFolded([...sessions.values()].filter((l) => l.rec.planetKey === planetKey).map((l) => l.rec), t0), // 8.06
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
        // notify/policy decides whether this becomes a published `notify` event (publishNotify below).
        if (e.kind !== 'escalate') {
          notifications.offer(sid, { kind: e.kind, title: e.title, body: e.body, ...(risk === undefined ? {} : { risk }), ...(e.requestId === undefined ? {} : { requestId: e.requestId }) });
        }
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
      const cache = mergeTranscriptCache(live.rec.cache, records, now()); // 5.07: fallback when the status line gave nothing
      if (cache !== undefined) patch(live, { cache });
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
    let nextRec = r.next;
    // 8.01: stuck badge. Fed by the same input, judged on the record AFTER the reducer (status and ctx are current).
    let det = stuckBy.get(sid);
    if (det === undefined) { det = createStuckDetector(); stuckBy.set(sid, det); }
    const stuck = det.observe(input, nextRec, now());
    if (!sameStuck(nextRec.flags.stuck, stuck)) {
      const flags = { ...nextRec.flags };
      if (stuck === undefined) delete flags.stuck;
      else flags.stuck = stuck;
      nextRec = { ...nextRec, flags, updatedAt: now() };
    }
    const changed = nextRec !== before;
    if (changed) {
      live.rec = nextRec;
      persistRec(live);
      if (nextRec.status !== before.status) notifications.setStatus(sid, nextRec.status); // before the effects: offer() relies on it
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
    if (changed) {
      trackWaiting(before, nextRec);
      if (nextRec.cost.lineageUsd !== before.cost.lineageUsd || nextRec.status !== before.status) logCost(nextRec, nextRec.status !== before.status);
      publishUpsert(live);
    }
    return r.effects;
  }

  /** A needs-you interval ended: write it to the event log, so 'waiting today' and the digest survive a restart (8.03). */
  function trackWaiting(before: SessionRecord, next: SessionRecord): void {
    if (before.waitingSince === next.waitingSince || before.waitingSince === undefined) return;
    const to = closeWaitsAt ?? now();
    if (to <= before.waitingSince) return;
    deps.events.append('wait', { status: before.status, from: before.waitingSince, to }, before.strategosId).catch(logErr('event log'));
  }

  /** Cost for the digest: the lineage total, at most every 30 s per session and always when the status changes. */
  function logCost(rec: SessionRecord, force: boolean): void {
    const usd = rec.cost.lineageUsd;
    const last = costLogged.get(rec.strategosId);
    if (last?.usd === usd) return;
    const t0 = now();
    if (!force && last !== undefined && t0 - last.at < 30_000) return;
    costLogged.set(rec.strategosId, { usd, at: t0 });
    deps.events.append('cost', { usd, claudeSessionId: rec.currentSessionId }, rec.strategosId).catch(logErr('event log'));
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

  function publishNotify(n: NotifyOut): void {
    hub.publish({
      t: 'notify', kind: n.kind, strategosId: n.strategosId, title: n.title, body: n.body,
      ...(n.risk === undefined || n.risk.length === 0 ? {} : { risk: n.risk }), ...(n.requestId === undefined ? {} : { requestId: n.requestId }),
    });
    deps.events.append('notify', { kind: n.kind, ...(n.requestId === undefined ? {} : { requestId: n.requestId }) }, n.strategosId).catch(logErr('event log'));
  }
  const notifications = createNotifyPolicy({
    publish: publishNotify,
    prefs: () => deps.config.portable.notifications,
    escalateMinutes: () => deps.config.portable.thresholds.escalateMinutes,
    now,
    onError: logErr('notify policy'),
  });

  // ---- conflict warnings (task 5.06, D9) ---------------------------------------------
  const conflictWindowMs = deps.config.portable.conflicts.windowMinutes * 60_000;
  const conflicts = createConflictTracker({
    session: (sid) => sessions.get(sid)?.rec,
    sessions: () => [...sessions.values()].map((l) => l.rec),
    initiatives: () => (store.loaded ? store.get().initiatives : []),
    now,
    windowMs: conflictWindowMs,
    trackerOff: () => deps.config.portable.conflicts.disableTrackerInStrategos,
    planetLabel,
  });

  /** A PostToolUse happened: record edits, set the flags (both sides) and hand back the note for Claude, if any. */
  function onPostToolUse(sid: string, ev: { tool: string; toolInput: Record<string, unknown> | undefined; agentId?: string }): string | undefined {
    const out = conflicts.onEdit({ sid, tool: ev.tool, toolInput: ev.toolInput, ...(ev.agentId === undefined ? {} : { agentId: ev.agentId }) });
    const touched = new Set([...out.warnings.map((w) => w.sid), ...out.contract.map((c) => c.sid)]);
    for (const id of touched) {
      const l = sessions.get(id);
      if (l === undefined) continue;
      let list = l.rec.flags.conflicts;
      for (const w of out.warnings) if (w.sid === id) list = addConflict(list, w.conflict);
      const marked = new Set(l.rec.flags.contractChanged);
      for (const c of out.contract) if (c.sid === id) marked.add(c.relPath);
      patch(l, { flags: { ...l.rec.flags, conflicts: list, contractChanged: [...marked].slice(-20) } });
    }
    if (out.warnings.length > 0) logger.info(`conflict: ${out.warnings.filter((w) => w.sid === sid).map((w) => `${w.conflict.file} with ${w.conflict.other}`).join(', ')} (${sid})`);
    const notes = [...(out.note === undefined ? [] : [out.note]), ...conflicts.takeNotes(sid)];
    return notes.length === 0 ? undefined : notes.join('\n');
  }

  const receiver = createHookReceiver({
    registry,
    dispatch: run,
    onPostToolUse,
    audit: deps.audit,
    ...(deps.guards === undefined ? {} : { checkGuards: deps.guards }),
    ...(deps.classifyRisk === undefined ? {} : { classifyRisk: deps.classifyRisk }),
    ...(deps.testPatterns === undefined ? {} : { testPatterns: deps.testPatterns }),
    onGuardDeny: (sid, info) => {
      run(sid, { k: 'guard.denied' });
      deps.events.append('guard', { ruleId: info.ruleId, tool: info.tool, reason: info.reason }, sid).catch(logErr('event log'));
    },
    onError: (err, where) => logger.error(`hook receiver (${where})`, err),
    now,
  });

  const statusLineHandler = createStatusLineHandler({
    dispatch: (sid, input) => {
      // 5.07: a status line that knows nothing about the cache must not wipe what the transcript told us.
      if (input.k === 'statusline' && keepTranscriptCache(sessions.get(sid)?.rec.cache, input.cache)) {
        const rest = { ...input };
        delete rest.cache;
        return feed(sid, rest);
      }
      return feed(sid, input);
    },
    onUsage: (_sid, u) => onUsage(u),
    onError: logErr('status line'),
    now,
  });

  function onUsage(reading: Usage): void {
    let u = reading;
    let suggestion: { id: string; kind: 'park'; text: string } | undefined;
    if (deps.usage !== undefined) {
      try {
        const r = deps.usage.ingest(reading);
        u = r.usage;
        suggestion = r.suggestion;
      } catch (err) {
        logger.error('usage tracker', err);
      }
    }
    const same = latestUsage !== undefined && JSON.stringify({ ...latestUsage, at: 0 }) === JSON.stringify({ ...u, at: 0 });
    latestUsage = u;
    if (!same) hub.publish({ t: 'usage', usage: u });
    if (suggestion !== undefined) {
      // A suggestion only: nothing is parked until the person accepts it.
      const strategosIds = [...sessions.values()].filter((l) => l.pty !== undefined && l.rec.status === 'working').map((l) => l.rec.strategosId);
      deps.onSuggestion?.({ id: suggestion.id, kind: 'park', strategosIds });
      hub.publish({ t: 'suggestion', ...suggestion, strategosIds });
    }
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
    if (code !== 0 && NO_CONVERSATION_RE.test(live.lastOutput.replace(ANSI, '')) && live.rec.flags.mayNotResume !== true) patch(live, { flags: { ...live.rec.flags, mayNotResume: true } }); // 8.06
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

  const chat = createChatService({
    tailer,
    session: (sid) => sessions.get(sid)?.rec,
    markers: (sid) => [...(sessions.get(sid)?.markers ?? [])],
    onSessionChange: (cb) => {
      const l = (s: SessionRecord): void => { cb(s.strategosId); };
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    now,
    onError: (err, where) => { logger.warn(`${where}: ${errText(err)}`); },
  });

  const digests = createDigestService({
    events: deps.events,
    sessions: () => [...sessions.values()].map((l) => l.rec),
    initiatives: () => (store.loaded ? store.get().initiatives : []),
    prefs: () => (store.loaded ? store.get().prefs : {}),
    now,
    onError: (what, err) => { logger.warn(`${what}: ${errText(err)}`); },
  });

  const api: SessionManager = {
    async start(o) {
      if (deps.claude === undefined) throw new Error(deps.claudeError ?? 'Claude Code was not found');
      let cwd = await canonicalDir(o.repoPath);
      let repo = await resolveRepo(cwd, deps.platform.paths.canonical, git);
      let worktree: SessionRecord['worktree'];
      if (o.worktree !== undefined) {
        if (deps.worktrees === undefined) throw new Error('Worktrees are not available.');
        if (!repo.isRepo) throw new Error(`Not a repository: ${cwd}`);
        const made = await deps.worktrees.create({ repoRoot: repo.repoRoot, ...o.worktree });
        worktree = { path: made.path, branch: made.branch, base: made.base, createdByStrategos: true };
        try {
          cwd = await canonicalDir(made.path);
          repo = await resolveRepo(cwd, deps.platform.paths.canonical, git);
        } catch (err) {
          await deps.worktrees.discard(made).catch(logErr('discard worktree'));
          throw err;
        }
      }
      const strategosId = randomUUID();
      const claudeSessionId = randomUUID();
      const label = planetLabel(repo.planetKey);
      const name = (o.name ?? '').trim() || (o.worktree === undefined ? `${label}-${strategosId.slice(0, 4)}` : `${label}-${o.worktree.name}`);
      const at = now();
      const others = [...sessions.values()].map((l) => l.rec);
      const slot = assignRingSlot(others, repo.planetKey, strategosId);
      const rec: SessionRecord = {
        schema: 1, strategosId, name, displayName: name,
        claudeSessionIds: [claudeSessionId], currentSessionId: claudeSessionId, transcriptOffset: 0,
        repoRoot: repo.repoRoot, planetKey: repo.planetKey, cwd, ...(repo.branch === undefined ? {} : { branch: repo.branch }),
        ...(worktree === undefined ? {} : { worktree }),
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
        if (worktree !== undefined) await deps.worktrees?.discard(worktree).catch(logErr('discard worktree'));
        throw err;
      }
      return live.rec;
    },

    async stop(id) {
      const live = req(id);
      await live.spawnP?.catch(() => undefined);
      if (live.rec.wasLiveAtStop) patch(live, { wasLiveAtStop: false }); // 8.04: stopped on purpose, not "live at a reboot"
      feed(id, { k: 'user', u: { cmd: 'stop' } });
      await waitExit(live, t.stopGraceMs + 5000);
    },

    async park(id) {
      const live = req(id);
      await live.spawnP?.catch(() => undefined);
      if (live.rec.wasLiveAtStop) patch(live, { wasLiveAtStop: false });
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
      // 8.06 (V14, R12): Claude deletes transcripts after about 30 days; `--resume` would only print "No conversation found".
      const tp = live.rec.transcriptPath;
      if (tp !== undefined && !(await exists(tp))) {
        if (live.rec.flags.mayNotResume !== true) patch(live, { flags: { ...live.rec.flags, mayNotResume: true } });
        throw new Error(NO_CONVERSATION);
      }
      live.spawnP = undefined;
      feed(id, { k: 'user', u: { cmd: 'resume' } });
      if (live.rec.status !== 'starting') throw new Error(`Cannot resume a session that is ${live.rec.status}.`);
      await live.spawnP;
      if (live.rec.wasLiveAtStop || live.rec.flags.mayNotResume === true) {
        const flags = { ...live.rec.flags };
        delete flags.mayNotResume;
        patch(live, { wasLiveAtStop: false, flags });
      }
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
      conflicts.forget(id);
      notifications.forget(id);
      live.unfollow?.();
      sessions.delete(id);
      stuckBy.delete(id);
      costLogged.delete(id);
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
      if (cmd === '/handoff-now' && !(deps.mods?.().autoHandoff ?? false)) {
        return { ok: false, reason: 'not_allowed', message: '/handoff-now needs the auto-handoff mod, which is not installed.' };
      }
      return sendText(id, cmd, true);
    },

    update(id, p) {
      const live = sessions.get(id);
      if (live === undefined || Object.keys(p).length === 0) return live?.rec;
      if (p.pr !== undefined && live.rec.pr?.number !== p.pr.number) deps.events.append('pr', { number: p.pr.number, url: p.pr.url }, id).catch(logErr('event log'));
      patch(live, p);
      return live.rec;
    },
    setRuntimePrefs(p) {
      runtimePrefs = { ...runtimePrefs, ...p };
    },
    setPrefs(p) {
      if (!store.loaded) return 'The state is not loaded yet.';
      const allowed = new Set(['groupBy', 'reducedMotion', 'notifications', 'keymap', 'awayDigest']);
      for (const k of Object.keys(p)) if (!allowed.has(k)) return `prefs.${k} cannot be set from the UI`;
      if (p.groupBy !== undefined && p.groupBy !== 'repo' && p.groupBy !== 'initiative') return 'prefs.groupBy must be repo or initiative';
      if (p.awayDigest !== undefined && typeof p.awayDigest !== 'boolean') return 'prefs.awayDigest must be a boolean';
      if (p.reducedMotion !== undefined && typeof p.reducedMotion !== 'boolean') return 'prefs.reducedMotion must be a boolean';
      if (p.keymap !== undefined && (typeof p.keymap !== 'object' || p.keymap === null || !Object.values(p.keymap).every((v) => typeof v === 'string'))) return 'prefs.keymap must map action ids to key chords';
      if (p.notifications !== undefined && (typeof p.notifications !== 'object' || p.notifications === null)) return 'prefs.notifications must be an object';
      store.update((st) => {
        st.prefs = { ...st.prefs, ...p, notifications: { ...st.prefs.notifications, ...(p.notifications ?? {}) } };
      });
      return null;
    },
    setPlanetCell(planetKey, col, row) {
      if (!store.loaded) return 'The state is not loaded yet.';
      if (![...sessions.values()].some((l) => l.rec.planetKey === planetKey)) return `no such planet: ${planetKey}`;
      store.update((st) => {
        st.layout.planetCells[planetKey] = { col, row };
        st.layout.pinnedPlanets = [...new Set([...(st.layout.pinnedPlanets ?? []), planetKey])];
      });
      hub.publish({ t: 'planets', planets: planets() });
      return null;
    },
    pruneLayout() {
      if (!store.loaded) return [];
      let gone: string[] = [];
      const withSessions = new Set([...sessions.values()].map((l) => l.rec.planetKey));
      store.update((st) => { gone = pruneLayout(st.layout, withSessions, now()); });
      if (gone.length > 0) hub.publish({ t: 'planets', planets: planets() });
      return gone;
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
      // 8.04: the sessions that were live when the daemon stopped (clean or not), one at a time with a gap.
      const resumed: string[] = [];
      const failed: { id: string; error: string }[] = [];
      const todo = [...sessions.values()].filter((l) => l.rec.wasLiveAtStop === true && !l.rec.archived && l.pty === undefined && l.rec.status !== 'open_elsewhere')
        .sort((x, y) => x.rec.createdAt - y.rec.createdAt);
      for (const l of todo) {
        if (shuttingDown) break;
        if (resumed.length + failed.length > 0 && t.resumeGapMs > 0) await delay(t.resumeGapMs);
        const id = l.rec.strategosId;
        try {
          await api.resume(id);
          resumed.push(id);
        } catch (err) {
          failed.push({ id, error: err instanceof Error ? err.message : String(err) });
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

    digest: (since) => digests.digest(since),
    digests,
    markers: (id) => [...(sessions.get(id)?.markers ?? [])],
    chat,
    registry,
    receiver,
    notifications,
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
      // 8.04: what was running when the daemon stopped is what "Resume all" brings back. A clean shutdown marked its sessions
      // already (shutdown below); a crash left them with a live status.
      // 8.03: a needs-you interval a crash left open ended when state.json was last written, not now.
      closeWaitsAt = Math.min(now(), store.get().writtenAt);
      for (const l of sessions.values()) {
        if (isLive(l.rec.status) && !l.rec.wasLiveAtStop) l.rec = { ...l.rec, wasLiveAtStop: true };
        run(l.rec.strategosId, { k: 'daemon.restart' });
        ensurePlanetCell(l.rec.planetKey);
      }
      closeWaitsAt = undefined;
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
        // 5.07: a warm cache goes cold when its TTL passes, whether or not anything was said about it
        const t0 = now();
        for (const l of sessions.values()) {
          const cache = expireCache(l.rec.cache, t0);
          if (cache !== undefined) patch(l, { cache });
          // 5.06: a conflict warning fades when its window is over
          const fresh = pruneConflicts(l.rec.flags.conflicts, t0, conflictWindowMs);
          if (fresh !== l.rec.flags.conflicts) patch(l, { flags: { ...l.rec.flags, conflicts: [...fresh] } });
        }
        conflicts.sweep();
      }, t.tickMs);
      tickTimer.unref();
    },

    snapshot() {
      const prefs = { ...store.get().prefs, ...runtimePrefs, mods: deps.mods?.() ?? { autoHandoff: false } };
      if (!deps.version.inRange) prefs.claudeVersionOutOfRange = true;
      const banner = deps.stateBanner ?? store.banner?.message;
      if (banner !== undefined) prefs.stateBanner = banner;
      return {
        sessions: api.list(), planets: planets(), initiatives: store.get().initiatives,
        ...(latestUsage === undefined ? {} : { usage: latestUsage }), prefs, repos: [...deps.config.machine.repos],
      };
    },

    planets,

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      chat.dispose();
      stopReconciler?.();
      if (tickTimer !== undefined) clearInterval(tickTimer);
      registry.releaseAll();
      notifications.dispose();
      const live = [...sessions.values()].filter((l) => l.pty !== undefined || l.spawnP !== undefined);
      for (const l of live) if (!l.rec.wasLiveAtStop) patch(l, { wasLiveAtStop: true }, { publish: false }); // 8.04
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
    // 5.04: a reply goes in only when the turn is over (done, seen, interrupted) or Claude waits on a question only the
    // terminal can answer. 5.05: a slash command is stricter: done or seen, nothing else.
    const turnOver = s.status === 'done' || s.status === 'seen' || (!slash && s.status === 'interrupted');
    const openQuestion = !slash && s.status === 'question' && s.pending !== undefined && !s.pending.held;
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
