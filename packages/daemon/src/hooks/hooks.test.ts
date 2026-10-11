// Integration tests for hooks/receiver + hooks/pending against the REAL server and the REAL reducer.
// Raw HTTP clients play Claude Code; tools/fake-claude drives the end-to-end cases in hooks.e2e.test.ts.
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, type Reply } from '../server/testkit.ts';
import { makeHarness, type Harness } from './testkit.ts';

let h: Harness;
const SID = 's1';
const CID = 'c1';
let token: string;

beforeEach(async () => {
  h = await makeHarness({ holdTimeoutSec: 3600, releaseMarginSec: 30 });
  token = h.addSession(SID, { status: 'working', claudeSessionIds: [CID], currentSessionId: CID, lastActivityAt: Date.now() }).token;
});
afterEach(async () => { await h.close(); });

const bodyOf = (event: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  session_id: CID, cwd: '/repo', permission_mode: 'default', hook_event_name: event, ...extra,
});

function post(event: string, extra: Record<string, unknown>, o: { sid?: string; token?: string | null } = {}): Promise<Reply> {
  const tok = o.token === undefined ? token : o.token;
  return http(h.server.port, {
    method: 'POST', path: `/hook/${o.sid ?? SID}/${event}`,
    headers: { 'content-type': 'application/json', ...(tok === null ? {} : { 'x-strategos-token': tok }) },
    body: JSON.stringify(bodyOf(event, extra)),
  });
}

