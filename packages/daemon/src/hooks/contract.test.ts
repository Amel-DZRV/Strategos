// Contract test: every recorded hook body of fixtures/claude/<version>/hooks goes through
// parseHookBody -> HTTP -> receiver -> reducer. It must not throw, must answer, and the status must be sensible.
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHookParseError, parseHookBody, type Status } from '@strategos/shared';
import { http } from '../server/testkit.ts';
import { makeHarness, type Harness } from './testkit.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/claude');
const versions = readdirSync(ROOT).filter((d) => /^\d+\.\d+\.\d+$/.test(d));

interface Fixture { url: string; body: Record<string, unknown> }

/** What status the session should have afterwards, by fixture file name. Default: working. */
function expected(file: string, body: Record<string, unknown>): Status[] {
  const ev = body['hook_event_name'];
  if (ev === 'PermissionRequest') return body['tool_name'] === 'AskUserQuestion' ? ['question'] : ['permission'];
  if (ev === 'PreToolUse' && body['tool_name'] === 'AskUserQuestion') return ['question'];
  if (ev === 'Stop') return ['done'];
  if (ev === 'SessionStart') return body['source'] === 'compact' || body['source'] === 'startup' ? ['working'] : ['done'];
  if (ev === 'SessionEnd') return body['reason'] === 'clear' || body['reason'] === 'resume' ? ['working'] : ['stopped'];
  return ['working'];
}
const isHeld = (b: Record<string, unknown>): boolean =>
  b['hook_event_name'] === 'PermissionRequest' || (b['hook_event_name'] === 'PreToolUse' && b['tool_name'] === 'AskUserQuestion');

describe.each(versions)('hook fixtures %s', (version) => {
  const dir = path.join(ROOT, version, 'hooks');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('RESPONSE-'));
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });

  it('has fixtures', () => { expect(files.length).toBeGreaterThan(20); });

  it.each(files)('%s', async (file) => {
    const fx = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Fixture;
    const event = fx.url.split('/').pop()!;
    const body = fx.body;
    expect(body['hook_event_name']).toBe(event);

    // 1. the tolerant parser accepts it and keeps the fields we rely on
    const parsed = parseHookBody(event, body);
    expect(isHookParseError(parsed)).toBe(false);

    // 2. receiver + reducer over real HTTP
    const sid = `fx-${file.replace(/[^A-Za-z0-9]/g, '-')}`;
    const claudeId = String(body['session_id']);
    const { token } = h.addSession(sid, { status: 'working', claudeSessionIds: [claudeId], currentSessionId: claudeId, lastActivityAt: Date.now() });
    const errorsBefore = h.errors.length;
    const sent = http(h.server.port, {
      method: 'POST', path: `/hook/${sid}/${event}`,
      headers: { 'content-type': 'application/json', 'x-strategos-token': token }, body: JSON.stringify(body),
    });
    sent.catch(() => undefined);
    if (isHeld(body)) {
      await h.until(() => h.registry.size > 0, 5000, `${file} to be held`);
      const p = h.get(sid).pending!;
      expect(p).toMatchObject({ held: true, toolName: body['tool_name'] });
      expect(p.inputSummary.length).toBeLessThanOrEqual(400);
      if (event === 'PermissionRequest' && body['permission_suggestions'] !== undefined) expect(p.suggestions).toEqual(body['permission_suggestions']);
      if (body['tool_name'] === 'AskUserQuestion') expect(p.questions?.length).toBeGreaterThan(0);
      expect(h.registry.getFull(sid, p.requestId)?.toolInput).toEqual(body['tool_input']);
    } else {
      const r = await sent;
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(0); // no decision
    }
    expect(h.get(sid).status).toBe(expected(file, body)[0]);
    expect(h.errors.length).toBe(errorsBefore);
    h.registry.dropSession(sid);
    await sent;
  });
});
