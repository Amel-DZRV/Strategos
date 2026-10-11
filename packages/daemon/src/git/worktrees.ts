// Worktrees (plan D17, task 6.02). Creating and removing linked worktrees with git, and the two guards around them:
//
//   * `.claude/worktrees/` is added to `.git/info/exclude` only when the caller says so (`addExclude`, after the person
//     agreed). The write goes through safe-fs with `.git/info` allowlisted for that one call.
//   * Removing never loses work silently. A dirty tree, commits that exist nowhere else, or a branch deletion all need
//     `confirmText` to equal the branch name (the worktree folder name on a detached HEAD). Without it the call fails
//     and the error lists exactly what would be lost.
//
// TODO(6.02): optional setup commands (npm install etc.) after creation; skipped for now.
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SafeFs } from '../safe-fs.ts';
import { GitError, type Git } from './git.ts';

export const EXCLUDE_LINE = '.claude/worktrees/';

export class WorktreeError extends Error {
  readonly code: 'invalid' | 'exists' | 'missing_base' | 'not_a_worktree' | 'needs_confirmation' | 'git';
  /** For needs_confirmation: what would be lost, and the text the person has to type. */
  readonly lost?: WorktreeLoss;
  constructor(code: WorktreeError['code'], message: string, lost?: WorktreeLoss) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    if (lost !== undefined) this.lost = lost;
  }
}

export interface WorktreeLoss {
  confirmText: string;
  dirty: string[];
  unpushed: string[];
  deletesBranch: boolean;
}

export interface WorktreeInspection {
  branch?: string;
  hasUpstream: boolean;
  /** `git status --porcelain` lines: changed, staged and untracked files (up to 50). */
  dirty: string[];
  dirtyCount: number;
  /** Commits that exist only on this branch: ahead of its upstream, or on no other branch/remote when it has none (up to 50 subjects). */
  unpushed: string[];
  unpushedCount: number;
}

export interface AddOptions {
  /** Add `.claude/worktrees/` to the repository's .git/info/exclude. Only pass true after the person agreed. */
  addExclude?: boolean;
}

