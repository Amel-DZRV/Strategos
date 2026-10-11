import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkTmp, rmTree, writeText } from './tmp-fs.ts';
import { startHookServer, writeTestSettings, type HookServer, type RecordedHook } from './fake-hook-server.ts';
import { listing } from './fake-claude-home.ts';
import { projectDirName } from '../packages/daemon/src/platform/common/project-dir.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.ts');

interface Run {
  child: ChildProcess;
  out: () => string;
  stdin: (s: string) => void;
  exited: Promise<number | null>;
  id: string;
}

describe('fake-claude scenarios', () => {
  let root: string;      // temp root holding the config dir, the cwd and settings
  let cfg: string;       // CLAUDE_CONFIG_DIR
  let work: string;      // cwd of the fake
  let server: HookServer;
  const running: ChildProcess[] = [];

  beforeEach(async () => {
    root = mkTmp('fakeclaude-');
    cfg = join(root, 'claude-home');
    work = join(root, 'work dir'); // a space in the cwd on purpose
    writeText(join(work, '.keep'), '');
    writeText(join(cfg, '.keep'), '');
    server = await startHookServer();
  });
  afterEach(async () => {
    // wait for the exit so no child still holds the cwd/config dir when rmTree runs (Windows EPERM/EBUSY)
    await Promise.all(running.splice(0).map((c) => new Promise<void>((res) => {
      if (c.exitCode !== null || c.signalCode !== null) return res();
      c.once('exit', () => res());
      c.kill('SIGKILL');
    })));
    await server.close();
    rmTree(root);
  });

  function start(scenario: string, opts: { args?: string[]; env?: Record<string, string | undefined>; id?: string } = {}): Run {
    const id = opts.id ?? randomUUID();
    const settings = writeTestSettings(root, { port: server.port, strategosId: 'sx-' + id.slice(0, 6) });
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: cfg, FAKE_CLAUDE_SCRIPT: scenario, STRATEGOS_HOOK_TOKEN: 'tok-123', STRATEGOS_PORT: String(server.port), FAKE_CLAUDE_STEP_MS: '1', ...opts.env };
    const args = opts.args ?? ['--session-id', id];
    const child = spawn(process.execPath, [FAKE, ...args, '--settings', settings, '--name', 'fake one'], { cwd: work, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    running.push(child);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => { buf += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { buf += d.toString(); });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    return { child, out: () => buf, stdin: (s) => { child.stdin!.write(s); }, exited, id };
  }

  const ev = (name: string, tool?: string) => (h: RecordedHook): boolean => h.event === name && (tool === undefined || h.body['tool_name'] === tool);
  const transcript = (id: string): Record<string, any>[] => {
    const f = join(cfg, 'projects', projectDirName(work), `${id}.jsonl`);
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  // The fake rewrites its sessions file in place (truncate, then write): a read that lands in between sees an empty or partial file.
  const readSession = (r: Run): Record<string, any> => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(readFileSync(join(cfg, 'sessions', `${r.child.pid}.json`), 'utf8')); } catch (e) {
        if (i >= 100) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  };
  const waitOut = async (r: Run, text: string, ms = 15_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!r.out().includes(text)) {
      if (Date.now() > end) throw new Error(`timed out waiting for output ${JSON.stringify(text)}; got ${JSON.stringify(r.out().slice(-300))}`);
      await new Promise((res) => setTimeout(res, 20));
    }
  };

  it('plain turn: hooks in order with the token header, transcript, sessions file, clean /exit', async () => {
    const r = start('plain');
    await server.waitFor(ev('SessionStart'));
    await waitOut(r, '> ');
    expect(existsSync(join(cfg, 'sessions', `${r.child.pid}.json`))).toBe(true);
    r.stdin('say hi\r');
    await server.waitFor(ev('Stop'));
    expect(server.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop']);
    for (const h of server.hooks) {
      expect(h.headers['x-strategos-token']).toBe('tok-123');
      expect(h.strategosId).toBe('sx-' + r.id.slice(0, 6));
      expect(h.body['session_id']).toBe(r.id);
      expect(h.body['cwd']).toBe(work);
      expect(h.body['hook_event_name']).toBe(h.event);
    }
    const pre = server.hooks[2]!.body;
    expect(pre['tool_name']).toBe('Read');
    expect(pre['tool_use_id']).toMatch(/^toolu_/);
    expect(server.hooks[1]!.body['prompt']).toBe('say hi');
    expect(server.hooks[5]!.body['last_assistant_message']).toBe('Fake reply to: say hi');
    expect(server.hooks[0]!.body['source']).toBe('startup');
    const t = transcript(r.id);
    expect(t.map((x) => x['type'])).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(t[0]!['message'].content).toBe('say hi');
    expect(t[0]!['sessionId']).toBe(r.id);
    expect(t[3]!['message'].content[0].text).toBe('Fake reply to: say hi');
    const sess = readSession(r);
    expect(sess).toMatchObject({ pid: r.child.pid, sessionId: r.id, cwd: work, kind: 'interactive', status: 'idle', name: 'fake one' });
    r.stdin('/exit\r');
    expect(await r.exited).toBe(0);
    expect(server.hooks.at(-1)).toMatchObject({ event: 'SessionEnd' });
    expect(server.hooks.at(-1)!.body['reason']).toBe('prompt_input_exit');
    expect(existsSync(join(cfg, 'sessions', `${r.child.pid}.json`))).toBe(false);
  }, 60_000);

  it('FAKE_CLAUDE_PROMPT runs a turn with no stdin and exits when stdin is closed', async () => {
    const r = start('plain', { env: { FAKE_CLAUDE_PROMPT: 'auto prompt' } });
    r.child.stdin!.end();
    expect(await r.exited).toBe(0);
    expect(server.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']);
  }, 60_000);

  it('--resume keeps the id and reports source=resume', async () => {
    const id = randomUUID();
    const r = start('plain', { args: ['--resume', id] });
    const h = await server.waitFor(ev('SessionStart'));
    expect(h.body['source']).toBe('resume');
    expect(h.body['session_id']).toBe(id);
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  describe('permission', () => {
    const holdPermission = () => server.setResponder((h) => (h.event === 'PermissionRequest' ? 'hold' : { status: 200 }));
    const allow = { json: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } };
    const deny = { json: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } } };

    it('holds until the daemon allows, then continues to PostToolUse and Stop; the command is only a string', async () => {
      holdPermission();
      const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
      const pr = await server.waitFor(ev('PermissionRequest'));
      expect(pr.body['tool_name']).toBe('Bash');
      expect((pr.body['tool_input'] as { command: string }).command).toBe('rm -rf /');
      await new Promise((res) => setTimeout(res, 300));
      expect(server.events()).not.toContain('PostToolUse');
      expect(readSession(r)).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' });
      (await server.waitHeld()).respond(allow);
      await server.waitFor(ev('Stop'));
      expect(server.events()).toContain('PostToolUse');
      expect(r.out()).toContain('allow via hook');
      r.stdin('/exit\r');
      await r.exited;
    }, 60_000);

    it('deny skips PostToolUse', async () => {
      holdPermission();
      const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
      await server.waitFor(ev('PermissionRequest'));
      (await server.waitHeld()).respond(deny);
      await server.waitFor(ev('Stop'));
      expect(server.events()).not.toContain('PostToolUse');
      expect(transcript(r.id).some((x) => JSON.stringify(x).includes('doesn'))).toBe(true);
      r.stdin('/exit\r');
      await r.exited;
    }, 60_000);

    it('answering in the terminal does NOT close the held request (as in real Claude) and the turn continues', async () => {
      holdPermission();
      const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
      const pr = await server.waitFor(ev('PermissionRequest'));
      await waitOut(r, 'Do you want to proceed?');
      r.stdin('1');
      await server.waitFor(ev('Stop'));
      expect(pr.closedByClient).toBe(false); // [ran, S2] real Claude leaves the held request open
      expect(r.out()).toContain('allow via tty');
      r.stdin('/exit\r');
      await r.exited;
    }, 60_000);

    it('an empty 200 means "no decision": the terminal decides', async () => {
      const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
      await server.waitFor(ev('PermissionRequest'));
      await waitOut(r, 'Do you want to proceed?');
      await new Promise((res) => setTimeout(res, 200));
      expect(server.events()).not.toContain('Stop');
      r.stdin('3');
      await server.waitFor(ev('Stop'));
      expect(r.out()).toContain('deny via tty');
      r.stdin('/exit\r');
      await r.exited;
    }, 60_000);

    it('a non-2xx hook response is non-blocking (fail open to the terminal)', async () => {
      server.setResponder((h) => (h.event === 'PermissionRequest' ? { status: 500 } : { status: 200 }));
      const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
      await server.waitFor(ev('PermissionRequest'));
      await waitOut(r, 'Do you want to proceed?');
      r.stdin('1');
      await server.waitFor(ev('Stop'));
      r.stdin('/exit\r');
      await r.exited;
    }, 60_000);
  });

  it('question: PreToolUse(AskUserQuestion) is held; allow with updatedInput.answers reaches the transcript', async () => {
    server.setResponder((h) => (h.event === 'PreToolUse' && h.body['tool_name'] === 'AskUserQuestion' ? 'hold' : { status: 200 }));
    const r = start('question', { env: { FAKE_CLAUDE_PROMPT: 'ask me' } });
    await server.waitFor(ev('PreToolUse', 'AskUserQuestion'));
    await new Promise((res) => setTimeout(res, 200));
    expect(readSession(r)).toMatchObject({ status: 'waiting', waitingFor: 'dialog open' });
    await server.waitHeld();
    const input = server.held[0]!.hook.body['tool_input'] as { questions: unknown[] };
    for (const h of [...server.held]) {
      h.respond({ json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: input.questions, answers: { 'Which flavour?': 'Chocolate' } } } } });
    }
    await server.waitFor(ev('Stop'));
    expect(JSON.stringify(transcript(r.id))).toContain('Chocolate');
    expect(server.hooks.some((h) => h.event === 'PostToolUse' && h.body['tool_name'] === 'AskUserQuestion')).toBe(true);
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('question answered in the terminal by option number', async () => {
    server.setResponder((h) => (h.event === 'PreToolUse' && h.body['tool_name'] === 'AskUserQuestion' ? 'hold' : { status: 200 }));
    const r = start('question', { env: { FAKE_CLAUDE_PROMPT: 'ask me' } });
    await server.waitFor(ev('PreToolUse', 'AskUserQuestion'));
    await waitOut(r, 'Which flavour?');
    r.stdin('2');
    await server.waitFor(ev('Stop'));
    expect(JSON.stringify(transcript(r.id))).toContain('Chocolate');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('subagent: events carry agent_id, a subagent transcript is written, top-level Stop follows', async () => {
    const r = start('subagent', { env: { FAKE_CLAUDE_PROMPT: 'delegate' } });
    await server.waitFor(ev('Stop'));
    expect(server.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PostToolUse', 'Stop']);
    const sub = server.hooks.filter((h) => h.body['agent_id'] === 'agent-fake1').map((h) => h.event);
    expect(sub).toEqual(['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop']);
    expect(server.hooks.at(-1)!.body['agent_id']).toBeUndefined();
    const dir = join(cfg, 'projects', projectDirName(work), r.id, 'subagents');
    expect(readdirSync(dir).sort()).toEqual(['agent-fake1.jsonl', 'agent-fake1.meta.json']);
    expect(readFileSync(join(dir, 'agent-fake1.jsonl'), 'utf8')).toContain('"isSidechain":true');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('subagent-permission: a subagent PermissionRequest carries agent_id and blocks until decided', async () => {
    server.setResponder((h) => (h.event === 'PermissionRequest' ? 'hold' : { status: 200 }));
    const r = start('subagent-permission', { env: { FAKE_CLAUDE_PROMPT: 'delegate' } });
    const pr = await server.waitFor(ev('PermissionRequest'));
    expect(pr.body['agent_id']).toBe('agent-fake1');
    (await server.waitHeld()).respond({ json: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } } });
    await server.waitFor(ev('Stop'));
    expect(r.out()).toContain('subagent: denied');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('/clear scenario: SessionEnd(clear) then SessionStart(clear) with a new id; the next turn writes the new transcript', async () => {
    const r = start('clear', { env: { FAKE_CLAUDE_PROMPT: 'first' } });
    const ss = await server.waitFor((h) => h.event === 'SessionStart' && h.body['source'] === 'clear');
    const end = server.hooks.find((h) => h.event === 'SessionEnd')!;
    expect(end.body['reason']).toBe('clear');
    expect(end.body['session_id']).toBe(r.id);
    const newId = ss.body['session_id'] as string;
    expect(newId).not.toBe(r.id);
    expect(server.hooks.indexOf(end)).toBeLessThan(server.hooks.indexOf(ss));
    expect(ss.body['transcript_path']).toBe(join(cfg, 'projects', projectDirName(work), `${newId}.jsonl`));
    await waitOut(r, '> ', 5000);
    await new Promise((res) => setTimeout(res, 150));
    r.stdin('second\r');
    await server.waitFor((h) => h.event === 'Stop' && h.body['session_id'] === newId);
    expect(transcript(newId)[0]!['message'].content).toBe('second');
    expect(transcript(r.id).length).toBeGreaterThan(0);
    // sessions/<pid>.json now names the new id
    expect(readSession(r).sessionId).toBe(newId);
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('a typed /clear works in any scenario', async () => {
    const r = start('plain');
    await server.waitFor(ev('SessionStart'));
    await waitOut(r, '> ');
    const before = readSession(r).sessionId;
    r.stdin('/clear\r');
    await server.waitFor((h) => h.event === 'SessionStart' && h.body['source'] === 'clear');
    // The hook is recorded before the fake finishes its /clear (the relay is still exiting): wait for the new prompt
    // instead of typing /exit into a half-finished clear.
    await waitOut(r, '(conversation cleared)');
    expect(readSession(r).sessionId).not.toBe(before);
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('interrupt: lone Esc writes the transcript marker, fires no Stop and returns to the prompt', async () => {
    const r = start('interrupt', { env: { FAKE_CLAUDE_PROMPT: 'long job' } });
    await server.waitFor(ev('PreToolUse', 'Bash'));
    await waitOut(r, 'esc to interrupt');
    r.stdin('\x1b');
    await waitOut(r, 'Interrupted');
    await new Promise((res) => setTimeout(res, 200));
    expect(server.events()).not.toContain('Stop');
    expect(server.events()).not.toContain('PostToolUseFailure');
    const marker = transcript(r.id).find((x) => JSON.stringify(x).includes('[Request interrupted by user'));
    expect(marker).toBeDefined();
    expect(JSON.stringify(marker)).toContain('[Request interrupted by user for tool use]');
    expect(readSession(r).status).toBe('idle');
    // the session is usable afterwards
    r.stdin('again\r');
    await server.waitFor(ev('Stop'));
    expect(r.out()).toContain('Back after interrupt: again');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('interrupt via Ctrl+C while working; Esc at a permission prompt closes the held connection', async () => {
    server.setResponder((h) => (h.event === 'PermissionRequest' ? 'hold' : { status: 200 }));
    const r = start('permission', { env: { FAKE_CLAUDE_PROMPT: 'go' } });
    const pr = await server.waitFor(ev('PermissionRequest'));
    await waitOut(r, 'Do you want to proceed?');
    r.stdin('\x1b');
    await waitOut(r, 'Interrupted');
    expect(pr.closedByClient).toBe(true); // an interrupt (unlike a TUI answer) ends the request [inferred]
    expect(server.events()).not.toContain('Stop');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('crash: exit code 1, no SessionEnd, stale sessions/<pid>.json left behind', async () => {
    const r = start('crash', { env: { FAKE_CLAUDE_PROMPT: 'boom' } });
    expect(await r.exited).toBe(1);
    expect(server.events()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(existsSync(join(cfg, 'sessions', `${r.child.pid}.json`))).toBe(true);
  }, 60_000);

  it('trust scenario: no hooks until Enter on the trust dialog', async () => {
    const r = start('trust');
    await waitOut(r, 'Do you trust the files');
    await new Promise((res) => setTimeout(res, 200));
    expect(server.events()).toEqual([]);
    r.stdin('\r');
    await server.waitFor(ev('SessionStart'));
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('a JSON scenario file is accepted', async () => {
    const file = writeText(join(root, 'scn.json'), JSON.stringify({ turns: [[
      { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
      { op: 'print', text: 'custom!\r\n' },
      { op: 'hook', event: 'Stop', body: { last_assistant_message: 'x' } },
    ]] }));
    const r = start(file, { env: { FAKE_CLAUDE_PROMPT: 'p' } });
    await server.waitFor(ev('Stop'));
    expect(r.out()).toContain('custom!');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('writes nothing without CLAUDE_CONFIG_DIR (the real ~/.claude is never used) and leaves the config dir listing unchanged', async () => {
    const before = listing(cfg);
    const r = start('plain', { env: { CLAUDE_CONFIG_DIR: '', FAKE_CLAUDE_PROMPT: 'x' } });
    r.child.stdin!.end();
    await r.exited;
    expect(r.out()).toContain('CLAUDE_CONFIG_DIR is not set');
    expect(listing(cfg)).toEqual(before);
    expect(server.events()).toContain('Stop');
  }, 60_000);

  it('ignores unknown flags', async () => {
    const r = start('plain', { args: ['--session-id', randomUUID(), '--model', 'x', '--permission-mode', 'default', '--add-dir', 'somewhere'] });
    await server.waitFor(ev('SessionStart'));
    r.stdin('/exit\r');
    expect(await r.exited).toBe(0);
  }, 60_000);

  it('SessionStart arrives through the command-hook relay (not http), with the token and the real body shape', async () => {
    const r = start('plain');
    const h = await server.waitFor(ev('SessionStart'));
    expect(h.headers['x-strategos-via']).toBe('command-relay');
    expect(h.headers['x-strategos-token']).toBe('tok-123');
    expect(h.body).toMatchObject({ session_id: r.id, hook_event_name: 'SessionStart', source: 'startup', model: 'fake-model', session_title: 'fake one' });
    expect(h.body['scratchpad_dir']).toEqual(expect.any(String));
    expect(h.body['permission_mode']).toBeUndefined(); // session-level events carry none, like the fixtures
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('--permission-mode is recorded in hook bodies; prompt_id and effort follow the fixtures', async () => {
    const r = start('plain', { args: ['--session-id', randomUUID(), '--permission-mode', 'plan'], env: { FAKE_CLAUDE_PROMPT: 'x' } });
    await server.waitFor(ev('Stop'));
    const pre = server.hooks.find((h) => h.event === 'PreToolUse')!;
    expect(pre.body).toMatchObject({ permission_mode: 'plan', effort: { level: 'medium' } });
    expect(pre.body['prompt_id']).toEqual(expect.any(String));
    expect(pre.body['prompt_id']).toBe(server.hooks.find((h) => h.event === 'UserPromptSubmit')!.body['prompt_id']);
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('plain turn includes SubagentStop with an empty agent_type and an agent_id (internal helper)', async () => {
    const r = start('plain', { env: { FAKE_CLAUDE_PROMPT: 'x' } });
    await server.waitFor(ev('Stop'));
    const s = server.hooks.find((h) => h.event === 'SubagentStop')!;
    expect(s.body['agent_type']).toBe('');
    expect(s.body['agent_id']).toEqual(expect.any(String));
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);

  it('question: PreToolUse (one request even though two matchers share the URL), then after "no decision" a PermissionRequest for AskUserQuestion', async () => {
    server.setResponder((h) => (h.event === 'PermissionRequest' ? 'hold' : { status: 200 }));
    const r = start('question', { env: { FAKE_CLAUDE_PROMPT: 'ask me' } });
    const pr = await server.waitFor(ev('PermissionRequest'));
    expect(pr.body['tool_name']).toBe('AskUserQuestion');
    expect(server.hooks.filter((h) => h.event === 'PreToolUse' && h.body['tool_name'] === 'AskUserQuestion')).toHaveLength(1);
    // answering in the terminal leaves the PermissionRequest open and the turn continues
    await waitOut(r, 'Which flavour?');
    r.stdin('1');
    await server.waitFor(ev('Stop'));
    expect(pr.closedByClient).toBe(false);
    expect(JSON.stringify(transcript(r.id))).toContain('Vanilla');
    r.stdin('/exit\r');
    await r.exited;
  }, 60_000);
});
