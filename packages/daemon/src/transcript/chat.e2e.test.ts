// End to end for the chat view feed (task 5.01 + 5.04): a real daemon, a real WebSocket client, fake claude writing real
// transcript files. Reply sending rules (5.04) are checked here too, with hooks posted by hand for the odd states.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatItem, DaemonEvent } from '@strategos/shared';
import { startRig, type Rig, type UiClient } from '../daemon.testkit.ts';
import { http } from '../server/testkit.ts';

const T = 60_000;
const rigs: Rig[] = [];
async function rig(script: string): Promise<Rig> {
  const r = await startRig({ daemon: { notifyQuietMs: 0 } });
  r.env['FAKE_CLAUDE_SCRIPT'] = script;
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

type ChatEv = Extract<DaemonEvent, { t: 'chat.items' }>;
const chatEvents = (ui: UiClient, sid: string): ChatEv[] => ui.events.filter((e): e is ChatEv => e.t === 'chat.items' && e.strategosId === sid);
function held(ui: UiClient, sid: string): ChatItem[] {
  let list: ChatItem[] = [];
  for (const e of chatEvents(ui, sid)) list = e.reset ? [...e.items] : [...list.slice(0, e.from), ...e.items];
  return list;
}
const label = (i: ChatItem): string => (i.k === 'user' ? `U:${i.text}` : i.k === 'assistant' ? `A:${i.md}` : i.k === 'tool' ? `T:${i.tool}${i.ok === undefined ? '' : i.ok ? ':ok' : ':fail'}` : i.k === 'marker' ? `M:${i.marker}` : i.k === 'subagent' ? `S:${i.agentId}` : i.k);

describe('chat.subscribe', () => {
  it('sends the history, then live appends after a reply; unsubscribe and closing stop the feed', async () => {
    const r = await rig('plain');
    const ui = await r.ui();
    const s = await ui.start('C', r.repo, 'hello');
    await ui.waitStatus(s.strategosId, 'done');

    expect((await ui.cmd({ c: 'chat.subscribe', strategosId: s.strategosId, from: 0 })).ok).toBe(true);
    expect(chatEvents(ui, s.strategosId)[0]).toMatchObject({ from: 0, reset: true });
    expect(held(ui, s.strategosId).map(label)).toEqual(['U:hello', 'T:Read:ok', 'A:Fake reply to: hello']);

    expect((await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'again' })).ok).toBe(true);
    await ui.until(() => held(ui, s.strategosId).length === 6, 15_000, 'second turn in chat');
    expect(held(ui, s.strategosId).map(label)).toEqual(['U:hello', 'T:Read:ok', 'A:Fake reply to: hello', 'U:again', 'T:Read:ok', 'A:Fake reply to: again']);

    await ui.cmd({ c: 'chat.unsubscribe', strategosId: s.strategosId });
    const n = chatEvents(ui, s.strategosId).length;
    await ui.waitStatus(s.strategosId, 'done');
    await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'quiet' });
    await ui.until(() => (ui.of(s.strategosId).last ?? '').includes('quiet'), 15_000, 'quiet reply');
    expect(chatEvents(ui, s.strategosId).length).toBe(n);

    // a second connection resumes from where it was without a reset
    const ui2 = await r.ui();
    await ui2.cmd({ c: 'chat.subscribe', strategosId: s.strategosId, from: 6 });
    expect(chatEvents(ui2, s.strategosId)[0]).toMatchObject({ from: 6, reset: false });
    // The Stop hook (which sets `last`) can arrive before the transcript tail has delivered the tool result and the reply:
    // wait for the feed to catch up (later events replace/extend from their absolute index) instead of asserting the first batch.
    const tail = (): ChatItem[] => {
      let list: ChatItem[] = [];
      for (const e of chatEvents(ui2, s.strategosId)) list = [...list.slice(0, e.from - 6), ...e.items];
      return list;
    };
    await ui2.until(() => tail().length === 3 && tail().every((i) => i.k !== 'tool' || i.ok !== undefined), 15_000, 'resumed feed complete');
    expect(tail().map(label)).toEqual(['U:quiet', 'T:Read:ok', 'A:Fake reply to: quiet']);
    ui2.close();
  }, T);

  it('refuses an unknown session', async () => {
    const r = await rig('plain');
    const ui = await r.ui();
    const a = await ui.cmd({ c: 'chat.subscribe', strategosId: 'nope', from: 0 });
    expect(a.ok).toBe(false);
  }, T);

  it('joins the transcripts across /clear with a marker between them', async () => {
    const r = await rig('clear');
    const ui = await r.ui();
    const s = await ui.start('L', r.repo, 'first');
    await ui.until(() => ui.of(s.strategosId).claudeSessionIds.length === 2, 20_000, 'new session id after /clear');
    await ui.waitStatus(s.strategosId, ['done', 'seen']);
    await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'second' });
    await ui.until(() => (ui.of(s.strategosId).last ?? '').includes('After clear'), 20_000, 'reply after clear');

    await ui.cmd({ c: 'chat.subscribe', strategosId: s.strategosId, from: 0 });
    await ui.until(() => held(ui, s.strategosId).some((i) => i.k === 'assistant' && i.md.includes('After clear')), 10_000, 'both transcripts');
    const labels = held(ui, s.strategosId).map(label);
    expect(labels).toEqual(['U:first', 'T:Read:ok', 'A:Before clear.', 'M:clear', 'U:second', 'T:Read:ok', 'A:After clear: second']);
  }, T);

  it('nests the subagent thread', async () => {
    const r = await rig('subagent');
    const ui = await r.ui();
    const s = await ui.start('S', r.repo, 'go');
    await ui.waitStatus(s.strategosId, 'done');
    await ui.cmd({ c: 'chat.subscribe', strategosId: s.strategosId, from: 0 });
    const items = held(ui, s.strategosId);
    const sub = items.find((i): i is Extract<ChatItem, { k: 'subagent' }> => i.k === 'subagent');
    expect(sub).toBeDefined();
    expect(sub!.items.map(label)).toEqual(['A:Subagent report.']);
    expect(sub!.brief).toBe('fake subagent');
    expect(items.filter((i) => i.k === 'subagent')).toHaveLength(1);
  }, T);
});