export interface Worktrees {
  /** `<repo>/<worktreeRoot>/<name>` (D17). Throws WorktreeError('invalid') for a name that is not one safe folder name. */
  defaultPath(repo: string, name: string, worktreeRoot?: string): string;
  worktreeAdd(repo: string, wtPath: string, branch: string, base: string, o?: AddOptions): Promise<{ path: string; branch: string; base: string; excludeAdded: boolean }>;
  inspect(wtPath: string): Promise<WorktreeInspection>;
  worktreeRemoveSafe(wtPath: string, o: { deleteBranch: boolean; confirmText?: string }): Promise<{ removed: string; branchDeleted: boolean }>;
  /** Is `.claude/worktrees/` ignored in this repository (exclude file or .gitignore)? */
  isExcluded(repo: string): Promise<boolean>;
  addExclude(repo: string): Promise<boolean>;
  list(repo: string): Promise<{ path: string; branch?: string; main: boolean }[]>;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const same = (a: string, b: string): boolean => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export function createWorktrees(deps: { git: Git; safeFs: SafeFs }): Worktrees {
  const { git, safeFs } = deps;

  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof GitError) throw new WorktreeError('git', err.message);
      throw err;
    }
  };

  async function list(repo: string): Promise<{ path: string; branch?: string; main: boolean }[]> {
    const text = await wrap(git.out(repo, ['worktree', 'list', '--porcelain']));
    const out: { path: string; branch?: string; main: boolean }[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      let p: string | undefined;
      let branch: string | undefined;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) p = line.slice('worktree '.length);
        else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
      }
      if (p !== undefined) out.push({ path: path.resolve(p), ...(branch === undefined ? {} : { branch }), main: out.length === 0 });
    }
    return out;
  }

  async function excludeFile(repo: string): Promise<string> {
    const p = (await wrap(git.out(repo, ['rev-parse', '--git-path', 'info/exclude']))).trim();
    return path.resolve(repo, p);
  }

  async function isExcluded(repo: string): Promise<boolean> {
    // `check-ignore` knows .gitignore, the global ignore file and info/exclude. A trailing slash makes the probe a directory.
    const r = await git.run(repo, ['check-ignore', '-q', '--', `${EXCLUDE_LINE}probe/`]);
    if (r.code === 0) return true;
    try {
      const text = await readFile(await excludeFile(repo), 'utf8');
      return text.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE || l.trim() === `/${EXCLUDE_LINE}`);
    } catch {
      return false;
    }
  }

  async function addExclude(repo: string): Promise<boolean> {
    if (await isExcluded(repo)) return false;
    const file = await excludeFile(repo);
    const dir = path.dirname(file);
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      /* no exclude file yet */
    }
    const next = `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`;
    await safeFs.mkdirp(dir, { allow: [dir] });
    await safeFs.writeFileAtomic(file, next, { allow: [dir] });
    return true;
  }

  async function inspect(wtPath: string): Promise<WorktreeInspection> {
    const branch = await git.currentBranch(wtPath);
    const st = await wrap(git.out(wtPath, ['status', '--porcelain', '--untracked-files=all']));
    const dirtyAll = st.split(/\r?\n/).filter((l) => l !== '');
    const upstream = branch === undefined ? undefined : await git.upstream(wtPath, branch);
    let subjects: string[];
    if (upstream !== undefined) {
      const r = await git.log(wtPath, { range: `${upstream}..HEAD`, max: 1000 });
      subjects = r.map((e) => e.subject);
    } else {
      // Commits reachable from HEAD but from no other branch and no remote branch: they exist nowhere else.
      const args = ['log', '--format=%s', '--max-count=1000', 'HEAD', '--not'];
      if (branch !== undefined) args.push(`--exclude=${branch}` /* relative to refs/heads/ for --branches */);
      args.push('--branches', '--remotes', '--');
      const r = await git.run(wtPath, args);
      subjects = r.code === 0 ? r.stdout.split(/\r?\n/).filter((l) => l !== '') : [];
    }
    return {
      ...(branch === undefined ? {} : { branch }), hasUpstream: upstream !== undefined,
      dirty: dirtyAll.slice(0, 50), dirtyCount: dirtyAll.length, unpushed: subjects.slice(0, 50), unpushedCount: subjects.length,
    };
  }

  return {
    list, isExcluded, addExclude, inspect,

    defaultPath(repo, name, worktreeRoot = path.join('.claude', 'worktrees')) {
      if (!SAFE_NAME.test(name) || name.endsWith('.') || name.includes('..')) {
        throw new WorktreeError('invalid', `"${name}" is not a usable folder name. Use letters, digits, dots, dashes and underscores.`);
      }
      return path.join(repo, worktreeRoot, name);
    },

    async worktreeAdd(repo, wtPath, branch, base, o = {}) {
      if (branch === '' || branch.startsWith('-') || (await git.run(repo, ['check-ref-format', '--branch', branch])).code !== 0) {
        throw new WorktreeError('invalid', `"${branch}" is not a valid branch name.`);
      }
      if (base === '' || base.startsWith('-')) throw new WorktreeError('invalid', `"${base}" is not a valid base.`);
      if (!(await git.refExists(repo, base))) throw new WorktreeError('missing_base', `The base "${base}" does not exist in this repository.`);
      if ((await git.run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
        throw new WorktreeError('exists', `The branch "${branch}" already exists. Pick another branch name.`);
      }
      const target = path.resolve(wtPath);
      const taken = await stat(target).then(() => true, () => false);
      if (taken) throw new WorktreeError('exists', `The folder already exists: ${target}`);

      let excludeAdded = false;
      const roots = [path.resolve(repo), real(repo)].map((r) => path.join(r, '.claude', 'worktrees'));
      if (o.addExclude === true && roots.some((r) => isInside(target, r))) {
        excludeAdded = await addExclude(repo);
      }
      await wrap(git.out(repo, ['worktree', 'add', '-b', branch, target, base]));
      return { path: target, branch, base, excludeAdded };
    },

    async worktreeRemoveSafe(wtPath, o) {
      const target = real(wtPath);
      const exists = await stat(target).then((s) => s.isDirectory(), () => false);
      if (!exists) throw new WorktreeError('not_a_worktree', `The folder does not exist: ${wtPath}`);
      const common = await wrap(git.commonDir(target));
      const mainDir = path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : common;
      const all = await list(mainDir);
      let entry: { path: string; branch?: string; main: boolean } | undefined;
      for (const w of all) if (same(real(w.path), target)) entry = w;
      if (entry === undefined) throw new WorktreeError('not_a_worktree', `${wtPath} is not a worktree of ${mainDir}.`);
      if (entry.main) throw new WorktreeError('not_a_worktree', 'That is the main checkout of the repository, not a linked worktree. It is never removed.');

      const info = await inspect(target);
      const confirmText = info.branch ?? path.basename(target);
      const needsConfirm = info.dirtyCount > 0 || info.unpushedCount > 0 || (o.deleteBranch && info.branch !== undefined);
      if (needsConfirm && o.confirmText !== confirmText) {
        const lost: WorktreeLoss = { confirmText, dirty: info.dirty, unpushed: info.unpushed, deletesBranch: o.deleteBranch && info.branch !== undefined };
        const parts: string[] = [];
        if (info.dirtyCount > 0) parts.push(`${info.dirtyCount} uncommitted change(s): ${info.dirty.slice(0, 5).map((l) => l.trim()).join('; ')}${info.dirtyCount > 5 ? '; ...' : ''}`);
        if (info.unpushedCount > 0) parts.push(`${info.unpushedCount} commit(s) that exist nowhere else${info.hasUpstream ? ' (not pushed)' : ' (the branch was never pushed)'}: ${info.unpushed.slice(0, 5).join('; ')}${info.unpushedCount > 5 ? '; ...' : ''}`);
        if (lost.deletesBranch) parts.push(`the branch ${confirmText} would be deleted`);
        throw new WorktreeError('needs_confirmation', `Not removed. This would lose: ${parts.join(' | ')}. To go ahead, type "${confirmText}" to confirm.`, lost);
      }

      // Run from the main checkout: a process cannot remove the folder it is standing in (Windows).
      await wrap(git.out(mainDir, ['worktree', 'remove', ...(info.dirtyCount > 0 ? ['--force'] : []), target]));
      let branchDeleted = false;
      if (o.deleteBranch && info.branch !== undefined) {
        await wrap(git.out(mainDir, ['branch', '-D', info.branch]));
        branchDeleted = true;
      }
      return { removed: target, branchDeleted };
    },
  };
}
