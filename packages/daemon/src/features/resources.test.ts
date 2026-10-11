import { describe, expect, it } from 'vitest';
import type { ProcSample, SessionRecord } from '@strategos/shared';
import { createResourceMonitor, processTree, sumTree } from './resources.ts';

const p = (pid: number, ppid: number, ws: number, cpu = 0, pv = ws / 2): ProcSample => ({ pid, ppid, workingSetMb: ws, privateMb: pv, cpuPct: cpu, startTime: `st${pid}` });

describe('processTree / sumTree', () => {
  it('takes the pid and every descendant, not siblings or ancestors', () => {
    const all = [p(1, 0, 5), p(10, 1, 100), p(11, 10, 40), p(12, 11, 30), p(20, 1, 999), p(13, 10, 20)];
    expect(processTree(10, all).map((x) => x.pid).sort()).toEqual([10, 11, 12, 13]);
    expect(processTree(404, all)).toEqual([]);
  });
  it('survives a cycle in the snapshot (pid reuse)', () => {
    const all = [p(10, 11, 1), p(11, 10, 1)];
    expect(processTree(10, all).map((x) => x.pid).sort()).toEqual([10, 11]);
  });
  it('sums working set, private and cpu', () => {
    expect(sumTree([p(1, 0, 10.25, 1.5, 4), p(2, 1, 20.5, 2, 6)])).toEqual({ workingSetMb: 30.8, privateMb: 10, cpuPct: 3.5 });
  });
});

/** A manager with the three methods the monitor uses, and a sampler the test drives tick by tick. */
function rig() {
  const sessions = new Map<string, SessionRecord>();
  const listeners = new Set<(s: SessionRecord) => void>();
  const published: unknown[] = [];
  const manager = {
    list: () => [...sessions.values()],
    update(id: string, patch: Partial<SessionRecord>) {
      const cur = sessions.get(id);
      if (cur === undefined) return undefined;
      const next = { ...cur, ...patch } as SessionRecord;
      sessions.set(id, next);
      for (const l of listeners) l(next);
      return next;
    },
    onChange(cb: (s: SessionRecord) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  let starts = 0;
  let returns = 0;
  let push: ((t: ProcSample[]) => void) | undefined;
  const sampler = {
    proc: {
      sample: () => ({
        [Symbol.asyncIterator]() {
          starts++;
          const queue: ProcSample[][] = [];
          let wake: (() => void) | undefined;
          let done = false;
          push = (t) => { queue.push(t); wake?.(); };
          return {
            async next(): Promise<IteratorResult<ProcSample[]>> {
              for (;;) {
                const v = queue.shift();
                if (v !== undefined) return { done: false, value: v };
                if (done) return { done: true, value: undefined };
                await new Promise<void>((r) => { wake = r; });
              }
            },
            return(): Promise<IteratorResult<ProcSample[]>> { returns++; done = true; wake?.(); return Promise.resolve({ done: true, value: undefined }); },
          };
        },
      }),
    },
  } as never;
  const monitor = createResourceMonitor({ platform: sampler, manager, hub: { publish: (e) => { published.push(e); } }, now: () => 1234 });
  const add = (id: string, pid: number | undefined): void => {
    const rec = { strategosId: id, status: 'working', pty: pid === undefined ? undefined : { pid, cols: 1, rows: 1, dirtyInput: false } } as unknown as SessionRecord;
    sessions.set(id, rec);
    for (const l of listeners) l(rec);
  };
  const tick = async (t: ProcSample[]): Promise<void> => {
    push?.(t);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { monitor, manager, add, tick, published, sessions, counts: () => ({ starts, returns }) };
}

describe('resource monitor', () => {
  it('does not sample with no live session, starts with the first and stops with the last', async () => {
    const r = rig();
    r.monitor.start();
    expect(r.monitor.sampling).toBe(false);
    expect(r.counts().starts).toBe(0);
    r.add('a', 100);
    expect(r.monitor.sampling).toBe(true);
    r.add('b', 200);
    expect(r.counts().starts).toBe(1); // one sampler for any number of sessions
    r.manager.update('a', { pty: undefined });
    expect(r.monitor.sampling).toBe(true);
    r.manager.update('b', { pty: undefined });
    expect(r.monitor.sampling).toBe(false);
    expect(r.counts().returns).toBe(1); // the iterator was returned: the child dies
    r.monitor.stop();
  });

  it('writes the tree totals into each session and publishes the grand total', async () => {
    const r = rig();
    r.monitor.start();
    r.add('a', 100);
    r.add('b', 200);
    await r.tick([p(100, 1, 300, 10), p(101, 100, 200, 5), p(200, 1, 150, 2.5), p(999, 1, 5000, 99)]);
    expect(r.sessions.get('a')!.resource).toEqual({ pid: 100, procStart: 'st100', treeWorkingSetMb: 500, treePrivateMb: 250, cpuPct: 15, at: 1234 });
    expect(r.sessions.get('b')!.resource).toMatchObject({ treeWorkingSetMb: 150, cpuPct: 2.5 });
    expect(r.published.at(-1)).toEqual({ t: 'resources', totalMb: 650, cpuPct: 17.5 });
  });

  it('a session whose process is missing from the sample is skipped, not zeroed', async () => {
    const r = rig();
    r.monitor.start();
    r.add('a', 100);
    await r.tick([p(1, 0, 1)]);
    expect(r.sessions.get('a')!.resource).toBeUndefined();
  });

  it('clears the figures and publishes a final zero when the last session ends', async () => {
    const r = rig();
    r.monitor.start();
    r.add('a', 100);
    await r.tick([p(100, 1, 50, 1)]);
    expect(r.sessions.get('a')!.resource).toBeDefined();
    r.manager.update('a', { pty: undefined });
    expect(r.sessions.get('a')!.resource).toBeUndefined();
    expect(r.published.at(-1)).toEqual({ t: 'resources', totalMb: 0, cpuPct: 0 });
  });

  it('restarts the sampler when a session appears again', async () => {
    const r = rig();
    r.monitor.start();
    r.add('a', 100);
    r.manager.update('a', { pty: undefined });
    r.add('b', 300);
    expect(r.counts().starts).toBe(2);
    await r.tick([p(300, 1, 70)]);
    expect(r.sessions.get('b')!.resource).toMatchObject({ treeWorkingSetMb: 70 });
  });
});
