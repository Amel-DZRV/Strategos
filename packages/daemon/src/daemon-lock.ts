// daemon.lock (plan section 5): `{pid, procStart}`, created exclusively at start. A live holder means a second daemon
// must exit; a stale holder (dead pid, or the pid now belongs to another process: different start time) is replaced.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SafeFs } from './safe-fs.ts';

export interface LockHolder {
  pid: number;
  procStart?: string;
}

export type LockResult =
  | { ok: true; release(): Promise<void> }
  | { ok: false; holder: LockHolder; message: string };

export interface LockDeps {
  fs: SafeFs;
  home: string;
  pid: number;
  /** platform.proc.startTime(pid) */
  startTime(pid: number): Promise<string | null>;
  /** platform.proc.isAlive(pid, procStart) */
  isAlive(pid: number, procStart?: string): Promise<boolean>;
}

export const lockPath = (home: string): string => path.join(home, 'daemon.lock');

export function readLock(home: string): LockHolder | null {
  try {
    const j = JSON.parse(readFileSync(lockPath(home), 'utf8')) as { pid?: unknown; procStart?: unknown };
    if (typeof j.pid !== 'number' || !Number.isInteger(j.pid) || j.pid <= 0) return null;
    return { pid: j.pid, ...(typeof j.procStart === 'string' ? { procStart: j.procStart } : {}) };
  } catch {
    return null;
  }
}

export async function acquireLock(d: LockDeps): Promise<LockResult> {
  const file = lockPath(d.home);
  const procStart = (await d.startTime(d.pid)) ?? undefined;
  const body = JSON.stringify({ pid: d.pid, ...(procStart === undefined ? {} : { procStart }) });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await d.fs.writeFile(file, body, { exclusive: true });
      return {
        ok: true,
        async release() {
          // only remove a lock that is still ours
          if (readLock(d.home)?.pid === d.pid) await d.fs.rm(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readLock(d.home);
    if (holder !== null && holder.pid !== d.pid && (await d.isAlive(holder.pid, holder.procStart))) {
      return { ok: false, holder, message: `Another Strategos daemon is already running (pid ${holder.pid}). Use \`strategos status\` or \`strategos stop\`.` };
    }
    await d.fs.rm(file, { force: true }); // stale (or unreadable): replace it
  }
  throw new Error('Could not take daemon.lock (it keeps being recreated).');
}