const json = (r: Reply): unknown => JSON.parse(r.body.toString('utf8'));
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
const SUGGESTIONS = [{ type: 'addDirectories', directories: ['/repo'], destination: 'session' }, { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];

/** Send a held request and wait until the reducer has it pending. */
async function hold(event: string, extra: Record<string, unknown>): Promise<{ reply: Promise<Reply>; requestId: string }> {
  const reply = post(event, extra);
  reply.catch(() => undefined);
  await h.until(() => h.get(SID).pending !== undefined, 5000, 'pending');
  return { reply, requestId: h.get(SID).pending!.requestId };
}

const AUQ = { questions: [{ question: 'Which flavour?', header: 'Flavour', multiSelect: false, options: [{ label: 'Vanilla', description: 'plain' }, { label: 'Chocolate' }] }] };
const holdQuestion = () => hold('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: AUQ, tool_use_id: 'toolu_q1' });
const holdPermission = () => hold('PermissionRequest', bash('npm test', { permission_suggestions: SUGGESTIONS }));

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../fixtures/claude/2.1.292/hooks/${name}`, import.meta.url), 'utf8'));

describe('a held request resolves in all five ways', () => {
  it('allow: the PermissionRequest answer matches the fixture, the session continues, the audit line has via and connId', async () => {
    const { reply, requestId } = await holdPermission();
    expect(h.get(SID)).toMatchObject({ status: 'permission', pending: { held: true, toolName: 'Bash', kind: 'permission' } });
    expect(h.registry.decide(SID, requestId, { kind: 'allow', via: 'drawer' }, { connId: 'conn-7' })).toEqual({ ok: true });
    const r = await reply;
    expect(r.status).toBe(200);
    expect(json(r)).toEqual(fixture('RESPONSE-PermissionRequest-allow.json'));
    expect(h.get(SID)).toMatchObject({ status: 'working', pending: undefined });
    await h.audit.idle();
    expect(h.audit.read()).toEqual([expect.objectContaining({ sid: SID, requestId, tool: 'Bash', inputSummary: 'npm test', decision: 'allow', via: 'drawer', connId: 'conn-7', claudeSessionId: CID })]);
    expect(h.registry.size).toBe(0);
  });

  it('deny: carries the message', async () => {
    const { reply, requestId } = await holdPermission();
    expect(h.registry.decide(SID, requestId, { kind: 'deny', message: 'Denied by the Strategos spike (S2 deny test)', via: 'strip' })).toEqual({ ok: true });
    expect(json(await reply)).toEqual(fixture('RESPONSE-PermissionRequest-deny-with-message.json'));
    expect(h.get(SID).status).toBe('working');
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'deny', via: 'strip' });
  });

  it('always: passes the chosen suggestion back verbatim as updatedPermissions', async () => {
    const { reply, requestId } = await holdPermission();
    h.registry.decide(SID, requestId, { kind: 'always', suggestionIndex: 1, via: 'drawer' });
    expect(json(await reply)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [SUGGESTIONS[1]] } },
    });
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'always' });
  });

  it('always with suggestion 0 matches the recorded fixture shape', async () => {
    const f = fixture('PermissionRequest-Bash-with-suggestion.json') as { body: Record<string, unknown> };
    h.sessions.set(SID, { ...h.get(SID), claudeSessionIds: [f.body['session_id'] as string], currentSessionId: f.body['session_id'] as string });
    const reply = post('PermissionRequest', f.body);
    await h.until(() => h.get(SID).pending !== undefined);
    h.registry.decide(SID, h.get(SID).pending!.requestId, { kind: 'always', suggestionIndex: 0 });
    const out = json(await reply) as { hookSpecificOutput: { decision: { updatedPermissions: unknown[] } } };
    expect(out.hookSpecificOutput.decision.updatedPermissions).toEqual([(f.body['permission_suggestions'] as unknown[])[0]]);
  });

  it('answers (AskUserQuestion): PreToolUse allow with updatedInput {questions echoed, answers}', async () => {
    const { reply, requestId } = await holdQuestion();
    expect(h.get(SID)).toMatchObject({ status: 'question', pending: { kind: 'question', toolUseId: 'toolu_q1', questions: [{ question: 'Which flavour?', options: [{ label: 'Vanilla' }, { label: 'Chocolate' }] }] } });
    expect(h.registry.decide(SID, requestId, { kind: 'answers', answers: { 'Which flavour?': 'Vanilla' }, via: 'drawer' })).toEqual({ ok: true });
    expect(json(await reply)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...AUQ, answers: { 'Which flavour?': 'Vanilla' } } },
    });
    expect(h.get(SID).status).toBe('working');
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'answer', tool: 'AskUserQuestion' });
  });

  it('release: an empty 200, the request stays pending but no longer held ("answer in terminal")', async () => {
    const { reply, requestId } = await holdPermission();
    expect(h.registry.release(SID, requestId, 'terminal-focus', { connId: 'c9' })).toEqual({ ok: true });
    const r = await reply;
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.get(SID)).toMatchObject({ status: 'permission', pending: { held: false } });
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'release', via: 'terminal-focus', connId: 'c9' });
  });

  it('client closes the connection (Esc in the TUI): hold.closed, back to working, audited as released via terminal', async () => {
    const req = request({ host: '127.0.0.1', port: h.server.port, method: 'POST', path: `/hook/${SID}/PermissionRequest`, agent: false, headers: { 'content-type': 'application/json', 'x-strategos-token': token, Host: `127.0.0.1:${h.server.port}` } });
    req.on('error', () => undefined);
    req.end(JSON.stringify(bodyOf('PermissionRequest', bash('npm test'))));
    await h.until(() => h.get(SID).pending !== undefined);
    expect(h.registry.size).toBe(1);
    req.destroy();
    await h.until(() => h.get(SID).pending === undefined, 5000, 'pending cleared by the close');
    expect(h.get(SID).status).toBe('working');
    expect(h.registry.size).toBe(0);
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'release', via: 'terminal_cancel' });
    expect(h.get(SID).interruptPendingAt).toBeTypeOf('number');
  });
});

describe('a held request is never left dangling', () => {
  it('auto-releases before the hook timeout (configurable)', async () => {
    await h.close();
    h = await makeHarness({ holdTimeoutSec: 1.2, releaseMarginSec: 1 }); // expires after 200 ms
    token = h.addSession(SID, { status: 'working', claudeSessionIds: [CID], currentSessionId: CID, lastActivityAt: Date.now() }).token;
    const { reply } = await holdPermission();
    const r = await reply;
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.get(SID).pending).toMatchObject({ held: false });
    await h.audit.idle();
    expect(h.audit.read()[0]).toMatchObject({ decision: 'release', via: 'expiry' });
  });

  it('expiresAt on the pending is the hook timeout minus the margin', async () => {
    const before = Date.now();
    await holdPermission();
    const exp = h.get(SID).pending!.expiresAt!;
    expect(exp - before).toBeGreaterThan((3600 - 30) * 1000 - 1000);
    expect(exp - before).toBeLessThan((3600 - 30) * 1000 + 2000);
  });

  it('shutdown releases everything with an empty 200', async () => {
    const { reply } = await holdPermission();
    h.registry.releaseAll();
    const r = await reply;
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.registry.size).toBe(0);
  });

  it('evidence that the TUI answered (PostToolUse of the same tool call) releases it; the session continues', async () => {
    const pre = await post('PreToolUse', bash('npm test', { tool_use_id: 'toolu_1' }));
    expect(pre.status).toBe(200);
    const { reply } = await holdPermission();
    expect(h.get(SID).pending!.toolUseId).toBe('toolu_1'); // linked from the PreToolUse before it
    const post1 = await post('PostToolUse', bash('npm test', { tool_use_id: 'toolu_1', tool_response: {} }));
    expect(post1.status).toBe(200);
    const r = await reply;
    expect(r.body.length).toBe(0);
    expect(h.get(SID)).toMatchObject({ status: 'working', pending: undefined });
  });

  it('a second PermissionRequest while one is held is released (the TUI shows it), the first stays held', async () => {
    const first = await holdPermission();
    const second = await post('PermissionRequest', bash('npm run build'));
    expect(second.status).toBe(200);
    expect(second.body.length).toBe(0);
    expect(h.get(SID).pending!.requestId).toBe(first.requestId);
    expect(h.registry.size).toBe(1);
  });

  it('a reducer that throws ends in an empty 200 (fail open) and nothing stays held', async () => {
    const broken = await makeHarness();
    broken.addSession('b1');
    const real = broken.dispatch;
    void real;
    // replace the session map entry by garbage so reduce throws
    broken.sessions.set('b1', null as never);
    const r = await http(broken.server.port, {
      method: 'POST', path: '/hook/b1/PermissionRequest',
      headers: { 'content-type': 'application/json', 'x-strategos-token': 'tok-b1' }, body: JSON.stringify(bodyOf('PermissionRequest', bash('x'))),
    });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(broken.registry.size).toBe(0);
    expect(broken.errors.length).toBeGreaterThan(0);
    await broken.close();
  });

  it('a request the reducer does not take (record already stopped) is answered with no decision', async () => {
    h.addSession('st', { status: 'stopped' });
    const r = await post('PermissionRequest', bash('x'), { sid: 'st', token: 'tok-st' });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.registry.size).toBe(0);
  });
});

describe('forged events decide nothing', () => {
  it('a wrong token is refused (401) and a held request is untouched', async () => {
    const { reply, requestId } = await holdPermission();
    const bad = await post('PostToolUse', bash('npm test', { tool_use_id: 'x' }), { token: 'nope' });
    expect(bad.status).toBe(401);
    const none = await post('PostToolUse', bash('npm test'), { token: null });
    expect(none.status).toBe(401);
    expect(h.registry.has(SID, requestId)).toBe(true);
    expect(h.get(SID).pending?.held).toBe(true);
    h.registry.releaseAll();
    await reply;
  });

  it('correct token, PostToolUse for a DIFFERENT tool: nothing decided, the request stays held', async () => {
    const { reply, requestId } = await holdPermission();
    const r = await post('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_other' });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.registry.has(SID, requestId)).toBe(true);
    expect(h.get(SID)).toMatchObject({ status: 'permission', pending: { held: true } });
    h.registry.releaseAll();
    await reply;
  });

  it('even a forged event that does release a request (same tool) can only produce an empty 200, never an allow', async () => {
    const { reply } = await holdPermission();
    await post('PostToolUse', bash('npm test'));
    const r = await reply;
    expect(r.body.length).toBe(0);
  });

  it('a hook for an unknown session is 404 and for a bad event name 404', async () => {
    expect((await post('Stop', {}, { sid: 'nobody', token: 'x' })).status).toBe(404);
    expect((await post('Bogus', {})).status).toBe(404);
  });

  it('a body that is not an object is a 400', async () => {
    const r = await http(h.server.port, { method: 'POST', path: `/hook/${SID}/Stop`, headers: { 'x-strategos-token': token }, body: '[1,2]' });
    expect(r.status).toBe(400);
  });
});

describe('decide validation', () => {
  it('a bare allow for AskUserQuestion is refused (allow alone is not sufficient); the request stays held', async () => {
    const { reply, requestId } = await holdQuestion();
    expect(h.registry.decide(SID, requestId, { kind: 'allow' })).toEqual({ ok: false, error: 'answers_required' });
    expect(h.registry.decide(SID, requestId, { kind: 'always' })).toEqual({ ok: false, error: 'answers_required' });
    expect(h.registry.has(SID, requestId)).toBe(true);
    h.registry.decide(SID, requestId, { kind: 'deny', message: 'no thanks' });
    expect(json(await reply)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no thanks' } });
  });

  it('answers for a permission request is refused; unknown ids and wrong sessions are not_found', async () => {
    const { reply, requestId } = await holdPermission();
    expect(h.registry.decide(SID, requestId, { kind: 'answers', answers: { a: 'b' } })).toEqual({ ok: false, error: 'not_a_question' });
    expect(h.registry.decide(SID, 'nope', { kind: 'allow' })).toEqual({ ok: false, error: 'not_found' });
    expect(h.registry.decide('other', requestId, { kind: 'allow' })).toEqual({ ok: false, error: 'not_found' });
    expect(h.registry.release(SID, 'nope', 'user')).toEqual({ ok: false, error: 'not_found' });
    h.registry.releaseAll();
    await reply;
    // a second decision for an answered request
    expect(h.registry.decide(SID, requestId, { kind: 'allow' })).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('the full input stays in memory (D21)', () => {
  it('summary is cut at 400 chars and flagged; getFull returns the whole input', async () => {
    const command = 'echo ' + 'x'.repeat(1000);
    const { reply, requestId } = await hold('PermissionRequest', bash(command));
    const p = h.get(SID).pending!;
    expect(p.inputSummary.length).toBe(400);
    expect(p.inputTruncated).toBe(true);
    expect(h.registry.getFull(SID, requestId)).toMatchObject({ toolName: 'Bash', toolInput: { command }, event: 'PermissionRequest' });
    expect(h.registry.getFull('other', requestId)).toBeUndefined();
    h.registry.releaseAll();
    await reply;
    expect(h.registry.getFull(SID, requestId)).toBeUndefined();
  });

  it('a short command is not flagged', async () => {
    await holdPermission();
    expect(h.get(SID).pending).toMatchObject({ inputSummary: 'npm test', inputTruncated: false, risk: [] });
  });

  it('subagent requests carry the agent id', async () => {
    const { reply } = await hold('PermissionRequest', bash('git push', { agent_id: 'agent-1', agent_type: 'general-purpose' }));
    expect(h.get(SID).pending).toMatchObject({ agentId: 'agent-1', held: true });
    h.registry.releaseAll();
    await reply;
  });
});

describe('guards (PreToolUse for tools that are not AskUserQuestion)', () => {
  it('a deny verdict returns the PreToolUse deny JSON and is audited via guard; the reducer still saw the event', async () => {
    h.guards.fn = (_sid, tool, input) => (tool === 'Bash' && JSON.stringify(input).includes('rm -rf') ? { deny: true, ruleId: 'rm-rf', reason: 'Blocked by Strategos guard rm-rf' } : { deny: false });
    const r = await post('PreToolUse', bash('rm -rf /', { tool_use_id: 'toolu_g' }));
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by Strategos guard rm-rf' } });
    await h.audit.idle();
    expect(h.audit.read()).toEqual([expect.objectContaining({ decision: 'deny', via: 'guard', tool: 'Bash', requestId: 'toolu_g', inputSummary: 'rm -rf /' })]);
    expect(h.get(SID).now).toMatchObject({ tool: 'Bash' });
  });

  it('no deny: empty 200 (no decision), never an allow', async () => {
    const r = await post('PreToolUse', bash('ls'));
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
  });

  it('a guard that throws fails open', async () => {
    h.guards.fn = () => { throw new Error('boom'); };
    const r = await post('PreToolUse', bash('ls'));
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(h.errors.some((e) => e.where === 'checkGuards')).toBe(true);
  });

  it('AskUserQuestion goes to the registry, not to the guards', async () => {
    let called = false;
    h.guards.fn = () => { called = true; return { deny: true, ruleId: 'x', reason: 'x' }; };
    const { reply, requestId } = await holdQuestion();
    expect(called).toBe(false);
    h.registry.release(SID, requestId, 'user');
    expect((await reply).body.length).toBe(0);
  });
});

describe('normalisation', () => {
  it('Stop, StopFailure, CwdChanged, Notification and SessionEnd reach the reducer in the right shape', async () => {
    await post('Stop', { last_assistant_message: 'All done?' });
    expect(h.get(SID)).toMatchObject({ status: 'done', last: 'All done?', lastIsQuestion: true });
    await post('UserPromptSubmit', { prompt: 'again' });
    await post('StopFailure', { error: 'rate_limit' });
    expect(h.get(SID).status).toBe('errored');
    await post('CwdChanged', { old_cwd: '/repo', new_cwd: '/repo/sub' });
    expect(h.get(SID).cwd).toBe('/repo/sub');
    await post('SessionEnd', { reason: 'prompt_input_exit' });
    expect(h.get(SID).status).toBe('stopped');
  });

  it('an elicitation Notification becomes a question that is NOT held (answer in the terminal)', async () => {
    await post('Notification', { notification_type: 'elicitation_dialog', message: 'Pick a branch' });
    expect(h.get(SID)).toMatchObject({ status: 'question', pending: { held: false, inputSummary: 'Pick a branch' } });
    expect(h.registry.size).toBe(0);
  });

  it('SessionStart through the command relay adopts the Claude id (lineage) and the transcript', async () => {
    h.addSession('fresh', { status: 'starting', launch: { addDirs: [], extraArgs: [], firstPrompt: 'go' } });
    const r = await http(h.server.port, {
      method: 'POST', path: '/hook/fresh/SessionStart',
      headers: { 'content-type': 'application/json', 'x-strategos-token': 'tok-fresh', 'x-strategos-via': 'command-relay' },
      body: JSON.stringify(bodyOf('SessionStart', { session_id: 'new-id', source: 'startup', transcript_path: '/t/new-id.jsonl', model: 'claude-opus-5-5' })),
    });
    expect(r.status).toBe(200);
    expect(h.get('fresh')).toMatchObject({ status: 'working', currentSessionId: 'new-id', claudeSessionIds: ['new-id'], transcriptPath: '/t/new-id.jsonl' });
  });
});
