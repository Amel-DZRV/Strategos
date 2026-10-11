// Retention (task 8.06, V14, R12). What is kept, for how long, and what the person is told when something is about to go.
//
//   logs/            7 days     (logger.prune)
//   events-*.jsonl   30 days    (events.prune; also on the first append of a new day)
//   audit.jsonl      180 days   (audit.prune; before this file nothing pruned it in a daemon that ran for weeks)
//   run/*.settings.json         deleted at start (manager.recover) and again here, sparing sessions that have a process
//   transcripts      Claude keeps them 30 days: a stopped session whose transcript was last written 28 days ago or more
//                    gets flags.mayNotResume; a transcript that is gone gets it too
//   planets          a planet is `folded` when every session is stopped, parked or archived and none was active for 7 days
//                    (the same rule as the Map's dormant dot); its Map cell is remembered 30 days after its last session
//                    went, at most 80 planets (least recently seen go first)
//
// archive and forget live in the session manager (they are user commands); this file holds the rules and the daily job.
import type { SessionRecord } from '@strategos/shared';
import { isLive } from '@strategos/shared';
import * as path from 'node:path';

export const DAY_MS = 86_400_000;
export const TRANSCRIPT_WARN_MS = 28 * DAY_MS;
export const FOLD_AFTER_MS = 7 * DAY_MS;
export const CELL_MEMORY_MS = 30 * DAY_MS;
export const PLANET_MEMORY_MAX = 80;
export const RETENTION_DAYS = { logs: 7, events: 30, audit: 180 } as const;

// ---------------------------------------------------------------------------
// folding
// ---------------------------------------------------------------------------

type FoldInput = Pick<SessionRecord, 'archived' | 'status' | 'lastActivityAt'>;

/** The Map's dormant rule (ui/src/map/layout.ts isDormant), computed on the daemon so `PlanetInfo.folded` is right for any client. */
export function isPlanetFolded(sessions: readonly FoldInput[], now: number): boolean {
  if (sessions.length === 0) return false;
  return sessions.every((s) => (s.archived || s.status === 'stopped' || s.status === 'parked') && now - s.lastActivityAt > FOLD_AFTER_MS);
}

// ---------------------------------------------------------------------------
// transcript age (V14)
// ---------------------------------------------------------------------------

export type TranscriptVerdict = 'fresh' | 'old' | 'gone' | 'unknown';

export interface TranscriptDeps {
  stat: (p: string) => Promise<{ mtimeMs: number } | null>;
  claudeDir: string;
  projectDirName: (cwd: string) => string;
  now: number;
}

/** Where the transcript is or would be: the path a hook reported, else the one Claude derives from the folder. */
export function transcriptPathOf(rec: Pick<SessionRecord, 'transcriptPath' | 'cwd' | 'currentSessionId'>, d: Pick<TranscriptDeps, 'claudeDir' | 'projectDirName'>): { path: string; reported: boolean } {
  if (rec.transcriptPath !== undefined) return { path: rec.transcriptPath, reported: true };
  return { path: path.join(d.claudeDir, 'projects', d.projectDirName(rec.cwd), `${rec.currentSessionId}.jsonl`), reported: false };
}

/**
 * old: the transcript is 28 days old or more. gone: a transcript Claude reported is no longer there. unknown: nothing was
 * ever reported and nothing is at the derived path (a session that never got a prompt has nothing to lose).
 */
export async function transcriptVerdict(rec: Pick<SessionRecord, 'transcriptPath' | 'cwd' | 'currentSessionId'>, d: TranscriptDeps): Promise<TranscriptVerdict> {
  const where = transcriptPathOf(rec, d);
  const st = await d.stat(where.path).catch(() => null);
  if (st === null) return where.reported ? 'gone' : 'unknown';
  return d.now - st.mtimeMs >= TRANSCRIPT_WARN_MS ? 'old' : 'fresh';
}

export interface TranscriptSweepDeps extends Omit<TranscriptDeps, 'now'> {
  now: () => number;
  list: () => readonly SessionRecord[];
  update: (id: string, p: Partial<SessionRecord>) => unknown;
}

/** Set or clear flags.mayNotResume on every session that has no process. Returns the ids whose flag changed. */
export async function sweepTranscripts(d: TranscriptSweepDeps): Promise<string[]> {
  const changed: string[] = [];
  for (const rec of d.list()) {
    if (rec.pty !== undefined || isLive(rec.status)) {
      if (rec.flags.mayNotResume === true) { clearFlag(d, rec); changed.push(rec.strategosId); } // it is running: it resumed fine
      continue;
    }
    const verdict = await transcriptVerdict(rec, { stat: d.stat, claudeDir: d.claudeDir, projectDirName: d.projectDirName, now: d.now() });
    const want = verdict === 'old' || verdict === 'gone';
    if (want === (rec.flags.mayNotResume === true)) continue;
    if (want) d.update(rec.strategosId, { flags: { ...rec.flags, mayNotResume: true } });
    else clearFlag(d, rec);
    changed.push(rec.strategosId);
  }
  return changed;
}

