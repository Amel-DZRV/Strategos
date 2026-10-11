// Read-only git (plan 4.1 `Git`, task 6.01). Every call is `git -C <cwd> <args>` through exec.ts (argument arrays, D16).
// Writes to the repository live in worktrees.ts and gh.ts (push); this file only looks.
//
//   status       porcelain v2 --branch: branch, ahead, behind, dirty (right on a detached HEAD and on a new branch without upstream)
//   commonDir    canonical-free absolute git common dir (the planet key before canonicalisation)
//   mergeBase    fork point of HEAD and a base ref
//   diffVsBase   file list (add/del/status, untracked files included) and the unified diff against the merge-base, size-capped
//   diffStat     the same numbers without the text (cheap enough for the 15 s poll)
//   log          commits, optionally only those in a range
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { DiffData, GitStatus, ReviewFile } from '@strategos/shared';
import { defaultExec, type Exec, type ExecOptions, type ExecResult } from './exec.ts';

export class GitError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(args: readonly string[], r: ExecResult) {
    const detail = (r.stderr.trim() || r.stdout.trim() || r.spawnError || `exit ${r.code}`).split(/\r?\n/).slice(0, 4).join(' | ');
    super(`git ${args.slice(0, 3).join(' ')}: ${detail}`);
    this.name = 'GitError';
    this.code = r.code;
    this.stderr = r.stderr;
  }
}

export interface GitLogEntry { hash: string; author: string; at: number; subject: string }
export interface DiffOptions { maxBytes?: number }

export interface Git {
  /** Raw call; never throws. */
  run(cwd: string, args: readonly string[], o?: ExecOptions): Promise<ExecResult>;
  /** stdout, or a GitError on a non-zero exit. */
  out(cwd: string, args: readonly string[], o?: ExecOptions): Promise<string>;
  status(cwd: string): Promise<GitStatus>;
  commonDir(cwd: string): Promise<string>;
  /** The merge-base of `head` (default HEAD) and `base`; null when there is none or a ref is unknown. */
  mergeBase(cwd: string, base: string, head?: string): Promise<string | null>;
  /** Files and totals against the merge-base with `base` (or against HEAD when `base` is omitted). undefined: not a repository or nothing to compare. */
  diffStat(cwd: string, base?: string): Promise<{ files: number; add: number; del: number } | undefined>;
  diffVsBase(cwd: string, base: string, o?: DiffOptions): Promise<DiffData>;
  log(cwd: string, o?: { range?: string; max?: number }): Promise<GitLogEntry[]>;
  /** `origin/HEAD`, else `main`/`master` (local or origin). undefined when nothing fits. */
  defaultBase(cwd: string): Promise<string | undefined>;
  /** Short name of the current branch; undefined on a detached HEAD. */
  currentBranch(cwd: string): Promise<string | undefined>;
  /** `origin/feature` style name of the upstream of the current branch, or undefined. */
  upstream(cwd: string, branch?: string): Promise<string | undefined>;
  /** Does this ref name a commit? */
  refExists(cwd: string, ref: string): Promise<boolean>;
}

export const DEFAULT_DIFF_BYTES = 1_000_000;
const UNTRACKED_FILE_BYTES = 200_000;
const UNTRACKED_MAX_FILES = 200;

// ---------------------------------------------------------------------------
// pure parsers (unit-tested)
// ---------------------------------------------------------------------------

/** `git status --porcelain=v2 --branch` (without -z). */
export function parseStatusV2(text: string): GitStatus {
  let branch: string | undefined;
  let detached = false;
  let ahead: number | undefined;
  let behind: number | undefined;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      if (h === '(detached)') detached = true;
      else branch = h;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m !== null) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const xy = line.slice(2, 4);
      if (line[0] === 'u') {
        unstaged++; // an unmerged path counts as a working-tree change
      } else {
        if (xy[0] !== '.') staged++;
        if (xy[1] !== '.') unstaged++;
      }
    } else if (line.startsWith('? ')) {
      untracked++;
    }
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(detached ? { detached: true } : {}),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    dirty: staged + unstaged + untracked > 0, staged, unstaged, untracked,
  };
}

