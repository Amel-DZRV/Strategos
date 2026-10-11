import { describe, expect, it } from 'vitest';
import type { HookMachineInput, MachineInput, SessionRecord } from '@strategos/shared';
import { isNeedsYou } from '@strategos/shared';
import { DRIFT_MS, INTERRUPT_DROP_MS, QUIET_MS, reduce } from './state-machine.ts';
import { applySessionStart, sumLineageCost, withSessionCost } from './identity.ts';
import { T0, effectsOf, hookIn, makePending, makeSession, obs, run, transitions } from './state-machine.testkit.ts';

const H = (hook: HookMachineInput): MachineInput => hookIn(hook);

describe('table: status after a hook event (rows of section 6)', () => {
  type Row = [name: string, from: Partial<SessionRecord>, hook: HookMachineInput, status: SessionRecord['status']];
  const rows: Row[] = [
    ['starting + SessionStart(startup, firstPrompt) -> working', { status: 'starting', launch: { addDirs: [], extraArgs: [], firstPrompt: 'hi' } }, { event: 'SessionStart', source: 'startup' }, 'working'],
    ['starting + SessionStart(startup) -> seen (idle at an empty prompt)', { status: 'starting' }, { event: 'SessionStart', source: 'startup' }, 'seen'],
    ['trust_pending + SessionStart(startup) -> seen', { status: 'trust_pending' }, { event: 'SessionStart', source: 'startup' }, 'seen'],
    ['working + SessionStart(startup) -> unchanged', { status: 'working' }, { event: 'SessionStart', source: 'startup' }, 'working'],
    ['starting + SessionStart(compact) -> working', { status: 'starting' }, { event: 'SessionStart', source: 'compact' }, 'working'],
    ['working + SessionStart(compact) -> unchanged', { status: 'working' }, { event: 'SessionStart', source: 'compact' }, 'working'],
    ['working + SessionStart(clear) -> done', {}, { event: 'SessionStart', source: 'clear' }, 'done'],
    ['working + SessionStart(resume) -> done', {}, { event: 'SessionStart', source: 'resume' }, 'done'],
    ['working + SessionStart(fork) -> done', {}, { event: 'SessionStart', source: 'fork' }, 'done'],
    ['done + UserPromptSubmit -> working', { status: 'done' }, { event: 'UserPromptSubmit' }, 'working'],
    ['seen + UserPromptSubmit -> working', { status: 'seen' }, { event: 'UserPromptSubmit' }, 'working'],
    ['interrupted + UserPromptSubmit -> working', { status: 'interrupted' }, { event: 'UserPromptSubmit' }, 'working'],
    ['errored + UserPromptSubmit -> working', { status: 'errored' }, { event: 'UserPromptSubmit' }, 'working'],
    ['starting + UserPromptSubmit -> working', { status: 'starting' }, { event: 'UserPromptSubmit' }, 'working'],
    ['done + PreToolUse -> working', { status: 'done' }, { event: 'PreToolUse', tool: 'Bash', summary: 'ls' }, 'working'],
    ['trust_pending + PostToolUse -> working', { status: 'trust_pending' }, { event: 'PostToolUse', tool: 'Bash' }, 'working'],
    ['working + PreCompact -> working', { status: 'seen' }, { event: 'PreCompact' }, 'working'],
    ['working + PostCompact -> unchanged', {}, { event: 'PostCompact' }, 'working'],
    ['working + PermissionRequest -> permission', {}, { event: 'PermissionRequest', pending: makePending() }, 'permission'],
    ['working + PreToolUse(AUQ, pending) -> question', {}, { event: 'PreToolUse', tool: 'AskUserQuestion', summary: 'q', pending: makePending({ kind: 'question', toolName: 'AskUserQuestion' }) }, 'question'],
    ['working + Notification(elicitation_dialog) -> question (held:false)', {}, { event: 'Notification', notificationType: 'elicitation_dialog', pending: makePending({ kind: 'question', held: false }) }, 'question'],
    ['working + Notification(elicitation, no type) -> question', {}, { event: 'Notification', pending: makePending({ kind: 'question', held: false }) }, 'question'],
    ['working + Notification(idle_prompt) -> unchanged', {}, { event: 'Notification', notificationType: 'idle_prompt' }, 'working'],
    ['starting + Notification -> working (any hook leaves starting)', { status: 'starting' }, { event: 'Notification' }, 'working'],
    ['working + Stop -> done', {}, { event: 'Stop', lastMessage: 'ok' }, 'done'],
    ['interrupted + Stop -> done', { status: 'interrupted' }, { event: 'Stop' }, 'done'],
    ['working + StopFailure -> errored', {}, { event: 'StopFailure', error: 'rate_limit' }, 'errored'],
    ['working + PostToolUseFailure(is_interrupt) -> interrupted', {}, { event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: true }, 'interrupted'],
    ['working + PostToolUseFailure(real failure) -> working', {}, { event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: false }, 'working'],
    ['working + SessionEnd(prompt_input_exit) -> stopped', {}, { event: 'SessionEnd', reason: 'prompt_input_exit' }, 'stopped'],
    ['working + SessionEnd(other) -> stopped', {}, { event: 'SessionEnd', reason: 'other' }, 'stopped'],
    ['working + SessionEnd(logout) -> stopped', {}, { event: 'SessionEnd', reason: 'logout' }, 'stopped'],
    ['working + SessionEnd(clear) -> working (lineage continues)', {}, { event: 'SessionEnd', reason: 'clear' }, 'working'],
    ['working + SessionEnd(resume) -> working', {}, { event: 'SessionEnd', reason: 'resume' }, 'working'],
    ['working + CwdChanged -> working', {}, { event: 'CwdChanged', newCwd: '/other' }, 'working'],
    ['stopped + PreToolUse -> stopped (not live: hooks carry no status)', { status: 'stopped', pty: undefined }, { event: 'PreToolUse', tool: 'Bash', summary: 'ls' }, 'stopped'],
    ['parked + Stop -> parked', { status: 'parked', pty: undefined }, { event: 'Stop' }, 'parked'],
    ['open_elsewhere + Stop -> open_elsewhere', { status: 'open_elsewhere', pty: undefined }, { event: 'Stop' }, 'open_elsewhere'],
  ];
  it.each(rows)('%s', (_name, from, hook, status) => {
    const { next } = run(makeSession(from), H(hook));
    expect(next.status).toBe(status);
  });
});

