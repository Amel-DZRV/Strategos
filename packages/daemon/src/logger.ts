// Diagnostics: logs/daemon-YYYY-MM-DD.log under the Strategos home, 7-day retention (plan section 5).
// Every write goes through safe-fs. Lines are "ISO-time LEVEL message" and never contain tool inputs or tokens.
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { SafeFs } from './safe-fs.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  /** Delete log files older than the retention window; returns their names. */
  prune(): Promise<string[]>;
  /** Wait for the writes queued so far. */
  idle(): Promise<void>;
  readonly dir: string;
}

const FILE_RE = /^daemon-(\d{4})-(\d{2})-(\d{2})\.log$/;

const pad = (n: number): string => String(n).padStart(2, '0');
export const dayStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 6).join(' | ') : String(err);
}

export function createLogger(o: { fs: SafeFs; home: string; now?: () => number; retentionDays?: number; echo?: boolean }): Logger {
  const now = o.now ?? Date.now;
  const dir = path.join(o.home, 'logs');
  const retentionMs = (o.retentionDays ?? 7) * 86_400_000;
  let queue: Promise<unknown> = Promise.resolve();
  let made = false;

  const log = (level: LogLevel, message: string): void => {
    const t = now();
    const line = `${new Date(t).toISOString()} ${level.toUpperCase()} ${message.replace(/\r?\n/g, ' | ')}`;
    if (o.echo === true) (level === 'error' ? console.error : console.log)(line);
    queue = queue
      .then(async () => {
        if (!made) {
          await o.fs.mkdirp(dir);
          made = true;
        }
        await o.fs.appendLine(path.join(dir, `daemon-${dayStamp(t)}.log`), line);
      })
      .catch(() => undefined); // logging must never throw into the caller
  };

  return {
    log,
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
    error: (m, err) => log('error', err === undefined ? m : `${m}: ${errText(err)}`),
    async prune() {
      await queue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const cutoff = now() - retentionMs;
      const removed: string[] = [];
      for (const n of names) {
        const m = FILE_RE.exec(n);
        if (m === null) continue;
        if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() >= cutoff) continue;
        await o.fs.rm(path.join(dir, n), { force: true });
        removed.push(n);
      }
      return removed;
    },
    idle: () => queue.then(() => undefined),
    dir,
  };
}
