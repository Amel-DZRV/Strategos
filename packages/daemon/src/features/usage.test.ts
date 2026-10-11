import { describe, expect, it } from 'vitest';
import type { Usage } from '@strategos/shared';
import { createUsageTracker, slopePerHour } from './usage.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const reading = (at: number, pct: number, resetsAt = T0 + 5 * HOUR): Usage => ({ fiveHour: { pct, resetsAt }, at });

describe('slopePerHour', () => {
  it('fits a straight line exactly', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * MIN, pct: 10 + i * 0.5 }));
    expect(slopePerHour(pts)).toBeCloseTo(30, 6);
  });
  it('is undefined for fewer than two points or a single instant', () => {
    expect(slopePerHour([])).toBeUndefined();
    expect(slopePerHour([{ t: 1, pct: 1 }])).toBeUndefined();
    expect(slopePerHour([{ t: 1, pct: 1 }, { t: 1, pct: 5 }])).toBeUndefined();
  });
  it('is negative for a falling line and zero for a flat one', () => {
    expect(slopePerHour([{ t: 0, pct: 5 }, { t: HOUR, pct: 3 }])).toBeCloseTo(-2);
    expect(slopePerHour([{ t: 0, pct: 5 }, { t: HOUR, pct: 5 }])).toBeCloseTo(0);
  });
});

describe('burn rate and ETA', () => {
  it('a synthetic line of 20 %/h from 10 % gives an ETA within 10% of the true time', () => {
    const tr = createUsageTracker();
    let last: Usage = {} as Usage;
    // one reading a minute for 30 minutes: 10% -> 20%, i.e. 20 %/h (integer steps like a real status line would give)
    for (let m = 0; m <= 30; m++) last = tr.ingest(reading(T0 + m * MIN, Math.floor(10 + (20 * m) / 60))).usage;
    const now = T0 + 30 * MIN;
    const trueEta = now + ((100 - 20) / 20) * HOUR; // 4 h from now
    expect(last.burnPctPerHour).toBeGreaterThan(18);
    expect(last.burnPctPerHour).toBeLessThan(22);
    // the window resets in 5 h - 30 min = 4.5 h, so the line reaches 100% first
    expect(last.etaFull).toBeDefined();
    expect(Math.abs((last.etaFull ?? 0) - trueEta) / (trueEta - now)).toBeLessThan(0.1);
  });
  it('no ETA while the percentage is flat, falling, or there is too little data', () => {
    const tr = createUsageTracker();
    expect(tr.ingest(reading(T0, 10)).usage.burnPctPerHour).toBeUndefined();
    expect(tr.ingest(reading(T0 + 10_000, 11)).usage.burnPctPerHour).toBeUndefined(); // 10 s of data
    const flat = createUsageTracker();
    let u: Usage = {} as Usage;
    for (let m = 0; m <= 20; m++) u = flat.ingest(reading(T0 + m * MIN, 40)).usage;
    expect(u.burnPctPerHour).toBeUndefined();
    expect(u.etaFull).toBeUndefined();
  });
  it('no ETA when the window resets before the line gets to 100%', () => {
    const tr = createUsageTracker();
    let u: Usage = {} as Usage;
    for (let m = 0; m <= 20; m++) u = tr.ingest(reading(T0 + m * MIN, 10 + m * 0.5, T0 + 30 * MIN)).usage; // 30 %/h, 20 min... reset in 10 min
    expect(u.burnPctPerHour).toBeGreaterThan(0);
    expect(u.etaFull).toBeUndefined();
  });
  it('only the last 30 minutes count', () => {
    const tr = createUsageTracker();
    // 80 minutes at 60 %/h-ish then 30 minutes flat: the slope of the last 30 min is ~0
    let u: Usage = {} as Usage;
    for (let m = 0; m <= 80; m++) u = tr.ingest(reading(T0 + m * MIN, Math.min(80, m))).usage;
    for (let m = 81; m <= 111; m++) u = tr.ingest(reading(T0 + m * MIN, 80)).usage;
    expect(u.burnPctPerHour).toBeUndefined();
    expect(u.etaFull).toBeUndefined();
  });
  it('keeps two hours of samples', () => {
    const tr = createUsageTracker();
    for (let m = 0; m <= 200; m++) tr.ingest(reading(T0 + m * MIN, m % 50));
    const s = tr.samples();
    expect(s[0]!.t).toBeGreaterThanOrEqual(T0 + 200 * MIN - 2 * HOUR);
  });
  it('forgets the old samples when a new 5-hour window starts', () => {
    const tr = createUsageTracker();
    for (let m = 0; m <= 30; m++) tr.ingest(reading(T0 + m * MIN, 50 + m));
    const first = tr.ingest(reading(T0 + 31 * MIN, 2, T0 + 10 * HOUR));
    expect(first.usage.burnPctPerHour).toBeUndefined();
    expect(tr.samples()).toHaveLength(1);
  });
  it('passes a reading without a 5-hour part straight through', () => {
    const tr = createUsageTracker();
    const u: Usage = { sevenDay: { pct: 10, resetsAt: T0 + 100 * HOUR }, at: T0 };
    expect(tr.ingest(u)).toEqual({ usage: u });
  });
  it('does not change the input object', () => {
    const tr = createUsageTracker();
    const u = reading(T0, 10);
    for (let m = 1; m <= 10; m++) tr.ingest(reading(T0 + m * MIN, 10 + m));
    tr.ingest(u);
    expect(u).toEqual(reading(T0, 10));
  });
});

describe('park suggestion', () => {
  it('appears at 85% and only once per 5-hour window', () => {
    const tr = createUsageTracker();
    expect(tr.ingest(reading(T0, 84)).suggestion).toBeUndefined();
    const s = tr.ingest(reading(T0 + MIN, 85));
    expect(s.suggestion).toMatchObject({ kind: 'park' });
    expect(s.suggestion?.text).toMatch(/85%/);
    expect(tr.ingest(reading(T0 + 2 * MIN, 90)).suggestion).toBeUndefined();
    expect(tr.ingest(reading(T0 + 3 * MIN, 99, T0 + 5 * HOUR + 20_000)).suggestion).toBeUndefined(); // reset time jitter: same window
  });
  it('comes again in the next window', () => {
    const tr = createUsageTracker();
    expect(tr.ingest(reading(T0, 90)).suggestion).toBeDefined();
    const next = T0 + 5 * HOUR;
    expect(tr.ingest(reading(next + MIN, 10, next + 5 * HOUR)).suggestion).toBeUndefined();
    expect(tr.ingest(reading(next + 2 * MIN, 88, next + 5 * HOUR)).suggestion).toBeDefined();
  });
  it('has a stable id per window', () => {
    const a = createUsageTracker().ingest(reading(T0, 90));
    const b = createUsageTracker().ingest(reading(T0 + MIN, 95));
    expect(a.suggestion?.id).toBe(b.suggestion?.id);
  });
  it('never applies itself: it is data only', () => {
    const s = createUsageTracker().ingest(reading(T0, 99)).suggestion;
    expect(Object.keys(s ?? {}).sort()).toEqual(['id', 'kind', 'text']);
  });
});