describe('hook details', () => {
  it('permission: sets pending, hook source, waitingSince, and a notify effect', () => {
    const p = makePending();
    const { next, effects } = run(makeSession(), H({ event: 'PermissionRequest', pending: p }));
    expect(next.pending).toEqual(p);
    expect(next.statusSource).toBe('hook');
    expect(next.waitingSince).toBe(T0);
    expect(effectsOf(effects, 'notify')).toEqual([expect.objectContaining({ kind: 'permission', requestId: 'r1', body: 'npm test' })]);
    expect(effects.at(-1)).toEqual({ e: 'persist' });
  });

  it('question: AskUserQuestion pending notifies as question', () => {
    const p = makePending({ kind: 'question', toolName: 'AskUserQuestion' });
    const { effects } = run(makeSession(), H({ event: 'PreToolUse', tool: 'AskUserQuestion', summary: 'q', pending: p }));
    expect(effectsOf(effects, 'notify')[0]?.kind).toBe('question');
  });

  it('AskUserQuestion PreToolUse without pending changes nothing', () => {
    const s = makeSession({ status: 'done' });
    const { next } = run(s, H({ event: 'PreToolUse', tool: 'AskUserQuestion', summary: 'q' }));
    expect(next.status).toBe('done');
  });

  it('PreToolUse records now; PostToolUse clears it and keeps the test result', () => {
    const a = run(makeSession(), H({ event: 'PreToolUse', tool: 'Bash', summary: 'npm test' })).next;
    expect(a.now).toEqual({ tool: 'Bash', summary: 'npm test', since: T0 });
    const b = run(a, H({ event: 'PostToolUse', tool: 'Bash', testResult: { command: 'npm test', ok: true } }), T0 + 5).next;
    expect(b.now).toBeUndefined();
    expect(b.flags.lastTest).toEqual({ command: 'npm test', ok: true, at: T0 + 5 });
  });

  it('PreCompact shows a compact now; PostCompact clears it', () => {
    const a = run(makeSession(), H({ event: 'PreCompact' })).next;
    expect(a.now?.tool).toBe('compact');
    expect(run(a, H({ event: 'PostCompact' })).next.now).toBeUndefined();
  });

  it('CwdChanged without a path leaves cwd alone', () => {
    expect(run(makeSession(), H({ event: 'CwdChanged' })).next.cwd).toBe('/repo');
    expect(run(makeSession(), H({ event: 'CwdChanged', newCwd: '/x' })).next.cwd).toBe('/x');
  });

  it('hook base fields update model, permission mode and effort', () => {
    const { next } = run(makeSession(), H({ event: 'PostCompact', model: 'm', permissionMode: 'plan', effort: 'high' }));
    expect([next.model, next.permissionMode, next.effort]).toEqual(['m', 'plan', 'high']);
  });

  it('UserPromptSubmit clears the previous turn flags and a terminal-only pending', () => {
    const s = makeSession({ status: 'permission', pending: makePending({ held: false }), lastIsQuestion: true, interruptPendingAt: T0 - 1, now: { tool: 'x', summary: 'y', since: 1 } });
    const { next } = run(s, H({ event: 'UserPromptSubmit' }));
    expect(next).toMatchObject({ status: 'working', pending: undefined, lastIsQuestion: false, interruptPendingAt: undefined, now: undefined });
    expect(next.waitingSince).toBeUndefined();
  });

  it('a held-false pending is cleared by a later hook (rule 1 lets H clear)', () => {
    const s = makeSession({ status: 'permission', statusSource: 'reconciler', pending: makePending({ held: false }) });
    expect(run(s, H({ event: 'PostToolUse', tool: 'Bash' })).next).toMatchObject({ status: 'working', pending: undefined });
    expect(run(s, H({ event: 'Stop' })).next).toMatchObject({ status: 'done', pending: undefined });
    expect(run(s, H({ event: 'StopFailure' })).next).toMatchObject({ status: 'errored', pending: undefined });
  });

  it('SessionEnd clears pending when not held', () => {
    const s = makeSession({ status: 'permission', pending: makePending({ held: false }) });
    expect(run(s, H({ event: 'SessionEnd', reason: 'other' })).next).toMatchObject({ status: 'stopped', pending: undefined });
  });

  it('PermissionRequest with agentId marks the pending as the subagent’s and still blocks (rule 3 exception)', () => {
    const p = makePending({ agentId: 'a1' });
    const { next } = run(makeSession(), H({ event: 'PermissionRequest', agentId: 'a1', pending: p }));
    expect(next.status).toBe('permission');
    expect(next.pending?.agentId).toBe('a1');
  });

  it('AskUserQuestion from a subagent blocks too', () => {
    const p = makePending({ kind: 'question', agentId: 'a1', toolName: 'AskUserQuestion' });
    const { next } = run(makeSession(), H({ event: 'PreToolUse', agentId: 'a1', tool: 'AskUserQuestion', summary: 'q', pending: p }));
    expect(next.status).toBe('question');
  });
});

describe('rule 6: lastIsQuestion', () => {
  it.each([
    ['Shall I continue?', true],
    ['Shall I continue?  \n', true],
    ['Done.', false],
  ])('Stop %j -> lastIsQuestion %s, status stays done', (msg, expected) => {
    const { next } = run(makeSession(), H({ event: 'Stop', lastMessage: msg }));
    expect(next.status).toBe('done');
    expect(next.lastIsQuestion).toBe(expected);
  });

  it('keeps the first 160 characters as last', () => {
    const { next } = run(makeSession(), H({ event: 'Stop', lastMessage: 'x'.repeat(500) + '?' }));
    expect(next.last).toHaveLength(160);
    expect(next.lastIsQuestion).toBe(true);
  });

  it('Stop without a message leaves last alone and clears the badge', () => {
    const { next } = run(makeSession({ last: 'old', lastIsQuestion: true }), H({ event: 'Stop' }));
    expect(next.last).toBe('old');
    expect(next.lastIsQuestion).toBe(false);
  });
});

describe('done and seen', () => {
  it('Stop sets doneAt and notifies once', () => {
    const { next, effects } = run(makeSession(), H({ event: 'Stop', lastMessage: 'finished' }));
    expect(next.doneAt).toBe(T0);
    expect(effectsOf(effects, 'notify')).toEqual([expect.objectContaining({ kind: 'done', body: 'finished' })]);
    expect(isNeedsYou(next)).toBe(true);
  });

  it('a second Stop while already done does not notify again', () => {
    const s = makeSession({ status: 'done', doneAt: T0 - 5 });
    expect(effectsOf(run(s, H({ event: 'Stop' })).effects, 'notify')).toEqual([]);
  });

  it('notify body falls back when there is no last message', () => {
    expect(effectsOf(run(makeSession(), H({ event: 'Stop' })).effects, 'notify')[0]?.body).toBe('Finished');
  });

  it('U seen: done -> seen with seenAt >= doneAt, no longer needs you', () => {
    const done = run(makeSession(), H({ event: 'Stop' }), T0).next;
    const { next } = run(done, { k: 'user', u: { cmd: 'seen' } }, T0 + 2000);
    expect(next).toMatchObject({ status: 'seen', statusSource: 'user', seenAt: T0 + 2000, waitingSince: undefined });
    expect(isNeedsYou(next)).toBe(false);
  });

  it('U seen also dismisses interrupted', () => {
    expect(run(makeSession({ status: 'interrupted' }), { k: 'user', u: { cmd: 'seen' } }).next.status).toBe('seen');
  });

  it('U seen on a working session is ignored', () => {
    const s = makeSession();
    expect(run(s, { k: 'user', u: { cmd: 'seen' } }).next).toBe(s);
  });

  it('new activity re-arms: seen -> working -> Stop is done and unseen again', () => {
    let s = run(makeSession({ status: 'seen', doneAt: 1, seenAt: 5 }), H({ event: 'UserPromptSubmit' }), T0).next;
    expect(s.status).toBe('working');
    s = run(s, H({ event: 'Stop' }), T0 + 100).next;
    expect(isNeedsYou(s)).toBe(true);
    expect(s.seenAt).toBeLessThan(s.doneAt as number);
  });
});

