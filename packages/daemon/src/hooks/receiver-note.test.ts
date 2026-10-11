// The PostToolUse response (task 5.06 / D9): a note goes back as hookSpecificOutput.additionalContext, anything else stays an
// empty 200, and a throwing note callback fails open.
import { afterEach, describe, expect, it } from 'vitest';
import { createStrategosServer, type StrategosServer } from '../server/http.ts';
import { http } from '../server/testkit.ts';
import { createPendingRegistry } from './pending.ts';
import { createHookReceiver } from './receiver.ts';

let server: StrategosServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(onPostToolUse: Parameters<typeof createHookReceiver>[0]['onPostToolUse']) {
  const seen: { sid: string; tool: string; agentId?: string; toolInput?: unknown }[] = [];
  const errors: string[] = [];
  const registry = createPendingRegistry({ dispatch: () => [], onError: () => undefined });
  const receiver = createHookReceiver({
    registry, dispatch: () => [], onError: (_e, where) => errors.push(where),
    onPostToolUse: (sid, ev) => { seen.push({ sid, tool: ev.tool, ...(ev.agentId === undefined ? {} : { agentId: ev.agentId }), toolInput: ev.toolInput }); return onPostToolUse?.(sid, ev); },
  });
  server = createStrategosServer({ port: 0, tokenFor: (sid) => (sid === 's1' ? 'tok' : undefined) });
  server.setHookHandler(receiver.handle);
  await server.listen();
  const send = (event: string, body: object) => http(server!.port, {
    method: 'POST', path: `/hook/s1/${event}`, headers: { 'x-strategos-token': 'tok', 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, ...body }),
  });
  return { seen, errors, send };
}

describe('PostToolUse note', () => {
  it('returns additionalContext as hookSpecificOutput and passes the tool call and the subagent id', async () => {
    const { send, seen } = await setup(() => 'Note from Strategos: x also edited y.');
    const r = await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, tool_use_id: 't1', agent_id: 'ag1' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Note from Strategos: x also edited y.' } });
    expect(seen).toEqual([{ sid: 's1', tool: 'Edit', agentId: 'ag1', toolInput: { file_path: 'a.ts' } }]);
  });

  it('no note, or an empty one: an empty 200', async () => {
    const a = await setup(() => undefined);
    expect((await a.send('PostToolUse', { tool_name: 'Edit' })).body.toString()).toBe('');
    await server!.close();
    const b = await setup(() => '');
    expect((await b.send('PostToolUse', { tool_name: 'Edit' })).body.toString()).toBe('');
  });

  it('a throwing callback fails open; other events never reach it', async () => {
    const { send, seen, errors } = await setup(() => { throw new Error('boom'); });
    const r = await send('PostToolUse', { tool_name: 'Edit' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('');
    expect(errors).toContain('onPostToolUse');
    await send('Stop', {});
    await send('PostToolUseFailure', { tool_name: 'Edit' });
    expect(seen).toHaveLength(1);
  });
});
