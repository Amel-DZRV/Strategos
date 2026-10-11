// events-YYYY-MM-DD.jsonl: append only, one writer, roll at 20 MB, keep 30 days (plan section 5).
// "Never full tool inputs or file contents" is enforced by type: each event type has a fixed list of summary
// fields, every other key is dropped, and every string is cut to a short length.
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { SafeFs } from '../safe-fs.ts';

export type EventData = {
  status: { from?: string; to: string; source: string; reason?: string };
  hook: { event: string; tool?: string; summary?: string };
  decision: { requestId: string; decision: string; via: string; tool?: string };
  guard: { ruleId: string; tool: string; reason?: string };
  cost: { usd: number; claudeSessionId?: string };
  usage: { fiveHourPct?: number; sevenDayPct?: number };
  notify: { kind: string; requestId?: string };
  error: { message: string; where?: string };
  activity: { idleMs: number };
  drift: { detail: string };
};
export type EventType = keyof EventData;

export interface EventRecord<T extends EventType = EventType> {
  ts: number;
  sid?: string;
  type: T;
  data: EventData[T];
}

const FIELDS: { [T in EventType]: readonly (keyof EventData[T] & string)[] } = {
  status: ['from', 'to', 'source', 'reason'],
  hook: ['event', 'tool', 'summary'],
  decision: ['requestId', 'decision', 'via', 'tool'],
  guard: ['ruleId', 'tool', 'reason'],
  cost: ['usd', 'claudeSessionId'],
  usage: ['fiveHourPct', 'sevenDayPct'],
  notify: ['kind', 'requestId'],
  error: ['message', 'where'],
  activity: ['idleMs'],
  drift: ['detail'],
};

export const MAX_FIELD_CHARS = 400;

/** Keep only the whitelisted fields of the type, primitives only, strings cut to 400 chars. */
export function sanitizeEventData(type: EventType, data: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof data !== 'object' || data === null) return out;
  const src = data as Record<string, unknown>;
  for (const key of FIELDS[type] as readonly string[]) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) : v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

export interface EventLogOptions {
  fs: SafeFs;
  /** Strategos home. */
  dir: string;
  now?: () => number;
  maxBytes?: number;
  retentionDays?: number;
}

export interface EventLog {
  append<T extends EventType>(type: T, data: EventData[T], sid?: string): Promise<void>;
  /** Delete files older than the retention window. Runs at start and whenever the day changes. */
  prune(): Promise<string[]>;
  /** Wait for everything queued so far. */
  idle(): Promise<void>;
}

const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

function dayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createEventLog(opts: EventLogOptions): EventLog {
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  const retentionMs = (opts.retentionDays ?? 30) * 86_400_000;
  let queue: Promise<unknown> = Promise.resolve();
  let curDay = '';
  let curPart = 0;
  let curSize = 0;
  let pruned = false;
  let lastPruneDay = '';

  const nameFor = (day: string, part: number) => `events-${day}${part === 0 ? '' : `.${part}`}.jsonl`;

  function scanDay(day: string): void {
    // Continue the highest existing part for today (daemon restart).
    let part = 0;
    try {
      for (const n of readdirSync(opts.dir)) {
        const m = FILE_RE.exec(n);
        if (m && `${m[1]}-${m[2]}-${m[3]}` === day) part = Math.max(part, m[4] ? Number(m[4]) : 0);
      }
    } catch { /* directory not there yet */ }
    curDay = day;
    curPart = part;
    try {
      curSize = statSync(path.join(opts.dir, nameFor(day, part))).size;
    } catch {
      curSize = 0;
    }
  }

  async function pruneNow(): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = now() - retentionMs;
    let names: string[];
    try {
      names = readdirSync(opts.dir);
    } catch {
      return removed;
    }
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (!m) continue;
      const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (fileDay + 86_400_000 <= cutoff) {
        await opts.fs.rm(path.join(opts.dir, n), { force: true }).catch(() => undefined);
        removed.push(n);
      }
    }
    lastPruneDay = dayOf(now());
    return removed;
  }

  async function write(type: EventType, data: unknown, sid: string | undefined): Promise<void> {
    const ts = now();
    const day = dayOf(ts);
    if (!pruned || lastPruneDay !== day) {
      pruned = true;
      await pruneNow();
    }
    if (day !== curDay) scanDay(day);
    const rec: EventRecord = { ts, ...(sid === undefined ? {} : { sid }), type, data: sanitizeEventData(type, data) as never };
    const line = JSON.stringify(rec);
    const bytes = Buffer.byteLength(line) + 1;
    if (curSize > 0 && curSize + bytes > maxBytes) {
      // Roll: the current file is full, start the next part.
      curPart += 1;
      curSize = 0;
    }
    await opts.fs.mkdirp(opts.dir);
    await opts.fs.appendLine(path.join(opts.dir, nameFor(curDay, curPart)), line);
    curSize += bytes;
  }

  return {
    append(type, data, sid) {
      const p = queue.then(() => write(type, data, sid));
      queue = p.catch(() => undefined);
      return p;
    },
    prune() {
      const p = queue.then(() => pruneNow());
      queue = p.catch(() => undefined);
      return p;
    },
    async idle() {
      await queue;
    },
  };
}
