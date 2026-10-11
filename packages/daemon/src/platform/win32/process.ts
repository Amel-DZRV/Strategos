import { run } from '../common/exec.ts';

const sysExe = (name: string): string => {
  const root = process.env['SystemRoot'] || process.env['SYSTEMROOT'] || 'C:\\Windows';
  return `${root}\\System32\\${name}`;
};

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid < 2 ** 31;
}

function kill0(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Process start time as a FILETIME string (100 ns ticks since 1601, UTC) - the same unit as `procStart` in Claude's
 * `~/.claude/sessions/<pid>.json` [ran]. Null when the process does not exist or cannot be queried.
 */
export async function startTime(pid: number): Promise<string | null> {
  if (!validPid(pid)) return null;
  const ps = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [string]$p.StartTime.ToFileTimeUtc() }`;
  try {
    const r = await run(sysExe('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 15_000 });
    const out = r.stdout.trim();
    return /^\d+$/.test(out) ? out : null;
  } catch { return null; }
}

/** Alive means the pid exists and, when `expectedStart` is given, it is the same process (pid reuse guard). */
export async function isAlive(pid: number, expectedStart?: string): Promise<boolean> {
  if (!validPid(pid) || !kill0(pid)) return false;
  if (expectedStart === undefined) return true;
  const st = await startTime(pid);
  return st === null ? kill0(pid) : st === expectedStart;
}

/** `taskkill /T /F /PID`: kills the process and every descendant still linked to it. Resolves once the root is gone. */
export async function killTree(pid: number): Promise<void> {
  if (!validPid(pid)) throw new Error(`bad pid ${pid}`);
  await run(sysExe('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { timeoutMs: 15_000 }); // 128 = already gone; not an error
  for (let i = 0; i < 10; i++) {
    if (!kill0(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process ${pid} still alive after taskkill`);
}
