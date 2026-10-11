// node-pty wrapper (plan section 4.1, task 1.09): scrubbed child env, 2 MB scrollback, input origin and dirty-input tracking.
import pty from 'node-pty';
import { InputTracker, type InputOrigin, type KeyEvent } from './input.ts';

export type { InputOrigin, KeyEvent } from './input.ts';

/** Environment keys Claude Code treats as its own state or credentials (plan section 10 "Env scrubbing", V24). */
function isScrubbed(upperKey: string): boolean {
  return upperKey === 'CLAUDECODE' || upperKey.startsWith('CLAUDE_CODE_') || upperKey.startsWith('CLAUDE_AGENT_SDK_') || upperKey.startsWith('ANTHROPIC_');
}

export interface EnvPolicy {
  /** Names to keep even though the scrubber would drop them (config.env.keep). Case-insensitive. */
  keep?: readonly string[];
  /** Names to set or override after scrubbing (config.env.set). */
  set?: Readonly<Record<string, string>>;
}

/**
 * Build a child environment: drop CLAUDECODE, CLAUDE_CODE_*, CLAUDE_AGENT_SDK_*, ANTHROPIC_* (an inherited key would
 * outrank /login, and CLAUDE_CODE_SIMPLE would switch the child into bare mode); keep CLAUDE_CONFIG_DIR; then re-add
 * `policy.keep` names from the source and apply `policy.set`. Names compare case-insensitively (Windows).
 * Pure: never reads process.env itself.
 */
export function scrubEnv(src: Readonly<Record<string, string | undefined>>, policy: EnvPolicy = {}): Record<string, string> {
  const keep = new Set((policy.keep ?? []).map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (up === 'CLAUDE_CONFIG_DIR' || keep.has(up) || !isScrubbed(up)) env[k] = v;
  }
  for (const [k, v] of Object.entries(policy.set ?? {})) {
    for (const existing of Object.keys(env)) if (existing !== k && existing.toUpperCase() === k.toUpperCase()) delete env[existing];
    env[k] = v;
  }
  return env;
}

export const SCROLLBACK_LIMIT = 2 * 1024 * 1024;

/**
 * Ring buffer of the most recent output. The limit counts UTF-16 code units, which equals bytes for the mostly-ASCII
 * terminal stream. `contents()` returns exactly the last `limit` units of everything pushed, in order.
 */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(readonly limit: number = SCROLLBACK_LIMIT) {}

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) { this.chunks.shift(); this.size -= first.length; continue; }
      let cut = excess;
      const code = first.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut++; // do not start in the middle of a surrogate pair
      this.chunks[0] = first.slice(cut);
      this.size -= cut;
    }
    if (this.chunks.length > 1024) { this.chunks = [this.chunks.join('')]; } // keep the array short for long sessions
  }

  contents(): string {
    return this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join('');
  }
}

export interface PtySpawnOptions {
  exe: string;
  args: string[];
  cwd: string;
  /** Already scrubbed (see scrubEnv); passed to the child unchanged. */
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Windows only: use node-pty's bundled conpty.dll (experimental; S3 fallback). */
  useConptyDll?: boolean;
}

export interface PtyHandle {
  readonly pid: number;
  write(d: string, origin: InputOrigin): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): () => void;
  onExit(cb: (code: number) => void): void;
  /** Esc / Ctrl+C written to the pty (by the user or by Strategos). */
  onKey(cb: (e: KeyEvent) => void): () => void;
  scrollback(): string;
  /** The user typed something into the prompt that was not submitted. */
  readonly dirtyInput: boolean;
  /** null while running */
  readonly exitCode: number | null;
}

export interface PtyHost {
  spawn(o: PtySpawnOptions): PtyHandle;
}

export interface PtyHostOptions { scrollbackLimit?: number; escMs?: number }

export function createPtyHost(hostOpts: PtyHostOptions = {}): PtyHost {
  return {
    spawn(o) {
      const proc = pty.spawn(o.exe, o.args, {
        name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env,
        ...(o.useConptyDll ? { useConptyDll: true } : {}),
      } as pty.IPtyForkOptions & pty.IWindowsPtyForkOptions);
      const scrollback = new ScrollbackBuffer(hostOpts.scrollbackLimit);
      const input = new InputTracker({ escMs: hostOpts.escMs });
      const dataCbs = new Set<(d: string) => void>();
      const exitCbs: ((code: number) => void)[] = [];
      let exitCode: number | null = null;

      proc.onData((d) => {
        scrollback.push(d);
        for (const cb of [...dataCbs]) cb(d);
      });
      proc.onExit(({ exitCode: code }) => {
        exitCode = code;
        input.dispose();
        for (const cb of exitCbs.splice(0)) cb(code);
      });

      return {
        pid: proc.pid,
        write(d, origin) {
          if (exitCode !== null || d.length === 0) return;
          input.feed(d, origin);
          try { proc.write(d); } catch { /* pty closed between the check and the write */ }
        },
        resize(c, r) {
          if (exitCode !== null) return;
          try { proc.resize(c, r); } catch { /* exited */ }
        },
        kill() {
          if (exitCode !== null) return;
          try { proc.kill(); } catch { /* already gone */ }
        },
        onData(cb) { dataCbs.add(cb); return () => { dataCbs.delete(cb); }; },
        onExit(cb) {
          if (exitCode !== null) { const c = exitCode; queueMicrotask(() => cb(c)); } else exitCbs.push(cb);
        },
        onKey: (cb) => input.onKey(cb),
        scrollback: () => scrollback.contents(),
        get dirtyInput() { return input.dirtyInput; },
        get exitCode() { return exitCode; },
      };
    },
  };
}