describe('interrupted', () => {
  const esc = (fromStrategos = false): MachineInput => ({ k: 'pty.key', key: 'esc', fromStrategos });

  it.each(['working', 'permission'] as const)('Esc while %s sets interruptPendingAt and no status change', (status) => {
    const s = makeSession({ status, pending: status === 'permission' ? makePending() : undefined });
    const { next } = run(s, esc());
    expect(next.status).toBe(status);
    expect(next.interruptPendingAt).toBe(T0);
  });

  it('Ctrl+C is treated like Esc', () => {
    expect(run(makeSession(), { k: 'pty.key', key: 'ctrl_c', fromStrategos: false }).next.interruptPendingAt).toBe(T0);
  });

  it.each(['done', 'seen', 'starting', 'errored'] as const)('Esc while %s is ignored', (status) => {
    const s = makeSession({ status });
    expect(run(s, esc()).next).toBe(s);
  });

  it('keys sent by Strategos itself (stop sequence) are not interrupts', () => {
    const s = makeSession();
    expect(run(s, esc(true)).next).toBe(s);
  });

  it('confirmed by a transcript marker', () => {
    const s = makeSession({ interruptPendingAt: T0 - 1000 });
    const { next, effects } = run(s, { k: 'transcript', signal: 'interrupt_marker' });
    expect(next).toMatchObject({ status: 'interrupted', statusSource: 'transcript', interruptPendingAt: undefined });
    expect(effectsOf(effects, 'chat.marker')).toEqual([{ e: 'chat.marker', marker: 'interrupted' }]);
    expect(isNeedsYou(next)).toBe(true);
  });

  it('confirmed by PostToolUseFailure is_interrupt (hook source)', () => {
    const s = makeSession({ interruptPendingAt: T0 - 1000 });
    const { next } = run(s, H({ event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: true }));
    expect(next).toMatchObject({ status: 'interrupted', statusSource: 'hook', interruptPendingAt: undefined });
  });

  it('a second is_interrupt failure while interrupted adds no second marker', () => {
    const s = makeSession({ status: 'interrupted' });
    expect(effectsOf(run(s, H({ event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: true })).effects, 'chat.marker')).toEqual([]);
  });

  it('confirmed by reconciler idle within 5 s', () => {
    const s = makeSession({ interruptPendingAt: T0 - 4000, lastActivityAt: T0 - 1000 }); // not even quiet
    const { next } = run(s, { k: 'reconciler', obs: obs({ status: 'idle' }) });
    expect(next).toMatchObject({ status: 'interrupted', statusSource: 'reconciler' });
  });

  it('reconciler idle later than 5 s after Esc does not confirm (and is plain inference instead)', () => {
    const s = makeSession({ interruptPendingAt: T0 - 6000, lastActivityAt: T0 - 1000 });
    expect(run(s, { k: 'reconciler', obs: obs({ status: 'idle' }) }).next.status).toBe('working');
  });

  it('dropped after 10 s when nothing confirms it', () => {
    const s = makeSession({ interruptPendingAt: T0 });
    const keep = run(s, { k: 'tick' }, T0 + INTERRUPT_DROP_MS - 1).next;
    expect(keep.interruptPendingAt).toBe(T0);
    const { next, effects } = run(s, { k: 'tick' }, T0 + INTERRUPT_DROP_MS);
    expect(next.interruptPendingAt).toBeUndefined();
    expect(next.status).toBe('working');
    expect(effectsOf(effects, 'log').some((l) => l.data.why === 'interrupt_unconfirmed')).toBe(true);
  });

  it('a marker with no pty flag is only inference: needs working and 10 s of hook silence', () => {
    const marker: MachineInput = { k: 'transcript', signal: 'interrupt_marker' };
    expect(run(makeSession({ lastActivityAt: T0 - 1000 }), marker).next.status).toBe('working');
    expect(run(makeSession({ status: 'done' }), marker).next.status).toBe('done');
    expect(run(makeSession(), marker).next.status).toBe('interrupted');
  });

  it('a marker never clears a pending request (rule 1)', () => {
    const s = makeSession({ status: 'permission', pending: makePending(), interruptPendingAt: T0 - 100 });
    expect(run(s, { k: 'transcript', signal: 'interrupt_marker' }).next.status).toBe('permission');
  });
});

describe('errored, stopped, parked', () => {
  const exit = (code: number | null, after?: 'stop' | 'park'): MachineInput => ({ k: 'pty.exit', code, after });

  it('StopFailure -> errored with a notification carrying the error', () => {
    const { next, effects } = run(makeSession(), H({ event: 'StopFailure', error: 'rate_limit', lastMessage: 'boom' }));
    expect(next).toMatchObject({ status: 'errored', last: 'boom' });
    expect(effectsOf(effects, 'notify')[0]).toMatchObject({ kind: 'errored', body: 'rate_limit' });
  });

  it('StopFailure without an error uses a generic body and keeps last', () => {
    const { effects, next } = run(makeSession({ last: 'prev' }), H({ event: 'StopFailure' }));
    expect(effectsOf(effects, 'notify')[0]?.body).toBe('The turn failed');
    expect(next.last).toBe('prev');
  });

  it('exit code != 0 without SessionEnd while not stopping -> errored', () => {
    const { next, effects } = run(makeSession(), exit(1));
    expect(next).toMatchObject({ status: 'errored', statusSource: 'pty', exitCode: 1, pty: undefined });
    expect(effectsOf(effects, 'notify')[0]?.body).toContain('code 1');
  });

  it('a signal exit (null code) is errored too', () => {
    const { next, effects } = run(makeSession(), exit(null));
    expect(next.status).toBe('errored');
    expect(next.exitCode).toBeUndefined();
    expect(effectsOf(effects, 'notify')[0]?.body).toContain('signal');
  });

  it('exit 0 -> stopped', () => {
    expect(run(makeSession(), exit(0)).next.status).toBe('stopped');
  });

  it('exit after our stop request -> stopped, even with a nonzero code', () => {
    expect(run(makeSession(), exit(1, 'stop')).next.status).toBe('stopped');
  });

  it('exit after our park request -> parked', () => {
    expect(run(makeSession(), exit(0, 'park')).next.status).toBe('parked');
  });

  it('SessionEnd then a nonzero exit stays stopped (SessionEnd seen)', () => {
    const ended = run(makeSession(), H({ event: 'SessionEnd', reason: 'prompt_input_exit' })).next;
    expect(run(ended, exit(1)).next.status).toBe('stopped');
  });

  it('SessionEnd then an exit that we asked to be a park becomes parked', () => {
    const ended = run(makeSession(), H({ event: 'SessionEnd', reason: 'other' })).next;
    expect(run(ended, exit(0, 'park')).next.status).toBe('parked');
  });

  it('parked and open_elsewhere keep their status on exit', () => {
    expect(run(makeSession({ status: 'parked', pty: undefined }), exit(1)).next.status).toBe('parked');
    expect(run(makeSession({ status: 'open_elsewhere', pty: undefined }), exit(1)).next.status).toBe('open_elsewhere');
  });

  it('exit ends running subagents and clears now', () => {
    const s = makeSession({ now: { tool: 'x', summary: 'y', since: 1 }, subagents: [{ agentId: 'a', running: true, startedAt: 1 }, { agentId: 'b', running: false, startedAt: 1, endedAt: 2 }] });
    const { next } = run(s, exit(0));
    expect(next.subagents.map((a) => a.running)).toEqual([false, false]);
    expect(next.subagents[0]?.endedAt).toBe(T0);
    expect(next.now).toBeUndefined();
  });

  it('U stop with a live pty asks the manager to kill it; status waits for the exit', () => {
    const s = makeSession();
    const { next, effects } = run(s, { k: 'user', u: { cmd: 'stop' } });
    expect(next).toBe(s);
    expect(effects).toEqual([{ e: 'pty.kill', park: false }]);
  });

  it('U park asks for park', () => {
    expect(run(makeSession(), { k: 'user', u: { cmd: 'park' } }).effects).toEqual([{ e: 'pty.kill', park: true }]);
  });

  it('U stop/park without a pty settles directly', () => {
    expect(run(makeSession({ pty: undefined, status: 'errored' }), { k: 'user', u: { cmd: 'stop' } }).next.status).toBe('stopped');
    expect(run(makeSession({ pty: undefined, status: 'stopped' }), { k: 'user', u: { cmd: 'park' } }).next.status).toBe('parked');
  });

  it.each(['start', 'resume'] as const)('U %s from stopped/parked/errored -> starting + spawn', (cmd) => {
    for (const status of ['stopped', 'parked', 'errored'] as const) {
      const s = makeSession({ status, pty: undefined, exitCode: 1, pending: undefined });
      const { next, effects } = run(s, { k: 'user', u: { cmd } });
      expect(next).toMatchObject({ status: 'starting', statusSource: 'user', exitCode: undefined, statusSince: T0, lastActivityAt: T0 });
      expect(effectsOf(effects, 'spawn')).toEqual([{ e: 'spawn', resume: cmd === 'resume' }]);
    }
  });

  it('U start while the pty is alive, or while open_elsewhere, is refused (single writer)', () => {
    const live = makeSession();
    const a = run(live, { k: 'user', u: { cmd: 'resume' } });
    expect(a.next).toBe(live);
    expect(effectsOf(a.effects, 'spawn')).toEqual([]);
    const other = makeSession({ status: 'open_elsewhere', pty: undefined });
    expect(effectsOf(run(other, { k: 'user', u: { cmd: 'resume' } }).effects, 'spawn')).toEqual([]);
  });

  it('daemon.restart: everything becomes stopped except parked; pending and pty are dropped', () => {
    const s = makeSession({ status: 'permission', pending: makePending(), subagents: [{ agentId: 'a', running: true, startedAt: 1 }], now: { tool: 'x', summary: 'y', since: 1 } });
    const { next } = run(s, { k: 'daemon.restart' });
    expect(next).toMatchObject({ status: 'stopped', pending: undefined, pty: undefined, now: undefined });
    expect(next.subagents[0]?.running).toBe(false);
    expect(run(makeSession({ status: 'parked', pty: undefined, subagents: [{ agentId: 'z', running: false, startedAt: 1, endedAt: 2 }] }), { k: 'daemon.restart' }).next.status).toBe('parked');
    expect(run(makeSession({ status: 'open_elsewhere', pty: undefined }), { k: 'daemon.restart' }).next.status).toBe('stopped');
  });
});

