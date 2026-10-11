import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http } from '../server/testkit.ts';
import { makeHarness, type Harness } from '../hooks/testkit.ts';
import { ingestStatusLine } from './ingest.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/claude/2.1.292/statusline');
const load = (name: string): Record<string, unknown> => (JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as { body: Record<string, unknown> }).body;
const NOW = 1_791_700_000_000;

describe('ingestStatusLine on the recorded samples', () => {
  it('a normal sample after turns: ctx, cost per Claude id, model, cache (seconds -> ms), usage', () => {
    const r = ingestStatusLine(load('statusline-after-turns-with-rate-limits-and-cache.json'), NOW)!;
    expect(r.claudeSessionId).toBe('b5a6d25c-f79c-4a72-b9fe-4763c2448c98');
    expect(r.input).toEqual({
      k: 'statusline',
      ctx: { pct: 5, tokens: 48218, window: 1_000_000, at: NOW, source: 'statusline' },
      cost: { claudeSessionId: 'b5a6d25c-f79c-4a72-b9fe-4763c2448c98', usd: 0.9351462000000003 },
      model: 'claude-opus-5-5',
      cache: { warm: true, ttl: '1h', expiresAt: 1_791_727_876_000, lastCallAt: 1_791_727_876_000 - 3_600_000, source: 'statusline' },
    });
    expect(r.usage).toEqual({
      fiveHour: { pct: 9, resetsAt: 1_791_741_000_000 },
      sevenDay: { pct: 66, resetsAt: 1_791_972_000_000 },
      at: NOW,
    });
  });

  it('the first sample (no request yet): used_percentage null, no prompt_cache, no rate_limits', () => {
    const r = ingestStatusLine(load('statusline-first-no-request-yet.json'), NOW)!;
    expect(r.input.ctx).toEqual({ pct: null, window: 1_000_000, at: NOW, source: 'statusline' });
    expect(r.input.cache).toEqual({ warm: null, source: 'statusline' });
    expect(r.input.cost).toEqual({ claudeSessionId: 'b5a6d25c-f79c-4a72-b9fe-4763c2448c98', usd: 0 });
    expect(r.usage).toBeUndefined();
  });

  it('/clear: a new Claude id with cost 0 (the reducer keeps one number per id)', () => {
    const r = ingestStatusLine(load('statusline-after-clear-cost-zero-new-session-id.json'), NOW)!;
    expect(r.input.cost).toEqual({ claudeSessionId: '3a28ac05-f3a5-43b4-abd3-bfb87dc1fade', usd: 0 });
    expect(r.input.ctx?.pct).toBeNull();
  });

  it('/resume carries the old total; /branch starts again from a small number', () => {
    expect(ingestStatusLine(load('statusline-after-resume-cost-carried.json'), NOW)!.input.cost?.usd).toBeCloseTo(0.4758608);
    expect(ingestStatusLine(load('statusline-after-branch-cost-reset-to-fresh.json'), NOW)!.input.cost?.usd).toBeCloseTo(0.0165026);
  });

  it('the ttl sample', () => {
    const r = ingestStatusLine(load('statusline-prompt-cache-ttl-1h-expires-at.json'), NOW)!;
    expect(r.input.cache).toMatchObject({ warm: true, ttl: '1h', expiresAt: 1_791_728_535_000 });
  });

  it('every sample ingests without throwing', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) expect(ingestStatusLine(load(f), NOW)).not.toBeNull();
  });
});

describe('ingestStatusLine is tolerant', () => {
  it('not an object -> null', () => {
    for (const v of [null, 5, 'x', [1], undefined]) expect(ingestStatusLine(v, NOW)).toBeNull();
  });
  it('an empty object still yields a machine input with unknown cache and no ctx', () => {
    expect(ingestStatusLine({}, NOW)!.input).toEqual({ k: 'statusline', cache: { warm: null, source: 'statusline' } });
  });
  it('wrong types are ignored field by field', () => {
    const r = ingestStatusLine({ session_id: 7, cost: { total_cost_usd: 'a' }, model: 5, context_window: { used_percentage: '5', current_usage: 3 }, prompt_cache: { warm: 'yes', ttl: '2h', expires_at: 'x' }, rate_limits: { five_hour: { used_percentage: 3 } } }, NOW)!;
    expect(r.input).toEqual({ k: 'statusline', ctx: { pct: null, at: NOW, source: 'statusline' }, cache: { warm: null, source: 'statusline' } });
    expect(r.usage).toBeUndefined();
  });
  it('a 5m ttl derives lastCallAt', () => {
    const r = ingestStatusLine({ prompt_cache: { warm: false, ttl: '5m', expires_at: 1000 } }, NOW)!;
    expect(r.input.cache).toEqual({ warm: false, ttl: '5m', expiresAt: 1_000_000, lastCallAt: 700_000, source: 'statusline' });
  });
  it('model falls back to the display name', () => {
    expect(ingestStatusLine({ model: { display_name: 'Opus' } }, NOW)!.input.model).toBe('Opus');
  });
});

describe('POST /statusline/<id> through the real server', () => {
  let h: Harness;
  let token: string;
  beforeEach(async () => {
    h = await makeHarness();
    token = h.addSession('s1', { status: 'working', claudeSessionIds: ['b5a6d25c-f79c-4a72-b9fe-4763c2448c98'], currentSessionId: 'b5a6d25c-f79c-4a72-b9fe-4763c2448c98' }).token;
  });
  afterEach(async () => { await h.close(); });

  const send = (body: unknown, tok: string | null = token) =>
    http(h.server.port, { method: 'POST', path: '/statusline/s1', headers: { 'content-type': 'application/json', ...(tok === null ? {} : { 'x-strategos-token': tok }) }, body: JSON.stringify(body) });

  it('updates ctx, cost, model and cache on the record, reports usage, answers 204', async () => {
    const r = await send(load('statusline-after-turns-with-rate-limits-and-cache.json'));
    expect(r.status).toBe(204);
    const s = h.get('s1');
    expect(s.ctx).toMatchObject({ pct: 5, tokens: 48218, source: 'statusline' });
    expect(s.cost.byClaudeSession['b5a6d25c-f79c-4a72-b9fe-4763c2448c98']).toBeCloseTo(0.9351462);
    expect(s.cost.lineageUsd).toBeCloseTo(0.9351462);
    expect(s.model).toBe('claude-opus-5-5');
    expect(s.cache).toMatchObject({ warm: true, ttl: '1h' });
    expect(h.usage).toHaveLength(1);
  });

  it('costs add up over the lineage: /clear starts a new id from 0, each id keeps its own number', async () => {
    await send(load('statusline-after-turns-with-rate-limits-and-cache.json'));
    await send(load('statusline-after-clear-cost-zero-new-session-id.json'));
    await send(load('statusline-after-branch-cost-reset-to-fresh.json'));
    expect(Object.keys(h.get('s1').cost.byClaudeSession)).toHaveLength(3);
    expect(h.get('s1').cost.lineageUsd).toBeCloseTo(0.9351462 + 0 + 0.0165026);
  });

  it('the null-percentage sample is accepted', async () => {
    expect((await send(load('statusline-first-no-request-yet.json'))).status).toBe(204);
    expect(h.get('s1').ctx).toMatchObject({ pct: null });
  });

  it('wrong or missing token -> 401; a body that is not an object -> 400', async () => {
    expect((await send({}, 'bad')).status).toBe(401);
    expect((await send({}, null)).status).toBe(401);
    expect((await send([1])).status).toBe(400);
  });
});