type FileStatus = ReviewFile['status'];

/** `git diff --numstat -z`: "add\tdel\tpath\0" or, for a rename, "add\tdel\t\0old\0new\0". Binary files show "-". */
export function parseNumstatZ(text: string): { path: string; add: number; del: number; from?: string }[] {
  const out: { path: string; add: number; del: number; from?: string }[] = [];
  const t = text.split('\0');
  for (let i = 0; i < t.length; i++) {
    const rec = t[i];
    if (rec === undefined || rec === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (m === null) continue;
    const add = m[1] === '-' ? 0 : Number(m[1]);
    const del = m[2] === '-' ? 0 : Number(m[2]);
    if (m[3] === '') {
      const from = t[i + 1];
      const to = t[i + 2];
      i += 2;
      if (from !== undefined && to !== undefined) out.push({ path: to, add, del, from });
    } else {
      out.push({ path: m[3] as string, add, del });
    }
  }
  return out;
}

/** `git diff --name-status -z`: "M\0path\0", "R100\0old\0new\0". */
export function parseNameStatusZ(text: string): Map<string, FileStatus> {
  const out = new Map<string, FileStatus>();
  const t = text.split('\0');
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (code === undefined || code === '') continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const to = t[i + 2];
      i += 2;
      if (to !== undefined) out.set(to, kind === 'R' ? 'renamed' : 'added');
    } else {
      const p = t[i + 1];
      i += 1;
      if (p === undefined) continue;
      out.set(p, kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : kind === 'M' || kind === 'T' ? 'modified' : 'other');
    }
  }
  return out;
}

export function sumFiles(files: readonly ReviewFile[]): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.add;
    del += f.del;
  }
  return { files: files.length, add, del };
}

function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { text: cut, truncated: true };
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

