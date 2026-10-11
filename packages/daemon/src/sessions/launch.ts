// Everything needed to launch a Claude process, as pure functions plus two small read-only probes (git, the owner's
// status line). The session manager (manager.ts) owns the process; this file owns the command line and the environment.
//
// Launch flags (plan section 5 "Launch flags", [ran] S19): every launch and every resume passes --session-id or --resume,
// --settings <file>, --name and --permission-mode <mode, default 'default'>. Without the permission-mode flag this
// account starts in auto mode and the Approve flow would never see a request.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SessionRecord } from '@strategos/shared';
import { scrubEnv } from '../pty/pty-host.ts';

export const DEFAULT_PERMISSION_MODE = 'default';

export interface LaunchArgsInput {
  /** `--session-id` for a new conversation, `--resume` for a returning one. */
  mode: { kind: 'new'; claudeSessionId: string } | { kind: 'resume'; claudeSessionId: string };
  settingsPath: string;
  name: string;
  launch: SessionRecord['launch'];
}

/** The arguments after the executable. Arrays only: nothing here is ever joined into a shell string (D16). */
export function buildLaunchArgs(i: LaunchArgsInput): string[] {
  const args: string[] = [i.mode.kind === 'new' ? '--session-id' : '--resume', i.mode.claudeSessionId];
  args.push('--settings', i.settingsPath, '--name', i.name);
  args.push('--permission-mode', i.launch.permissionMode ?? DEFAULT_PERMISSION_MODE);
  if (i.launch.model !== undefined && i.launch.model !== '') args.push('--model', i.launch.model);
  for (const d of i.launch.addDirs) args.push('--add-dir', d);
  args.push(...i.launch.extraArgs);
  return args;
}

export interface LaunchEnvInput {
  /** Usually process.env. */
  source: Readonly<Record<string, string | undefined>>;
  keep?: readonly string[];
  set?: Readonly<Record<string, string>>;
  hookToken: string;
  port: number;
  /** The owner's original statusLine command (read-only from their settings), chained by the tap. */
  chainStatusLine?: string;
}

/** Scrubbed env (ANTHROPIC_*, CLAUDE_CODE_*, ... dropped; CLAUDE_CONFIG_DIR kept) plus the per-session secrets. */
export function buildLaunchEnv(i: LaunchEnvInput): Record<string, string> {
  const env = scrubEnv(i.source, { keep: i.keep ?? [], set: i.set ?? {} });
  env['STRATEGOS_HOOK_TOKEN'] = i.hookToken;
  env['STRATEGOS_PORT'] = String(i.port);
  delete env['STRATEGOS_CHAIN_STATUSLINE'];
  if (i.chainStatusLine !== undefined && i.chainStatusLine !== '') env['STRATEGOS_CHAIN_STATUSLINE'] = i.chainStatusLine;
  return env;
}

/**
 * The owner's own `statusLine.command` from `<claude config dir>/settings.json`, READ ONLY (never written, never
 * "fixed"). Undefined when the file, the key or a command-type status line is missing.
 */
export function readOwnerStatusLine(claudeConfigDir: string): string | undefined {
  try {
    const text = readFileSync(path.join(claudeConfigDir, 'settings.json'), 'utf8');
    const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as { statusLine?: { type?: unknown; command?: unknown } };
    const sl = j.statusLine;
    if (sl !== undefined && sl !== null && (sl.type === undefined || sl.type === 'command') && typeof sl.command === 'string' && sl.command.trim() !== '') {
      return sl.command;
    }
  } catch {
    /* no settings, unreadable or not JSON: nothing to chain */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export interface RepoInfo {
  /** canonical(git common dir), or canonical(cwd) when the folder is not in a repository. */
  planetKey: string;
  /** The main checkout (the common dir's parent), or the folder itself. */
  repoRoot: string;
  branch?: string;
  isRepo: boolean;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

/** `git` with an argument array (D16). null on any failure: a missing git or a non-repo folder is not an error here. */
export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });

/** planetKey = canonical(`git rev-parse --git-common-dir`) so every worktree of one repo shares a planet (D10, task 1.10). */
export async function resolveRepo(cwd: string, canonical: (p: string) => string, git: GitRunner = runGit): Promise<RepoInfo> {
  const out = await git(cwd, ['rev-parse', '--git-common-dir', '--show-toplevel']);
  const lines = out === null ? [] : out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const common = lines[0];
  if (common === undefined) return { planetKey: canonical(cwd), repoRoot: cwd, isRepo: false };
  const commonAbs = canonical(path.resolve(cwd, common)); // relative to cwd when it is just ".git"
  const top = lines[1] !== undefined ? canonical(path.resolve(cwd, lines[1])) : undefined;
  const repoRoot = path.basename(commonAbs).toLowerCase() === '.git' ? path.dirname(commonAbs) : (top ?? path.dirname(commonAbs));
  const branchOut = await git(cwd, ['branch', '--show-current']);
  const branch = branchOut?.trim();
  return { planetKey: commonAbs, repoRoot, ...(branch ? { branch } : {}), isRepo: true };
}

// ---------------------------------------------------------------------------
// ring slots and planets
// ---------------------------------------------------------------------------

/** Lowest free slot among the sessions that already sit on this group (planet or initiative). Sticky: a record keeps its own. */
export function assignRingSlot(others: readonly Pick<SessionRecord, 'strategosId' | 'ringSlotByGroup'>[], group: string, selfId: string): number {
  const used = new Set<number>();
  for (const o of others) {
    if (o.strategosId === selfId) continue;
    const slot = o.ringSlotByGroup[group];
    if (slot !== undefined) used.add(slot);
  }
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/** Label of a planet: the repo folder's name. */
export function planetLabel(planetKey: string): string {
  const base = path.basename(planetKey);
  const name = base.toLowerCase() === '.git' ? path.basename(path.dirname(planetKey)) : base.replace(/\.git$/i, '');
  return name === '' ? planetKey : name;
}

/** A stable colour from the key (FNV-1a hash -> hue). */
export function planetColour(planetKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < planetKey.length; i++) {
    h ^= planetKey.toLowerCase().charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return hslToHex(h % 360, 55, 58);
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The n-th cell of an outward square spiral from (0,0): (0,0), (1,0), (1,1), (0,1), (-1,1), (-1,0), ... A placeholder layout. */
export function spiralCell(n: number): { col: number; row: number } {
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let segment = 1;
  let passed = 0;
  let turns = 0;
  for (let i = 0; i < n; i++) {
    x += dx;
    y += dy;
    passed++;
    if (passed === segment) {
      passed = 0;
      [dx, dy] = [-dy, dx];
      turns++;
      if (turns % 2 === 0) segment++;
    }
  }
  return { col: x, row: y };
}
