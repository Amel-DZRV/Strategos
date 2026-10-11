// End to end for the daemon features (4.03 risk + batch, 4.04 guards, 4.08 usage, 2.09/4.05 notify policy): a real daemon,
// real WebSocket clients, fake claude; the hooks and status lines are posted by hand with the session's token.
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@strategos/shared';
import { startRig, type Rig, type UiClient } from '../daemon.testkit.ts';
import { http, type Reply } from '../server/testkit.ts';

const T = 60_000;
const rigs: Rig[] = [];
async function rig(o: Parameters<typeof startRig>[0] = {}): Promise<Rig> {
  const r = await startRig({ ...o, daemon: { notifyQuietMs: 0, ...(o.daemon ?? {}) } });
  r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

async function session(r: Rig, ui: UiClient, name: string): Promise<{ sid: string; claudeId: string }> {
  const s = await ui.start(name, r.repo, 'hello');
  await ui.waitStatus(s.strategosId, 'done');
  return { sid: s.strategosId, claudeId: ui.of(s.strategosId).currentSessionId };
}

function hook(r: Rig, sid: string, event: string, body: Record<string, unknown>): Promise<Reply> {
  const token = r.daemon.manager.tokenFor(sid);
  return http(r.daemon.port, {
    method: 'POST', path: `/hook/${sid}/${event}`, headers: { 'x-strategos-token': token ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, ...body }),
  });
}

const audit = (r: Rig): Record<string, unknown>[] => {
  try {
    return readFileSync(path.join(r.home, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const notifies = (ui: UiClient): Extract<DaemonEvent, { t: 'notify' }>[] => ui.events.filter((e): e is Extract<DaemonEvent, { t: 'notify' }> => e.t === 'notify');

describe('guards in the receiver (4.04)', () => {
  it('denies a force push with the PreToolUse deny JSON, audits it via guard, counts it, and leaves other commands alone', async () => {
    const r = await rig();
    const ui = await r.ui();
    const { sid, claudeId } = await session(r, ui, 'G');

    const ok = await hook(r, sid, 'PreToolUse', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't0' });
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe('');

    const t0 = performance.now();
    const bad = await hook(r, sid, 'PreToolUse', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, tool_use_id: 't1' });
    expect(bad.status).toBe(200);
    const out = JSON.parse(bad.body.toString()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/git-force-push/);
    expect(performance.now() - t0).toBeLessThan(2000); // the guard itself takes well under 20 ms (unit-tested); this is the whole HTTP round trip

    await ui.until(() => audit(r).some((e) => e['via'] === 'guard'), 5000, 'guard audit line');
    expect(audit(r).find((e) => e['via'] === 'guard')).toMatchObject({ sid, tool: 'Bash', decision: 'deny' });
    await ui.until(() => ui.of(sid).flags.guardDenials === 1, 5000, 'guardDenials');

    // writing to ~/.strategos is refused too (the daemon uses os.homedir() for {HOME})
    const edit = await hook(r, sid, 'PreToolUse', { session_id: claudeId, tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), '.strategos', 'x') }, tool_use_id: 't2' });
    expect(JSON.parse(edit.body.toString())).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  }, T);

  it('config.json defaults carry the starter rules', async () => {
    const r = await rig();
    expect(r.daemon.manager.get).toBeDefined();
    const { defaultConfig } = await import('../config.ts');
    expect(defaultConfig(0).portable.guards.map((g) => g.id)).toContain('git-force-push');
  }, T);
});

