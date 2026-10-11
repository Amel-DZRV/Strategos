// The daemon: every module wired together (task 1.15). main.ts runs one of these as a process; the end-to-end tests run
// several inside the test process with a fake `claude`. Nothing here is specific to being a separate process.
//
// Start order: home folder -> daemon.lock -> logger -> config (stable port) -> locate claude + version guard (never fatal)
// -> stores -> server + session manager -> recover state.json (daemon.restart) -> listen -> daemon.json -> reconciler.
// Files this file writes (all through safe-fs): daemon.lock, daemon.json (no token), cli.secret (user-only), logs/.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClaudeVersion, TESTED_RANGE, type VersionStatus } from './claude-version.ts';
import { loadConfig, strategosHome, type Config } from './config.ts';
import { acquireLock } from './daemon-lock.ts';
import { checkGuards } from './features/guards.ts';
import { registerGitCommands, createWorktreeProvider } from './git/commands.ts';
import type { Exec } from './git/exec.ts';
import { createInitiatives, registerInitiativeCommands } from './features/initiatives.ts';
import { createGh, type Gh } from './git/gh.ts';
import { createGitPoller, type GitPoller } from './git/git-poller.ts';
import { createGit } from './git/git.ts';
import { createPrPoller, type PrPoller } from './git/pr-poller.ts';
import { createReview } from './git/review.ts';
import { compileTestPatterns } from './git/test-detect.ts';
import { createWorktrees } from './git/worktrees.ts';
import { classifyRisk, riskCtxOf } from './features/risk.ts';
import { createUsageTracker } from './features/usage.ts';
import { cliSecretPath, daemonJsonPath, type DaemonInfo } from './home-files.ts';
import { createLogger, errText, type Logger } from './logger.ts';
import { getPlatform, type Platform } from './platform/index.ts';
import { createPtyHost, type PtyHost } from './pty/pty-host.ts';
import type { ExecFn } from './reconciler/agents-cli.ts';
import { claudeConfigDir as defaultClaudeDir, createSafeFs, type SafeFs } from './safe-fs.ts';
import { replyJson } from './server/guards.ts';
import { createStrategosServer, type StrategosServer } from './server/http.ts';
import { registerSessionCommands } from './sessions/commands.ts';
import { readOwnerStatusLine, type GitRunner } from './sessions/launch.ts';
import { createSessionManager, type ClaudeLauncher, type ManagerTiming, type SessionManager } from './sessions/manager.ts';
import { createAuditLog } from './store/audit-log.ts';
import { createEventLog } from './store/event-log.ts';
import { createStateStore } from './store/state-store.ts';
import { VERSION } from './version.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TAP_PATH = path.join(here, 'statusline', 'tap.mjs');
export const DEFAULT_RELAY_PATH = path.resolve(here, '..', '..', '..', 'tools', 'hook-relay.mjs');
export const DEFAULT_UI_DIST = path.resolve(here, '..', '..', 'ui', 'dist');

export interface DaemonOptions {
  /** Default: STRATEGOS_HOME or ~/.strategos. */
  home?: string;
  env?: Record<string, string | undefined>;
  claudeConfigDir?: string;
  platform?: Platform;
  ptyHost?: PtyHost;
  /** Use this instead of running the locator (tests: the fake claude). `{ error }` simulates a missing Claude. */
  claude?: ClaudeLauncher | { error: string };
  /** Use this config instead of config.json (tests: port 0). */
  config?: Config;
  /** Directory of the built UI. Default: packages/ui/dist when it exists. */
  staticDir?: string | null;
  tapPath?: string;
  relayPath?: string;
  nodePath?: string;
  /** Run `claude agents --json` from the reconciler. Default false; main.ts turns it on. */
  agents?: boolean;
  git?: GitRunner;
  /** Tests: replace the process runner behind git (M6 modules) and gh. */
  gitExec?: Exec;
  ghExec?: Exec;
  /** Tests: replace gh wholesale. */
  gh?: Gh;
  /** Poll periods (M6): git status of live sessions (default 15 s), pull requests (default 60 s). */
  polling?: { gitMs?: number; prMs?: number; suggestMs?: number };
  timing?: ManagerTiming;
  /** Echo log lines to the console. */
  echo?: boolean;
  /** Called when `strategos stop` asks the daemon to exit (main.ts shuts down and exits the process). */
  onShutdownRequested?: () => void;
  testedRange?: string;
  /** Tests: wrap the SafeFs to record every path the daemon writes. */
  wrapFs?: (fs: SafeFs) => SafeFs;
  /** Notifications stay quiet this long after startup (default 1500 ms): nothing is announced for what was already there. */
  notifyQuietMs?: number;
}

