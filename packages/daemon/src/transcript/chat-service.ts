// The chat view's source (plan task 5.01, `chat.subscribe`): for each session someone is looking at, build the ChatItem
// list from the whole lineage of transcripts (every Claude session id the Strategos session went through, in order),
// the subagent files next to them, and the lineage markers the manager recorded; then follow the live files.
//
//   subscribe(sid, from, send)
//     from = 0 (or beyond what we have): one `chat.items` {reset: true} with the last `maxInitial` items
//              (`truncatedBefore` = how many older items were left out; `from` is then that count)
//     from > 0: only the items from that index on, reset: false
//   then every change is sent as `{from, items, reset: false}` (the client replaces its list from `from`).
//
// Reading never writes. The history is read in 1 MiB ranges, the live part is followed by the shared tailer. A session
// nobody watches for `idleMs` is dropped from memory.
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ChatItem, DaemonEvent, SessionRecord } from '@strategos/shared';
import { ChatBuilder, type ChatDelta } from './chat-items.ts';
import { jsonLines, readRange } from './fsutil.ts';
import type { Tailer } from './tailer.ts';

export type ChatItemsEvent = Extract<DaemonEvent, { t: 'chat.items' }>;
type LineageMarker = 'clear' | 'resume' | 'fork';
const LINEAGE: readonly string[] = ['clear', 'resume', 'fork'];
const isLineage = (m: string): m is LineageMarker => LINEAGE.includes(m);

export interface ChatServiceDeps {
  tailer: Tailer;
  session(sid: string): Pick<SessionRecord, 'claudeSessionIds' | 'currentSessionId' | 'transcriptPath'> | undefined;
  /** chat.marker effects recorded by the manager (clear/compact/resume/fork/interrupted; only the lineage kinds are used). */
  markers(sid: string): { marker: string; at: number }[];
  /** Called after every session record change (the manager's onChange). Returns the unsubscribe. */
  onSessionChange(cb: (sid: string) => void): () => void;
  /** Initial payload cap. Default 2000 items. */
  maxInitial?: number;
  /** How often to look for new subagent files of the live transcript. Default 750 ms. */
  subagentPollMs?: number;
  /** Keep a session's chat in memory this long after the last subscriber left. Default 60 s. */
  idleMs?: number;
  now?: () => number;
  onError?: (err: unknown, where: string) => void;
}

export interface ChatService {
  /** Rejects when the session is unknown. `send` is called synchronously for the initial payload and for every later change. */
  subscribe(sid: string, from: number, send: (ev: ChatItemsEvent) => void): Promise<() => void>;
  /** Items currently built for a session (tests). Undefined when it is not loaded. */
  peek(sid: string): readonly ChatItem[] | undefined;
  dispose(): void;
}

interface Sub {
  send: (ev: ChatItemsEvent) => void;
  /** Absolute index of the first item this subscriber holds. */
  base: number;
}

const CHUNK = 1024 * 1024;

/** Read every complete line of a file in ranges; calls `onRecords` per chunk. Returns the offset after the last newline. */
async function readComplete(file: string, onRecords: (records: unknown[]) => void): Promise<number> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let pos = 0;
  let pending = Buffer.alloc(0);
  let offset = 0;
  while (pos < size) {
    const buf = await readRange(file, pos, Math.min(size, pos + CHUNK));
    if (buf.length === 0) break;
    pos += buf.length;
    const data = pending.length > 0 ? Buffer.concat([pending, buf]) : buf;
    const nl = data.lastIndexOf(0x0a);
    if (nl < 0) {
      pending = Buffer.from(data);
      continue;
    }
    pending = Buffer.from(data.subarray(nl + 1));
    offset += nl + 1;
    onRecords(jsonLines(new TextDecoder().decode(data.subarray(0, nl + 1))));
  }
  return offset;
}

