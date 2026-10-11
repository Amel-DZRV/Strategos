// M6 end to end: a real daemon with fake claude and temporary repositories. gh is a stub; nothing is pushed.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, PrCreate, PrInfo } from '@strategos/shared';
import { startRig, type Rig } from '../daemon.testkit.ts';
import { http } from '../server/testkit.ts';
import { GhError, type Gh } from './gh.ts';
import { g, makeRepo, write } from './git.testkit.ts';

vi.setConfig({ testTimeout: 120_000 });

const rigs: Rig[] = [];
async function rig(o: { gh?: Gh } = {}): Promise<Rig> {
  const r = await startRig({ repo: makeRepo(), daemon: { notifyQuietMs: 0, ...(o.gh === undefined ? {} : { gh: o.gh }) } });
  r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

const lc = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const wtDir = (r: Rig, name: string): string => path.join(r.repo, '.claude', 'worktrees', name);

function hook(r: Rig, sid: string, event: string, body: Record<string, unknown>) {
  return http(r.daemon.port, {
    method: 'POST', path: `/hook/${sid}/${event}`, headers: { 'x-strategos-token': r.daemon.manager.tokenFor(sid) ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, ...body }),
  });
}

describe('session.start with a worktree (6.02)', () => {
  it('creates the worktree on a new branch, starts the session inside it on the repo planet, and adds the exclude only when asked', async () => {
    const r = await rig();
    const ui = await r.ui();
    const plain = await ui.start('Plain', r.repo, 'hi');
    const a = await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'WT', firstPrompt: 'work', worktree: { name: 'w1', branch: 'feat/w1', base: 'main' } });
    expect(a).toEqual({ ok: true });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'WT'), 5000, 'WT');
    const s = ui.byName('WT');
    expect(lc(s.cwd)).toBe(lc(wtDir(r, 'w1')));
    expect(s.worktree).toMatchObject({ branch: 'feat/w1', base: 'main', createdByStrategos: true });
    expect(lc(s.worktree!.path)).toBe(lc(wtDir(r, 'w1')));
    expect(s.planetKey).toBe(plain.planetKey); // one planet for the repo and its worktrees (D10)
    expect(s.branch).toBe('feat/w1');
    await ui.waitStatus(s.strategosId, 'done');
    const exclude = path.join(r.repo, '.git', 'info', 'exclude');
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').not.toContain('.claude/worktrees');

    // second one, with consent for the exclude
    expect((await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'WT2', worktree: { name: 'w2', branch: 'feat/w2', base: 'main', addExclude: true } })).ok).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toContain('.claude/worktrees/');
    const exWrites = r.writes.filter((w) => lc(w).includes('/.git/info/'));
    expect(exWrites.length).toBeGreaterThan(0);
    expect(r.writes.filter((w) => lc(w).includes('/.claude/worktrees/') )).toEqual([]); // the daemon wrote nothing else into the worktrees
  });

  it('a start that cannot create the worktree leaves no session and no folder', async () => {
    const r = await rig();
    const ui = await r.ui();
    g(r.repo, 'branch', 'taken');
    const bad = await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'X', worktree: { name: 'x', branch: 'taken', base: 'main' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/already exists/);
    const nobase = await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'Y', worktree: { name: 'y', branch: 'y', base: 'nope' } });
    expect(nobase.error).toMatch(/does not exist/);
    const badName = await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'Z', worktree: { name: '../escape', branch: 'z', base: 'main' } });
    expect(badName.ok).toBe(false);
    expect(ui.sessions.size).toBe(0);
    expect(existsSync(wtDir(r, 'x'))).toBe(false);
    expect(existsSync(wtDir(r, 'y'))).toBe(false);
  });

  it('live git state: branch, dirty and a diff stat arrive on the record (6.01)', async () => {
    const r = await rig();
    const ui = await r.ui();
    await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'G', firstPrompt: 'go', worktree: { name: 'gg', branch: 'feat/gg', base: 'main' } });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'G'), 5000, 'G');
    const id = ui.byName('G').strategosId;
    await ui.until(() => ui.of(id).git !== undefined, 15_000, 'first git reading');
    expect(ui.of(id).git).toMatchObject({ branch: 'feat/gg', dirty: false });
    write(wtDir(r, 'gg'), 'new.txt', 'a\nb\n');
    await r.daemon.gitPoller.tick();
    await ui.until(() => ui.of(id).git?.dirty === true, 5000, 'dirty');
    expect(ui.of(id).git?.diffStat).toEqual({ files: 1, add: 2, del: 0 });
  });
});