export interface Daemon {
  readonly home: string;
  readonly info: DaemonInfo;
  readonly server: StrategosServer;
  readonly manager: SessionManager;
  readonly fs: SafeFs;
  readonly logger: Logger;
  readonly gitPoller: GitPoller;
  readonly prPoller: PrPoller;
  readonly version: VersionStatus;
  readonly port: number;
  /** Graceful: release held requests, stop every process (resumable), close the server, flush state, remove lock/json/secret. */
  shutdown(): Promise<void>;
}

export class DaemonStartError extends Error {
  readonly code: 'locked' | 'config' | 'port';
  constructor(code: DaemonStartError['code'], message: string) {
    super(message);
    this.name = 'DaemonStartError';
    this.code = code;
  }
}

export { cliSecretPath, daemonJsonPath, type DaemonInfo };

/** One-shot descendant check from a fresh process sample; only used when a sessions file names a pid that is not our pty's. */
function makeIsDescendant(platform: Platform): (pid: number, ancestor: number) => Promise<boolean> {
  let snap: { at: number; parent: Map<number, number> } | undefined;
  return async (pid, ancestor) => {
    if (snap === undefined || Date.now() - snap.at > 5000) {
      const it = platform.proc.sample()[Symbol.asyncIterator]();
      try {
        const first = await Promise.race([it.next(), new Promise<null>((r) => { setTimeout(() => r(null), 8000).unref(); })]);
        if (first === null || first.done === true) return false;
        snap = { at: Date.now(), parent: new Map(first.value.map((p) => [p.pid, p.ppid])) };
      } finally {
        await it.return?.(undefined);
      }
    }
    let cur = snap.parent.get(pid);
    for (let depth = 0; cur !== undefined && cur > 0 && depth < 32; depth++) {
      if (cur === ancestor) return true;
      cur = snap.parent.get(cur);
    }
    return false;
  };
}