const firstTime = (records: readonly unknown[]): number | undefined => {
  for (const r of records) {
    const t = Date.parse(String((r as { timestamp?: unknown } | null)?.timestamp ?? ''));
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
};

class ChatSession {
  builder = new ChatBuilder();
  readonly sid: string;
  readonly svc: ChatServiceDeps;
  readonly now: () => number;
  readonly onDrop: () => void;
  readonly subs = new Set<Sub>();
  idleTimer: NodeJS.Timeout | undefined;
  /** What the last sync saw of the record; a different value means the lineage or the markers changed. */
  sig = '';
  ready: Promise<void>;
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #loaded = new Set<string>(); // transcript files read
  readonly #stops = new Map<string, () => void>(); // file -> stop following
  readonly #subagents = new Set<string>(); // subagent files picked up
  readonly #dirsDone = new Set<string>(); // subagent folders of finished transcripts, read once
  readonly #markersAdded = new Set<string>();
  #pollTimer: NodeJS.Timeout | undefined;
  #followed: string | undefined;
  #rebuilding = false;

  constructor(sid: string, svc: ChatServiceDeps, now: () => number, onDrop: () => void) {
    this.sid = sid;
    this.svc = svc;
    this.now = now;
    this.onDrop = onDrop;
    this.ready = this.sync();
    this.#pollTimer = setInterval(() => { this.sync().catch(this.#err('subagent poll')); }, svc.subagentPollMs ?? 750);
    this.#pollTimer.unref();
  }

  #err(where: string): (err: unknown) => void {
    return (err) => { this.svc.onError?.(err, `chat ${where}`); };
  }

  /** Serialised: bring the builder up to date with the session record (lineage files, subagents, markers). */
  sync(): Promise<void> {
    const run = this.#chain.then(() => this.#sync());
    this.#chain = run.catch(this.#err('sync'));
    return run;
  }

  async #sync(): Promise<void> {
    if (this.#disposed) return;
    const info = this.svc.session(this.sid);
    if (info === undefined) {
      this.onDrop();
      return;
    }
    this.sig = signature(info, this.svc.markers(this.sid));
    const files = this.#lineageFiles(info);
    const fresh = markersToUse(this.svc.markers(this.sid), this.#markersAdded);
    for (const [i, f] of files.entries()) {
      if (this.#loaded.has(f.file)) continue;
      this.#loaded.add(f.file);
      const records: unknown[] = [];
      const offset = await readComplete(f.file, (rs) => { records.push(...rs); });
      this.#emit(this.builder.ingest(records));
      // A transition in the lineage (not the first transcript): marker nearest in time, else "unknown".
      if (i > 0) {
        const at = firstTime(records);
        const m = takeNearest(fresh, at);
        this.#emit(m !== undefined
          ? this.builder.addMarker(m.marker as LineageMarker, m.at)
          : this.builder.addMarker('unknown', at === undefined ? this.now() : at - 1));
        if (m !== undefined) this.#markersAdded.add(`${m.marker}:${m.at}`);
      }
      if (f.current) this.#follow(f.file, offset);
    }
    // Markers the lineage did not explain (a resume of the same conversation): by time.
    for (const m of fresh) {
      this.#markersAdded.add(`${m.marker}:${m.at}`);
      this.#emit(this.builder.addMarker(m.marker as LineageMarker, m.at));
    }
    // The subagents of the live transcript, and of the others once.
    for (const f of files) {
      if (!f.current && this.#dirsDone.has(f.file)) continue;
      if (!f.current) this.#dirsDone.add(f.file);
      await this.#subagentFiles(f.file, f.sessionId, f.current);
    }
  }

  #lineageFiles(info: NonNullable<ReturnType<ChatServiceDeps['session']>>): { file: string; sessionId: string; current: boolean }[] {
    if (info.transcriptPath === undefined) return [];
    const dir = path.dirname(info.transcriptPath);
    const out: { file: string; sessionId: string; current: boolean }[] = [];
    for (const id of info.claudeSessionIds) {
      const current = id === info.currentSessionId;
      out.push({ file: current ? info.transcriptPath : path.join(dir, `${id}.jsonl`), sessionId: id, current });
    }
    if (!out.some((o) => o.current)) out.push({ file: info.transcriptPath, sessionId: path.basename(info.transcriptPath, '.jsonl'), current: true });
    return out;
  }

  #follow(file: string, offset: number): void {
    if (this.#followed === file) return;
    this.#stops.get(this.#followed ?? '')?.();
    this.#followed = file;
    this.#stops.set(file, this.svc.tailer.follow(file, offset, (records, _off, info) => {
      if (this.#disposed) return;
      if (info.reset) {
        void this.#rebuild();
        return;
      }
      this.#emit(this.builder.ingest(records));
    }));
  }

  async #subagentFiles(transcript: string, sessionId: string, live: boolean): Promise<void> {
    const dir = path.join(path.dirname(transcript), sessionId, 'subagents');
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      if (this.#subagents.has(file)) continue;
      this.#subagents.add(file);
      const base = n.replace(/\.jsonl$/, '');
      const agentId = base.replace(/^agent-/, '');
      let meta: { description?: unknown; toolUseId?: unknown } = {};
      try {
        meta = JSON.parse(await readFile(path.join(dir, `${base}.meta.json`), 'utf8')) as typeof meta;
      } catch {
        // no meta (yet): the brief comes from the first prompt
      }
      this.#emit(this.builder.declareSubagent({
        agentId,
        ...(typeof meta.toolUseId === 'string' ? { toolUseId: meta.toolUseId } : {}),
        ...(typeof meta.description === 'string' ? { brief: meta.description } : {}),
      }));
      const offset = await readComplete(file, (rs) => { this.#emit(this.builder.ingest(rs, { agentId })); });
      if (live) {
        this.#stops.set(file, this.svc.tailer.follow(file, offset, (records, _off, info) => {
          if (this.#disposed || info.reset) return;
          this.#emit(this.builder.ingest(records, { agentId }));
        }));
      }
    }
  }

  /** The followed file shrank (rewritten): start over and tell everybody to replace their list. */
  async #rebuild(): Promise<void> {
    if (this.#rebuilding || this.#disposed) return;
    this.#rebuilding = true;
    try {
      for (const stop of this.#stops.values()) stop();
      this.#stops.clear();
      this.#followed = undefined;
      this.#loaded.clear();
      this.#subagents.clear();
      this.#markersAdded.clear();
      this.#dirsDone.clear();
      this.builder = new ChatBuilder();
      await this.sync();
      for (const s of this.subs) this.sendInitial(s, 0);
    } finally {
      this.#rebuilding = false;
    }
  }

  #emit(d: ChatDelta | undefined): void {
    if (d === undefined || this.#rebuilding) return;
    for (const s of this.subs) {
      let { from, items } = d;
      if (from < s.base) {
        items = items.slice(s.base - from);
        from = s.base;
      }
      s.send({ t: 'chat.items', strategosId: this.sid, from, items: structuredClone(items), reset: false });
    }
  }

  sendInitial(s: Sub, from: number): void {
    const all = this.builder.items();
    const max = this.svc.maxInitial ?? 2000;
    if (from > 0 && from <= all.length) {
      s.base = from;
      s.send({ t: 'chat.items', strategosId: this.sid, from, items: structuredClone(all.slice(from)), reset: false });
      return;
    }
    const start = Math.max(0, all.length - max);
    s.base = start;
    s.send({
      t: 'chat.items', strategosId: this.sid, from: start, items: structuredClone(all.slice(start)), reset: true,
      ...(start > 0 ? { truncatedBefore: start } : {}),
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    for (const stop of this.#stops.values()) stop();
    this.#stops.clear();
    this.subs.clear();
  }
}

function signature(info: { claudeSessionIds: string[]; currentSessionId: string; transcriptPath?: string | undefined }, markers: { marker: string }[]): string {
  return `${info.claudeSessionIds.join(',')}|${info.currentSessionId}|${info.transcriptPath ?? ''}|${markers.filter((m) => isLineage(m.marker)).length}`;
}

function markersToUse(all: { marker: string; at: number }[], done: Set<string>): { marker: string; at: number }[] {
  return all.filter((m) => isLineage(m.marker) && !done.has(`${m.marker}:${m.at}`)).sort((a, b) => a.at - b.at);
}

/** Remove and return the marker closest in time to `at` (within 2 minutes); with no time, the oldest. */
function takeNearest(markers: { marker: string; at: number }[], at: number | undefined): { marker: string; at: number } | undefined {
  if (markers.length === 0) return undefined;
  let best = 0;
  if (at !== undefined) {
    for (let i = 1; i < markers.length; i++) if (Math.abs(markers[i]!.at - at) < Math.abs(markers[best]!.at - at)) best = i;
    if (Math.abs(markers[best]!.at - at) > 120_000) return undefined;
  }
  return markers.splice(best, 1)[0];
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, ChatSession>();
  let disposed = false;

  const unsubChange = deps.onSessionChange((sid) => {
    const cs = sessions.get(sid);
    const info = deps.session(sid);
    if (cs === undefined || (info !== undefined && signature(info, deps.markers(sid)) === cs.sig)) return;
    cs.sync().catch((err: unknown) => { deps.onError?.(err, 'chat sync'); });
  });

  function get(sid: string): ChatSession {
    let cs = sessions.get(sid);
    if (cs === undefined) {
      cs = new ChatSession(sid, deps, now, () => {
        const c = sessions.get(sid);
        c?.dispose();
        sessions.delete(sid);
      });
      sessions.set(sid, cs);
    }
    return cs;
  }

  return {
    async subscribe(sid, from, send) {
      if (disposed) throw new Error('chat service stopped');
      if (deps.session(sid) === undefined) throw new Error(`no such session: ${sid}`);
      const cs = get(sid);
      if (cs.idleTimer !== undefined) {
        clearTimeout(cs.idleTimer);
        cs.idleTimer = undefined;
      }
      await cs.ready;
      const sub: Sub = { send, base: 0 };
      cs.sendInitial(sub, from); // synchronous with the registration below: no delta can fall between them
      cs.subs.add(sub);
      return () => {
        cs.subs.delete(sub);
        if (cs.subs.size === 0 && sessions.get(sid) === cs) {
          cs.idleTimer = setTimeout(() => {
            if (cs.subs.size === 0) {
              cs.dispose();
              sessions.delete(sid);
            }
          }, deps.idleMs ?? 60_000);
          cs.idleTimer.unref();
        }
      };
    },
    peek: (sid) => sessions.get(sid)?.builder.items(),
    dispose() {
      disposed = true;
      unsubChange();
      for (const cs of sessions.values()) cs.dispose();
      sessions.clear();
    },
  };
}