describe('trust_pending', () => {
  it('pty text matching the trust dialog while starting', () => {
    const { next } = run(makeSession({ status: 'starting' }), { k: 'pty.trust_dialog' });
    expect(next).toMatchObject({ status: 'trust_pending', statusSource: 'pty' });
    expect(isNeedsYou(next)).toBe(true);
  });

  it('pty trust text in any other state is ignored', () => {
    const s = makeSession();
    expect(run(s, { k: 'pty.trust_dialog' }).next).toBe(s);
  });

  it('reconciler waitingFor "dialog open" within 20 s of spawn', () => {
    const s = makeSession({ status: 'starting', statusSince: T0 - 19_000, lastActivityAt: T0 - 19_000 });
    const { next } = run(s, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'dialog open' }) });
    expect(next).toMatchObject({ status: 'trust_pending', statusSource: 'reconciler' });
  });

  it('... but not later than 20 s, nor when a hook already arrived', () => {
    const late = makeSession({ status: 'starting', statusSince: T0 - 21_000 });
    expect(run(late, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'dialog open' }) }).next.status).toBe('starting');
    const working = makeSession({ status: 'working', statusSince: T0 - 1000 });
    expect(run(working, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'dialog open' }) }).next.status).toBe('working');
  });

  it('the first hook leaves trust_pending', () => {
    expect(run(makeSession({ status: 'trust_pending' }), H({ event: 'SessionStart', source: 'startup', claudeSessionId: 'c1' })).next.status).not.toBe('trust_pending');
  });
});

describe('permission and question', () => {
  it('reconciler "permission prompt" with no hook -> permission with held:false', () => {
    const s = makeSession({ now: { tool: 'Write', summary: 'a.ts', since: 1 } });
    const { next, effects } = run(s, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'permission prompt' }) });
    expect(next).toMatchObject({ status: 'permission', statusSource: 'reconciler' });
    expect(next.pending).toMatchObject({ kind: 'permission', held: false, toolName: 'Write', inputSummary: 'a.ts' });
    expect(effectsOf(effects, 'notify')).toHaveLength(1);
  });

  it('synthesised pending has sensible defaults without a known tool', () => {
    const { next } = run(makeSession(), { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'permission prompt' }) });
    expect(next.pending).toMatchObject({ toolName: 'unknown' });
  });

  it('reconciler permission is held back while a hook was heard within 10 s (rule 2)', () => {
    const s = makeSession({ lastActivityAt: T0 - (QUIET_MS - 1) });
    expect(run(s, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'permission prompt' }) }).next.status).toBe('working');
  });

  it('reconciler waiting with another reason does nothing', () => {
    const s = makeSession();
    expect(run(s, { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'something else' }) }).next).toBe(s);
    expect(run(s, { k: 'reconciler', obs: obs({ status: 'waiting' }) }).next).toBe(s);
  });

  it('held request: decide(allow) responds, audits, and returns to working', () => {
    const s = makeSession({ status: 'permission', pending: makePending(), waitingSince: T0 - 10 });
    const d = { kind: 'allow', via: 'strip' } as const;
    const { next, effects } = run(s, { k: 'user', u: { cmd: 'decide', requestId: 'r1', decision: d } });
    expect(next).toMatchObject({ status: 'working', statusSource: 'user', pending: undefined, waitingSince: undefined });
    expect(effectsOf(effects, 'hook.respond')).toEqual([{ e: 'hook.respond', requestId: 'r1', response: 'allow', decision: d }]);
    expect(effectsOf(effects, 'audit')).toEqual([{ e: 'audit', requestId: 'r1', decision: 'allow', via: 'strip' }]);
  });

  it.each([
    [{ kind: 'deny', message: 'no' }, 'deny', 'deny'],
    [{ kind: 'always', suggestionIndex: 0 }, 'always', 'always'],
    [{ kind: 'answers', answers: { q: 'a' } }, 'answers', 'answer'],
  ] as const)('decision %j responds %s and audits %s', (decision, response, audit) => {
    const s = makeSession({ status: 'question', pending: makePending({ kind: 'question' }) });
    const { effects } = run(s, { k: 'user', u: { cmd: 'decide', requestId: 'r1', decision } });
    expect(effectsOf(effects, 'hook.respond')[0]?.response).toBe(response);
    expect(effectsOf(effects, 'audit')[0]).toMatchObject({ decision: audit, via: 'ui' });
  });

  it('decide with the wrong requestId, no pending, or a terminal-only pending is ignored and logged', () => {
    const cases = [
      makeSession({ status: 'permission', pending: makePending() }),
      makeSession(),
      makeSession({ status: 'permission', pending: makePending({ held: false }) }),
    ];
    for (const s of cases) {
      const { next, effects } = run(s, { k: 'user', u: { cmd: 'decide', requestId: 'zzz', decision: { kind: 'allow' } } });
      expect(next).toBe(s);
      expect(effectsOf(effects, 'hook.respond')).toEqual([]);
      expect(effectsOf(effects, 'log')[0]).toMatchObject({ type: 'error' });
    }
    const terminalOnly = cases[2] as SessionRecord;
    expect(effectsOf(run(terminalOnly, { k: 'user', u: { cmd: 'decide', requestId: 'r1', decision: { kind: 'allow' } } }).effects, 'hook.respond')).toEqual([]);
  });

  it.each(['terminal-focus', 'user', 'expiry', 'shutdown'] as const)('release(%s): no_decision + audit; the session stays permission with held:false', (why) => {
    const s = makeSession({ status: 'permission', pending: makePending({ expiresAt: T0 + 5 }) });
    const { next, effects } = run(s, { k: 'user', u: { cmd: 'release', requestId: 'r1', why } });
    expect(next.status).toBe('permission');
    expect(next.pending).toMatchObject({ held: false, expiresAt: undefined });
    expect(effectsOf(effects, 'hook.respond')).toEqual([{ e: 'hook.respond', requestId: 'r1', response: 'no_decision' }]);
    expect(effectsOf(effects, 'audit')).toEqual([{ e: 'audit', requestId: 'r1', decision: 'release', via: why }]);
  });

  it('release for an unknown request is ignored', () => {
    const s = makeSession({ status: 'permission', pending: makePending() });
    const r = run(s, { k: 'user', u: { cmd: 'release', requestId: 'nope', why: 'user' } });
    expect(r.next).toBe(s);
    expect(effectsOf(r.effects, 'hook.respond')).toEqual([]);
    expect(effectsOf(run(makeSession(), { k: 'user', u: { cmd: 'release', requestId: 'r1', why: 'user' } }).effects, 'log')[0]?.type).toBe('error');
  });

  it('hold.closed (answered in the TUI) clears the pending and returns to working', () => {
    const s = makeSession({ status: 'permission', pending: makePending() });
    const { next, effects } = run(s, { k: 'hold.closed', requestId: 'r1' });
    expect(next).toMatchObject({ status: 'working', pending: undefined });
    expect(effectsOf(effects, 'audit')).toEqual([{ e: 'audit', requestId: 'r1', decision: 'release', via: 'terminal' }]);
  });

  it('hold.closed for another request, or one that is no longer held, changes nothing', () => {
    const s = makeSession({ status: 'permission', pending: makePending() });
    expect(run(s, { k: 'hold.closed', requestId: 'other' }).next).toBe(s);
    const released = makeSession({ status: 'permission', pending: makePending({ held: false }) });
    expect(run(released, { k: 'hold.closed', requestId: 'r1' }).next).toBe(released);
    const none = makeSession();
    expect(run(none, { k: 'hold.closed', requestId: 'r1' }).next).toBe(none);
  });

  it('process exit releases a held request and clears it', () => {
    const s = makeSession({ status: 'permission', pending: makePending() });
    const { next, effects } = run(s, { k: 'pty.exit', code: 0, after: 'stop' });
    expect(next).toMatchObject({ status: 'stopped', pending: undefined });
    expect(effectsOf(effects, 'hook.respond')[0]).toMatchObject({ requestId: 'r1', response: 'no_decision' });
    expect(effectsOf(effects, 'audit')[0]).toMatchObject({ via: 'pty.exit' });
  });

  it('daemon-side expiry on tick releases the hold once', () => {
    const s = makeSession({ status: 'permission', pending: makePending({ expiresAt: T0 + 100 }) });
    expect(run(s, { k: 'tick' }, T0 + 99).next).toBe(s);
    const { next, effects } = run(s, { k: 'tick' }, T0 + 100);
    expect(next.pending).toMatchObject({ held: false, expiresAt: undefined });
    expect(next.status).toBe('permission');
    expect(effectsOf(effects, 'audit')[0]).toMatchObject({ decision: 'release', via: 'expiry' });
    expect(effectsOf(run(next, { k: 'tick' }, T0 + 200).effects, 'hook.respond')).toEqual([]);
  });

  it('a pending without an expiry never expires', () => {
    const s = makeSession({ status: 'permission', pending: makePending() });
    expect(run(s, { k: 'tick' }, T0 + 10 * 60_000).next).toBe(s);
  });
});

