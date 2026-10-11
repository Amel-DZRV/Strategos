import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createGit, parseNameStatusZ, parseNumstatZ, parseStatusV2 } from './git.ts';
import { g, makeRepo, makeRepoWithRemote, write } from './git.testkit.ts';

vi.setConfig({ testTimeout: 60_000 }); // real git on Windows is slow (process start ~50 ms each)
const git = createGit();

describe('parseStatusV2', () => {
  it('reads branch, ahead/behind and counts', () => {
    const s = parseStatusV2([
      '# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a b src/a.txt', '1 M. N... 100644 100644 100644 a b x.txt', '? new.txt', '',
    ].join('\n'));
    expect(s).toMatchObject({ branch: 'feat', ahead: 2, behind: 1, dirty: true, staged: 1, unstaged: 1, untracked: 1 });
    expect(s.detached).toBeUndefined();
  });
  it('detached HEAD has no branch; a new branch has no ahead/behind', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toEqual({ detached: true, dirty: false, staged: 0, unstaged: 0, untracked: 0 });
    const n = parseStatusV2('# branch.oid abc\n# branch.head topic\n');
    expect(n.branch).toBe('topic');
    expect(n.ahead).toBeUndefined();
  });
  it('numstat and name-status with renames and binary files', () => {
    expect(parseNumstatZ('1\t2\ta.txt\0-\t-\tbin.png\0' + '3\t0\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'a.txt', add: 1, del: 2 }, { path: 'bin.png', add: 0, del: 0 }, { path: 'new.txt', add: 3, del: 0, from: 'old.txt' },
    ]);
    const ns = parseNameStatusZ('M\0a.txt\0A\0b.txt\0D\0c.txt\0R100\0old\0new\0');
    expect(ns.get('a.txt')).toBe('modified');
    expect(ns.get('b.txt')).toBe('added');
    expect(ns.get('c.txt')).toBe('deleted');
    expect(ns.get('new')).toBe('renamed');
  });
});

describe('status on real repositories', () => {
  it('clean repo on main without upstream', async () => {
    const repo = makeRepo();
    const s = await git.status(repo);
    expect(s).toMatchObject({ branch: 'main', dirty: false });
    expect(s.ahead).toBeUndefined();
  });

  it('a new branch with no upstream and commits has no ahead/behind; dirty is reported', async () => {
    const repo = makeRepo();
    g(repo, 'switch', '-q', '-c', 'feature');
    write(repo, 'src/b.txt', 'x\n');
    expect(await git.status(repo)).toMatchObject({ branch: 'feature', dirty: true, untracked: 1 });
    expect((await git.status(repo)).ahead).toBeUndefined();
  });

  it('detached HEAD', async () => {
    const repo = makeRepo();
    g(repo, 'checkout', '-q', '--detach');
    const s = await git.status(repo);
    expect(s.detached).toBe(true);
    expect(s.branch).toBeUndefined();
    expect(await git.currentBranch(repo)).toBeUndefined();
  });

  it('ahead and behind against a bare remote', async () => {
    const { repo, remote } = makeRepoWithRemote();
    write(repo, 'local.txt', 'l\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'local');
    expect(await git.status(repo)).toMatchObject({ branch: 'main', ahead: 1, behind: 0, dirty: false });
    // another clone pushes two commits
    const other = repo + '-other';
    g(repo, 'clone', '-q', remote, other);
    write(other, 'o1.txt', '1\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-q', '-m', 'o1');
    write(other, 'o2.txt', '2\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-q', '-m', 'o2');
    g(other, 'push', '-q');
    g(repo, 'fetch', '-q');
    expect(await git.status(repo)).toMatchObject({ ahead: 1, behind: 2 });
    expect(await git.upstream(repo)).toBe('origin/main');
  });

  it('commonDir of a linked worktree is the main .git', async () => {
    const repo = makeRepo();
    const wt = repo + '-wt';
    g(repo, 'worktree', 'add', '-q', '-b', 'w', wt);
    const a = await git.commonDir(wt);
    const b = await git.commonDir(repo);
    const tail = (p: string): string[] => p.toLowerCase().split(/[\\/]/).slice(-2); // the temp dir may differ in 8.3 short names
    expect(tail(a)).toEqual(tail(b));
    expect(a.toLowerCase().endsWith('.git')).toBe(true);
  });

  it('a folder that is not a repository is an error, not a crash', async () => {
    await expect(git.status(makeRepo() + '-missing')).rejects.toThrow();
  });
});

describe('diff against the merge-base', () => {
  it('lists committed, modified, deleted, renamed and untracked files with the unified text', async () => {
    const repo = makeRepo();
    g(repo, 'switch', '-q', '-c', 'feat');
    write(repo, 'src/a.txt', 'one\nTWO\nthree\nfour\n');
    write(repo, 'added.txt', 'a\nb\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'work');
    // main moves on: the diff must still be against the merge-base, not main's tip
    g(repo, 'switch', '-q', 'main');
    write(repo, 'main-only.txt', 'm\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'main moves');
    g(repo, 'switch', '-q', 'feat');
    g(repo, 'mv', 'README.md', 'README2.md');
    write(repo, 'untracked.txt', 'u1\nu2\nu3\n');

    const d = await git.diffVsBase(repo, 'main');
    expect(d.base).toBe('main');
    expect(d.head).toBe('feat');
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by['src/a.txt']).toMatchObject({ add: 2, del: 1, status: 'modified' });
    expect(by['added.txt']).toMatchObject({ add: 2, del: 0, status: 'added' });
    expect(by['README2.md']).toMatchObject({ status: 'renamed' });
    expect(by['untracked.txt']).toMatchObject({ add: 3, status: 'untracked' });
    expect(by['main-only.txt']).toBeUndefined();
    expect(d.diff).toContain('+TWO');
    expect(d.diff).toContain('+u1');
    expect(d.truncated).toBe(false);
    const st = await git.diffStat(repo, 'main');
    expect(st?.files).toBe(d.files.length);
  });

  it('caps the diff text and says so', async () => {
    const repo = makeRepo();
    g(repo, 'switch', '-q', '-c', 'big');
    write(repo, 'big.txt', Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'big');
    const d = await git.diffVsBase(repo, 'main', { maxBytes: 2000 });
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.diff)).toBeLessThanOrEqual(2000);
    expect(d.files[0]?.add).toBe(5000);
  });

  it('an unknown base is a clear error', async () => {
    const repo = makeRepo();
    await expect(git.diffVsBase(repo, 'nope')).rejects.toThrow(/does not exist/);
  });

  it('works in a repository with no commits (nothing to compare)', async () => {
    const dir = makeRepo() + '-empty';
    execFileSync('git', ['init', '-q', dir]);
    expect(await git.diffStat(dir)).toEqual({ files: 0, add: 0, del: 0 });
  });
});

describe('log and defaultBase', () => {
  it('reads commits in a range', async () => {
    const repo = makeRepo();
    g(repo, 'switch', '-q', '-c', 'feat');
    write(repo, 'x.txt', 'x\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'add x');
    const l = await git.log(repo, { range: 'main..HEAD' });
    expect(l.map((e) => e.subject)).toEqual(['add x']);
    expect(l[0]?.author).toBe('Test');
    expect(l[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.log(repo)).length).toBe(2);
  });
  it('defaultBase finds main', async () => {
    expect(await git.defaultBase(makeRepo())).toBe('main');
  });
});
