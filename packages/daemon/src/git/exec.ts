// The one place git and gh processes are started (plan D16): execFile with an argument array, never a shell string.
// Nothing here throws on a non-zero exit; callers look at `code`. Tests inject their own Exec.
import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when the program could not be started (not installed) or timed out. */
  code: number;
  /** Set when the program could not be started: 'ENOENT' for a missing executable. */
  spawnError?: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Written to the program's stdin, then closed. */
  input?: string;
}

export type Exec = (file: string, args: readonly string[], o?: ExecOptions) => Promise<ExecResult>;

/** Never prompt (a push that wants a password must fail, not hang) and do not take optional locks (polling must not fight Claude's own git). */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' };

export const defaultExec: Exec = (file, args, o = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        timeout: o.timeoutMs ?? 30_000,
        maxBuffer: o.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const code = typeof e.code === 'number' ? e.code : -1;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, ...(typeof e.code === 'string' ? { spawnError: e.code } : {}) });
      },
    );
    if (o.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(o.input);
    }
  });
