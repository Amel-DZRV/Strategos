// Single-writer state.json (plan section 5, on-disk files). Idea adapted from Bot Crossing's serialised writeState
// (MIT, see THIRD_PARTY_NOTICES.md); rewritten for Strategos.
//
//  - one serialised write queue, so two writes never overlap;
//  - unique temp name state.json.<pid>.<seq>.tmp, then rename;
//  - no write until load() finished or startEmpty() was called (a failed load never silently overwrites data);
//  - debounce (default 500 ms); flush()/close() on exit;
//  - state.json.bak refreshed at most hourly (a copy of the previous good file);
//  - a parse failure renames the file to state.json.corrupt-<ts>, loads the .bak and sets `banner`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Initiative, SessionRecord, UiPrefs } from '@strategos/shared';
import type { SafeFs } from '../safe-fs.ts';

export interface StateFile {
  schema: 1;
  writtenAt: number;
  daemonVersion: string;
  sessions: SessionRecord[];
  initiatives: Initiative[];
  layout: { planetCells: Record<string, { col: number; row: number }>; groupCells: Record<string, { col: number; row: number }> };
  prefs: UiPrefs;
  dismissedSuggestions: string[];
}

export function defaultPrefs(): UiPrefs {
  return {
    groupBy: 'repo',
    notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true },
    keymap: {},
  };
}

export function emptyState(daemonVersion = '0.0.0', now = Date.now()): StateFile {
  return {
    schema: 1,
    writtenAt: now,
    daemonVersion,
    sessions: [],
    initiatives: [],
    layout: { planetCells: {}, groupCells: {} },
    prefs: defaultPrefs(),
    dismissedSuggestions: [],
  };
}

export type StateBanner =
  | { kind: 'restored_from_backup'; corruptPath: string; message: string }
  | { kind: 'corrupt_no_backup'; corruptPath: string; message: string };

export type LoadStatus = 'new' | 'ok' | 'restored_from_backup' | 'failed';

export class StoreNotLoadedError extends Error {
  constructor() {
    super('state store: not loaded yet. Call load() (and handle a failed result) or startEmpty() first.');
    this.name = 'StoreNotLoadedError';
  }
}

export interface StateStoreOptions {
  fs: SafeFs;
  /** Strategos home. */
  dir: string;
  daemonVersion?: string;
  debounceMs?: number;
  bakIntervalMs?: number;
  now?: () => number;
  pid?: number;
}

function validate(x: unknown): StateFile | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o['schema'] !== 1 || !Array.isArray(o['sessions'])) return null;
  const base = emptyState();
  return {
    ...base,
    ...(o as Partial<StateFile>),
    sessions: o['sessions'] as SessionRecord[],
    initiatives: Array.isArray(o['initiatives']) ? (o['initiatives'] as Initiative[]) : [],
    dismissedSuggestions: Array.isArray(o['dismissedSuggestions']) ? (o['dismissedSuggestions'] as string[]) : [],
    layout: { ...base.layout, ...(typeof o['layout'] === 'object' && o['layout'] !== null ? (o['layout'] as StateFile['layout']) : {}) },
    prefs: { ...base.prefs, ...(typeof o['prefs'] === 'object' && o['prefs'] !== null ? (o['prefs'] as UiPrefs) : {}) },
    schema: 1,
  };
}

/** What goes to disk: no pty or resource, and a pending request is saved with held:false. */
export function toPersisted(s: StateFile, now: number, daemonVersion: string): StateFile {
  return {
    ...s,
    writtenAt: now,
    daemonVersion,
    sessions: s.sessions.map((r) => {
      const { pty: _pty, resource: _resource, ...rest } = r;
      void _pty;
      void _resource;
      return rest.pending === undefined ? rest : { ...rest, pending: { ...rest.pending, held: false } };
    }),
  };
}

export interface StateStore {
  load(): Promise<{ status: LoadStatus; banner: StateBanner | null }>;
  /** Explicit "start empty" after a failed load (or on first run). */
  startEmpty(): void;
  readonly loaded: boolean;
  readonly banner: StateBanner | null;
  /** The live in-memory state. Mutate via update(); never write to the returned object directly. */
  get(): StateFile;
  /** Mutate in place (or return a replacement) and schedule a debounced write. Throws before load. */
  update(mutator: (s: StateFile) => void | StateFile): void;
  /** Write now (after anything already queued) and wait. No-op when nothing changed. Throws before load. */
  flush(): Promise<void>;
  /** Flush and stop the timer. Safe to call before load (then does nothing). */
  close(): Promise<void>;
  readonly paths: { state: string; bak: string };
}