describe('rule 8: a held request is cleared only by its own resolution', () => {
  const held = () => makeSession({ status: 'permission', pending: makePending(), waitingSince: T0 - 50 });
  const forged: HookMachineInput[] = [
    { event: 'PostToolUse', tool: 'Bash' },
    { event: 'PreToolUse', tool: 'Read', summary: 'x' },
    { event: 'Stop', lastMessage: 'bye' },
    { event: 'StopFailure', error: 'x' },
    { event: 'UserPromptSubmit' },
    { event: 'SessionEnd', reason: 'other' },
    { event: 'SessionStart', source: 'clear' },
    { event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: true },
    { event: 'PreCompact' },
    { event: 'Notification', notificationType: 'elicitation_dialog', pending: makePending({ requestId: 'r9', kind: 'question', held: false }) },
  ];
  it.each(forged)('hook %j leaves status and pending alone', (hook) => {
    const s = held();
    const { next, effects } = run(s, H(hook));
    expect(next.status).toBe('permission');
    expect(next.pending).toBe(s.pending);
    expect(next.waitingSince).toBe(T0 - 50);
    expect(effectsOf(effects, 'hook.respond')).toEqual([]);
  });

  it('a second PermissionRequest is released to the TUI instead of replacing the first', () => {
    const s = held();
    const second = makePending({ requestId: 'r2' });
    const { next, effects } = run(s, H({ event: 'PermissionRequest', pending: second }));
    expect(next.pending?.requestId).toBe('r1');
    expect(effectsOf(effects, 'hook.respond')).toEqual([{ e: 'hook.respond', requestId: 'r2', response: 'no_decision' }]);
    expect(effectsOf(effects, 'audit')[0]).toMatchObject({ requestId: 'r2', via: 'superseded' });
  });

  it('a second held AskUserQuestion is released too', () => {
    const second = makePending({ requestId: 'r3', kind: 'question' });
    const { effects } = run(held(), H({ event: 'PreToolUse', tool: 'AskUserQuestion', summary: 'q', pending: second }));
    expect(effectsOf(effects, 'hook.respond')[0]).toMatchObject({ requestId: 'r3' });
  });

  it('transcript, reconciler and statusline inputs cannot clear it either', () => {
    const s = held();
    for (const e of [
      { k: 'transcript', signal: 'working' },
      { k: 'transcript', signal: 'awaiting_reply' },
      { k: 'transcript', signal: 'interrupt_marker' },
      { k: 'reconciler', obs: obs({ status: 'busy' }) },
      { k: 'reconciler', obs: obs({ status: 'idle' }) },
    ] as MachineInput[]) {
      const { next } = run(s, e);
      expect(next.status).toBe('permission');
      expect(next.pending).toBe(s.pending);
    }
  });

  it('subagent events during a hold do not change it', () => {
    const s = held();
    const { next } = run(s, H({ event: 'PostToolUse', agentId: 'a1', tool: 'Read' }));
    expect(next.status).toBe('permission');
  });
});

describe('rule 1: inferred sources never clear a pending request', () => {
  const states = [
    ['held permission', makeSession({ status: 'permission', pending: makePending() })],
    ['terminal-only permission', makeSession({ status: 'permission', statusSource: 'reconciler', pending: makePending({ held: false }) })],
    ['held question', makeSession({ status: 'question', pending: makePending({ kind: 'question' }) })],
    ['terminal-only question', makeSession({ status: 'question', pending: makePending({ kind: 'question', held: false }) })],
  ] as const;
  const inferred: MachineInput[] = [
    { k: 'transcript', signal: 'working' },
    { k: 'transcript', signal: 'awaiting_reply', lastIsQuestion: true },
    { k: 'transcript', signal: 'interrupt_marker' },
    { k: 'reconciler', obs: obs({ status: 'busy' }) },
    { k: 'reconciler', obs: obs({ status: 'idle' }) },
    { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'permission prompt' }) },
    { k: 'reconciler', obs: obs({ status: 'waiting', waitingFor: 'dialog open' }) },
  ];
  for (const [label, s] of states) {
    it.each(inferred.map((e, i) => [i, e] as const))(`${label}: inference #%i leaves it`, (_i, e) => {
      const { next } = run(s, e, T0 + 120_000);
      expect(next.status).toBe(s.status);
      expect(next.pending).toEqual(s.pending);
    });
  }

  it('the idle-after-Esc shortcut is also blocked', () => {
    const s = makeSession({ status: 'permission', pending: makePending({ held: false }), interruptPendingAt: T0 - 100 });
    expect(run(s, { k: 'reconciler', obs: obs({ status: 'idle' }) }).next.status).toBe('permission');
  });
});

