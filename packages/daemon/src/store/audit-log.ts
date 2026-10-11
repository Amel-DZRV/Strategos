// audit.jsonl: every allow, deny, always, release, answer and guard deny (plan section 5). Append only,
// 180-day retention. The summary is the 400-char inputSummary, never the full tool input.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { RiskClass } from '@strategos/shared';
import type { SafeFs } from '../safe-fs.ts';

export type AuditVia = 'map' | 'strip' | 'drawer' | 'toast' | 'palette' | 'guard' | 'lowRiskBatch';
export type AuditDecision = 'allow' | 'deny' | 'always' | 'release' | 'answer';

export interface AuditEntry {
  ts: number;
  sid: string;
  claudeSessionId?: string;
  requestId: string;
  tool: string;
  inputSummary: string;
  risk: RiskClass[];
  decision: AuditDecision;
  via: AuditVia;
  connId?: string;
}

export interface AuditLogOptions {
  fs: SafeFs;
  /** Strategos home. */
  dir: string;
  now?: () => number;
  retentionDays?: number;
}

export interface AuditLog {
  /** `ts` is filled in when absent. The summary is cut to 400 chars. */
  append(entry: Omit<AuditEntry, 'ts'> & { ts?: number }): Promise<void>;
  /** Newest last. */
  read(o?: { since?: number; limit?: number }): AuditEntry[];
  /** Drop lines older than the retention window (rewrites the file atomically). Returns how many were dropped. */
  prune(): Promise<number>;
  idle(): Promise<void>;
  readonly path: string;
}

export function createAuditLog(opts: AuditLogOptions): AuditLog {
  const file = path.join(opts.dir, 'audit.jsonl');
  const now = opts.now ?? Date.now;
  const retentionMs = (opts.retentionDays ?? 180) * 86_400_000;
  let queue: Promise<unknown> = Promise.resolve();
  let pruned = false;

  function parse(): AuditEntry[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (typeof e.ts === 'number') out.push(e);
      } catch { /* a torn last line after a crash: skip it */ }
    }
    return out;
  }

  async function pruneNow(): Promise<number> {
    const all = parse();
    const cutoff = now() - retentionMs;
    const keep = all.filter((e) => e.ts >= cutoff);
    pruned = true;
    if (keep.length === all.length) return 0;
    await opts.fs.writeFileAtomic(file, keep.map((e) => JSON.stringify(e) + '\n').join(''));
    return all.length - keep.length;
  }

  return {
    path: file,
    append(entry) {
      const p = queue.then(async () => {
        if (!pruned) await pruneNow();
        const e: AuditEntry = {
          ...entry,
          ts: entry.ts ?? now(),
          inputSummary: entry.inputSummary.length > 400 ? entry.inputSummary.slice(0, 400) : entry.inputSummary,
        };
        await opts.fs.mkdirp(opts.dir);
        await opts.fs.appendLine(file, JSON.stringify(e));
      });
      queue = p.catch(() => undefined);
      return p;
    },
    read(o) {
      let all = parse();
      if (o?.since !== undefined) all = all.filter((e) => e.ts >= o.since!);
      return o?.limit !== undefined ? all.slice(-o.limit) : all;
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
