// The daemon's only write path (plan section 4, task 1.04). The lint rule forbids fs writes everywhere else.
//
// Every write target is resolved (path.resolve, then realpath of the nearest existing ancestor, so symlinks and
// junctions cannot hide a target) and checked twice:
//   1. it must NOT be inside the Claude config dir (CLAUDE_CONFIG_DIR or ~/.claude): never writable, no override;
//   2. it MUST be inside an allowed root (the Strategos home, plus roots the policy lists), or inside a root the
//      caller passes for this one call through `allow` (run settings files, worktrees).
// Comparison is case-insensitive on win32 and darwin.
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const fsp = fs.promises;

export type SafeFsErrorCode = 'CLAUDE_DIR' | 'OUTSIDE_ROOTS' | 'BAD_PATH';

export class SafeFsError extends Error {
  readonly code: SafeFsErrorCode;
  readonly target: string;
  constructor(code: SafeFsErrorCode, target: string, message: string) {
    super(message);
    this.name = 'SafeFsError';
    this.code = code;
    this.target = target;
  }
}

export interface SafeFsPolicy {
  /** The Claude config dir. Nothing under it can ever be written. Callers pass `claudeConfigDir()`. */
  claudeDir: string;
  /** Roots that are always writable: normally just the Strategos home. */
  roots: readonly string[];
  /** Override for tests. Default: true on win32 and darwin. */
  caseInsensitive?: boolean;
}

/** The Claude config dir as Claude itself resolves it: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const fromEnv = env['CLAUDE_CONFIG_DIR'];
  return fromEnv !== undefined && fromEnv !== '' ? path.resolve(fromEnv) : path.join(home, '.claude');
}

export interface WriteOpts {
  /** Extra roots allowed for this one call (run settings dir, a worktree). Never overrides the Claude dir ban. */
  allow?: readonly string[];
  mode?: number;
}

export interface SafeFs {
  readonly claudeDir: string;
  /** Resolve and validate. Returns the absolute path to write, or throws SafeFsError. */
  check(target: string, allow?: readonly string[]): string;
  writeFile(target: string, data: string | Uint8Array, opts?: WriteOpts): Promise<void>;
  /** Write `<target>.<pid>.<n>.tmp` (or `opts.tmpPath`), then rename over `target`. */
  writeFileAtomic(target: string, data: string | Uint8Array, opts?: WriteOpts & { tmpPath?: string }): Promise<void>;
  /** Append `line` plus a newline (one JSONL record). */
  appendLine(target: string, line: string, opts?: WriteOpts): Promise<void>;
  mkdirp(target: string, opts?: WriteOpts): Promise<void>;
  rename(from: string, to: string, opts?: WriteOpts): Promise<void>;
  copyFile(from: string, to: string, opts?: WriteOpts): Promise<void>;
  rm(target: string, opts?: WriteOpts & { recursive?: boolean; force?: boolean }): Promise<void>;
  /** Windows: icacls /inheritance:r /grant:r user:F. POSIX: chmod 700 (dir) or 600 (file). */
  chmodUserOnly(target: string, opts?: WriteOpts): Promise<void>;
}

function stripExtendedPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail re-appended. */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = stripExtendedPrefix(fs.realpathSync.native(head));
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function isInside(child: string, parent: string, ci: boolean): boolean {
  const c = ci ? child.toLowerCase() : child;
  const p = ci ? parent.toLowerCase() : parent;
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createSafeFs(policy: SafeFsPolicy): SafeFs {
  const ci = policy.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin');
  const claude = realResolve(policy.claudeDir);
  const claudeLexical = path.resolve(policy.claudeDir);
  let tmpSeq = 0;

  function check(target: string, allow?: readonly string[]): string {
    if (typeof target !== 'string' || target === '' || target.includes('\0')) {
      throw new SafeFsError('BAD_PATH', String(target), 'safe-fs: empty or invalid path');
    }
    const lexical = path.resolve(target);
    const real = realResolve(lexical);
    if (isInside(real, claude, ci) || isInside(lexical, claudeLexical, ci) || isInside(real, claudeLexical, ci)) {
      throw new SafeFsError('CLAUDE_DIR', target, `safe-fs: refusing to write inside the Claude config dir (${claude}): ${target}`);
    }
    const roots = [...policy.roots, ...(allow ?? [])].map(realResolve);
    if (!roots.some((r) => isInside(real, r, ci))) {
      throw new SafeFsError('OUTSIDE_ROOTS', target, `safe-fs: ${target} is outside the allowed folders`);
    }
    return real;
  }

  return {
    claudeDir: claude,
    check,
    async writeFile(target, data, opts) {
      const p = check(target, opts?.allow);
      await fsp.writeFile(p, data, opts?.mode === undefined ? undefined : { mode: opts.mode });
    },
    async writeFileAtomic(target, data, opts) {
      const p = check(target, opts?.allow);
      const tmp = opts?.tmpPath !== undefined ? check(opts.tmpPath, opts.allow) : `${p}.${process.pid}.${++tmpSeq}.tmp`;
      try {
        await fsp.writeFile(tmp, data, opts?.mode === undefined ? undefined : { mode: opts.mode });
        await fsp.rename(tmp, p);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    },
    async appendLine(target, line, opts) {
      const p = check(target, opts?.allow);
      await fsp.appendFile(p, line + '\n', opts?.mode === undefined ? undefined : { mode: opts.mode });
    },
    async mkdirp(target, opts) {
      const p = check(target, opts?.allow);
      await fsp.mkdir(p, { recursive: true, ...(opts?.mode === undefined ? {} : { mode: opts.mode }) });
    },
    async rename(from, to, opts) {
      const a = check(from, opts?.allow);
      const b = check(to, opts?.allow);
      await fsp.rename(a, b);
    },
    async copyFile(from, to, opts) {
      const b = check(to, opts?.allow);
      await fsp.copyFile(path.resolve(from), b);
    },
    async rm(target, opts) {
      const p = check(target, opts?.allow);
      await fsp.rm(p, { recursive: opts?.recursive ?? false, force: opts?.force ?? false });
    },
    async chmodUserOnly(target, opts) {
      const p = check(target, opts?.allow);
      if (process.platform === 'win32') {
        const user = os.userInfo().username;
        const grant = (await fsp.stat(p)).isDirectory() ? `${user}:(OI)(CI)F` : `${user}:F`;
        await new Promise<void>((resolve, reject) => {
          execFile('icacls', [p, '/inheritance:r', '/grant:r', grant], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
        });
      } else {
        const st = await fsp.stat(p);
        await fsp.chmod(p, st.isDirectory() ? 0o700 : 0o600);
      }
    },
  };
}