export function createStateStore(opts: StateStoreOptions): StateStore {
  const sfs = opts.fs;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const debounceMs = opts.debounceMs ?? 500;
  const bakIntervalMs = opts.bakIntervalMs ?? 3_600_000;
  const version = opts.daemonVersion ?? '0.0.0';
  const statePath = path.join(opts.dir, 'state.json');
  const bakPath = statePath + '.bak';

  let loaded = false;
  let banner: StateBanner | null = null;
  let state: StateFile = emptyState(version, now());
  let dirty = false;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let lastBakAt = 0;

  function readParsed(file: string): StateFile | null | 'missing' {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null;
    }
    try {
      return validate(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async function sweepTemps(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(opts.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (/^state\.json(\.bak)?\.\d+\.\d+\.tmp$/.test(n)) await sfs.rm(path.join(opts.dir, n), { force: true }).catch(() => undefined);
    }
  }

  async function load(): Promise<{ status: LoadStatus; banner: StateBanner | null }> {
    await sfs.mkdirp(opts.dir);
    await sweepTemps(); // leftovers of a kill mid-write; the daemon lock guarantees nobody else is writing
    try {
      lastBakAt = statSync(bakPath).mtimeMs;
    } catch {
      lastBakAt = 0;
    }
    const main = readParsed(statePath);
    if (main !== 'missing' && main !== null) {
      state = main;
      loaded = true;
      return { status: 'ok', banner: null };
    }
    if (main === 'missing') {
      const bak = readParsed(bakPath);
      if (bak !== 'missing' && bak !== null) {
        state = bak;
        loaded = true;
        return { status: 'restored_from_backup', banner: null };
      }
      state = emptyState(version, now());
      loaded = true;
      return { status: 'new', banner: null };
    }
    // Present but unreadable or invalid.
    const corruptPath = `${statePath}.corrupt-${now()}`;
    await sfs.rename(statePath, corruptPath).catch(() => undefined);
    const bak = readParsed(bakPath);
    if (bak !== 'missing' && bak !== null) {
      state = bak;
      loaded = true;
      banner = { kind: 'restored_from_backup', corruptPath, message: `state.json was unreadable. It was kept as ${path.basename(corruptPath)} and the last backup was loaded.` };
      return { status: 'restored_from_backup', banner };
    }
    banner = { kind: 'corrupt_no_backup', corruptPath, message: `state.json was unreadable and there is no backup. It was kept as ${path.basename(corruptPath)}.` };
    return { status: 'failed', banner }; // stays not-loaded: writes are refused until startEmpty()
  }

  function requireLoaded(): void {
    if (!loaded) throw new StoreNotLoadedError();
  }

  function doWrite(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!dirty) return;
      dirty = false;
      const t = now();
      const json = JSON.stringify(toPersisted(state, t, version));
      try {
        if (t - lastBakAt >= bakIntervalMs && existsSync(statePath)) {
          const bakTmp = `${bakPath}.${pid}.${++seq}.tmp`;
          await sfs.copyFile(statePath, bakTmp);
          await sfs.rename(bakTmp, bakPath);
          lastBakAt = t;
        }
        await sfs.writeFileAtomic(statePath, json, { tmpPath: `${statePath}.${pid}.${++seq}.tmp` });
      } catch (err) {
        dirty = true; // try again at the next flush
        throw err;
      }
    };
    // The queue keeps going after a failed write; the failure is reported to whoever asked for this write.
    const p = queue.then(run);
    queue = p.catch(() => undefined);
    return p;
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      doWrite().catch(() => undefined); // surfaced by the next explicit flush()
    }, debounceMs);
    timer.unref();
  }

  return {
    load,
    startEmpty() {
      state = emptyState(version, now());
      loaded = true;
      dirty = true;
    },
    get loaded() { return loaded; },
    get banner() { return banner; },
    get() {
      requireLoaded();
      return state;
    },
    update(mutator) {
      requireLoaded();
      const r = mutator(state);
      if (r !== undefined) state = r;
      dirty = true;
      schedule();
    },
    async flush() {
      requireLoaded();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await doWrite();
    },
    async close() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!loaded) return;
      await doWrite();
    },
    paths: { state: statePath, bak: bakPath },
  };
}
