// End to end for the M5 daemon helpers: slash.send rules and mod detection (5.05), cache warmth (5.07).
import { appendFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClaudeHome } from '../../../../tools/fake-claude-home.ts';
import { mkTmp } from '../../../../tools/tmp-fs.ts';
import { startRig, type Rig, type UiClient } from '../daemon.testkit.ts';
import { http } from '../server/testkit.ts';

const T = 60_000;
const rigs: Rig[] = [];
async function rig(o: { plugins?: Record<string, boolean>; script?: string } = {}): Promise<Rig> {
  const claudeHome = createFakeClaudeHome(path.join(mkTmp('strategos-m5-'), 'claude-home'));
  if (o.plugins !== undefined) writeFileSync(path.join(claudeHome.root, 'settings.json'), JSON.stringify({ enabledPlugins: o.plugins }));
  const r = await startRig({ claudeHome, daemon: { notifyQuietMs: 0 } });
  r.env['FAKE_CLAUDE_SCRIPT'] = o.script ?? 'plain';
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

async function done(r: Rig, ui: UiClient, name: string): Promise<string> {
  const s = await ui.start(name, r.repo, 'hello');
  await ui.waitStatus(s.strategosId, 'done');
  return s.strategosId;
}

describe('slash.send and mods (5.05)', () => {
  it('offers /handoff-now only when the auto-handoff mod is present, and says so in the snapshot', async () => {
    const without = await rig();
    const u1 = await without.ui();
    expect(u1.snapshot?.prefs.mods).toEqual({ autoHandoff: false });
    const s1 = await done(without, u1, 'A');
    const refused = await u1.cmd({ c: 'slash.send', strategosId: s1, cmd: '/handoff-now' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not_allowed.*auto-handoff/);

    const withMod = await rig({ plugins: { 'auto-handoff@amel-mods': true } });
    const u2 = await withMod.ui();
    expect(u2.snapshot?.prefs.mods).toEqual({ autoHandoff: true });
    const s2 = await done(withMod, u2, 'B');
    expect((await u2.cmd({ c: 'slash.send', strategosId: s2, cmd: '/handoff-now' })).ok).toBe(true);
    await u2.until(() => (u2.of(s2).last ?? '').includes('/handoff-now'), 15_000, 'the command reached the session');
  }, T);

  it('sends /compact and /keepwarm only when the turn is over, and nothing else', async () => {
    const r = await rig();
    const ui = await r.ui();
    const sid = await done(r, ui, 'K');
    expect((await ui.cmd({ c: 'slash.send', strategosId: sid, cmd: '/keepwarm 60m' })).ok).toBe(true);
    await ui.until(() => (ui.of(sid).last ?? '').includes('/keepwarm 60m'), 15_000, 'keepwarm sent');
    await ui.waitStatus(sid, 'done');
    expect((await ui.cmd({ c: 'slash.send', strategosId: sid, cmd: '/compact' })).ok).toBe(true);
    await ui.until(() => (ui.of(sid).last ?? '').includes('/compact'), 15_000, 'compact sent');
    await ui.waitStatus(sid, 'done');
    // the protocol validator already rejects anything else
    const bad = await ui.cmd({ c: 'slash.send', strategosId: sid, cmd: '/rm -rf' as never });
    expect(bad.ok).toBe(false);

    // mid-turn: refused
    r.env['FAKE_CLAUDE_SCRIPT'] = 'permission';
    const p = await ui.start('P', r.repo, 'go');
    await ui.waitStatus(p.strategosId, 'permission');
    const busy = await ui.cmd({ c: 'slash.send', strategosId: p.strategosId, cmd: '/compact' });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/busy/);
    await ui.cmd({ c: 'perm.release', strategosId: p.strategosId, requestId: ui.of(p.strategosId).pending!.requestId });
  }, T);

  it('refuses a slash command after an interrupt, while a reply is still fine', async () => {
    const r = await rig({ script: 'interrupt' });
    const ui = await r.ui();
    const s = await ui.start('I', r.repo, 'long job');
    await ui.waitStatus(s.strategosId, 'working');
    await new Promise((res) => setTimeout(res, 300));
    await ui.cmd({ c: 'pty.input', strategosId: s.strategosId, data: '\x1b' });
    await ui.waitStatus(s.strategosId, 'interrupted');
    const slash = await ui.cmd({ c: 'slash.send', strategosId: s.strategosId, cmd: '/compact' });
    expect(slash.ok).toBe(false);
    expect(slash.error).toMatch(/busy/);
    expect((await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'continue' })).ok).toBe(true);
  }, T);
});

describe('cache warmth (5.07)', () => {
  const statusline = (r: Rig, sid: string, body: Record<string, unknown>): Promise<unknown> =>
    http(r.daemon.port, { method: 'POST', path: `/statusline/${sid}`, headers: { 'x-strategos-token': r.daemon.manager.tokenFor(sid) ?? '', 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('the status line sets it and the tick turns it cold when the TTL passes', async () => {
    const r = await rig();
    const ui = await r.ui();
    const sid = await done(r, ui, 'W');
    const expires = Math.round(Date.now() / 1000) + 2;
    await statusline(r, sid, { session_id: ui.of(sid).currentSessionId, prompt_cache: { warm: true, ttl: '5m', expires_at: expires } });
    await ui.until(() => ui.of(sid).cache?.warm === true, 5000, 'warm from the status line');
    expect(ui.of(sid).cache).toMatchObject({ ttl: '5m', source: 'statusline', expiresAt: expires * 1000 });
    await ui.until(() => ui.of(sid).cache?.warm === false, 8000, 'cold after expiry');
    expect(ui.of(sid).cache).toMatchObject({ ttl: '5m', source: 'statusline' });
  }, T);

  it('without a status line the transcript supplies it, and a blank status line does not wipe it', async () => {
    const r = await rig();
    const ui = await r.ui();
    const sid = await done(r, ui, 'F');
    const rec = ui.of(sid);
    const lastCall = Date.now() - 297_000; // a 5 min cache written 297 s ago: warm for 3 more seconds
    appendFileSync(rec.transcriptPath!, `${JSON.stringify({
      type: 'assistant', uuid: 'cache-1', timestamp: new Date(lastCall).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'cached' }], stop_reason: 'end_turn', usage: { cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } } },
    })}\n`);
    await ui.until(() => ui.of(sid).cache?.source === 'transcript', 8000, 'cache from the transcript');
    expect(ui.of(sid).cache).toMatchObject({ warm: true, ttl: '5m', lastCallAt: lastCall, expiresAt: lastCall + 300_000 });

    await statusline(r, sid, { session_id: rec.currentSessionId, context_window: { used_percentage: 5 } }); // no prompt_cache
    await new Promise((res) => setTimeout(res, 400));
    expect(ui.of(sid).cache?.source).toBe('transcript');

    await ui.until(() => ui.of(sid).cache?.warm === false, 8000, 'cold after expiry');
  }, T);
});
