// 6.06 end to end: real daemon, fake claude, temporary repositories. Nothing is pushed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@strategos/shared';
import { startRig, type Rig, type UiClient } from '../daemon.testkit.ts';
import { g, makeRepo } from '../git/git.testkit.ts';

vi.setConfig({ testTimeout: 120_000 });

const rigs: Rig[] = [];
async function rig(): Promise<Rig> {
  const r = await startRig({ repo: makeRepo(), daemon: { notifyQuietMs: 0, polling: { suggestMs: 50 } } });
  r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

const suggestions = (ui: UiClient): Extract<DaemonEvent, { t: 'suggestion' }>[] =>
  ui.events.filter((e): e is Extract<DaemonEvent, { t: 'suggestion' }> => e.t === 'suggestion' && e.kind === 'initiative');

/** suggestion.respond reuses the suggestion id as the command id (protocol 1), so it cannot go through ui.cmd, which makes up its own ids. */
async function respond(ui: UiClient, id: string, accept: boolean): Promise<{ ok: boolean; error?: string }> {
  const before = ui.events.length;
  ui.ws.send(JSON.stringify({ id, c: 'suggestion.respond', accept }));
  await ui.until(() => ui.events.slice(before).some((e) => e.t === 'ack' && e.id === id), 5000, 'ack');
  const a = ui.events.slice(before).find((e) => e.t === 'ack' && e.id === id) as Extract<DaemonEvent, { t: 'ack' }>;
  return { ok: a.ok, ...(a.error === undefined ? {} : { error: a.error }) };
}

async function startWt(r: Rig, ui: UiClient, name: string, branch: string): Promise<string> {
  const a = await ui.cmd({ c: 'session.start', repoPath: r.repo, name, worktree: { name: branch.replace('/', '-'), branch, base: 'main' } });
  expect(a).toEqual({ ok: true });
  await ui.until(() => [...ui.sessions.values()].some((s) => s.name === name), 5000, name);
  return ui.byName(name).strategosId;
}

describe('initiatives (6.06)', () => {
  it('upsert and assign are persisted in the daemon state and broadcast', async () => {
    const r = await rig();
    const ui = await r.ui();
    const s = await ui.start('A', r.repo, 'hi');
    const ini = { id: 'i1', name: 'Checkout', colour: '#33aa66', createdAt: 1, contractFiles: [{ planetKey: s.planetKey, relPath: 'api/schema.json' }], archived: false };
    expect((await ui.cmd({ c: 'initiative.upsert', initiative: ini })).ok).toBe(true);
    await ui.until(() => ui.events.some((e) => e.t === 'initiatives' && e.initiatives.length === 1), 5000, 'initiatives event');
    expect(r.daemon.manager.snapshot().initiatives).toEqual([ini]);

    expect((await ui.cmd({ c: 'initiative.upsert', initiative: { ...ini, id: 'bad', name: ' ' } })).ok).toBe(false);
    expect((await ui.cmd({ c: 'initiative.upsert', initiative: { ...ini, id: 'bad', contractFiles: [{ planetKey: 'p', relPath: '../x' }] } })).ok).toBe(false);

    expect((await ui.cmd({ c: 'initiative.assign', strategosId: s.strategosId, initiativeId: 'i1' })).ok).toBe(true);
    await ui.until(() => ui.of(s.strategosId).initiativeId === 'i1', 5000, 'assigned');
    expect(ui.of(s.strategosId).ringSlotByGroup['i1']).toBe(0);
    expect((await ui.cmd({ c: 'initiative.assign', strategosId: s.strategosId, initiativeId: 'nope' })).ok).toBe(false);
    expect((await ui.cmd({ c: 'initiative.assign', strategosId: s.strategosId, initiativeId: null })).ok).toBe(true);
    await ui.until(() => ui.of(s.strategosId).initiativeId === undefined, 5000, 'cleared');

    // a second client sees the initiative in its snapshot
    const ui2 = await r.ui();
    expect(ui2.snapshot?.initiatives.map((i) => i.id)).toEqual(['i1']);
  });

  it('two sessions on matching branches raise a suggestion that changes nothing until accepted', async () => {
    const r = await rig();
    const ui = await r.ui();
    const a = await startWt(r, ui, 'UI', 'feat/checkout-ui');
    const b = await startWt(r, ui, 'API', 'feat/checkout-api');
    await ui.until(() => suggestions(ui).length > 0, 10_000, 'suggestion');
    const sug = suggestions(ui).at(-1)!;
    expect(sug.strategosIds.sort()).toEqual([a, b].sort());
    expect(ui.of(a).initiativeId).toBeUndefined();
    expect(r.daemon.manager.snapshot().initiatives).toEqual([]);

    expect((await respond(ui, sug.id, true)).ok).toBe(true);
    await ui.until(() => ui.of(a).initiativeId !== undefined && ui.of(b).initiativeId !== undefined, 5000, 'assigned');
    const [ini] = r.daemon.manager.snapshot().initiatives;
    expect(ini?.name).toBe('Checkout');
    expect(ui.of(a).initiativeId).toBe(ini?.id);
    expect((await respond(ui, sug.id, true)).ok).toBe(false); // already answered
  });

  it('a dismissed suggestion is not offered again', async () => {
    const r = await rig();
    const ui = await r.ui();
    await startWt(r, ui, 'UI', 'feat/billing-ui');
    await startWt(r, ui, 'API', 'feat/billing-api');
    await ui.until(() => suggestions(ui).length > 0, 10_000, 'suggestion');
    const sug = suggestions(ui)[0]!;
    expect((await respond(ui, sug.id, false)).ok).toBe(true);
    await startWt(r, ui, 'Docs', 'feat/billing-docs');
    await new Promise((res) => setTimeout(res, 600)); // longer than the debounce
    expect(suggestions(ui)).toHaveLength(1);
    expect(r.daemon.manager.snapshot().initiatives).toEqual([]);
  });
});

describe('mission.start (6.06)', () => {
  it('starts several sessions in new worktrees tagged with the initiative; the first leads', async () => {
    const r = await rig();
    const ui = await r.ui();
    await ui.cmd({ c: 'initiative.upsert', initiative: { id: 'm1', name: 'Mission', colour: '#336699', createdAt: 1, contractFiles: [], archived: false } });
    const res = await ui.cmd({
      c: 'mission.start', initiativeId: 'm1',
      sessions: [{ repoPath: r.repo, branch: 'feat/m-one', firstPrompt: 'part one' }, { repoPath: r.repo, branch: 'feat/m-two', firstPrompt: 'part two' }],
    });
    expect(res).toEqual({ ok: true });
    await ui.until(() => ui.sessions.size === 2, 5000, 'two sessions');
    const [lead, other] = [...ui.sessions.values()].sort((x, y) => x.createdAt - y.createdAt);
    expect(lead?.worktree?.branch).toBe('feat/m-one');
    expect(other?.worktree?.branch).toBe('feat/m-two');
    expect(lead?.initiativeId).toBe('m1');
    expect(other?.initiativeId).toBe('m1');
    expect(lead?.parentId).toBeUndefined();
    expect(other?.parentId).toBe(lead?.strategosId);
    expect(lead?.cwd).not.toBe(other?.cwd);
    await ui.waitStatus(lead!.strategosId, 'done');
    await ui.waitStatus(other!.strategosId, 'done');
  });

  it('reports a partial failure but keeps the sessions that started', async () => {
    const r = await rig();
    const ui = await r.ui();
    g(r.repo, 'branch', 'feat/exists');
    await ui.cmd({ c: 'initiative.upsert', initiative: { id: 'm2', name: 'Half', colour: '#336699', createdAt: 1, contractFiles: [], archived: false } });
    const res = await ui.cmd({
      c: 'mission.start', initiativeId: 'm2',
      sessions: [{ repoPath: r.repo, branch: 'feat/exists', firstPrompt: 'a' }, { repoPath: r.repo, branch: 'feat/fresh', firstPrompt: 'b' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Started 1 of 2/);
    expect(res.error).toMatch(/feat\/exists.*already exists/);
    await ui.until(() => ui.sessions.size === 1, 30_000, 'one session');
    expect([...ui.sessions.values()][0]?.worktree?.branch).toBe('feat/fresh');
    expect((await ui.cmd({ c: 'mission.start', initiativeId: 'nope', sessions: [{ repoPath: r.repo, branch: 'x', firstPrompt: 'p' }] })).ok).toBe(false);
  });
});
