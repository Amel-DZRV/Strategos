import { describe, expect, it } from 'vitest';
import { expireCache, keepTranscriptCache, mergeTranscriptCache } from './cache.ts';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const call = (atMs: number, created?: { m5?: number; h1?: number }): object => ({
  type: 'assistant', timestamp: new Date(atMs).toISOString(),
  message: { content: [], usage: { cache_creation: created === undefined ? undefined : { ephemeral_5m_input_tokens: created.m5 ?? 0, ephemeral_1h_input_tokens: created.h1 ?? 0 } } },
});

describe('expireCache', () => {
  it('flips warm to false once expiresAt has passed, only then', () => {
    const c = { warm: true as const, ttl: '5m' as const, expiresAt: T0 + 1000, source: 'statusline' as const };
    expect(expireCache(c, T0 + 999)).toBeUndefined();
    expect(expireCache(c, T0 + 1000)).toEqual({ ...c, warm: false });
  });
  it('leaves cold, unknown and absent readings alone', () => {
    expect(expireCache({ warm: false, expiresAt: 1, source: 'statusline' }, T0)).toBeUndefined();
    expect(expireCache({ warm: null, source: 'statusline' }, T0)).toBeUndefined();
    expect(expireCache({ warm: true, source: 'statusline' }, T0)).toBeUndefined(); // no expiry known
    expect(expireCache(undefined, T0)).toBeUndefined();
  });
});

describe('mergeTranscriptCache', () => {
  it('derives warmth and expiry from the last call and the TTL it wrote', () => {
    const c = mergeTranscriptCache(undefined, [call(T0, { h1: 53 })], T0 + 60_000);
    expect(c).toEqual({ warm: true, ttl: '1h', expiresAt: T0 + 3_600_000, lastCallAt: T0, source: 'transcript' });
    expect(mergeTranscriptCache(undefined, [call(T0, { m5: 10 })], T0 + 6 * 60_000)).toMatchObject({ warm: false, ttl: '5m' });
  });
  it('unknown TTL gives warm null; a later call reuses the TTL already known', () => {
    const first = mergeTranscriptCache(undefined, [call(T0)], T0);
    expect(first).toEqual({ warm: null, lastCallAt: T0, source: 'transcript' });
    const known = mergeTranscriptCache(undefined, [call(T0, { m5: 1 })], T0)!;
    const next = mergeTranscriptCache(known, [call(T0 + 120_000)], T0 + 120_000);
    expect(next).toMatchObject({ warm: true, ttl: '5m', expiresAt: T0 + 120_000 + 300_000, lastCallAt: T0 + 120_000 });
  });
  it('a status-line reading with facts wins; an unknown one does not', () => {
    const sl = { warm: true as const, ttl: '5m' as const, expiresAt: T0 + 1, lastCallAt: T0, source: 'statusline' as const };
    expect(mergeTranscriptCache(sl, [call(T0 + 5, { m5: 1 })], T0)).toBeUndefined();
    expect(mergeTranscriptCache({ warm: null, source: 'statusline' }, [call(T0, { m5: 1 })], T0)).toMatchObject({ source: 'transcript', warm: true });
  });
  it('says nothing for batches without a call, subagent calls or older calls', () => {
    expect(mergeTranscriptCache(undefined, [{ type: 'user' }], T0)).toBeUndefined();
    expect(mergeTranscriptCache(undefined, [{ ...call(T0, { m5: 1 }), isSidechain: true }], T0)).toBeUndefined();
    const prev = mergeTranscriptCache(undefined, [call(T0 + 10_000, { m5: 1 })], T0 + 10_000)!;
    expect(mergeTranscriptCache(prev, [call(T0, { m5: 1 })], T0 + 10_000)).toBeUndefined();
  });
});

describe('keepTranscriptCache', () => {
  it('protects a transcript reading from a status line that knows nothing', () => {
    const t = { warm: true as const, source: 'transcript' as const };
    expect(keepTranscriptCache(t, { warm: null, source: 'statusline' })).toBe(true);
    expect(keepTranscriptCache(t, { warm: true, expiresAt: 5, source: 'statusline' })).toBe(false);
    expect(keepTranscriptCache(undefined, { warm: null, source: 'statusline' })).toBe(false);
  });
});