describe('worktree.remove (6.02)', () => {
  it('needs a stopped session, then the typed branch name for a dirty tree and for deleting the branch', async () => {
    const r = await rig();
    const ui = await r.ui();
    await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'R', firstPrompt: 'go', worktree: { name: 'rm', branch: 'feat/rm', base: 'main' } });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'R'), 5000, 'R');
    const id = ui.byName('R').strategosId;
    await ui.waitStatus(id, 'done');
    const dir = wtDir(r, 'rm');
    write(dir, 'wip.txt', 'unsaved\n');

    const live = await ui.cmd({ c: 'worktree.remove', strategosId: id, deleteBranch: false });
    expect(live.error).toMatch(/Stop the session first/);

    await ui.cmd({ c: 'session.stop', strategosId: id });
    await ui.waitStatus(id, 'stopped');
    await ui.until(() => ui.of(id).pty === undefined, 10_000, 'process gone');

    const refused = await ui.cmd({ c: 'worktree.remove', strategosId: id, deleteBranch: true });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('wip.txt');
    expect(refused.error).toContain('feat/rm');
    expect(existsSync(dir)).toBe(true);
    const wrong = await ui.cmd({ c: 'worktree.remove', strategosId: id, deleteBranch: true, confirmText: 'main' });
    expect(wrong.ok).toBe(false);
    expect(existsSync(dir)).toBe(true);

    const done = await ui.cmd({ c: 'worktree.remove', strategosId: id, deleteBranch: true, confirmText: 'feat/rm' });
    expect(done).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect(g(r.repo, 'branch', '--list', 'feat/rm').trim()).toBe('');
    await ui.until(() => ui.of(id).worktree === undefined && ui.of(id).archived, 5000, 'record updated');
  });

  it('a session without a worktree is refused', async () => {
    const r = await rig();
    const ui = await r.ui();
    const s = await ui.start('P', r.repo, 'x');
    await ui.waitStatus(s.strategosId, 'done');
    await ui.cmd({ c: 'session.stop', strategosId: s.strategosId });
    await ui.waitStatus(s.strategosId, 'stopped');
    expect((await ui.cmd({ c: 'worktree.remove', strategosId: s.strategosId, deleteBranch: false })).error).toMatch(/does not run in a worktree/);
  });

  it('worktree.exclude answers with the state and only adds on request', async () => {
    const r = await rig();
    const ui = await r.ui();
    const ask = async (add: boolean): Promise<boolean> => {
      const before = ui.events.length;
      expect((await ui.cmd({ c: 'worktree.exclude', repoPath: r.repo, add })).ok).toBe(true);
      const ev = ui.events.slice(before).find((e): e is Extract<DaemonEvent, { t: 'worktree.exclude' }> => e.t === 'worktree.exclude');
      return ev!.excluded;
    };
    expect(await ask(false)).toBe(false);
    expect(await ask(false)).toBe(false);
    expect(await ask(true)).toBe(true);
    expect(await ask(false)).toBe(true);
  });
});

describe('review (6.03)', () => {
  it('review.get returns the diff against the merge-base; review.sendBack is one user turn', async () => {
    const r = await rig();
    const ui = await r.ui();
    await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'V', firstPrompt: 'go', worktree: { name: 'rv', branch: 'feat/rv', base: 'main' } });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'V'), 5000, 'V');
    const id = ui.byName('V').strategosId;
    await ui.waitStatus(id, 'done');
    const dir = wtDir(r, 'rv');
    write(dir, 'src/a.txt', 'one\nTWO\nthree\n');
    write(dir, 'extra.txt', 'x\ny\nz\n');

    expect((await ui.cmd({ c: 'review.get', strategosId: id })).ok).toBe(true);
    const ev = ui.events.find((e): e is Extract<DaemonEvent, { t: 'review' }> => e.t === 'review');
    expect(ev?.strategosId).toBe(id);
    const rv = ev!.review;
    expect(rv.base).toBe('main');
    expect(rv.head).toBe('feat/rv');
    expect(rv.files.map((f) => f.path).sort()).toEqual(['extra.txt', 'src/a.txt']);
    expect(rv.stat).toEqual({ files: 2, add: 4, del: 1 });
    expect(rv.diff).toContain('+TWO');
    expect((await ui.cmd({ c: 'review.get', strategosId: 'nope' })).ok).toBe(false);

    const sent = await ui.cmd({ c: 'review.sendBack', strategosId: id, text: 'Line 1: rename x\nLine 2: add a test' });
    expect(sent.ok).toBe(true);
    // The fake claude reads lines, so a multi-line paste is several prompts there; the real one takes a bracketed paste as ONE turn (spike S4).
    await ui.until(() => (ui.of(id).last ?? '').includes('add a test'), 15_000, 'reply to the notes');
    await ui.waitStatus(id, 'done');
    expect((await ui.cmd({ c: 'review.sendBack', strategosId: id, text: '   ' })).ok).toBe(false);
  });
});

