// gh and git are stubbed here: nothing in this file touches a network or a real repository.
import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from './exec.ts';
import { ciOf, classifyGhFailure, createGh, GhError, parsePrView } from './gh.ts';
import type { Git } from './git.ts';

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });
const bad = (stderr: string, code = 1): ExecResult => ({ stdout: '', stderr, code });

interface Call { file: string; args: string[]; cwd?: string; input?: string }

function stubs(opts: { upstream?: string; branch?: string | undefined; remote?: boolean; replies: (c: Call) => ExecResult }): { gh: ReturnType<typeof createGh>; calls: Call[]; gitCalls: string[][] } {
  const calls: Call[] = [];
  const gitCalls: string[][] = [];
  const exec: Exec = (file, args, o) => {
    const c: Call = { file, args: [...args], ...(o?.cwd === undefined ? {} : { cwd: o.cwd }), ...(o?.input === undefined ? {} : { input: o.input }) };
    calls.push(c);
    return Promise.resolve(opts.replies(c));
  };
  const git = {
    currentBranch: () => Promise.resolve('branch' in opts ? opts.branch : 'feat'),
    upstream: () => Promise.resolve(opts.upstream),
    run: (_cwd: string, args: readonly string[]) => {
      gitCalls.push([...args]);
      if (args[0] === 'remote') return Promise.resolve(opts.remote === false ? bad('no such remote') : ok('git@github.com:o/r.git'));
      return Promise.resolve(ok());
    },
  } as unknown as Git;
  return { gh: createGh({ git, exec }), calls, gitCalls };
}

const VIEW = (o: Record<string, unknown>): string => JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: '', statusCheckRollup: [], ...o });