describe('rule 2: hooks beat inference', () => {
  const justHeard = (over: Partial<SessionRecord> = {}) => makeSession({ lastActivityAt: T0 - 9_999, ...over });
  const longQuiet = (over: Partial<SessionRecord> = {}) => makeSession({ lastActivityAt: T0 - QUIET_MS, ...over });

  it('transcript awaiting_reply -> done only after 10 s of hook silence, labelled transcript', () => {
    const sig: MachineInput = { k: 'transcript', signal: 'awaiting_reply', lastIsQuestion: true, at: T0 - 500 };
    expect(run(justHeard(), sig).next.status).toBe('working');
    const { next, effects } = run(longQuiet(), sig);
    expect(next).toMatchObject({ status: 'done', statusSource: 'transcript', lastIsQuestion: true, doneAt: T0 - 500 });
    expect(transitions(effects)).toEqual(['working>done:transcript']);
  });

  it('awaiting_reply defaults: lastIsQuestion false, doneAt = now; only from working-ish states', () => {
    const { next } = run(longQuiet(), { k: 'transcript', signal: 'awaiting_reply' });
    expect(next).toMatchObject({ lastIsQuestion: false, doneAt: T0 });
    for (const status of ['done', 'seen', 'interrupted', 'errored'] as const) {
      const s = longQuiet({ status });
      expect(run(s, { k: 'transcript', signal: 'awaiting_reply' }).next).toBe(s);
    }
    expect(run(longQuiet({ status: 'starting' }), { k: 'transcript', signal: 'awaiting_reply' }).next.status).toBe('done');
    expect(run(longQuiet({ status: 'trust_pending' }), { k: 'transcript', signal: 'awaiting_reply' }).next.status).toBe('done');
  });

  it('a transcript verdict older than the current status is a stale tail and is ignored', () => {
    const s = longQuiet({ statusSince: T0 - 5_000 });
    expect(run(s, { k: 'transcript', signal: 'awaiting_reply', at: T0 - 6_000 }).next).toBe(s);
    expect(run(s, { k: 'transcript', signal: 'awaiting_reply', at: T0 - 5_000 }).next.status).toBe('done');
    expect(run(s, { k: 'transcript', signal: 'interrupt_marker', at: T0 - 6_000 }).next).toBe(s);
    expect(run(s, { k: 'transcript', signal: 'interrupt_marker', at: T0 - 4_000 }).next.status).toBe('interrupted');
    // with the pty flag the marker must postdate the key press (1 s of skew allowed)
    const flagged = makeSession({ interruptPendingAt: T0 - 3_000, statusSince: T0 - 50_000 });
    expect(run(flagged, { k: 'transcript', signal: 'interrupt_marker', at: T0 - 5_000 }).next).toBe(flagged);
    expect(run(flagged, { k: 'transcript', signal: 'interrupt_marker', at: T0 - 3_500 }).next.status).toBe('interrupted');
  });

  it('transcript working re-arms done/seen/starting only after silence', () => {
    const sig: MachineInput = { k: 'transcript', signal: 'working' };
    expect(run(justHeard({ status: 'done' }), sig).next.status).toBe('done');
    for (const status of ['done', 'seen', 'starting', 'interrupted', 'trust_pending'] as const) {
      expect(run(longQuiet({ status }), sig).next).toMatchObject({ status: 'working', statusSource: 'transcript' });
    }
    const w = longQuiet({ status: 'working' });
    expect(run(w, sig).next).toBe(w);
    const e = longQuiet({ status: 'errored' });
    expect(run(e, sig).next).toBe(e);
  });

  it('transcript signals do nothing on non-live records', () => {
    const s = longQuiet({ status: 'stopped', pty: undefined });
    expect(run(s, { k: 'transcript', signal: 'working' }).next).toBe(s);
  });

  it('reconciler busy/idle follow the same gate and label', () => {
    expect(run(justHeard({ status: 'done' }), { k: 'reconciler', obs: obs({ status: 'busy' }) }).next.status).toBe('done');
    expect(run(longQuiet({ status: 'done' }), { k: 'reconciler', obs: obs({ status: 'busy' }) }).next).toMatchObject({ status: 'working', statusSource: 'reconciler' });
    expect(run(justHeard(), { k: 'reconciler', obs: obs({ status: 'idle' }) }).next.status).toBe('working');
    const { next, effects } = run(longQuiet(), { k: 'reconciler', obs: obs({ status: 'idle' }) });
    expect(next).toMatchObject({ status: 'done', statusSource: 'reconciler' });
    expect(effectsOf(effects, 'notify')[0]?.kind).toBe('done');
    const w = longQuiet();
    expect(run(w, { k: 'reconciler', obs: obs({ status: 'busy' }) }).next).toBe(w);
    const err = longQuiet({ status: 'errored' });
    expect(run(err, { k: 'reconciler', obs: obs({ status: 'busy' }) }).next).toBe(err);
    const seen = longQuiet({ status: 'seen' });
    expect(run(seen, { k: 'reconciler', obs: obs({ status: 'idle' }) }).next).toBe(seen);
  });

  it('reconciler idle at an empty prompt before any hook -> seen (probably)', () => {
    expect(run(longQuiet({ status: 'starting' }), { k: 'reconciler', obs: obs({ status: 'idle' }) }).next.status).toBe('seen');
    expect(run(longQuiet({ status: 'trust_pending' }), { k: 'reconciler', obs: obs({ status: 'idle' }) }).next.status).toBe('seen');
  });

  it('a hook after inference takes the source back to hook', () => {
    const inferred = run(longQuiet(), { k: 'reconciler', obs: obs({ status: 'idle' }) }).next;
    const { next } = run(inferred, H({ event: 'UserPromptSubmit' }), T0 + 1);
    expect(next).toMatchObject({ status: 'working', statusSource: 'hook' });
  });

  it('a hook of the same status but different source is logged as a source change', () => {
    const s = longQuiet({ status: 'working', statusSource: 'reconciler' });
    const { effects } = run(s, H({ event: 'PostToolUse', tool: 'Bash' }));
    expect(transitions(effects)).toEqual(['working>working:hook']);
  });

  it('observations about another Claude session id, or a dead own process, are ignored', () => {
    const s = longQuiet({ status: 'done' });
    expect(run(s, { k: 'reconciler', obs: obs({ claudeSessionId: 'old', status: 'busy' }) }).next).toBe(s);
    expect(run(s, { k: 'reconciler', obs: obs({ alive: false, status: 'busy' }) }).next).toBe(s);
    const stopped = longQuiet({ status: 'stopped', pty: undefined });
    expect(run(stopped, { k: 'reconciler', obs: obs({ status: 'busy' }) }).next).toBe(stopped);
  });
});

describe('rule 3: subagents', () => {
  it('SubagentStart/Stop maintain the list and never change the status', () => {
    let s = makeSession({ status: 'done' });
    s = run(s, H({ event: 'SubagentStart', agentId: 'a1', agentType: 'Explore' }), T0).next;
    expect(s.status).toBe('done');
    expect(s.subagents).toEqual([{ agentId: 'a1', type: 'Explore', running: true, startedAt: T0 }]);
    s = run(s, H({ event: 'SubagentStop', agentId: 'a1' }), T0 + 9).next;
    expect(s.subagents).toEqual([{ agentId: 'a1', type: 'Explore', running: false, startedAt: T0, endedAt: T0 + 9 }]);
    expect(s.status).toBe('done');
  });

  it('SubagentStart again restarts an entry; SubagentStop for an unknown agent records it', () => {
    let s = run(makeSession(), H({ event: 'SubagentStop', agentId: 'z' })).next;
    expect(s.subagents[0]).toMatchObject({ agentId: 'z', running: false, startedAt: T0, endedAt: T0 });
    s = run(s, H({ event: 'SubagentStart', agentId: 'z', agentType: 'Plan' }), T0 + 5).next;
    expect(s.subagents).toEqual([{ agentId: 'z', type: 'Plan', running: true, startedAt: T0 + 5 }]);
  });

  it('updating one entry leaves the others alone; a stop keeps the old type', () => {
    let s = run(makeSession(), H({ event: 'SubagentStart', agentId: 'a', agentType: 'Explore' })).next;
    s = run(s, H({ event: 'SubagentStart', agentId: 'b' })).next;
    s = run(s, H({ event: 'SubagentStop', agentId: 'a' }), T0 + 1).next;
    expect(s.subagents.map((a) => [a.agentId, a.type, a.running])).toEqual([['a', 'Explore', false], ['b', undefined, true]]);
  });

  it('lifecycle events without an agent id change nothing but activity', () => {
    const s = makeSession();
    expect(run(s, H({ event: 'SubagentStart' })).next.subagents).toEqual([]);
  });

  it('keeps at most 50 subagents', () => {
    let s = makeSession();
    for (let i = 0; i < 55; i++) s = run(s, H({ event: 'SubagentStart', agentId: `a${i}` })).next;
    expect(s.subagents).toHaveLength(50);
    expect(s.subagents[0]?.agentId).toBe('a5');
  });

  it('subagent tool events update now with the agent id and never the top-level status', () => {
    const s0 = makeSession({ status: 'done' });
    const s1 = run(s0, H({ event: 'PreToolUse', agentId: 'a1', tool: 'Grep', summary: 'foo' })).next;
    expect(s1.status).toBe('done');
    expect(s1.now).toEqual({ tool: 'Grep', summary: 'foo', since: T0, agentId: 'a1' });
    const other = run(s1, H({ event: 'PostToolUse', agentId: 'a2', tool: 'Grep' })).next;
    expect(other.now).toBeDefined();
    expect(run(s1, H({ event: 'PostToolUse', agentId: 'a1', tool: 'Grep' })).next.now).toBeUndefined();
    expect(run(s1, H({ event: 'PostToolUseFailure', agentId: 'a1', tool: 'Grep', isInterrupt: true })).next).toMatchObject({ status: 'done', now: undefined });
  });

  it('other subagent events (Stop, StopFailure, UserPromptSubmit-like) do not move the main status', () => {
    const s = makeSession();
    expect(run(s, H({ event: 'Stop', agentId: 'a1' })).next.status).toBe('working');
    expect(run(s, H({ event: 'StopFailure', agentId: 'a1' })).next.status).toBe('working');
  });
});