describe('last test run (6.04)', () => {
  it('is set only by an observed test command: ok after PostToolUse, failed after PostToolUseFailure, absent before', async () => {
    const r = await rig();
    const ui = await r.ui();
    const s = await ui.start('T', r.repo, 'hi');
    await ui.waitStatus(s.strategosId, 'done');
    const sid = s.strategosId;
    const claudeId = ui.of(sid).currentSessionId;
    expect(ui.of(sid).flags.lastTest).toBeUndefined(); // the fake session ran no tests: nothing to show

    await hook(r, sid, 'PostToolUse', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 'a' });
    await hook(r, sid, 'PostToolUse', { session_id: claudeId, tool_name: 'Read', tool_input: { file_path: 'npm test' }, tool_use_id: 'b' });
    await new Promise((res) => setTimeout(res, 150));
    expect(ui.of(sid).flags.lastTest).toBeUndefined(); // not a test command / not Bash

    await hook(r, sid, 'PostToolUse', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'npm test -- --run' }, tool_use_id: 'c' });
    await ui.until(() => ui.of(sid).flags.lastTest?.ok === true, 5000, 'ok');
    expect(ui.of(sid).flags.lastTest).toMatchObject({ command: 'npm test -- --run', ok: true });

    await hook(r, sid, 'PostToolUseFailure', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_use_id: 'd', error: 'Exit code 1', is_interrupt: false });
    await ui.until(() => ui.of(sid).flags.lastTest?.ok === false, 5000, 'failed');
    expect(ui.of(sid).flags.lastTest?.command).toBe('npx vitest run');

    const at = ui.of(sid).flags.lastTest!.at;
    await hook(r, sid, 'PostToolUseFailure', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'pytest' }, tool_use_id: 'e', error: 'interrupted', is_interrupt: true });
    await new Promise((res) => setTimeout(res, 150));
    expect(ui.of(sid).flags.lastTest?.at).toBe(at); // an interrupted run says nothing about the outcome
  });
});

describe('pull requests (6.05)', () => {
  function stubGh(): { gh: Gh; created: PrCreate[]; view: { fn: () => Promise<PrInfo | null> } } {
    const created: PrCreate[] = [];
    const view = { fn: (): Promise<PrInfo | null> => Promise.resolve({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'DRAFT', ci: 'pending' }) };
    const gh: Gh = {
      prCreate: (o) => { created.push(o); return Promise.resolve({ number: 12, url: 'https://github.com/o/r/pull/12', existing: false, pushed: true }); },
      prView: () => view.fn(),
      authStatus: () => Promise.resolve({ ok: true, message: '' }),
    };
    return { gh, created, view };
  }

  it('pr.create runs gh in the session folder, writes the record, and the poller then keeps the CI dot fresh', async () => {
    const s0 = stubGh();
    const r = await rig({ gh: s0.gh });
    const ui = await r.ui();
    await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'PR', firstPrompt: 'go', worktree: { name: 'pr', branch: 'feat/pr', base: 'main' } });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'PR'), 5000, 'PR');
    const id = ui.byName('PR').strategosId;
    const ok = await ui.cmd({ c: 'pr.create', strategosId: id, title: 'Add feature', body: 'Does things', draft: true });
    expect(ok).toEqual({ ok: true });
    expect(s0.created).toHaveLength(1);
    expect(s0.created[0]).toMatchObject({ title: 'Add feature', body: 'Does things', draft: true, base: 'main' });
    expect(lc(s0.created[0]!.cwd)).toBe(lc(wtDir(r, 'pr')));
    await ui.until(() => ui.of(id).pr !== undefined, 5000, 'pr on the record');
    expect(ui.of(id).pr).toMatchObject({ number: 12, state: 'DRAFT' });

    s0.view.fn = () => Promise.resolve({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', ci: 'pass', review: 'approved' });
    await r.daemon.prPoller.tick();
    await ui.until(() => ui.of(id).pr?.ci === 'pass', 5000, 'ci pass');
    expect(ui.of(id).pr).toMatchObject({ state: 'OPEN', review: 'approved', ci: 'pass' });
  });

  it('a gh login problem shows up as a gh.status event and in the next snapshot, and clears itself', async () => {
    const s0 = stubGh();
    const r = await rig({ gh: s0.gh });
    const ui = await r.ui();
    await ui.cmd({ c: 'session.start', repoPath: r.repo, name: 'A', firstPrompt: 'go', worktree: { name: 'au', branch: 'feat/au', base: 'main' } });
    await ui.until(() => [...ui.sessions.values()].some((s) => s.name === 'A'), 5000, 'A');
    const id = ui.byName('A').strategosId;
    await ui.cmd({ c: 'pr.create', strategosId: id, title: 't', body: '', draft: true });
    await ui.until(() => ui.of(id).pr !== undefined, 5000, 'pr');

    s0.view.fn = () => Promise.reject(new GhError('auth', 'gh auth login'));
    await r.daemon.prPoller.tick();
    await ui.until(() => ui.events.some((e) => e.t === 'gh.status' && e.needsLogin), 5000, 'gh.status');
    const ui2 = await r.ui();
    expect(ui2.snapshot?.prefs.ghNeedsLogin).toBe(true);

    // create fails the same way: the person is told, and nothing is recorded
    s0.gh.prCreate = () => Promise.reject(new GhError('auth', 'gh pr create: not logged in'));
    const bad = await ui.cmd({ c: 'pr.create', strategosId: id, title: 't2', body: '', draft: true });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not logged in/);
  });
});
