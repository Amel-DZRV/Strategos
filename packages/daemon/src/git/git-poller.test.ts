import { describe, expect, it } from 'vitest';
import type { GitStatus, SessionRecord } from '@strategos/shared';
import { createGitPoller } from './git-poller.ts';

function rec(id: string, o: Partial<SessionRecord> = {}): SessionRecord {
  return {
    strategosId: id, cwd: `/r/${id}`, branch: 'main', pty: { pid: 1, cols: 80, rows: 24, dirtyInput: false }, launch: { addDirs: [], extraArgs: [] }, ...o,
  } as SessionRecord;
}

function rig(sessions: SessionRecord[], status: (cwd: string) => Promise<GitStatus>, stat: () => Promise<{ files: number; add: number; del: number } | undefined> = () => Promise.resolve(undefined)) {
  const map = new Map(sessions.map((s) => [s.strategosId, s]));
  const updates: { id: string; p: Partial<SessionRecord> }[] = [];
  const stats: (string | undefined)[] = [];
  const errors: string[] = [];
  let t = 1_000_000;
  const poller = createGitPoller({
    manager: {
      list: () => [...map.values()], get: (id) => map.get(id),
      update: (id, p) => { updates.push({ id, p }); const s = map.get(id); if (s === undefined) return undefined; const n = { ...s, ...p }; map.set(id, n); return n; },
    },
    git: { status, diffStat: (_cwd, base) => { stats.push(base); return stat(); } },
    now: () => t, onError: (what) => errors.push(what),
  });
  return { poller, map, updates, stats, errors, advance: (ms: number) => { t += ms; } };
}

const clean = (o: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', dirty: false, staged: 0, unstaged: 0, untracked: 0, ...o });

describe('git poller (6.01)', () => {
  it('writes git {branch, ahead, behind, dirty, diffStat, at} for sessions with a process only', async () => {
    const r = rig(
      [rec('live'), rec('dead', { pty: undefined })],
      () => Promise.resolve(clean({ branch: 'feat', ahead: 2, behind: 1, dirty: true })),
      () => Promise.resolve({ files: 3, add: 10, del: 4 }),
    );
    await r.poller.tick();
    expect(r.updates.map((u) => u.id)).toEqual(['live']);
    expect(r.map.get('live')?.git).toEqual({ branch: 'feat', ahead: 2, behind: 1, dirty: true, diffStat: { files: 3, add: 10, del: 4 }, at: 1_000_000 });
    expect(r.map.get('live')?.branch).toBe('feat'); // the session's own branch follows a checkout
  });

  it('detached HEAD and a branch without upstream: no branch / no ahead-behind keys', async () => {
    const det = rig([rec('a')], () => Promise.resolve({ detached: true, dirty: false, staged: 0, unstaged: 0, untracked: 0 }));
    await det.poller.tick();
    expect(det.map.get('a')?.git).toEqual({ dirty: false, at: 1_000_000 });
    expect(det.map.get('a')?.branch).toBe('main'); // unchanged
    const fresh = rig([rec('b')], () => Promise.resolve(clean({ branch: 'topic' })));
    await fresh.poller.tick();
    expect(fresh.map.get('b')?.git).toEqual({ branch: 'topic', dirty: false, at: 1_000_000 });
  });

  it('only rewrites the record when something changed, plus a heartbeat every 5 minutes', async () => {
    const r = rig([rec('a')], () => Promise.resolve(clean()));
    await r.poller.tick();
    await r.poller.tick();
    r.advance(60_000);
    await r.poller.tick();
    expect(r.updates).toHaveLength(1);
    r.advance(5 * 60_000);
    await r.poller.tick();
    expect(r.updates).toHaveLength(2);
  });

  it('compares against the worktree base when there is one', async () => {
    const r = rig([rec('w', { worktree: { path: '/r/w', branch: 'f', base: 'develop', createdByStrategos: true } }), rec('p')], () => Promise.resolve(clean()));
    await r.poller.tick();
    expect(new Set(r.stats)).toEqual(new Set([undefined, 'develop']));
  });

  it('a folder git cannot read is reported once, not every round, and does not stop the others', async () => {
    const r = rig([rec('bad'), rec('ok')], (cwd) => (cwd.endsWith('bad') ? Promise.reject(new Error('not a repository')) : Promise.resolve(clean())));
    await r.poller.tick();
    await r.poller.tick();
    expect(r.errors).toHaveLength(1);
    expect(r.map.get('ok')?.git).toBeDefined();
    expect(r.map.get('bad')?.git).toBeUndefined();
  });

  it('refresh reads one session now, process or not', async () => {
    const r = rig([rec('s', { pty: undefined })], () => Promise.resolve(clean({ dirty: true })));
    await r.poller.refresh('s');
    expect(r.map.get('s')?.git?.dirty).toBe(true);
  });
});
