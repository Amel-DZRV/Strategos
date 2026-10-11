import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@strategos/shared';
import { makePending, makeSession } from '../test/fixtures.ts';
import { createStore, DEFAULT_PREFS } from './store.ts';

const snap = (seq: number, sessions = [makeSession({ strategosId: 'a' })]): DaemonEvent =>
  ({ t: 'snapshot', seq, sessions, planets: [], initiatives: [], prefs: DEFAULT_PREFS });

describe('store', () => {
  it('applies a snapshot', () => {
    const s = createStore();
    expect(s.applyEvent(snap(5, [makeSession({ strategosId: 'a' }), makeSession({ strategosId: 'b' })]))).toBe('applied');
    expect([...s.sessions.value.keys()]).toEqual(['a', 'b']);
    expect(s.lastSeq).toBe(5);
    expect(s.synced.value).toBe(true);
  });

  it('applies upsert and removed deltas in order', () => {
    const s = createStore();
    s.applyEvent(snap(1));
    expect(s.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'b', displayName: 'Bee' }) })).toBe('applied');
    expect(s.sessions.value.get('b')?.displayName).toBe('Bee');
    expect(s.applyEvent({ t: 'session.upsert', seq: 3, session: makeSession({ strategosId: 'a', displayName: 'Renamed' }) })).toBe('applied');
    expect(s.sessions.value.get('a')?.displayName).toBe('Renamed');
    expect(s.applyEvent({ t: 'session.removed', seq: 4, strategosId: 'a' })).toBe('applied');
    expect(s.sessions.value.has('a')).toBe(false);
    expect(s.lastSeq).toBe(4);
  });

  it('applies usage and resources', () => {
    const s = createStore();
    s.applyEvent(snap(0, []));
    s.applyEvent({ t: 'usage', seq: 1, usage: { at: 1, fiveHour: { pct: 40, resetsAt: 9 } } });
    s.applyEvent({ t: 'resources', seq: 2, totalMb: 900, cpuPct: 12 });
    expect(s.usage.value?.fiveHour?.pct).toBe(40);
    expect(s.resources.value).toEqual({ totalMb: 900, cpuPct: 12 });
  });

  it('reports a gap and does not apply the event', () => {
    const s = createStore();
    s.applyEvent(snap(1));
    const r = s.applyEvent({ t: 'session.upsert', seq: 3, session: makeSession({ strategosId: 'z' }) });
    expect(r).toBe('gap');
    expect(s.sessions.value.has('z')).toBe(false);
    expect(s.lastSeq).toBe(1);
  });

  it('ignores repeats and old events', () => {
    const s = createStore();
    s.applyEvent(snap(4));
    expect(s.applyEvent({ t: 'session.removed', seq: 4, strategosId: 'a' })).toBe('stale');
    expect(s.sessions.value.has('a')).toBe(true);
  });

  it('ignores deltas before the first snapshot, and after a disconnect until a new snapshot', () => {
    const s = createStore();
    expect(s.applyEvent({ t: 'session.removed', seq: 1, strategosId: 'a' })).toBe('ignored');
    s.applyEvent(snap(1));
    s.markDisconnected();
    expect(s.synced.value).toBe(false);
    expect(s.applyEvent({ t: 'session.removed', seq: 2, strategosId: 'a' })).toBe('ignored');
    s.applyEvent(snap(0)); // a restarted daemon starts again at a low seq
    expect(s.lastSeq).toBe(0);
    expect(s.applyEvent({ t: 'session.removed', seq: 1, strategosId: 'a' })).toBe('applied');
  });

  it('keeps the last state while disconnected', () => {
    const s = createStore();
    s.applyEvent(snap(1));
    s.markDisconnected();
    expect(s.sessions.value.size).toBe(1);
  });

  it('announces a session that newly needs you, but not at the first snapshot', () => {
    const s = createStore();
    s.applyEvent(snap(1, [makeSession({ strategosId: 'a', status: 'permission', pending: makePending() })]));
    expect(s.announcement.value).toBe('');
    s.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'b', displayName: 'Bee', status: 'question' }) });
    expect(s.announcement.value).toBe('Bee has a question');
  });

  it('does not re-announce an unchanged needs-you status', () => {
    const s = createStore();
    s.applyEvent(snap(1, [makeSession({ strategosId: 'a', status: 'permission' })]));
    s.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'a', status: 'permission', last: 'x' }) });
    expect(s.announcement.value).toBe('');
  });

  it('sorts needs-you first, oldest wait first', () => {
    const s = createStore();
    s.applyEvent(snap(1, [
      makeSession({ strategosId: 'w', status: 'working' }),
      makeSession({ strategosId: 'q', status: 'question', waitingSince: 100 }),
      makeSession({ strategosId: 'p2', status: 'permission', waitingSince: 300 }),
      makeSession({ strategosId: 'p1', status: 'permission', waitingSince: 200 }),
    ]));
    expect(s.sorted.value.map((x) => x.strategosId)).toEqual(['p1', 'p2', 'q', 'w']);
    expect(s.needsYou.value.map((x) => x.strategosId)).toEqual(['p1', 'p2', 'q']);
  });
});
