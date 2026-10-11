import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { createEventLog, sanitizeEventData } from './event-log.ts';
import { createAuditLog } from './audit-log.ts';
import { makeTestEnv, type TestEnv } from './testing.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeTestEnv(); });
afterEach(async () => { await env.cleanup(); });

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const lines = (f: string) => readFileSync(path.join(env.home, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('event log', () => {
  it('appends to events-YYYY-MM-DD.jsonl in order', async () => {
    const t = at(2026, 10, 11);
    const log = createEventLog({ fs: env.fs, dir: env.home, now: () => t });
    for (let i = 0; i < 20; i++) void log.append('activity', { idleMs: i }, 's1');
    await log.idle();
    const rows = lines('events-2026-10-11.jsonl');
    expect(rows.map((r) => (r['data'] as { idleMs: number }).idleMs)).toEqual([...Array(20).keys()]);
    expect(rows[0]).toMatchObject({ ts: t, sid: 's1', type: 'activity' });
  });

  it('never stores full tool inputs: unknown keys dropped, strings cut, no nested objects', () => {
    const big = 'x'.repeat(5000);
    const out = sanitizeEventData('hook', { event: 'PreToolUse', tool: 'Write', summary: big, tool_input: { content: big }, command: big, nested: { a: 1 } });
    expect(Object.keys(out).sort()).toEqual(['event', 'summary', 'tool']);
    expect((out['summary'] as string).length).toBe(400);
    expect(sanitizeEventData('status', 'nope')).toEqual({});
  });

  it('rolls at the size cap into numbered parts', async () => {
    const t = at(2026, 10, 11);
    const log = createEventLog({ fs: env.fs, dir: env.home, now: () => t, maxBytes: 300 });
    for (let i = 0; i < 12; i++) void log.append('error', { message: `message number ${i} with some padding text` });
    await log.idle();
    const files = readdirSync(env.home).filter((n) => n.startsWith('events-')).sort();
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain('events-2026-10-11.jsonl');
    expect(files).toContain('events-2026-10-11.1.jsonl');
    for (const f of files) expect(statSync(path.join(env.home, f)).size).toBeLessThanOrEqual(300);
    const total = files.reduce((n, f) => n + lines(f).length, 0);
    expect(total).toBe(12);
  });

  it('continues the newest part after a restart', async () => {
    const t = at(2026, 10, 11);
    const a = createEventLog({ fs: env.fs, dir: env.home, now: () => t, maxBytes: 200 });
    for (let i = 0; i < 6; i++) void a.append('error', { message: `padding padding padding ${i}` });
    await a.idle();
    const before = readdirSync(env.home).length;
    const b = createEventLog({ fs: env.fs, dir: env.home, now: () => t, maxBytes: 200 });
    await b.append('activity', { idleMs: 1 });
    expect(readdirSync(env.home).length).toBeGreaterThanOrEqual(before);
  });

  it('keeps 30 days and deletes older files, at first append and on a new day', async () => {
    let t = at(2026, 10, 11);
    for (const d of [at(2026, 8, 1), at(2026, 9, 10), at(2026, 9, 13)]) {
      const day = new Date(d);
      const name = `events-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.jsonl`;
      await env.fs.writeFile(path.join(env.home, name), '{}\n');
    }
    await env.fs.writeFile(path.join(env.home, 'state.json'), '{}');
    const log = createEventLog({ fs: env.fs, dir: env.home, now: () => t });
    await log.append('activity', { idleMs: 1 });
    const names = readdirSync(env.home).sort();
    expect(names).toEqual(['events-2026-09-13.jsonl', 'events-2026-10-11.jsonl', 'state.json']);
    t += 25 * DAY; // 2026-11-05: the 09-13 file is now 53 days old
    await log.append('activity', { idleMs: 2 });
    expect(readdirSync(env.home)).not.toContain('events-2026-09-13.jsonl');
  });
});

describe('audit log', () => {
  const entry = (over = {}) => ({
    sid: 's1', requestId: 'r1', tool: 'Bash', inputSummary: 'ls', risk: ['run' as const], decision: 'allow' as const, via: 'map' as const, connId: 'c1', ...over,
  });

  it('appends entries in the section 5 shape and reads them back', async () => {
    const log = createAuditLog({ fs: env.fs, dir: env.home, now: () => 5000 });
    await log.append(entry());
    await log.append(entry({ requestId: 'r2', decision: 'deny', via: 'guard' }));
    const rows = log.read();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ts: 5000, ...entry() });
    expect(log.read({ limit: 1 })[0]!.requestId).toBe('r2');
  });

  it('cuts the summary to 400 chars and ignores a torn last line', async () => {
    const log = createAuditLog({ fs: env.fs, dir: env.home });
    await log.append(entry({ inputSummary: 'y'.repeat(900) }));
    await env.fs.appendLine(log.path, '{"ts": 1, "sid"');
    const rows = log.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputSummary).toHaveLength(400);
  });

  it('drops entries older than 180 days', async () => {
    const t = at(2026, 10, 11);
    const log0 = createAuditLog({ fs: env.fs, dir: env.home, now: () => t - 200 * DAY });
    await log0.append(entry({ requestId: 'old' }));
    const log = createAuditLog({ fs: env.fs, dir: env.home, now: () => t });
    await log.append(entry({ requestId: 'new' }));
    expect(log.read().map((e) => e.requestId)).toEqual(['new']);
    expect(await log.prune()).toBe(0);
  });
});
