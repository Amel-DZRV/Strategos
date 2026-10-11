import { describe, expect, test } from 'vitest';
import { compareNeedsYou, glyphFor, isLive, isNeedsYou, needsYouRank, STATUS_GLYPH } from './status-rank.ts';
import type { SessionRecord, Status } from './types.ts';

const ALL: Record<Status, true> = {
  starting: true, trust_pending: true, working: true, permission: true, question: true, done: true, seen: true,
  interrupted: true, errored: true, stopped: true, parked: true, open_elsewhere: true,
};
const statuses = Object.keys(ALL) as Status[];

const rec = (status: Status, o: Partial<SessionRecord> = {}) => ({ status, statusSince: 1000, ...o });

describe('needs-you ranking', () => {
  test('tier order', () => {
    const order: Status[] = ['permission', 'question', 'errored', 'trust_pending', 'interrupted', 'done'];
    const ranks = order.map((s) => needsYouRank(s));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
    const shuffled = [...order].reverse().map((s) => rec(s));
    expect(shuffled.sort(compareNeedsYou).map((r) => r.status)).toEqual(order);
  });

  test('non needs-you statuses have no rank and sort last', () => {
    for (const s of ['starting', 'working', 'seen', 'stopped', 'parked', 'open_elsewhere'] as Status[]) {
      expect(needsYouRank(s)).toBeNull();
      expect(isNeedsYou(rec(s))).toBe(false);
    }
    const sorted = [rec('working'), rec('done'), rec('stopped')].sort(compareNeedsYou);
    expect(sorted[0]?.status).toBe('done');
  });

  test('within a tier, oldest waitingSince first; missing falls back to statusSince', () => {
    const a = rec('permission', { waitingSince: 500 });
    const b = rec('permission', { waitingSince: 100 });
    const c = rec('permission', { statusSince: 300 });
    expect([a, b, c].sort(compareNeedsYou)).toEqual([b, c, a]);
  });

  test('done counts only while unseen', () => {
    expect(isNeedsYou(rec('done', { doneAt: 10 }))).toBe(true);
    expect(isNeedsYou(rec('done', { doneAt: 10, seenAt: 5 }))).toBe(true);
    expect(isNeedsYou(rec('done', { doneAt: 10, seenAt: 10 }))).toBe(false);
  });
});

describe('glyphs and liveness', () => {
  test('a glyph for every status', () => {
    for (const s of statuses) expect(glyphFor(s).length).toBeGreaterThan(0);
    expect(Object.keys(STATUS_GLYPH).sort()).toEqual([...statuses].sort());
  });
  test('glyphs are distinct', () => {
    expect(new Set(Object.values(STATUS_GLYPH)).size).toBe(statuses.length);
  });
  test('isLive', () => {
    expect(isLive('working')).toBe(true);
    expect(isLive('permission')).toBe(true);
    expect(isLive('stopped')).toBe(false);
    expect(isLive('parked')).toBe(false);
    expect(isLive('open_elsewhere')).toBe(false);
  });
});
