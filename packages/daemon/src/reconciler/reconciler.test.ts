import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { MachineInput, Observation, SessionRecord } from '@strategos/shared';
import { FakeClaudeHome, appendBytes, writeText } from '../testing/tmp-fs.ts';
import { reduce } from '../sessions/state-machine.ts';
import { T0, makePending, makeSession } from '../sessions/state-machine.testkit.ts';
import { parseAgentsJson, rowToObservation, runAgentsCli, type ExecFn } from './agents-cli.ts';
import { FileReconciler, type ReconcilerDeps, type TrackedSession } from './reconciler.ts';
import { parseSessionFile, readSessionsDir } from './sessions-dir.ts';

let home: FakeClaudeHome;
beforeEach(() => {
  home = new FakeClaudeHome();
});
afterEach(() => home.dispose());

const tracked = (over: Partial<TrackedSession> = {}): TrackedSession => ({
  strategosId: 's1', claudeSessionIds: ['c1'], currentSessionId: 'c1', ptyPid: 100, live: true, ...over,
});

interface Rig {
  rec: FileReconciler;
  alive: Set<number>;
  sessions: TrackedSession[];
  clock: { now: number };
  execCalls: string[][];
  agents: { text: string; code: number | null; throws: boolean };
  errors: unknown[];
}
function rig(over: Partial<ReconcilerDeps> = {}, withAgents = false): Rig {
  const alive = new Set<number>([100]);
  const sessions = [tracked()];
  const clock = { now: T0 };
  const execCalls: string[][] = [];
  const agents = { text: '[]', code: 0 as number | null, throws: false };
  const errors: unknown[] = [];
  const exec: ExecFn = async (exe, args) => {
    execCalls.push([exe, ...args]);
    if (agents.throws) throw new Error('spawn failed');
    return { stdout: agents.text, code: agents.code };
  };
  const rec = new FileReconciler({
    claudeConfigDir: home.root,
    sessions: () => sessions,
    isAlive: async (pid) => alive.has(pid),
    now: () => clock.now,
    onError: (e) => errors.push(e),
    ...(withAgents ? { exec, claudeExe: 'C:/claude.exe' } : {}),
    ...over,
  });
  return { rec, alive, sessions, clock, execCalls, agents, errors };
}

describe('sessions-dir', () => {
  it('parses the shape Claude Code writes', () => {
    const f = parseSessionFile('48852.json', JSON.stringify({
      pid: 48852, sessionId: 'abc', cwd: '~/repo', startedAt: 1, procStart: '134361970286705107', version: '2.1.292', kind: 'interactive',
      entrypoint: 'cli', name: 'spike', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 7, updatedAt: 7,
    }));
    expect(f).toMatchObject({ pid: 48852, sessionId: 'abc', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 7, procStart: '134361970286705107', kind: 'interactive' });
  });

  it.each([['not json'], ['[]'], ['null'], ['{"pid":1}'], ['{"sessionId":"x"}'], ['{"pid":"1","sessionId":"x"}'], ['{"pid":1,"sessionId":""}']])('rejects %j', (text) => {
    expect(parseSessionFile('x.json', text)).toBeNull();
  });

  it('unknown status values are dropped, other fields kept', () => {
    expect(parseSessionFile('x.json', '{"pid":1,"sessionId":"s","status":"asleep"}')).toMatchObject({ pid: 1, status: undefined });
  });

  it('reads every .json, ignores .key files and junk, tolerates a half-written file', async () => {
    home.addSessionFile({ pid: 2, sessionId: 'b' });
    home.addSessionFile({ pid: 1, sessionId: 'a', status: 'busy' });
    home.addRawSessionFile('1.0123abcd.key', 'secret-ish');
    home.addRawSessionFile('3.json', '{"pid":3,"sess');
    home.addRawSessionFile('notes.txt', 'x');
    const files = await readSessionsDir(home.root);
    expect(files.map((f) => f.sessionId)).toEqual(['a', 'b']);
  });

  it('a missing config dir is an empty list', async () => {
    expect(await readSessionsDir(join(home.root, 'nope'))).toEqual([]);
  });

  it('never changes the directory', async () => {
    home.addSessionFile({ pid: 1, sessionId: 'a' });
    const before = home.listing();
    await readSessionsDir(home.root);
    expect(home.listing()).toEqual(before);
  });
});