describe('risk tags and "approve all low-risk" (4.03)', () => {
  it('tags the pending request, and the batch approves only the in-worktree Edit', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A'); // Edit inside the worktree
    const b = await session(r, ui, 'B'); // Bash
    const c = await session(r, ui, 'C'); // Edit outside
    const d = await session(r, ui, 'D'); // Edit inside .github

    const ask = (s: { sid: string; claudeId: string }, tool: string, input: Record<string, unknown>): Promise<Reply> =>
      hook(r, s.sid, 'PermissionRequest', { session_id: s.claudeId, tool_name: tool, tool_input: input });
    const ra = ask(a, 'Edit', { file_path: path.join(r.repo, 'src', 'a.ts'), old_string: 'x', new_string: 'y' });
    const rb = ask(b, 'Bash', { command: 'rm -rf build' });
    const rc = ask(c, 'Edit', { file_path: path.join(path.dirname(r.repo), 'elsewhere.ts'), old_string: 'x', new_string: 'y' });
    const rd = ask(d, 'Write', { file_path: path.join(r.repo, '.github', 'workflows', 'ci.yml'), content: 'x' });
    for (const s of [a, b, c, d]) await ui.waitStatus(s.sid, 'permission');

    expect(ui.of(a.sid).pending?.risk).toEqual(['write']);
    expect(ui.of(b.sid).pending?.risk).toEqual(['delete', 'run']);
    expect(ui.of(c.sid).pending?.risk).toEqual(['outside_repo', 'write']);
    expect(ui.of(d.sid).pending?.risk).toEqual(['write']);

    const res = await ui.cmd({ c: 'perm.approveLowRisk', initiativeId: '*' });
    expect(res).toEqual({ ok: true });
    const answered = await ra;
    expect(JSON.parse(answered.body.toString())).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await ui.waitStatus(a.sid, ['working', 'done']);
    for (const s of [b, c, d]) expect(ui.of(s.sid).status).toBe('permission'); // untouched
    await ui.until(() => audit(r).some((e) => e['via'] === 'lowRiskBatch'), 5000, 'batch audit line');
    expect(audit(r).filter((e) => e['via'] === 'lowRiskBatch')).toHaveLength(1);
    expect(audit(r).find((e) => e['via'] === 'lowRiskBatch')).toMatchObject({ sid: a.sid, tool: 'Edit', decision: 'allow' });

    // a second batch has nothing left it may approve
    const again = await ui.cmd({ c: 'perm.approveLowRisk', initiativeId: '*' });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/Nothing could be approved/);
    for (const s of [b, c, d]) await ui.cmd({ c: 'perm.release', strategosId: s.sid, requestId: ui.of(s.sid).pending!.requestId });
    await Promise.all([rb, rc, rd]);
  }, T);

  it('never approves a request whose summary was cut (D21), even when the path is fine', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A');
    const long = path.join(r.repo, 'src', `${'a'.repeat(500)}.ts`);
    const ra = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Edit', tool_input: { file_path: long } });
    await ui.waitStatus(a.sid, 'permission');
    expect(ui.of(a.sid).pending?.inputTruncated).toBe(true);
    const res = await ui.cmd({ c: 'perm.approveLowRisk', initiativeId: '*' });
    expect(res.ok).toBe(false);
    expect(ui.of(a.sid).status).toBe('permission');
    await ui.cmd({ c: 'perm.release', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId });
    await ra;
  }, T);

  it('only the confirmed list is approved', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A');
    const b = await session(r, ui, 'B');
    const ra = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Read', tool_input: { file_path: path.join(r.repo, 'a.ts') } });
    const rb = hook(r, b.sid, 'PermissionRequest', { session_id: b.claudeId, tool_name: 'Read', tool_input: { file_path: path.join(r.repo, 'b.ts') } });
    await ui.waitStatus(a.sid, 'permission');
    await ui.waitStatus(b.sid, 'permission');
    expect(await ui.cmd({ c: 'perm.approveLowRisk', initiativeId: '*', requestIds: [ui.of(b.sid).pending!.requestId] })).toEqual({ ok: true });
    expect(JSON.parse((await rb).body.toString())).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    expect(ui.of(a.sid).status).toBe('permission');
    await ui.cmd({ c: 'perm.release', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId });
    await ra;
  }, T);
});

