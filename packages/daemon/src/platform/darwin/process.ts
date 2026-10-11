import { run } from '../common/exec.ts';

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid < 2 ** 31;
}

function kill0(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Start time as `ps -o lstart=` prints it (e.g. "Sun Oct 11 10:00:00 2026"). Null when the process does not exist. */
export async function startTime(pid: number): Promise<string | null> {
  if (!validPid(pid)) return null;
  try {
    const r = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    const out = r.stdout.trim().replace(/\s+/g, ' ');
    return r.code === 0 && out ? out : null;
  } catch { return null; }
}

export async function isAlive(pid: number, expectedStart?: string): Promise<boolean> {
  if (!validPid(pid) || !kill0(pid)) return false;
  if (expectedStart === undefined) return true;
  const st = await startTime(pid);
  return st === null ? kill0(pid) : st === expectedStart.trim().replace(/\s+/g, ' ');
}

/** Parse `ps -A -o pid=,ppid=` into child lists and return every descendant of `root` (children before parents). */
export function descendantsFromPs(psOutput: string, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    const list = kids.get(ppid) ?? [];
    list.push(pid);
    kids.set(ppid, list);
  }
  const out: number[] = [];
  const visit = (p: number, seen: Set<number>): void => {
    for (const k of kids.get(p) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      visit(k, seen);
      out.push(k);
    }
  };
  visit(root, new Set([root]));
  return out;
}

/**
 * Process-group kill. A pty child is a session and group leader, so `kill(-pid)` reaches its grandchildren; descendants
 * that left the group (setsid, daemonised) are found through a `ps` snapshot and killed one by one.
 */
export async function killTree(pid: number): Promise<void> {
  if (!validPid(pid)) throw new Error(`bad pid ${pid}`);
  let desc: number[] = [];
  try { desc = descendantsFromPs((await run('/bin/ps', ['-A', '-o', 'pid=,ppid='])).stdout, pid); } catch { /* group kill still happens */ }
  const send = (target: number, sig: NodeJS.Signals): void => { try { process.kill(target, sig); } catch { /* already gone */ } };
  send(-pid, 'SIGTERM');
  send(pid, 'SIGTERM');
  for (const d of desc) send(d, 'SIGTERM');
  for (let i = 0; i < 10; i++) {
    if (![pid, ...desc].some(kill0)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  send(-pid, 'SIGKILL');
  send(pid, 'SIGKILL');
  for (const d of desc) send(d, 'SIGKILL');
  for (let i = 0; i < 20; i++) {
    if (!kill0(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`process ${pid} still alive after SIGKILL`);
}
