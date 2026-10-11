import { execFile } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string }

/** execFile with an argument array only (never a shell). Resolves with the exit code instead of rejecting on non-zero. */
export function run(file: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeoutMs ?? 10_000, windowsHide: true, env: opts.env, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) { resolve({ code: 0, stdout, stderr }); return; }
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (typeof e.code === 'number') { resolve({ code: e.code, stdout, stderr }); return; }
      reject(err);
    });
  });
}
