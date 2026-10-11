import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mkTmp } from '../../../../tools/tmp-fs.ts';
import { createSafeFs, type SafeFs } from '../safe-fs.ts';
import { createGit } from './git.ts';
import { g, makeRepo, makeRepoWithRemote, write } from './git.testkit.ts';
import { createWorktrees, EXCLUDE_LINE, WorktreeError } from './worktrees.ts';

vi.setConfig({ testTimeout: 90_000 });

function rig(): { wt: ReturnType<typeof createWorktrees>; writes: string[] } {
  const base = createSafeFs({ claudeDir: path.join(mkTmp('strategos-claude-'), '.claude'), roots: [mkTmp('strategos-home-')] });
  const writes: string[] = [];
  const fs = new Proxy(base, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if (typeof v !== 'function' || p === 'check') return v;
      return (...a: unknown[]) => { if (typeof a[0] === 'string') writes.push(a[0]); return (v as (...x: unknown[]) => unknown).apply(t, a); };
    },
  }) as SafeFs;
  return { wt: createWorktrees({ git: createGit(), safeFs: fs }), writes };
}

const fail = async (p: Promise<unknown>): Promise<WorktreeError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WorktreeError);
    return e as WorktreeError;
  }
  throw new Error('expected a WorktreeError');
};

describe('creating', () => {
  it('defaultPath follows D17 and rejects names that are not one safe folder name', () => {
    const { wt } = rig();
    expect(wt.defaultPath('/r', 'feat-1')).toBe(path.join('/r', '.claude', 'worktrees', 'feat-1'));
    for (const bad of ['', '..', 'a/b', 'a\\b', '-x', '.hidden', 'a..b', 'x'.repeat(101)]) expect(() => wt.defaultPath('/r', bad), bad).toThrow(WorktreeError);
  });

  it('adds a worktree on a new branch from the base and leaves the exclude file alone by default', async () => {
    const { wt, writes } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'one');
    const r = await wt.worktreeAdd(repo, p, 'feat/one', 'main');
    expect(r).toMatchObject({ branch: 'feat/one', base: 'main', excludeAdded: false });
    expect(existsSync(path.join(p, 'README.md'))).toBe(true);
    expect(g(p, 'branch', '--show-current').trim()).toBe('feat/one');
    expect(writes).toEqual([]);
    expect(await wt.isExcluded(repo)).toBe(false);
    expect((await wt.list(repo)).map((w) => w.branch)).toEqual(['main', 'feat/one']);
  });

  it('addExclude writes .claude/worktrees/ to .git/info/exclude once, through safe-fs, inside .git/info only', async () => {
    const { wt, writes } = rig();
    const repo = makeRepo();
    const a = await wt.worktreeAdd(repo, wt.defaultPath(repo, 'a'), 'a', 'main', { addExclude: true });
    expect(a.excludeAdded).toBe(true);
    const b = await wt.worktreeAdd(repo, wt.defaultPath(repo, 'b'), 'b', 'main', { addExclude: true });
    expect(b.excludeAdded).toBe(false);
    const text = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(text.split(/\r?\n/).filter((l) => l === EXCLUDE_LINE)).toHaveLength(1);
    expect(await wt.isExcluded(repo)).toBe(true);
    expect(g(repo, 'status', '--porcelain').trim()).toBe(''); // the worktrees no longer show as untracked
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(path.resolve(w).toLowerCase()).toContain(path.join('.git', 'info').toLowerCase());
  });

  it('addExclude is ignored for a worktree outside <repo>/.claude/worktrees', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const r = await wt.worktreeAdd(repo, repo + '-sibling', 's', 'main', { addExclude: true });
    expect(r.excludeAdded).toBe(false);
  });

  it('refuses an existing branch, a missing base, a bad name and an existing folder', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    g(repo, 'branch', 'taken');
    expect((await fail(wt.worktreeAdd(repo, wt.defaultPath(repo, 'x'), 'taken', 'main'))).code).toBe('exists');
    expect((await fail(wt.worktreeAdd(repo, wt.defaultPath(repo, 'x'), 'new', 'nope'))).code).toBe('missing_base');
    expect((await fail(wt.worktreeAdd(repo, wt.defaultPath(repo, 'x'), 'bad name', 'main'))).code).toBe('invalid');
    expect((await fail(wt.worktreeAdd(repo, wt.defaultPath(repo, 'x'), '-rf', 'main'))).code).toBe('invalid');
    await wt.worktreeAdd(repo, wt.defaultPath(repo, 'y'), 'y', 'main');
    expect((await fail(wt.worktreeAdd(repo, wt.defaultPath(repo, 'y'), 'y2', 'main'))).code).toBe('exists');
  });
});