describe('rule 4: lineage', () => {
  const start = (source: string, id: string, path = `/t/${id}.jsonl`): MachineInput => H({ event: 'SessionStart', source, claudeSessionId: id, transcriptPath: path });

  it('clear with a new id: push, current, transcript path, offset reset, marker, follow, status done', () => {
    const s = makeSession({ transcriptOffset: 4096 });
    const { next, effects } = run(s, start('clear', 'c2'));
    expect(next).toMatchObject({ claudeSessionIds: ['c1', 'c2'], currentSessionId: 'c2', transcriptPath: '/t/c2.jsonl', transcriptOffset: 0, status: 'done' });
    expect(effectsOf(effects, 'chat.marker')).toEqual([{ e: 'chat.marker', marker: 'clear' }]);
    expect(effectsOf(effects, 'transcript.follow')).toEqual([{ e: 'transcript.follow', path: '/t/c2.jsonl', offset: 0 }]);
    expect(next.cost.byClaudeSession).toEqual({ c2: 0 });
    expect(effectsOf(effects, 'notify')).toEqual([]); // a /clear you typed is not news
  });

  it.each(['resume', 'fork'] as const)('%s with a new id -> done + marker', (source) => {
    const { next, effects } = run(makeSession(), start(source, 'c2'));
    expect(next.status).toBe('done');
    expect(effectsOf(effects, 'chat.marker')).toEqual([{ e: 'chat.marker', marker: source }]);
  });

  it('compact: new id is recorded and marked, status is untouched', () => {
    const s = makeSession({ status: 'working' });
    const { next, effects } = run(s, start('compact', 'c2'));
    expect(next).toMatchObject({ currentSessionId: 'c2', claudeSessionIds: ['c1', 'c2'], status: 'working' });
    expect(effectsOf(effects, 'chat.marker')).toEqual([{ e: 'chat.marker', marker: 'compact' }]);
  });

  it('compact with the same id still gets its marker but no follow', () => {
    const { effects, next } = run(makeSession(), start('compact', 'c1', '/t/c1.jsonl'));
    expect(effectsOf(effects, 'chat.marker')).toEqual([{ e: 'chat.marker', marker: 'compact' }]);
    expect(effectsOf(effects, 'transcript.follow')).toEqual([]);
    expect(next.status).toBe('working');
  });

  it('startup with the known id adds no marker', () => {
    const { effects } = run(makeSession({ status: 'starting' }), start('startup', 'c1'));
    expect(effectsOf(effects, 'chat.marker')).toEqual([]);
  });

  it('returning to an older id of the lineage (in-TUI /resume) switches current without a duplicate', () => {
    const s = makeSession({ claudeSessionIds: ['c1', 'c2'], currentSessionId: 'c2', transcriptPath: '/t/c2.jsonl', transcriptOffset: 99 });
    const { next } = run(s, start('resume', 'c1'));
    expect(next).toMatchObject({ claudeSessionIds: ['c1', 'c2'], currentSessionId: 'c1', transcriptPath: '/t/c1.jsonl', transcriptOffset: 0 });
  });

  it('SessionStart without ids or paths leaves lineage alone', () => {
    const s = makeSession();
    const { next, effects } = run(s, H({ event: 'SessionStart', source: 'compact' }));
    expect(next.claudeSessionIds).toBe(s.claudeSessionIds);
    expect(effectsOf(effects, 'transcript.follow')).toEqual([]);
  });

  it('a new id without any known transcript path cannot be followed yet', () => {
    const s = makeSession({ transcriptPath: undefined });
    const { effects, next } = run(s, H({ event: 'SessionStart', source: 'clear', claudeSessionId: 'c2' }));
    expect(effectsOf(effects, 'transcript.follow')).toEqual([]);
    expect(next.currentSessionId).toBe('c2');
  });

  it('non-SessionStart hooks from an id outside the lineage are ignored and logged', () => {
    const s = makeSession();
    const { next, effects } = run(s, H({ event: 'Stop', claudeSessionId: 'stranger' }));
    expect(next).toBe(s);
    expect(effectsOf(effects, 'log')[0]).toMatchObject({ type: 'error' });
    // an id of the lineage is fine
    expect(run(makeSession({ status: 'working' }), H({ event: 'Stop', claudeSessionId: 'c1' })).next.status).toBe('done');
  });

  it('identity helpers', () => {
    expect(sumLineageCost({ a: 1.5, b: 2 })).toBe(3.5);
    expect(withSessionCost({ lineageUsd: 0, byClaudeSession: { a: 1 } }, 'b', 2)).toEqual({ lineageUsd: 3, byClaudeSession: { a: 1, b: 2 } });
    const r = applySessionStart(makeSession(), { claudeSessionId: 'c9', source: 'startup', transcriptPath: '/x' });
    expect(r.patch.currentSessionId).toBe('c9');
  });
});

describe('cost per Claude session id (C3) and statusline', () => {
  it('sums over the lineage; /clear resetting Claude’s own total does not lose money', () => {
    let s = makeSession();
    s = run(s, { k: 'statusline', cost: { claudeSessionId: 'c1', usd: 1.25 } }).next;
    s = run(s, { k: 'statusline', cost: { claudeSessionId: 'c1', usd: 2.5 } }).next;
    s = run(s, H({ event: 'SessionStart', source: 'clear', claudeSessionId: 'c2', transcriptPath: '/t/c2.jsonl' })).next;
    s = run(s, { k: 'statusline', cost: { claudeSessionId: 'c2', usd: 0.5 } }).next;
    expect(s.cost).toEqual({ lineageUsd: 3, byClaudeSession: { c1: 2.5, c2: 0.5 } });
  });

  it('ctx, model and cache are stored without touching status', () => {
    const ctx = { pct: 40, tokens: 1, window: 2, at: T0, source: 'statusline' as const };
    const cache = { warm: true, ttl: '5m' as const, source: 'statusline' as const };
    const { next } = run(makeSession(), { k: 'statusline', ctx, model: 'opus', cache });
    expect(next).toMatchObject({ ctx, model: 'opus', cache, status: 'working' });
  });

  it('an empty statusline input changes nothing', () => {
    const s = makeSession();
    expect(run(s, { k: 'statusline' }).next).toBe(s);
  });
});