describe('agents-cli', () => {
  it('parses a bare array, a wrapped array, and field spellings', () => {
    const row = { sessionId: 's', pid: 5, status: 'waiting', waitingFor: 'dialog open', kind: 'interactive', cwd: '/r', name: 'n', statusUpdatedAt: 9 };
    expect(parseAgentsJson(JSON.stringify([row]))).toEqual([row]);
    expect(parseAgentsJson(JSON.stringify({ agents: [row] }))).toEqual([row]);
    expect(parseAgentsJson(JSON.stringify({ sessions: [{ session_id: 'q', waiting_for: 'x', status_updated_at: 3 }] }))).toEqual([
      { sessionId: 'q', pid: undefined, status: undefined, waitingFor: 'x', kind: undefined, cwd: undefined, name: undefined, statusUpdatedAt: 3 },
    ]);
    expect(parseAgentsJson(JSON.stringify([{ id: 'z', state: 'working' }, { id: 'y', state: 'blocked' }, { id: 'w', state: 'done' }, { id: 'v', state: 'mystery' }])).map((r) => r.status))
      .toEqual(['busy', 'waiting', 'idle', undefined]);
  });

  it('is tolerant of garbage', () => {
    expect(parseAgentsJson('')).toEqual([]);
    expect(parseAgentsJson('{"nothing":1}')).toEqual([]);
    expect(parseAgentsJson('"str"')).toEqual([]);
    expect(parseAgentsJson(JSON.stringify([1, null, 'x', {}, { sessionId: '' }, { sessionId: 'ok' }])).map((r) => r.sessionId)).toEqual(['ok']);
  });

  it('runAgentsCli passes the arguments through the injected exec and survives failures', async () => {
    const calls: string[][] = [];
    const ok: ExecFn = async (exe, args, o) => { calls.push([exe, ...args, String(o.timeoutMs)]); return { stdout: '[{"sessionId":"s"}]', code: 0 }; };
    expect(await runAgentsCli(ok, 'claude', 5000)).toEqual([expect.objectContaining({ sessionId: 's' })]);
    expect(calls).toEqual([['claude', 'agents', '--json', '5000']]);
    expect(await runAgentsCli(async () => ({ stdout: '[]', code: 1 }), 'claude')).toBeNull();
    expect(await runAgentsCli(async () => { throw new Error('x'); }, 'claude')).toBeNull();
  });

  it('rowToObservation', () => {
    expect(rowToObservation({ sessionId: 's', status: 'idle' }, { alive: true, ownedByUs: false, strategosId: 'x' })).toEqual({
      strategosId: 'x', claudeSessionId: 's', pid: 0, alive: true, ownedByUs: false, status: 'idle', waitingFor: undefined, statusUpdatedAt: undefined, source: 'agents_cli',
    });
  });
});