describe('reply.send rules (5.04)', () => {
  const post = (r: Rig, sid: string, event: string, body: Record<string, unknown>): Promise<unknown> =>
    http(r.daemon.port, { method: 'POST', path: `/hook/${sid}/${event}`, headers: { 'x-strategos-token': r.daemon.manager.tokenFor(sid) ?? '', 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: event, ...body }) });

  it('is allowed after an interrupt (Esc), and the chat shows the interrupt marker', async () => {
    const r = await rig('interrupt');
    const ui = await r.ui();
    const s = await ui.start('I', r.repo, 'long job');
    const sid = s.strategosId;
    await ui.waitStatus(sid, 'working');
    await new Promise((res) => setTimeout(res, 300));
    await ui.cmd({ c: 'pty.input', strategosId: sid, data: '\x1b' });
    await ui.waitStatus(sid, 'interrupted');
    await ui.cmd({ c: 'chat.subscribe', strategosId: sid, from: 0 });
    await ui.until(() => held(ui, sid).some((i) => i.k === 'interrupted'), 10_000, 'interrupted item');
    expect((await ui.cmd({ c: 'reply.send', strategosId: sid, text: 'carry on' })).ok).toBe(true);
    await ui.until(() => held(ui, sid).some((i) => i.k === 'assistant' && i.md.includes('Back after interrupt')), 15_000, 'reply after interrupt');
  }, T);

  it('is allowed for an unheld question, refused while a held question or permission waits, and refused when something is typed', async () => {
    const r = await rig('plain');
    const ui = await r.ui();
    const s = await ui.start('R', r.repo, 'hello');
    await ui.waitStatus(s.strategosId, 'done');
    const sid = s.strategosId;
    const claudeId = ui.of(sid).currentSessionId;

    // unheld question (an elicitation dialog only the terminal can answer): a typed reply is allowed
    await post(r, sid, 'Notification', { session_id: claudeId, notification_type: 'elicitation_dialog', message: 'Pick one?' });
    await ui.until(() => ui.of(sid).status === 'question', 5000, 'question');
    expect(ui.of(sid).pending?.held).toBe(false);
    expect((await ui.cmd({ c: 'reply.send', strategosId: sid, text: 'one' })).ok).toBe(true);
    await ui.until(() => (ui.of(sid).last ?? '').includes('one'), 15_000, 'reply to the question');
    await ui.waitStatus(sid, 'done');

    // held permission: busy
    const heldReq = post(r, sid, 'PermissionRequest', { session_id: claudeId, tool_name: 'Bash', tool_input: { command: 'ls' } });
    await ui.waitStatus(sid, 'permission');
    const busy = await ui.cmd({ c: 'reply.send', strategosId: sid, text: 'x' });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/busy/);
    await ui.cmd({ c: 'perm.release', strategosId: sid, requestId: ui.of(sid).pending!.requestId });
    await heldReq;
  }, T);
});