export function createGit(exec: Exec = defaultExec): Git {
  const run: Git['run'] = (cwd, args, o) => exec('git', ['-C', cwd, ...args], o);

  const out: Git['out'] = async (cwd, args, o) => {
    const r = await run(cwd, args, o);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout;
  };

  const refExists: Git['refExists'] = async (cwd, ref) => (await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;

  const currentBranch: Git['currentBranch'] = async (cwd) => {
    const r = await run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const name = r.stdout.trim();
    return r.code === 0 && name !== '' ? name : undefined;
  };

  const upstream: Git['upstream'] = async (cwd, branch) => {
    const spec = `${branch ?? ''}@{upstream}`;
    const r = await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', spec]);
    const name = r.stdout.trim();
    return r.code === 0 && name !== '' ? name : undefined;
  };

  const mergeBase: Git['mergeBase'] = async (cwd, base, head = 'HEAD') => {
    const r = await run(cwd, ['merge-base', head, base]);
    const sha = r.stdout.trim();
    return r.code === 0 && sha !== '' ? sha : null;
  };

  const defaultBase: Git['defaultBase'] = async (cwd) => {
    const r = await run(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const head = r.stdout.trim();
    if (r.code === 0 && head !== '' && (await refExists(cwd, head))) return head;
    for (const c of ['main', 'master', 'origin/main', 'origin/master']) if (await refExists(cwd, c)) return c;
    return undefined;
  };

  /** Untracked, not ignored files. Line counts only for small text files; the rest count as 0 lines. */
  async function untrackedFiles(cwd: string): Promise<{ file: ReviewFile; text?: string }[]> {
    const r = await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (r.code !== 0) return [];
    const names = r.stdout.split('\0').filter((n) => n !== '').slice(0, UNTRACKED_MAX_FILES);
    const res: { file: ReviewFile; text?: string }[] = [];
    for (const name of names) {
      let add = 0;
      let text: string | undefined;
      try {
        const abs = path.join(cwd, name);
        const st = await stat(abs);
        if (st.isFile() && st.size <= UNTRACKED_FILE_BYTES) {
          const buf = await readFile(abs);
          if (!buf.includes(0)) {
            text = buf.toString('utf8');
            add = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          }
        }
      } catch {
        /* vanished or unreadable: listed with 0 lines */
      }
      res.push({ file: { path: name, add, del: 0, status: 'untracked' }, ...(text === undefined ? {} : { text }) });
    }
    return res;
  }

  /** Tracked changes of the working tree against `from` (a commit), as a ReviewFile list. */
  async function trackedFiles(cwd: string, from: string): Promise<ReviewFile[]> {
    const [num, ns] = await Promise.all([
      run(cwd, ['diff', '--numstat', '-z', '--find-renames', from, '--']),
      run(cwd, ['diff', '--name-status', '-z', '--find-renames', from, '--']),
    ]);
    if (num.code !== 0) throw new GitError(['diff', '--numstat'], num);
    const statuses = ns.code === 0 ? parseNameStatusZ(ns.stdout) : new Map<string, FileStatus>();
    return parseNumstatZ(num.stdout).map((f) => ({ path: f.path, add: f.add, del: f.del, status: statuses.get(f.path) ?? 'modified' }));
  }

  async function compareFrom(cwd: string, base: string | undefined): Promise<{ from: string | undefined; baseLabel: string }> {
    if (base !== undefined) {
      const mb = await mergeBase(cwd, base);
      return { from: mb ?? undefined, baseLabel: base }; // no merge-base (unrelated histories or an unknown ref): nothing to compare
    }
    return { from: (await refExists(cwd, 'HEAD')) ? 'HEAD' : undefined, baseLabel: 'HEAD' };
  }

  return {
    run, out, refExists, currentBranch, upstream, mergeBase, defaultBase,

    async status(cwd) {
      const text = await out(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
      return parseStatusV2(text);
    },

    async commonDir(cwd) {
      const text = (await out(cwd, ['rev-parse', '--git-common-dir'])).trim();
      return path.resolve(cwd, text);
    },

    async diffStat(cwd, base) {
      try {
        const { from } = await compareFrom(cwd, base);
        const tracked = from === undefined ? [] : await trackedFiles(cwd, from);
        const untracked = (await untrackedFiles(cwd)).map((u) => u.file);
        return sumFiles([...tracked, ...untracked]);
      } catch {
        return undefined;
      }
    },

    async diffVsBase(cwd, base, o = {}) {
      const maxBytes = o.maxBytes ?? DEFAULT_DIFF_BYTES;
      const { from, baseLabel } = await compareFrom(cwd, base);
      if (from === undefined && !(await refExists(cwd, base))) throw new Error(`The base "${base}" does not exist in this repository.`);
      const branch = await currentBranch(cwd);
      const headR = await run(cwd, ['rev-parse', '--short', 'HEAD']);
      const head = branch ?? (headR.code === 0 ? headR.stdout.trim() : 'HEAD');
      const tracked = from === undefined ? [] : await trackedFiles(cwd, from);
      let diffText = '';
      if (from !== undefined && tracked.length > 0) {
        const d = await run(cwd, ['diff', '--no-color', '--find-renames', '--no-ext-diff', from, '--'], { maxBuffer: Math.max(maxBytes * 4, 8 * 1024 * 1024) });
        if (d.code === 0) diffText = d.stdout;
      }
      const untracked = await untrackedFiles(cwd);
      for (const u of untracked) {
        if (u.text === undefined || u.text === '') continue;
        const lines = u.text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        diffText += `diff --git a/${u.file.path} b/${u.file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${u.file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
      }
      const capped = capText(diffText, maxBytes);
      return { base: baseLabel, head, files: [...tracked, ...untracked.map((u) => u.file)], diff: capped.text, truncated: capped.truncated };
    },

    async log(cwd, o = {}) {
      const args = ['log', `--max-count=${o.max ?? 50}`, '--format=%H%x1f%an%x1f%ct%x1f%s%x1e'];
      if (o.range !== undefined) args.push(o.range);
      args.push('--');
      const r = await run(cwd, args);
      if (r.code !== 0) return [];
      return r.stdout.split('\x1e').map((e) => e.replace(/^\r?\n/, '')).filter((e) => e !== '').map((e) => {
        const [hash = '', author = '', at = '0', subject = ''] = e.split('\x1f');
        return { hash, author, at: Number(at) * 1000, subject };
      });
    },
  };
}
