import { describe, expect, it } from 'vitest';
import { buildHookResponse, createPendingRegistry, type HookResponder } from './pending.ts';
import type { Effect, MachineInput, Pending } from '@strategos/shared';

describe('buildHookResponse (pure)', () => {
  const full = { questions: [{ question: 'Q?' }] };
  it('no_decision is null (an empty 200)', () => {
    expect(buildHookResponse('PermissionRequest', 'no_decision', undefined, {}, undefined)).toBeNull();
    expect(buildHookResponse('PreToolUse', 'no_decision', undefined, full, undefined)).toBeNull();
  });
  it('deny without a message omits the message field', () => {
    expect(buildHookResponse('PermissionRequest', 'deny', { kind: 'deny' }, {}, undefined)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });
  it('always with a missing or out-of-range suggestion degrades to a plain allow (never invents a rule)', () => {
    const plain = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    expect(buildHookResponse('PermissionRequest', 'always', { kind: 'always', suggestionIndex: 3 }, {}, [{ type: 'x' }])).toEqual(plain);
    expect(buildHookResponse('PermissionRequest', 'always', { kind: 'always' }, {}, undefined)).toEqual(plain);
  });
  it('always defaults to suggestion 0 and passes it through untouched (same object contents)', () => {
    const s = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm *' }], behavior: 'allow', destination: 'localSettings', extra: [1, { a: 2 }] };
    const out = buildHookResponse('PermissionRequest', 'always', { kind: 'always' }, {}, [s]) as { hookSpecificOutput: { decision: { updatedPermissions: unknown[] } } };
    expect(out.hookSpecificOutput.decision.updatedPermissions).toEqual([s]);
  });
  it('PreToolUse (AskUserQuestion): a bare allow means nothing, so it is null', () => {
    expect(buildHookResponse('PreToolUse', 'allow', { kind: 'allow' }, full, undefined)).toBeNull();
  });
  it('answers keep every other field of the input', () => {
    const out = buildHookResponse('PreToolUse', 'answers', { kind: 'answers', answers: { 'Q?': 'a' } }, { ...full, metadata: { x: 1 } }, undefined);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: [{ question: 'Q?' }], metadata: { x: 1 }, answers: { 'Q?': 'a' } } } });
  });
});

describe('registry without the HTTP layer', () => {
  const pend = (id: string): Pending => ({ requestId: id, kind: 'permission', held: true, toolName: 'Bash', inputSummary: 'x', inputTruncated: false, risk: [], since: 0 });
  function responder() {
    const sent: (Record<string, unknown> | null)[] = [];
    let close: (() => void) | undefined;
    const r: HookResponder = {
      open: true,
      respond(b) { sent.push(b); return true; },
      onClientClose(cb) { close = cb; },
    };
    return { r, sent, closeClient: () => close?.() };
  }

  it('hook.respond effects from ANY dispatch (e.g. a pty exit) resolve the matching held response only', () => {
    const dispatched: MachineInput[] = [];
    const reg = createPendingRegistry({ dispatch: (_s, i) => { dispatched.push(i); return []; } });
    const a = responder();
    const b = responder();
    reg.hold('s1', pend('r1'), a.r, { event: 'PermissionRequest', fullInput: {} });
    reg.hold('s2', pend('r2'), b.r, { event: 'PermissionRequest', fullInput: {} });
    const fx: Effect[] = [{ e: 'hook.respond', requestId: 'r1', response: 'no_decision' }, { e: 'hook.respond', requestId: 'r2', response: 'no_decision' }];
    reg.applyEffects('s1', fx); // r2 belongs to s2: a hook.respond for another session's request is ignored
    expect(a.sent).toEqual([null]);
    expect(b.sent).toEqual([]);
    expect(reg.size).toBe(1);
    reg.releaseAll();
    expect(b.sent).toEqual([null]);
  });

  it('a client close dispatches hold.closed exactly once and nothing is sent', () => {
    const dispatched: MachineInput[] = [];
    const reg = createPendingRegistry({ dispatch: (_s, i) => { dispatched.push(i); return []; } });
    const a = responder();
    reg.hold('s1', pend('r1'), a.r, { event: 'PermissionRequest', fullInput: {} });
    a.closeClient();
    a.closeClient();
    expect(dispatched).toEqual([{ k: 'hold.closed', requestId: 'r1' }]);
    expect(a.sent).toEqual([]);
    expect(reg.size).toBe(0);
  });

  it('the reducer rejecting a decision leaves no dangling response', () => {
    const reg = createPendingRegistry({ dispatch: () => [] });
    const a = responder();
    reg.hold('s1', pend('r1'), a.r, { event: 'PermissionRequest', fullInput: {} });
    expect(reg.decide('s1', 'r1', { kind: 'allow' })).toEqual({ ok: false, error: 'rejected' });
    expect(a.sent).toEqual([null]); // fail open: no decision
    expect(reg.size).toBe(0);
  });

  it('dropSession answers every held request of that session with no decision', () => {
    const reg = createPendingRegistry({ dispatch: () => [] });
    const a = responder();
    const b = responder();
    reg.hold('s1', pend('r1'), a.r, { event: 'PermissionRequest', fullInput: {} });
    reg.hold('s2', pend('r2'), b.r, { event: 'PermissionRequest', fullInput: {} });
    reg.dropSession('s1');
    expect(a.sent).toEqual([null]);
    expect(b.sent).toEqual([]);
    reg.releaseAll();
  });
});