describe('FileReconciler.tick (sessions dir)', () => {
  it('turns a session file into an observation mapped to our record', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 5, procStart: 'P' });
    const r = rig();
    expect(await r.rec.tick()).toEqual([{
      strategosId: 's1', claudeSessionId: 'c1', pid: 100, procStart: 'P', alive: true, ownedByUs: true,
      status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 5, source: 'sessions_dir',
    }]);
  });

  it('skips sessions that are not ours', async () => {
    home.addSessionFile({ pid: 7, sessionId: 'someone-else' });
    expect(await rig().rec.tick()).toEqual([]);
  });

  it('a dead pid is reported as not alive (pid-reuse is isAlive’s job via procStart)', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'busy' });
    const r = rig();
    r.alive.clear();
    expect((await r.rec.tick())[0]).toMatchObject({ alive: false, ownedByUs: true });
  });

  it('our id owned by a different pid is ownedByUs:false', async () => {
    home.addSessionFile({ pid: 999, sessionId: 'c1' });
    const r = rig();
    r.alive.add(999);
    expect((await r.rec.tick())[0]).toMatchObject({ pid: 999, alive: true, ownedByUs: false });
  });

  it('with no pty of our own nothing is ours', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1' });
    const r = rig();
    r.sessions[0] = tracked({ ptyPid: undefined });
    expect((await r.rec.tick())[0]?.ownedByUs).toBe(false);
  });

  it('a descendant of our pty (a shim in front of claude) counts as ours when the platform says so', async () => {
    home.addSessionFile({ pid: 555, sessionId: 'c1' });
    const asked: [number, number][] = [];
    const r = rig({ isDescendant: async (pid, anc) => { asked.push([pid, anc]); return pid === 555 && anc === 100; } });
    r.alive.add(555);
    expect((await r.rec.tick())[0]?.ownedByUs).toBe(true);
    expect(asked).toEqual([[555, 100]]);
  });

  it('maps an old lineage id to its record, and an unknown id by our pty pid (the /clear gap)', async () => {
    home.addSessionFile({ pid: 5, sessionId: 'c0' });
    home.addSessionFile({ pid: 100, sessionId: 'brand-new-after-clear' });
    const r = rig();
    r.sessions[0] = tracked({ claudeSessionIds: ['c0', 'c1'], currentSessionId: 'c1' });
    const obs = await r.rec.tick();
    expect(obs.map((o) => [o.claudeSessionId, o.strategosId]).sort()).toEqual([['brand-new-after-clear', 's1'], ['c0', 's1']]);
  });

  it('prefers the record whose current id matches', async () => {
    home.addSessionFile({ pid: 5, sessionId: 'shared' });
    const r = rig();
    r.sessions.splice(0, 2, tracked({ strategosId: 'old', claudeSessionIds: ['shared'], currentSessionId: 'other' }), tracked({ strategosId: 'cur', claudeSessionIds: ['shared'], currentSessionId: 'shared', ptyPid: undefined }));
    expect((await r.rec.tick())[0]?.strategosId).toBe('cur');
  });

  it('leaves the Claude directory untouched', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1' });
    home.addTranscript('proj', 'c1', [{ type: 'user', message: { content: 'hi' } }]);
    const before = home.listing();
    const r = rig({}, true);
    r.sessions[0] = tracked({ transcriptPath: join(home.root, 'projects', 'proj', 'c1.jsonl') });
    await r.rec.tick();
    await r.rec.inferTranscripts();
    await r.rec.onDemand('s1');
    expect(home.listing()).toEqual(before);
  });
});

describe('FileReconciler: agents CLI', () => {
  const row = (over: object = {}) => ({ sessionId: 'c1', pid: 100, status: 'busy', ...over });

  it('runs at the first tick, then every 60 s, not in between', async () => {
    const r = rig({}, true);
    await r.rec.tick();
    expect(r.execCalls).toEqual([['C:/claude.exe', 'agents', '--json']]);
    r.clock.now += 59_000;
    await r.rec.tick();
    expect(r.execCalls).toHaveLength(1);
    r.clock.now += 1_000;
    await r.rec.tick();
    expect(r.execCalls).toHaveLength(2);
  });

  it('reports an agent row only where the folder is silent or disagrees', async () => {
    const r = rig({}, true);
    r.agents.text = JSON.stringify([row({ status: 'busy' })]);
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'busy' });
    expect((await r.rec.tick()).map((o) => o.source)).toEqual(['sessions_dir']); // agreement
    r.clock.now += 60_000;
    r.agents.text = JSON.stringify([row({ status: 'waiting', waitingFor: 'permission prompt' })]);
    expect((await r.rec.tick()).map((o) => o.source)).toEqual(['sessions_dir', 'agents_cli']); // disagreement
    r.clock.now += 60_000;
    home.removeSessionFile(100);
    expect((await r.rec.tick()).map((o) => o.source)).toEqual(['agents_cli']); // folder silent
  });

  it('ignores rows that are not ours; a row without a pid is alive and not ours', async () => {
    const r = rig({}, true);
    r.agents.text = JSON.stringify([{ sessionId: 'stranger', pid: 9, status: 'busy' }, { sessionId: 'c1', status: 'idle' }]);
    const obs = await r.rec.tick();
    expect(obs).toEqual([expect.objectContaining({ claudeSessionId: 'c1', pid: 0, alive: true, ownedByUs: false, source: 'agents_cli' })]);
  });

  it('a failing CLI keeps the last good rows and does not throw', async () => {
    const r = rig({}, true);
    r.agents.text = JSON.stringify([row()]);
    await r.rec.tick();
    r.clock.now += 60_000;
    r.agents.throws = true;
    await expect(r.rec.tick()).resolves.toBeDefined();
    r.agents.throws = false;
    r.agents.code = 2;
    r.clock.now += 60_000;
    expect((await r.rec.onDemand('s1'))?.claudeSessionId).toBe('c1');
  });

  it('without exec or exe the CLI half is simply off', async () => {
    const r = rig({}, false);
    expect(await r.rec.tick()).toEqual([]);
    expect(r.execCalls).toEqual([]);
  });

  it('onDemand forces a run and answers for one session; unknown session -> null', async () => {
    const r = rig({}, true);
    await r.rec.tick();
    r.agents.text = JSON.stringify([row({ status: 'idle' })]);
    const o = await r.rec.onDemand('s1');
    expect(r.execCalls).toHaveLength(2);
    expect(o).toMatchObject({ strategosId: 's1', status: 'idle', source: 'agents_cli', ownedByUs: true });
    expect(await r.rec.onDemand('nope')).toBeNull();
  });

  it('onDemand falls back to the folder, then to null', async () => {
    const r = rig({}, true);
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'idle' });
    expect(await r.rec.onDemand('s1')).toMatchObject({ source: 'sessions_dir', status: 'idle' });
    home.removeSessionFile(100);
    expect(await r.rec.onDemand('s1')).toBeNull();
  });
});

