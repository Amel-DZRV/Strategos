import { describe, expect, it } from 'vitest';
import type { PrInfo, SessionRecord } from '@strategos/shared';
import { GhError } from './gh.ts';
import { backoffDelay, createPrPoller, isCandidate, MAX_BACKOFF_MS } from './pr-poller.ts';

function rec(id: string, o: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schema: 1, strategosId: id, name: id, displayName: id, claudeSessionIds: ['c'], currentSessionId: 'c', transcriptOffset: 0,
    repoRoot: '/r', planetKey: '/r/.git', cwd: `/r/${id}`, branch: `b-${id}`, launch: { addDirs: [], extraArgs: [] },
    status: 'working', statusSource: 'hook', statusSince: 0, ringSlot: 0, ringSlotByGroup: {}, cost: { lineageUsd: 0, byClaudeSession: {} },
    flags: { conflicts: [], contractChanged: [], guardDenials: 0 }, subagents: [], createdAt: 0, updatedAt: 0, lastActivityAt: 0, archived: false, view: 'term', ...o,
  };
}

const PR: PrInfo = { number: 5, url: 'https://github.com/o/r/pull/5', state: 'OPEN', ci: 'pending' };

function rig(sessions: SessionRecord[], view: (cwd: string, branch: string) => Promise<PrInfo | null>) {
  const map = new Map(sessions.map((s) => [s.strategosId, s]));
  let t = 1_000_000;
  const login: boolean[] = [];
  const asked: string[] = [];
  const poller = createPrPoller({
    manager: {
      list: () => [...map.values()], get: (id) => map.get(id),
      update: (id, p) => { const s = map.get(id); if (s === undefined) return undefined; const n = { ...s, ...p }; map.set(id, n); return n; },
    },
    gh: { prView: (cwd, branch) => { asked.push(branch); return view(cwd, branch); } },
    onNeedsLogin: (v) => login.push(v),
    now: () => t,
  });
  return { poller, map, login, asked, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('who is polled', () => {
  it('open or draft pull requests, and pushed branches; not archived, merged, closed or unpushed ones', () => {
    expect(isCandidate(rec('a', { pr: { ...PR, at: 1 } }))).toBe(true);
    expect(isCandidate(rec('a', { pr: { ...PR, state: 'DRAFT', at: 1 } }))).toBe(true);
    expect(isCandidate(rec('a', { pr: { ...PR, state: 'MERGED', at: 1 } }))).toBe(false);
    expect(isCandidate(rec('a', { pr: { ...PR, state: 'CLOSED', at: 1 } }))).toBe(false);
    expect(isCandidate(rec('a', { git: { branch: 'x', ahead: 0, behind: 0, at: 1 } }))).toBe(true);
    expect(isCandidate(rec('a', { git: { branch: 'x', at: 1 } }))).toBe(false); // no upstream
    expect(isCandidate(rec('a'))).toBe(false);
    expect(isCandidate(rec('a', { archived: true, pr: { ...PR, at: 1 } }))).toBe(false);
  });
});

describe('polling', () => {
  it('writes pr {number,url,state,review,ci,at} and leaves unchanged data alone', async () => {
    const r = rig([rec('a', { pr: { ...PR, ci: 'pending', at: 1 } })], () => Promise.resolve({ ...PR, ci: 'pass', review: 'approved' }));
    await r.poller.tick();
    expect(r.map.get('a')?.pr).toEqual({ number: 5, url: PR.url, state: 'OPEN', review: 'approved', ci: 'pass', at: r.now() });
    const before = r.map.get('a');
    await r.poller.tick();
    expect(r.map.get('a')).toBe(before); // same answer: no new record, no extra session.upsert
  });

  it('a pushed branch without a PR stays quiet; the polled branch is the session branch', async () => {
    const r = rig([rec('a', { git: { branch: 'pushed', ahead: 0, behind: 0, at: 1 } })], () => Promise.resolve(null));
    await r.poller.tick();
    expect(r.map.get('a')?.pr).toBeUndefined();
    expect(r.asked).toEqual(['pushed']);
  });

  it('pollNow polls one session even without a PR yet (after pr.create)', async () => {
    const r = rig([rec('a')], () => Promise.resolve(PR));
    await r.poller.tick();
    expect(r.asked).toEqual([]);
    await r.poller.pollNow('a');
    expect(r.map.get('a')?.pr?.number).toBe(5);
  });
});

describe('backoff on rate limits (R14)', () => {
  it('delay doubles from 2 minutes and stops at 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffDelay(60_000, n))).toEqual([120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });

  it('a 403 stops the round, keeps the cached pr, waits, doubles on the next failure and resets after a good answer', async () => {
    let mode: 'rate' | 'ok' = 'rate';
    const r = rig([rec('a', { pr: { ...PR, at: 1 } }), rec('b', { pr: { ...PR, number: 6, at: 1 } })], () => (mode === 'rate' ? Promise.reject(new GhError('rate', 'HTTP 403')) : Promise.resolve({ ...PR, ci: 'pass' })));

    await r.poller.tick();
    expect(r.asked).toEqual(['b-a']); // the round stopped at the first failure
    expect(r.map.get('a')?.pr?.ci).toBe('pending'); // cached state kept
    expect(r.poller.status().consecutiveRateLimits).toBe(1);

    r.advance(60_000); // inside the 2 minute backoff: no call at all
    await r.poller.tick();
    expect(r.asked).toHaveLength(1);

    r.advance(60_001);
    await r.poller.tick();
    expect(r.asked).toHaveLength(2);
    expect(r.poller.status().consecutiveRateLimits).toBe(2);
    r.advance(239_000); // the second wait is 4 minutes
    await r.poller.tick();
    expect(r.asked).toHaveLength(2);

    mode = 'ok';
    r.advance(2_000);
    await r.poller.tick();
    expect(r.poller.status().consecutiveRateLimits).toBe(0);
    expect(r.map.get('a')?.pr?.ci).toBe('pass');
    expect(r.map.get('b')?.pr?.ci).toBe('pass');
  });

  it('429 several times in a row never waits longer than 15 minutes', async () => {
    const r = rig([rec('a', { pr: { ...PR, at: 1 } })], () => Promise.reject(new GhError('rate', 'HTTP 429')));
    for (let i = 0; i < 8; i++) {
      await r.poller.tick();
      r.advance(MAX_BACKOFF_MS + 1);
    }
    const s = r.poller.status();
    expect(s.consecutiveRateLimits).toBe(8);
    expect(s.nextPollAt - (r.now() - MAX_BACKOFF_MS - 1)).toBe(MAX_BACKOFF_MS);
  });
});

describe('gh needs login (R14)', () => {
  it('raises the flag once on an auth error, waits, and lowers it after a good answer', async () => {
    let mode: 'auth' | 'ok' = 'auth';
    const r = rig([rec('a', { pr: { ...PR, at: 1 } })], () => (mode === 'auth' ? Promise.reject(new GhError('auth', 'gh auth login')) : Promise.resolve(PR)));
    await r.poller.tick();
    r.advance(61_000);
    await r.poller.tick(); // still inside the retry wait
    expect(r.login).toEqual([true]);
    expect(r.asked).toHaveLength(1);
    mode = 'ok';
    r.advance(5 * 60_000);
    await r.poller.tick();
    expect(r.login).toEqual([true, false]);
    expect(r.poller.status().needsLogin).toBe(false);
  });

  it('gh not installed raises the same flag', async () => {
    const r = rig([rec('a', { pr: { ...PR, at: 1 } })], () => Promise.reject(new GhError('missing', 'ENOENT')));
    await r.poller.tick();
    expect(r.poller.status().needsLogin).toBe(true);
  });

  it('another kind of error skips that session only', async () => {
    const r = rig([rec('a', { pr: { ...PR, at: 1 } }), rec('b', { pr: { ...PR, number: 6, at: 1 } })], (_c, branch) => (branch === 'b-a' ? Promise.reject(new GhError('other', 'no remote')) : Promise.resolve({ ...PR, number: 6, ci: 'fail' })));
    await r.poller.tick();
    expect(r.asked).toEqual(['b-a', 'b-b']);
    expect(r.map.get('b')?.pr?.ci).toBe('fail');
    expect(r.poller.status().consecutiveRateLimits).toBe(0);
  });
});