describe('open_elsewhere', () => {
  const other = (over = {}) => ({ k: 'reconciler', obs: obs({ pid: 999, ownedByUs: false, ...over }) }) as MachineInput;

  it('our current id owned by a foreign pid while we have no process -> open_elsewhere', () => {
    const s = makeSession({ status: 'stopped', pty: undefined, pending: undefined });
    const { next, effects } = run(s, other());
    expect(next).toMatchObject({ status: 'open_elsewhere', statusSource: 'reconciler' });
    expect(transitions(effects)).toEqual(['stopped>open_elsewhere:reconciler']);
    expect(isNeedsYou(next)).toBe(false);
  });

  it('works from parked and errored without a pty; repeated observations are idempotent', () => {
    for (const status of ['parked', 'errored'] as const) {
      const a = run(makeSession({ status, pty: undefined }), other()).next;
      expect(a.status).toBe('open_elsewhere');
      expect(run(a, other()).next).toBe(a);
    }
  });

  it('never when we own a live process', () => {
    const s = makeSession();
    expect(run(s, other()).next).toBe(s);
  });

  it('the foreign process going away -> stopped; an own-process obs going away does not', () => {
    const s = makeSession({ status: 'open_elsewhere', pty: undefined });
    expect(run(s, other({ alive: false })).next).toMatchObject({ status: 'stopped', statusSource: 'reconciler' });
    expect(run(s, { k: 'reconciler', obs: obs({ alive: false }) }).next).toBe(s);
    const live = makeSession();
    expect(run(live, other({ alive: false })).next).toBe(live);
  });

  it('an observation of an old lineage id is not a conflict', () => {
    const s = makeSession({ status: 'stopped', pty: undefined, claudeSessionIds: ['c0', 'c1'] });
    expect(run(s, other({ claudeSessionId: 'c0' })).next).toBe(s);
  });
});

describe('rule 5: waitingSince', () => {
  it.each([
    ['permission', H({ event: 'PermissionRequest', pending: makePending() })],
    ['question', H({ event: 'PreToolUse', tool: 'AskUserQuestion', summary: 'q', pending: makePending({ kind: 'question' }) })],
    ['errored', H({ event: 'StopFailure' })],
    ['done', H({ event: 'Stop' })],
    ['interrupted', H({ event: 'PostToolUseFailure', tool: 'Bash', isInterrupt: true })],
  ] as [string, MachineInput][])('set on entering %s', (status, e) => {
    const { next } = run(makeSession(), e, T0 + 7);
    expect(next.status).toBe(status);
    expect(next.waitingSince).toBe(T0 + 7);
  });

  it('set on entering trust_pending', () => {
    expect(run(makeSession({ status: 'starting' }), { k: 'pty.trust_dialog' }, T0 + 3).next.waitingSince).toBe(T0 + 3);
  });

  it('cleared on leaving, kept while the status does not change', () => {
    const waiting = run(makeSession(), H({ event: 'PermissionRequest', pending: makePending() }), T0).next;
    const stillWaiting = run(waiting, { k: 'user', u: { cmd: 'release', requestId: 'r1', why: 'user' } }, T0 + 50).next;
    expect(stillWaiting.waitingSince).toBe(T0);
    const left = run(stillWaiting, H({ event: 'PostToolUse', tool: 'Bash' }), T0 + 60).next;
    expect(left.waitingSince).toBeUndefined();
  });

  it('not set for working, stopped, parked, seen, open_elsewhere', () => {
    expect(run(makeSession({ status: 'done' }), H({ event: 'UserPromptSubmit' })).next.waitingSince).toBeUndefined();
    expect(run(makeSession(), { k: 'pty.exit', code: 0, after: 'park' }).next.waitingSince).toBeUndefined();
  });
});

describe('rule 7: every transition is logged with its source; drift', () => {
  it.each([
    ['hook', H({ event: 'Stop' }), 'working>done:hook'],
    ['pty', { k: 'pty.exit', code: 2 } as MachineInput, 'working>errored:pty'],
    ['user', { k: 'user', u: { cmd: 'decide', requestId: 'r1', decision: { kind: 'allow' } } } as MachineInput, 'permission>working:user'],
  ])('%s source', (_n, e, expected) => {
    const s = makeSession({ status: expected.startsWith('permission') ? 'permission' : 'working', pending: expected.startsWith('permission') ? makePending() : undefined });
    expect(transitions(run(s, e).effects)).toEqual([expected]);
  });

  it('log lines carry the session id, time and reason', () => {
    const l = effectsOf(run(makeSession(), H({ event: 'Stop' })).effects, 'log')[0];
    expect(l?.data).toMatchObject({ strategosId: 's1', at: T0, why: 'Stop', from: 'working', to: 'done', source: 'hook' });
  });

  it('a no-op input yields no log and no persist', () => {
    const { next, effects } = run(makeSession(), { k: 'tick' });
    expect(effects).toEqual([]);
    expect(next.updatedAt).toBe(0);
  });

  it('a change persists once and bumps updatedAt', () => {
    const { next, effects } = run(makeSession(), H({ event: 'Stop' }));
    expect(effects.filter((x) => x.e === 'persist')).toHaveLength(1);
    expect(next.updatedAt).toBe(T0);
  });

  it('drift: hook says one thing, reconciler another for more than 30 s', () => {
    const s = makeSession({ status: 'permission', pending: makePending(), lastActivityAt: T0 - DRIFT_MS });
    const { effects } = run(s, { k: 'reconciler', obs: obs({ status: 'idle' }) });
    expect(effectsOf(effects, 'log').filter((l) => l.type === 'drift')).toHaveLength(1);
  });

  it('no drift inside 30 s, when they agree, when the source is not hook, or before the first hook', () => {
    const fresh = makeSession({ status: 'permission', pending: makePending(), lastActivityAt: T0 - DRIFT_MS + 1 });
    const drift = (s: SessionRecord, o: Parameters<typeof obs>[0]) =>
      effectsOf(run(s, { k: 'reconciler', obs: obs(o) }).effects, 'log').filter((l) => l.type === 'drift').length;
    expect(drift(fresh, { status: 'idle' })).toBe(0);
    const old = { lastActivityAt: 0 };
    expect(drift(makeSession({ status: 'permission', pending: makePending(), ...old }), { status: 'waiting', waitingFor: 'permission prompt' })).toBe(0);
    expect(drift(makeSession({ status: 'working', ...old }), { status: 'busy' })).toBe(0);
    expect(drift(makeSession({ status: 'done', ...old }), { status: 'idle' })).toBe(0);
    expect(drift(makeSession({ status: 'working', ...old }), {})).toBe(0); // obs without status: nothing to compare
    expect(drift(makeSession({ status: 'permission', statusSource: 'reconciler', pending: makePending({ held: false }), ...old }), { status: 'idle' })).toBe(0);
    expect(drift(makeSession({ status: 'starting', ...old }), { status: 'idle' })).toBe(0);
    expect(drift(makeSession({ status: 'question', pending: makePending({ kind: 'question' }), ...old }), { status: 'busy' })).toBe(1);
    expect(drift(makeSession({ status: 'trust_pending', ...old }), { status: 'waiting', waitingFor: 'dialog open' })).toBe(0);
  });
});

describe('purity', () => {
  it('never mutates its input, including nested arrays and objects', () => {
    const s = makeSession({ subagents: [{ agentId: 'a', running: true, startedAt: 1 }], cost: { lineageUsd: 1, byClaudeSession: { c1: 1 } } });
    const frozen = structuredClone(s);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    };
    deepFreeze(s);
    const inputs: MachineInput[] = [
      H({ event: 'SubagentStop', agentId: 'a' }),
      H({ event: 'SessionStart', source: 'clear', claudeSessionId: 'c2' }),
      { k: 'statusline', cost: { claudeSessionId: 'c1', usd: 3 } },
      { k: 'pty.exit', code: 1 },
      { k: 'daemon.restart' },
    ];
    for (const e of inputs) expect(() => reduce(s, e, T0)).not.toThrow();
    expect(s).toEqual(frozen);
  });

  it('is deterministic', () => {
    const e = H({ event: 'Stop', lastMessage: 'x?' });
    expect(run(makeSession(), e)).toEqual(run(makeSession(), e));
  });
});