function clearFlag(d: Pick<TranscriptSweepDeps, 'update'>, rec: SessionRecord): void {
  const flags = { ...rec.flags };
  delete flags.mayNotResume;
  d.update(rec.strategosId, { flags });
}

// ---------------------------------------------------------------------------
// Map cell memory
// ---------------------------------------------------------------------------

export interface LayoutMemory {
  planetCells: Record<string, { col: number; row: number }>;
  planetSeen?: Record<string, number>;
  pinnedPlanets?: string[];
}

/**
 * Forget the Map cell of planets that have had no session for 30 days, then keep at most 80 remembered planets (the ones
 * with sessions always stay; the least recently seen empty ones go first). Mutates `layout`; returns the keys forgotten.
 */
export function pruneLayout(layout: LayoutMemory, withSessions: ReadonlySet<string>, now: number): string[] {
  const seen = (layout.planetSeen ??= {});
  for (const key of withSessions) seen[key] = now;
  for (const key of Object.keys(layout.planetCells)) seen[key] ??= now; // cells from before this field existed start their 30 days now
  const gone: string[] = [];
  const forget = (key: string): void => {
    delete layout.planetCells[key];
    delete seen[key];
    if (layout.pinnedPlanets !== undefined) layout.pinnedPlanets = layout.pinnedPlanets.filter((k) => k !== key);
    gone.push(key);
  };
  for (const key of Object.keys(layout.planetCells)) if (!withSessions.has(key) && now - (seen[key] ?? now) > CELL_MEMORY_MS) forget(key);
  const keys = Object.keys(layout.planetCells);
  if (keys.length > PLANET_MEMORY_MAX) {
    const empty = keys.filter((k) => !withSessions.has(k)).sort((a, b) => (seen[a] ?? 0) - (seen[b] ?? 0));
    for (const key of empty) {
      if (Object.keys(layout.planetCells).length <= PLANET_MEMORY_MAX) break;
      forget(key);
    }
  }
  return gone;
}

// ---------------------------------------------------------------------------
// the daily job
// ---------------------------------------------------------------------------

export interface RetentionDeps {
  logger: { prune(): Promise<string[]> };
  events: { prune(): Promise<string[]> };
  audit: { prune(): Promise<number> };
  /** Delete run/*.settings.json of sessions that have no process. Returns the names removed. */
  sweepRun: () => Promise<string[]>;
  sweepTranscripts: () => Promise<string[]>;
  /** Forget remembered Map cells (a state.json update). */
  sweepLayout: () => string[];
  onError: (what: string, err: unknown) => void;
  /** Default 24 h. */
  intervalMs?: number;
  /** Tests: replace the timer. */
  setInterval?: (fn: () => void, ms: number) => { unref(): unknown } & object;
  clearInterval?: (t: object) => void;
}

export interface RetentionReport {
  logs: number;
  events: number;
  audit: number;
  run: number;
  transcripts: number;
  cells: number;
}

export interface Retention {
  /** Run every job now. Each job's failure is reported and does not stop the others. */
  runOnce(): Promise<RetentionReport>;
  /** Run now, then every 24 hours. */
  start(): void;
  stop(): void;
}

export function createRetention(deps: RetentionDeps): Retention {
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = deps.clearInterval ?? ((t) => { clearInterval(t as ReturnType<typeof setInterval>); });
  let timer: object | undefined;
  let running: Promise<RetentionReport> | undefined;

  async function job<T>(what: string, fn: () => Promise<T> | T, zero: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      deps.onError(what, err);
      return zero;
    }
  }

  function runOnce(): Promise<RetentionReport> {
    running ??= (async () => {
      const report: RetentionReport = {
        logs: (await job('prune logs', () => deps.logger.prune(), [] as string[])).length,
        events: (await job('prune events', () => deps.events.prune(), [] as string[])).length,
        audit: await job('prune audit', () => deps.audit.prune(), 0),
        run: (await job('sweep run/', () => deps.sweepRun(), [] as string[])).length,
        transcripts: (await job('transcript age', () => deps.sweepTranscripts(), [] as string[])).length,
        cells: (await job('layout memory', () => deps.sweepLayout(), [] as string[])).length,
      };
      return report;
    })().finally(() => { running = undefined; });
    return running;
  }

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      void runOnce();
      const t = every(() => { void runOnce(); }, deps.intervalMs ?? DAY_MS);
      t.unref();
      timer = t;
    },
    stop() {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
    },
  };
}