const execFn: ExecFn = (exe, args, o) =>
  new Promise((resolve) => {
    execFile(exe, args, { timeout: o.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as NodeJS.ErrnoException).code as unknown as number) : 1;
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
    });
  });

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const env = opts.env ?? process.env;
  const home = path.resolve(opts.home ?? strategosHome(env));
  const claudeDir = opts.claudeConfigDir ?? defaultClaudeDir(env);
  const platform = opts.platform ?? getPlatform();
  const baseFs = createSafeFs({ claudeDir, roots: [home] });
  const sfs = opts.wrapFs === undefined ? baseFs : opts.wrapFs(baseFs);

  // ---- home folder, user-only permission at creation -----------------------------
  const existed = existsSync(home);
  await sfs.mkdirp(home);
  if (!existed) await sfs.chmodUserOnly(home).catch(() => undefined);

  // ---- single instance --------------------------------------------------------------
  const lock = await acquireLock({
    fs: sfs, home, pid: process.pid, startTime: platform.proc.startTime, isAlive: platform.proc.isAlive,
  });
  if (!lock.ok) throw new DaemonStartError('locked', lock.message);

  const logger = createLogger({ fs: sfs, home, ...(opts.echo === undefined ? {} : { echo: opts.echo }) });
  const releaseAndRethrow = async (err: unknown): Promise<never> => {
    logger.error('daemon failed to start', err);
    await lock.release().catch(() => undefined);
    await logger.idle();
    throw err;
  };

  try {
    logger.info(`strategos daemon ${VERSION} starting (pid ${process.pid}, home ${home})`);
    await logger.prune().catch(() => undefined);

    // ---- config: stable port (D14) -----------------------------------------------------
    let config: Config;
    if (opts.config !== undefined) {
      config = opts.config;
    } else {
      const loaded = await loadConfig({ fs: sfs, home });
      if (!loaded.ok) throw new DaemonStartError('config', loaded.message);
      config = loaded.config;
    }

    // ---- Claude Code + version guard (never fatal) ---------------------------------------
    let claude: ClaudeLauncher | undefined;
    let claudeError: string | undefined;
    if (opts.claude !== undefined) {
      if ('error' in opts.claude) claudeError = opts.claude.error;
      else claude = opts.claude;
    } else {
      const located = await platform.locateClaude({ ...(config.machine.claudePath === undefined ? {} : { claudePath: config.machine.claudePath }) }).catch((err: unknown) => ({ error: errText(err) }));
      if ('error' in located) claudeError = located.error;
      else claude = { exe: located.exe, version: located.version };
    }
    const version = checkClaudeVersion(claude?.version, opts.testedRange ?? TESTED_RANGE);
    if (claudeError !== undefined) logger.error(`Claude Code not found: ${claudeError}`);
    else if (!version.inRange) logger.warn(version.message);
    else logger.info(`Claude Code ${version.claudeVersion} (tested range ${version.testedRange})`);

    // ---- stores ------------------------------------------------------------------------------
    const store = createStateStore({ fs: sfs, dir: home, daemonVersion: VERSION });
    const events = createEventLog({ fs: sfs, dir: home });
    const audit = createAuditLog({ fs: sfs, dir: home });
    events.prune().catch(() => undefined);
    audit.prune().catch(() => undefined);

    // ---- server + manager (they refer to each other through closures) ---------------------------
    const controlSecret = randomBytes(32).toString('hex');
    const staticDir = opts.staticDir === null ? undefined : (opts.staticDir ?? (existsSync(DEFAULT_UI_DIST) ? DEFAULT_UI_DIST : undefined));
    const ref: { m?: SessionManager; ini?: ReturnType<typeof createInitiatives> } = {};
    const gitApi = createGit(opts.gitExec);
    const worktrees = createWorktrees({ git: gitApi, safeFs: sfs });
    const server = createStrategosServer({
      port: config.machine.port,
      tokenFor: (sid) => ref.m?.tokenFor(sid),
      controlSecret,
      ...(staticDir === undefined ? {} : { staticDir }),
    });
    const m = createSessionManager({
      home, port: () => server.port, config, safeFs: sfs, store, events, audit, hub: server.hub, platform,
      ptyHost: opts.ptyHost ?? createPtyHost(), claude, ...(claudeError === undefined ? {} : { claudeError }),
      claudeConfigDir: claudeDir,
      paths: { nodePath: opts.nodePath ?? config.machine.nodePath ?? process.execPath, tapPath: opts.tapPath ?? DEFAULT_TAP_PATH, relayPath: opts.relayPath ?? DEFAULT_RELAY_PATH },
      env, ...((): { ownerStatusLine?: string } => { const s = readOwnerStatusLine(claudeDir); return s === undefined ? {} : { ownerStatusLine: s }; })(),
      ...(opts.git === undefined ? {} : { git: opts.git }),
      ...(opts.agents === true ? {
        agentsExec: ((exe, args, o) => {
          // `claude agents --json` costs about 0.5 s and 125 MB: only ask while a process of ours is running.
          if (!m.list().some((s) => s.pty !== undefined)) return Promise.resolve({ stdout: '', code: 1 });
          return execFn(exe, args, o);
        }) satisfies ExecFn,
      } : {}),
      isDescendant: makeIsDescendant(platform),
      // 4.04: guards read the live rule list of the config; they only ever deny. 4.03: risk classes need the session's worktree.
      guards: (_sid, ev) => checkGuards(config.portable.guards, ev, { home: os.homedir() }),
      classifyRisk: (sid, tool, input) => { const s = ref.m?.get(sid); return s === undefined ? [] : classifyRisk(tool, input, riskCtxOf(s)); },
      usage: createUsageTracker(),
      worktrees: createWorktreeProvider({ worktrees, worktreeRoot: () => config.machine.worktreeRoot }),
      testPatterns: () => compileTestPatterns(config.portable.testCommandPatterns),
      onSuggestion: (s) => { ref.ini?.remember(s); },
      version, logger, ...(opts.timing === undefined ? {} : { timing: opts.timing }),
    });
    ref.m = m;

    server.setHookHandler(m.receiver.handle);
    server.setStatusLineHandler(m.statusLineHandler);
    server.hub.setHelloProvider(() => ({ daemonVersion: VERSION, claudeVersion: version.claudeVersion, testedRange: version.testedRange, inRange: version.inRange }));
    server.hub.setSnapshotProvider(() => m.snapshot());
    registerSessionCommands(server.hub, m, (what, err) => { logger.error(`command ${what}`, err); });

    // ---- M6: git, worktrees, review, pull requests ---------------------------------------------
    const gh = opts.gh ?? createGh({ git: gitApi, ...(opts.ghExec === undefined ? {} : { exec: opts.ghExec }) });
    const setGhNeedsLogin = (needsLogin: boolean, message?: string): void => {
      m.setRuntimePrefs({ ghNeedsLogin: needsLogin });
      server.hub.publish({ t: 'gh.status', needsLogin, ...(message === undefined ? {} : { message }) });
    };
    const gitPoller = createGitPoller({ manager: m, git: gitApi, ...(opts.polling?.gitMs === undefined ? {} : { intervalMs: opts.polling.gitMs }), onError: (what, err) => { logger.warn(`${what}: ${errText(err)}`); } });
    const prPoller = createPrPoller({
      manager: m, gh, onNeedsLogin: setGhNeedsLogin, ...(opts.polling?.prMs === undefined ? {} : { intervalMs: opts.polling.prMs }),
      onError: (what, err) => { logger.warn(`${what}: ${errText(err)}`); },
    });
    const initiatives = createInitiatives({
      manager: m, store, hub: server.hub, git: gitApi, ...(opts.polling?.suggestMs === undefined ? {} : { debounceMs: opts.polling.suggestMs }),
      onError: (what, err) => { logger.warn(`${what}: ${errText(err)}`); },
    });
    ref.ini = initiatives;
    registerInitiativeCommands(server.hub, initiatives);
    registerGitCommands(server.hub, {
      manager: m, git: gitApi, worktrees, review: createReview({ manager: m, git: gitApi }), gh, prPoller, gitPoller,
      canonical: platform.paths.canonical, onGhProblem: (err) => { setGhNeedsLogin(true, err.message); },
      onError: (what, err) => { logger.error(`command ${what}`, err); },
    });

    // ---- control routes for the CLI (loopback, no Origin, secret from a user-only file) ----------
    server.registerControl('pair', (_req, res) => { replyJson(res, 200, { url: server.pairUrl() }); });
    server.registerControl('status', (_req, res) => {
      replyJson(res, 200, {
        pid: process.pid, port: server.port, version: VERSION, startedAt: info.startedAt,
        claude: { version: version.claudeVersion, testedRange: version.testedRange, inRange: version.inRange, error: claudeError ?? null },
        sessions: m.list().map((s) => ({
          strategosId: s.strategosId, name: s.name, status: s.status, statusSource: s.statusSource, statusSince: s.statusSince,
          planet: m.planets().find((p) => p.planetKey === s.planetKey)?.label ?? s.planetKey, cwd: s.cwd,
          last: s.last ?? null, pending: s.pending === undefined ? null : { tool: s.pending.toolName, summary: s.pending.inputSummary, held: s.pending.held },
          ctxPct: s.ctx?.pct ?? null, costUsd: s.cost.lineageUsd, pid: s.pty?.pid ?? null, archived: s.archived,
        })),
      });
    });
    server.registerControl('shutdown', (_req, res) => {
      replyJson(res, 202, { ok: true });
      logger.info('shutdown requested over /control/shutdown');
      setImmediate(() => { opts.onShutdownRequested?.(); });
    });

    // ---- recover, listen, announce --------------------------------------------------------------
    await m.recover();
    let port: number;
    try {
      port = await server.listen();
    } catch (err) {
      throw new DaemonStartError('port', err instanceof Error ? err.message : String(err));
    }
    const info: DaemonInfo = { pid: process.pid, port, startedAt: Date.now(), version: VERSION };
    // The secret file is created user-only: the file is written empty-permission first on POSIX (mode) and locked down with icacls on Windows.
    await sfs.writeFile(cliSecretPath(home), controlSecret, { mode: 0o600 });
    await sfs.chmodUserOnly(cliSecretPath(home)).catch((err: unknown) => { logger.warn(`could not restrict cli.secret: ${errText(err)}`); });
    await sfs.writeFileAtomic(daemonJsonPath(home), JSON.stringify(info) + '\n');
    m.startBackground();
    gitPoller.start();
    prPoller.start();
    initiatives.start();
    m.notifications.arm(opts.notifyQuietMs ?? 1500);
    logger.info(`listening on 127.0.0.1:${port}${staticDir === undefined ? ' (no UI build found)' : ''}`);

    let closing: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      closing ??= (async () => {
        logger.info('shutting down');
        gitPoller.stop();
        prPoller.stop();
        initiatives.stop();
        await m.shutdown().catch((err: unknown) => { logger.error('manager shutdown', err); });
        await server.close().catch((err: unknown) => { logger.error('server close', err); });
        await store.close().catch((err: unknown) => { logger.error('state close', err); });
        await Promise.all([events.idle(), audit.idle()]).catch(() => undefined);
        await sfs.rm(daemonJsonPath(home), { force: true }).catch(() => undefined);
        await sfs.rm(cliSecretPath(home), { force: true }).catch(() => undefined);
        await lock.release().catch(() => undefined);
        logger.info('stopped');
        await logger.idle();
      })();
      return closing;
    };

    return { home, info, server, manager: m, fs: sfs, logger, gitPoller, prPoller, version, port, shutdown };
  } catch (err) {
    return releaseAndRethrow(err);
  }
}