describe('FileReconciler.inferTranscripts', () => {
  const asst = (stop: string, text = 'Done.', n = 1) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 7, 9, 0, n)).toISOString(), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
  const usr = (text: string, n = 1) => ({ type: 'user', timestamp: new Date(Date.UTC(2026, 9, 7, 9, 0, n)).toISOString(), message: { role: 'user', content: text } });

  function withTranscript(records: unknown[]): { r: Rig; path: string } {
    const path = home.addTranscript('proj', 'c1', records);
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: path });
    return { r, path };
  }

  it('end_turn -> awaiting_reply with the question flag; a user prompt -> working; marker -> interrupt_marker', async () => {
    const a = withTranscript([usr('hi'), asst('end_turn', 'Which one?', 5)]);
    expect(await a.r.rec.inferTranscripts()).toEqual([{ strategosId: 's1', input: { k: 'transcript', signal: 'awaiting_reply', lastIsQuestion: true, at: Date.UTC(2026, 9, 7, 9, 0, 5) } }]);
    home.dispose();
    home = new FakeClaudeHome();
    const b = withTranscript([asst('end_turn'), usr('next')]);
    expect((await b.r.rec.inferTranscripts())[0]?.input.signal).toBe('working');
    home.dispose();
    home = new FakeClaudeHome();
    const c = withTranscript([usr('go'), usr('[Request interrupted by user]')]);
    expect((await c.r.rec.inferTranscripts())[0]?.input.signal).toBe('interrupt_marker');
  });

  it('is level-triggered and re-reads only when the file changes', async () => {
    const { r, path } = withTranscript([asst('end_turn')]);
    const first = await r.rec.inferTranscripts();
    expect(await r.rec.inferTranscripts()).toEqual(first);
    appendBytes(path, `${JSON.stringify(usr('again', 9))}\n`);
    expect((await r.rec.inferTranscripts())[0]?.input.signal).toBe('working');
  });

  it('skips sessions that are not live, have no transcript, or whose file is missing', async () => {
    const { r } = withTranscript([asst('end_turn')]);
    r.sessions.push(tracked({ strategosId: 's2', live: false, transcriptPath: r.sessions[0]?.transcriptPath }));
    r.sessions.push(tracked({ strategosId: 's3', transcriptPath: undefined }));
    r.sessions.push(tracked({ strategosId: 's4', transcriptPath: join(home.root, 'projects', 'gone.jsonl') }));
    expect((await r.rec.inferTranscripts()).map((i) => i.strategosId)).toEqual(['s1']);
    expect(r.errors).toEqual([]);
  });

  it('a transcript with nothing decisive gives no input; a big one retries with a larger window', async () => {
    const path = join(home.root, 'projects', 'proj', 'c1.jsonl');
    const filler = Array.from({ length: 3000 }, (_, i) => `${JSON.stringify({ type: 'system', subtype: 'x', i, pad: 'p'.repeat(150) })}\n`).join('');
    writeText(path, `${JSON.stringify(asst('end_turn', 'early answer'))}\n${filler}`);
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: path });
    expect((await r.rec.inferTranscripts())[0]?.input).toMatchObject({ signal: 'awaiting_reply' });
    writeText(path, filler);
    expect(await r.rec.inferTranscripts()).toEqual([]);
  });

  it('other read errors go to onError', async () => {
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: join(home.root, 'bad\u0000name') }); // stat fails with something other than ENOENT
    expect(await r.rec.inferTranscripts()).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});

