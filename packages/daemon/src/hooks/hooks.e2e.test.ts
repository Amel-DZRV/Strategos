// End to end: tools/fake-claude.ts started with the settings file the settings writer produced (so the SessionStart relay
// command, the quoted node path and the http hooks are all exercised for real), talking to the real server, receiver,
// registry and reducer. The fake posts frightening commands as strings only; nothing is executed.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTmp, rmTree, writeText } from '../../../../tools/tmp-fs.ts';
import { makeHarness, type Harness } from './testkit.ts';
import { writeRunSettings } from './settings-writer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FAKE = path.join(ROOT, 'tools', 'fake-claude.ts');
const RELAY = path.join(ROOT, 'tools', 'hook-relay.mjs');
const TAP = path.join(ROOT, 'packages', 'daemon', 'src', 'statusline', 'tap.mjs');

let h: Harness;
let work: string;
let cfg: string;
const children: ChildProcess[] = [];
const SID = 'e2e-1';

beforeEach(async () => {
  h = await makeHarness();
  const root = mkTmp('hooks-e2e-');
  work = path.join(root, 'work dir');
  cfg = path.join(root, 'claude-home');
  writeText(path.join(work, '.keep'), '');
  writeText(path.join(cfg, '.keep'), '');
});
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  await h.close();
  rmTree(path.dirname(work));
});

interface Fake { out: () => string; stdin: (s: string) => void; claudeId: string }

async function startFake(scenario: string): Promise<Fake> {
  const { token } = h.addSession(SID, { status: 'starting', launch: { addDirs: [], extraArgs: [], firstPrompt: 'go' } });
  const claudeId = randomUUID();
  const settings = await writeRunSettings(h.env.fs, h.env.home, { strategosId: SID, port: h.server.port, nodePath: process.execPath, tapPath: TAP, relayPath: RELAY });
  const child = spawn(process.execPath, [FAKE, '--session-id', claudeId, '--settings', settings, '--name', 'fake'], {
    cwd: work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: cfg, FAKE_CLAUDE_SCRIPT: scenario, FAKE_CLAUDE_PROMPT: 'go', FAKE_CLAUDE_STEP_MS: '1',
      STRATEGOS_HOOK_TOKEN: token, STRATEGOS_PORT: String(h.server.port),
    },
  });
  children.push(child);
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => { buf += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { buf += d.toString(); });
  return { out: () => buf, stdin: (s) => { child.stdin!.write(s); }, claudeId };
}

const T = 30_000;
const pending = () => h.get(SID).pending;

describe('fake-claude permission scenario', () => {
  it('SessionStart arrives through the relay and the session leaves "starting"; then the request is held', async () => {
    const f = await startFake('permission');
    await h.until(() => h.get(SID).status === 'permission', T, 'permission');
    expect(h.get(SID)).toMatchObject({ currentSessionId: f.claudeId, claudeSessionIds: [f.claudeId], pending: { held: true, toolName: 'Bash', inputSummary: 'rm -rf /' } });
    expect(h.effects.some((e) => e.e === 'log' && e.type === 'status' && e.data['why'] === 'SessionStart:startup')).toBe(true);
  }, T);

  it('allow: the fake continues as if the owner approved, the turn ends done', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    expect(h.registry.decide(SID, pending()!.requestId, { kind: 'allow', via: 'drawer' })).toEqual({ ok: true });
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via hook)');
    expect(f.out()).toContain('Bash ran (pretend)');
  }, T);

  it('deny: the fake sees a denial', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    h.registry.decide(SID, pending()!.requestId, { kind: 'deny', message: 'no way', via: 'strip' });
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(deny via hook)');
    expect(f.out()).toContain('Denied');
  }, T);

  it('always: allowed', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    h.registry.decide(SID, pending()!.requestId, { kind: 'always', suggestionIndex: 0, via: 'drawer' });
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via hook)');
  }, T);

  it('release: nothing is decided, the terminal dialog stays and the owner can answer there', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    h.registry.release(SID, pending()!.requestId, 'terminal-focus');
    await h.until(() => pending()?.held === false, T, 'released');
    expect(f.out()).not.toContain('via hook');
    f.stdin('1'); // the owner presses Yes in the terminal
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via tty)');
  }, T);

  it('close: Esc in the terminal closes the held connection; the session is no longer pending', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    f.stdin('\x1b');
    await h.until(() => pending() === undefined, T, 'pending cleared by the close');
    expect(h.get(SID).status).toBe('working');
    expect(h.registry.size).toBe(0);
    await h.audit.idle();
    expect(h.audit.read().at(-1)).toMatchObject({ decision: 'release', via: 'terminal', tool: 'Bash' });
  }, T);

  it('answered in the terminal (Yes does NOT close the connection): PostToolUse releases the held request', async () => {
    const f = await startFake('permission');
    await h.until(() => pending()?.held === true, T, 'held');
    f.stdin('1');
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via tty)');
    expect(h.registry.size).toBe(0);
    expect(pending()).toBeUndefined();
  }, T);
});

describe('fake-claude question scenario', () => {
  it('answers: PreToolUse allow with the answers; the fake continues with them', async () => {
    const f = await startFake('question');
    await h.until(() => h.get(SID).status === 'question' && pending()?.held === true, T, 'question');
    expect(pending()).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', questions: [{ question: 'Which flavour?', options: [{ label: 'Vanilla' }, { label: 'Chocolate' }] }] });
    expect(h.registry.decide(SID, pending()!.requestId, { kind: 'answers', answers: { 'Which flavour?': 'Chocolate' }, via: 'drawer' })).toEqual({ ok: true });
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via hook)');
    expect(h.get(SID).last).toContain('Chocolate');
  }, T);

  it('release of the PreToolUse: Claude then raises a PermissionRequest for the same tool, held as a question again', async () => {
    const f = await startFake('question');
    await h.until(() => pending()?.held === true, T, 'held');
    const first = pending()!.requestId;
    h.registry.release(SID, first, 'user');
    // the fake does what real Claude does after PreToolUse returned nothing: a PermissionRequest for AskUserQuestion
    await h.until(() => pending()?.held === true && pending()!.requestId !== first, T, 'second request');
    expect(pending()).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion' });
    expect(h.registry.decide(SID, pending()!.requestId, { kind: 'answers', answers: { 'Which flavour?': 'Vanilla' } })).toEqual({ ok: true });
    await h.until(() => h.get(SID).status === 'done', T, 'done');
    expect(f.out()).toContain('(allow via hook)');
  }, T);
});