describe('notification policy in the daemon (2.09 / 4.05)', () => {
  it('a new waiting session notifies once; a reload (new connection + snapshot) notifies nothing', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A');
    const held = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await ui.until(() => notifies(ui).length === 1, 5000, 'notify');
    expect(notifies(ui)[0]).toMatchObject({ kind: 'permission', strategosId: a.sid, risk: ['run'] });

    const reloaded = await r.ui(); // a second connection gets hello + snapshot
    expect(reloaded.snapshot?.sessions.find((s) => s.strategosId === a.sid)?.status).toBe('permission');
    await new Promise((res) => setTimeout(res, 400));
    expect(notifies(reloaded)).toEqual([]);
    expect(notifies(ui)).toHaveLength(1);
    const again = await reloaded.cmd({ c: 'resync' });
    expect(again.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(notifies(reloaded)).toEqual([]);

    await ui.cmd({ c: 'perm.release', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId });
    await held;
  }, T);

  it('says nothing for the session a connection is viewing (view.focus), and speaks again when it looks away', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A');
    expect((await ui.cmd({ c: 'view.focus', strategosId: a.sid })).ok).toBe(true);
    const h1 = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Bash', tool_input: { command: 'one' } });
    await ui.waitStatus(a.sid, 'permission');
    await new Promise((res) => setTimeout(res, 300));
    expect(notifies(ui)).toEqual([]);
    expect((await ui.cmd({ c: 'view.focus', strategosId: null })).ok).toBe(true);
    await ui.cmd({ c: 'perm.decide', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId, decision: 'allow' });
    await h1;
    await ui.waitStatus(a.sid, ['working', 'done', 'seen']);
    await new Promise((res) => setTimeout(res, 2600)); // past the 2.5 s window
    const h2 = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Bash', tool_input: { command: 'two' } });
    await ui.until(() => notifies(ui).length === 1, 5000, 'notify after looking away');
    expect(notifies(ui)[0]).toMatchObject({ kind: 'permission', body: 'two' });
    await ui.cmd({ c: 'perm.release', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId });
    await h2;
  }, T);

  it('view.focus on an unknown session is refused; a closed connection stops counting as viewing', async () => {
    const r = await rig();
    const ui = await r.ui();
    expect((await ui.cmd({ c: 'view.focus', strategosId: 'nope' })).ok).toBe(false);
    const a = await session(r, ui, 'A');
    const viewer = await r.ui();
    await viewer.cmd({ c: 'view.focus', strategosId: a.sid });
    viewer.close();
    await new Promise((res) => setTimeout(res, 300));
    const held = hook(r, a.sid, 'PermissionRequest', { session_id: a.claudeId, tool_name: 'Bash', tool_input: { command: 'x' } });
    await ui.until(() => notifies(ui).length === 1, 5000, 'notify');
    await ui.cmd({ c: 'perm.release', strategosId: a.sid, requestId: ui.of(a.sid).pending!.requestId });
    await held;
  }, T);
});

describe('usage (4.08)', () => {
  const line = (pct: number, resetsInSec = 3 * 3600): Record<string, unknown> => ({
    session_id: 'x', rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.round(Date.now() / 1000) + resetsInSec } },
  });
  const post = (r: Rig, sid: string, body: Record<string, unknown>): Promise<Reply> =>
    http(r.daemon.port, { method: 'POST', path: `/statusline/${sid}`, headers: { 'x-strategos-token': r.daemon.manager.tokenFor(sid) ?? '', 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('publishes usage, and a park suggestion once at 85% (never parks by itself)', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await session(r, ui, 'A');
    expect((await post(r, a.sid, line(40))).status).toBe(204);
    await ui.until(() => ui.events.some((e) => e.t === 'usage'), 5000, 'usage');
    const first = ui.events.find((e): e is Extract<DaemonEvent, { t: 'usage' }> => e.t === 'usage')!;
    expect(first.usage.fiveHour?.pct).toBe(40);

    await post(r, a.sid, line(86));
    await ui.until(() => ui.events.some((e) => e.t === 'suggestion'), 5000, 'suggestion');
    await post(r, a.sid, line(90));
    await post(r, a.sid, line(95));
    await new Promise((res) => setTimeout(res, 300));
    const sug = ui.events.filter((e): e is Extract<DaemonEvent, { t: 'suggestion' }> => e.t === 'suggestion');
    expect(sug).toHaveLength(1);
    expect(sug[0]).toMatchObject({ kind: 'park' });
    expect(ui.of(a.sid).status).not.toBe('parked');

    const late = await r.ui();
    expect(late.snapshot?.usage?.fiveHour?.pct).toBe(95);
  }, T);
});