describe('start()', () => {
  it('delivers observations and transcript inputs on a timer and stops', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'busy' });
    const path = home.addTranscript('proj', 'c1', [{ type: 'user', message: { content: 'hi' } }]);
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: path });
    const obs: Observation[] = [];
    const ins: string[] = [];
    const stop = r.rec.start({ onObservation: (o) => obs.push(o), onTranscript: (i) => ins.push(i.input.signal) }, 10);
    await new Promise((res) => setTimeout(res, 80));
    stop();
    const n = obs.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(ins[0]).toBe('working');
    await new Promise((res) => setTimeout(res, 40));
    expect(obs.length).toBe(n);
  });

  it('errors in a cycle go to onError and the loop continues', async () => {
    const r = rig();
    const stop = r.rec.start({ onObservation: () => { throw new Error('handler'); }, onTranscript: () => undefined }, 10);
    home.addSessionFile({ pid: 100, sessionId: 'c1' });
    await new Promise((res) => setTimeout(res, 80));
    stop();
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// reconciler -> reducer: the acceptance rows of task 1.13
// ---------------------------------------------------------------------------

describe('reconciler feeding the reducer', () => {
  /** Run one reconciler cycle and apply everything to the record, like the session manager will. */
  async function cycle(r: Rig, s: SessionRecord, now: number): Promise<SessionRecord> {
    let cur = s;
    const inputs: MachineInput[] = [];
    for (const o of await r.rec.tick()) inputs.push({ k: 'reconciler', obs: o });
    for (const i of await r.rec.inferTranscripts()) inputs.push(i.input);
    for (const e of inputs) cur = reduce(cur, e, now).next;
    return cur;
  }

  it('NEVER clears a held permission, whatever the folder and the transcript say', async () => {
    const path = home.addTranscript('proj', 'c1', [
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] } },
    ]);
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: path });
    let s = makeSession({ status: 'permission', pending: makePending(), transcriptPath: path });
    for (const status of ['idle', 'busy', 'waiting'] as const) {
      home.addSessionFile({ pid: 100, sessionId: 'c1', status, waitingFor: status === 'waiting' ? 'permission prompt' : undefined });
      s = await cycle(r, s, T0 + 3_600_000);
      expect(s.status).toBe('permission');
      expect(s.pending).toEqual(makePending());
    }
  });

  it('NEVER clears a terminal-only question either', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'idle' });
    const r = rig();
    const q = makePending({ kind: 'question', held: false });
    const s = await cycle(r, makeSession({ status: 'question', pending: q }), T0 + 3_600_000);
    expect(s).toMatchObject({ status: 'question', pending: q });
  });

  it('"permission prompt" in the folder with no hook -> permission, held:false, labelled reconciler', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'waiting', waitingFor: 'permission prompt' });
    const r = rig();
    const s = await cycle(r, makeSession({ now: { tool: 'Write', summary: 'src/a.ts', since: 1 } }), T0);
    expect(s).toMatchObject({ status: 'permission', statusSource: 'reconciler' });
    expect(s.pending).toMatchObject({ held: false, toolName: 'Write' });
  });

  it('idle in the folder + end_turn in the transcript -> done, labelled as inferred', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'idle' });
    const path = home.addTranscript('proj', 'c1', [{ type: 'assistant', timestamp: new Date(T0).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready?' }] } }]);
    const r = rig();
    r.sessions[0] = tracked({ transcriptPath: path });
    const s = await cycle(r, makeSession({ statusSince: T0 - 60_000 }), T0 + 1);
    expect(s.status).toBe('done');
    expect(['reconciler', 'transcript']).toContain(s.statusSource);
  });

  it('open_elsewhere: another process on our id while we have none, then it exits -> stopped', async () => {
    home.addSessionFile({ pid: 999, sessionId: 'c1', status: 'busy' });
    const r = rig();
    r.alive.add(999);
    r.sessions[0] = tracked({ ptyPid: undefined, live: false });
    let s = makeSession({ status: 'stopped', pty: undefined });
    s = await cycle(r, s, T0);
    expect(s).toMatchObject({ status: 'open_elsewhere', statusSource: 'reconciler' });
    s = await cycle(r, s, T0 + 3000);
    expect(s.status).toBe('open_elsewhere');
    r.alive.delete(999);
    s = await cycle(r, s, T0 + 6000);
    expect(s.status).toBe('stopped');
  });

  it('our own live process alone never produces open_elsewhere', async () => {
    home.addSessionFile({ pid: 100, sessionId: 'c1', status: 'busy' });
    const r = rig();
    const s = await cycle(r, makeSession(), T0);
    expect(s.status).toBe('working');
  });
});