describe('parsing gh output', () => {
  it('state: a draft is DRAFT, merged and closed win over the draft flag', () => {
    expect(parsePrView(VIEW({ isDraft: true })).state).toBe('DRAFT');
    expect(parsePrView(VIEW({})).state).toBe('OPEN');
    expect(parsePrView(VIEW({ state: 'MERGED', isDraft: true })).state).toBe('MERGED');
    expect(parsePrView(VIEW({ state: 'CLOSED' })).state).toBe('CLOSED');
  });
  it('review decision is lower-cased and absent when empty', () => {
    expect(parsePrView(VIEW({ reviewDecision: 'CHANGES_REQUESTED' })).review).toBe('changes_requested');
    expect(parsePrView(VIEW({})).review).toBeUndefined();
  });
  it('rejects output without a number or url', () => {
    expect(() => parsePrView('{}')).toThrow(GhError);
  });
  it('ci dot: none, pass, pending, fail (fail beats pending)', () => {
    const run = (status: string, conclusion: string): object => ({ __typename: 'CheckRun', status, conclusion });
    expect(ciOf([])).toBe('none');
    expect(ciOf(undefined)).toBe('none');
    expect(ciOf([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'NEUTRAL')])).toBe('pass');
    expect(ciOf([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')])).toBe('pending');
    expect(ciOf([run('QUEUED', '')])).toBe('pending');
    expect(ciOf([run('IN_PROGRESS', ''), run('COMPLETED', 'FAILURE')])).toBe('fail');
    expect(ciOf([run('COMPLETED', 'TIMED_OUT')])).toBe('fail');
    expect(ciOf([{ __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('pass');
    expect(ciOf([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending');
    expect(ciOf([{ __typename: 'StatusContext', state: 'FAILURE' }])).toBe('fail');
  });
  it('classifies failures', () => {
    expect(classifyGhFailure(bad('HTTP 403: API rate limit exceeded for user'))).toBe('rate');
    expect(classifyGhFailure(bad('HTTP 429: Too Many Requests'))).toBe('rate');
    expect(classifyGhFailure(bad('You are not logged into any GitHub hosts. To log in, run: gh auth login'))).toBe('auth');
    expect(classifyGhFailure(bad('HTTP 401: Bad credentials'))).toBe('auth');
    expect(classifyGhFailure({ stdout: '', stderr: '', code: -1, spawnError: 'ENOENT' })).toBe('missing');
    expect(classifyGhFailure(bad('something else'))).toBe('other');
  });
});

describe('prView', () => {
  it('asks for exactly the planned fields with an argument array in the session folder', async () => {
    const s = stubs({ replies: () => ok(VIEW({ isDraft: true, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] })) });
    const info = await s.gh.prView('C:/work/repo', 'feat/x');
    expect(info).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'DRAFT', ci: 'pass' });
    expect(s.calls).toEqual([{ file: 'gh', args: ['pr', 'view', 'feat/x', '--json', 'number,url,state,isDraft,reviewDecision,statusCheckRollup'], cwd: 'C:/work/repo' }]);
  });
  it('no pull request is null; rate limits and login problems are typed errors', async () => {
    expect(await stubs({ replies: () => bad('no pull requests found for branch "feat"') }).gh.prView('/r', 'feat')).toBeNull();
    await expect(stubs({ replies: () => bad('HTTP 403: rate limit') }).gh.prView('/r', 'f')).rejects.toMatchObject({ kind: 'rate' });
    await expect(stubs({ replies: () => bad('gh auth login') }).gh.prView('/r', 'f')).rejects.toMatchObject({ kind: 'auth' });
  });
  it('authStatus is the read-only gh auth status', async () => {
    const s = stubs({ replies: () => ok() });
    expect((await s.gh.authStatus()).ok).toBe(true);
    expect(s.calls[0]?.args).toEqual(['auth', 'status']);
  });
});

describe('prCreate', () => {
  const create = (c: Call): ExecResult => {
    if (c.args[1] === 'view') return bad('no pull requests found for branch "feat"');
    return ok('Creating draft pull request for feat into main in o/r\nhttps://github.com/o/r/pull/42\n');
  };

  it('pushes first when the branch has no upstream, then creates a draft pull request', async () => {
    const s = stubs({ replies: create });
    const r = await s.gh.prCreate({ cwd: '/r', title: 'T', body: 'B', draft: true });
    expect(r).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42', existing: false, pushed: true });
    expect(s.gitCalls).toContainEqual(['push', '-u', 'origin', 'feat']);
    const c = s.calls.find((x) => x.args[1] === 'create');
    expect(c?.args).toEqual(['pr', 'create', '--draft', '--title', 'T', '--body', 'B', '--head', 'feat']);
    expect(c?.cwd).toBe('/r');
  });

  it('does not push a branch that already has an upstream; a non-draft omits --draft; base is passed', async () => {
    const s = stubs({ upstream: 'origin/feat', replies: create });
    const r = await s.gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: false, base: 'develop' });
    expect(r.pushed).toBe(false);
    expect(s.gitCalls.some((a) => a[0] === 'push')).toBe(false);
    expect(s.calls.find((x) => x.args[1] === 'create')?.args).toEqual(['pr', 'create', '--title', 'T', '--body', '', '--head', 'feat', '--base', 'develop']);
  });

  it('a huge body goes over stdin, not the command line', async () => {
    const s = stubs({ upstream: 'origin/feat', replies: create });
    const body = 'x'.repeat(25_000);
    await s.gh.prCreate({ cwd: '/r', title: 'T', body, draft: true });
    const c = s.calls.find((x) => x.args[1] === 'create');
    expect(c?.args).toContain('--body-file');
    expect(c?.args).not.toContain(body);
    expect(c?.input).toBe(body);
  });

  it('returns the open pull request that already exists instead of creating another', async () => {
    const s = stubs({ replies: (c) => (c.args[1] === 'view' ? ok(VIEW({ number: 9, url: 'https://github.com/o/r/pull/9' })) : ok('should not be called')) });
    expect(await s.gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: true })).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9', existing: true, pushed: false });
    expect(s.calls.some((c) => c.args[1] === 'create')).toBe(false);
    expect(s.gitCalls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('refuses an empty title, a detached HEAD, a dash-led branch and a missing origin', async () => {
    await expect(stubs({ replies: create }).gh.prCreate({ cwd: '/r', title: '  ', body: '', draft: true })).rejects.toThrow(/title/);
    await expect(stubs({ branch: undefined, replies: create }).gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: true })).rejects.toThrow(/detached/);
    await expect(stubs({ replies: create }).gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: true, head: '--evil' })).rejects.toThrow(/not a valid branch/);
    await expect(stubs({ remote: false, replies: create }).gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: true })).rejects.toThrow(/origin/);
  });

  it('typed errors from gh pr create', async () => {
    const s = stubs({ upstream: 'origin/feat', replies: (c) => (c.args[1] === 'view' ? bad('no pull requests found') : bad('HTTP 403: Resource not accessible')) });
    await expect(s.gh.prCreate({ cwd: '/r', title: 'T', body: '', draft: true })).rejects.toMatchObject({ kind: 'rate' });
  });
});