describe('removing', () => {
  it('a clean worktree with nothing unique is removed without confirmation and the branch is kept', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'clean');
    await wt.worktreeAdd(repo, p, 'clean', 'main');
    const r = await wt.worktreeRemoveSafe(p, { deleteBranch: false });
    expect(r.branchDeleted).toBe(false);
    expect(existsSync(p)).toBe(false);
    expect(g(repo, 'branch', '--list', 'clean').trim()).toContain('clean');
  });

  it('deleting the branch always needs the typed branch name', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'del');
    await wt.worktreeAdd(repo, p, 'del-me', 'main');
    const e = await fail(wt.worktreeRemoveSafe(p, { deleteBranch: true }));
    expect(e.code).toBe('needs_confirmation');
    expect(e.message).toContain('del-me');
    expect(existsSync(p)).toBe(true);
    expect((await fail(wt.worktreeRemoveSafe(p, { deleteBranch: true, confirmText: 'main' }))).code).toBe('needs_confirmation');
    expect(existsSync(p)).toBe(true);
    const ok = await wt.worktreeRemoveSafe(p, { deleteBranch: true, confirmText: 'del-me' });
    expect(ok.branchDeleted).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(g(repo, 'branch', '--list', 'del-me').trim()).toBe('');
  });

  it('uncommitted and untracked work blocks removal until the branch name is typed; the error lists the files', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'dirty');
    await wt.worktreeAdd(repo, p, 'dirty', 'main');
    write(p, 'src/a.txt', 'changed\n');
    write(p, 'new-file.txt', 'n\n');
    const e = await fail(wt.worktreeRemoveSafe(p, { deleteBranch: false }));
    expect(e.code).toBe('needs_confirmation');
    expect(e.lost?.dirty.join('\n')).toContain('new-file.txt');
    expect(e.lost?.dirty.join('\n')).toContain('src/a.txt');
    expect(e.lost?.confirmText).toBe('dirty');
    expect(e.message).toMatch(/2 uncommitted/);
    expect(existsSync(p)).toBe(true);
    await wt.worktreeRemoveSafe(p, { deleteBranch: false, confirmText: 'dirty' });
    expect(existsSync(p)).toBe(false);
  });

  it('commits that were never pushed (no upstream) block removal and are listed', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'u');
    await wt.worktreeAdd(repo, p, 'u', 'main');
    write(p, 'work.txt', 'w\n');
    g(p, 'add', '-A');
    g(p, 'commit', '-q', '-m', 'precious work');
    const info = await wt.inspect(p);
    expect(info).toMatchObject({ hasUpstream: false, unpushedCount: 1, dirtyCount: 0 });
    const e = await fail(wt.worktreeRemoveSafe(p, { deleteBranch: false }));
    expect(e.message).toContain('precious work');
    expect(e.message).toContain('never pushed');
    expect(existsSync(p)).toBe(true);
    await wt.worktreeRemoveSafe(p, { deleteBranch: true, confirmText: 'u' });
    expect(existsSync(p)).toBe(false);
  });

  it('a pushed branch is not "unpushed", a commit ahead of its upstream is', async () => {
    const { wt } = rig();
    const { repo } = makeRepoWithRemote();
    const p = wt.defaultPath(repo, 'p');
    await wt.worktreeAdd(repo, p, 'p', 'main');
    write(p, 'a.txt', 'a\n');
    g(p, 'add', '-A');
    g(p, 'commit', '-q', '-m', 'first');
    g(p, 'push', '-q', '-u', 'origin', 'p'); // to the temp bare remote
    expect(await wt.inspect(p)).toMatchObject({ hasUpstream: true, unpushedCount: 0 });
    write(p, 'b.txt', 'b\n');
    g(p, 'add', '-A');
    g(p, 'commit', '-q', '-m', 'second');
    const info = await wt.inspect(p);
    expect(info).toMatchObject({ hasUpstream: true, unpushedCount: 1, unpushed: ['second'] });
    expect((await fail(wt.worktreeRemoveSafe(p, { deleteBranch: false }))).code).toBe('needs_confirmation');
    g(p, 'push', '-q');
    await wt.worktreeRemoveSafe(p, { deleteBranch: false }); // nothing to lose now
    expect(existsSync(p)).toBe(false);
  });

  it('a detached HEAD asks for the folder name', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    const p = wt.defaultPath(repo, 'det');
    await wt.worktreeAdd(repo, p, 'det', 'main');
    g(p, 'checkout', '-q', '--detach');
    write(p, 'x.txt', 'x\n');
    const e = await fail(wt.worktreeRemoveSafe(p, { deleteBranch: false }));
    expect(e.lost?.confirmText).toBe('det');
    await wt.worktreeRemoveSafe(p, { deleteBranch: false, confirmText: 'det' });
    expect(existsSync(p)).toBe(false);
  });

  it('never removes the main checkout or a folder that is not a worktree', async () => {
    const { wt } = rig();
    const repo = makeRepo();
    expect((await fail(wt.worktreeRemoveSafe(repo, { deleteBranch: false, confirmText: 'main' }))).code).toBe('not_a_worktree');
    expect((await fail(wt.worktreeRemoveSafe(path.join(repo, 'src'), { deleteBranch: false }))).code).toBe('not_a_worktree');
    expect((await fail(wt.worktreeRemoveSafe(path.join(repo, 'missing'), { deleteBranch: false }))).code).toBe('not_a_worktree');
    expect(existsSync(path.join(repo, 'README.md'))).toBe(true);
  });
});
