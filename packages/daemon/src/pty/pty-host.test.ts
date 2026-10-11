import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPtyHost, scrubEnv, SCROLLBACK_LIMIT, type PtyHandle, type KeyEvent } from './pty-host.ts';
import { pasteAndSubmit } from './input.ts';
import { getPlatform } from '../platform/index.ts';
import { mkTmp, rmTree, writeText } from '../../../../tools/tmp-fs.ts';
import { startHookServer, writeTestSettings, type HookServer } from '../../../../tools/fake-hook-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, '..', '..', '..', '..', 'tools');
const FAKE = join(TOOLS, 'fake-claude.ts');
const win = process.platform === 'win32';

const host = createPtyHost({ escMs: 50 });
const open: PtyHandle[] = [];
async function killAll(): Promise<void> {
  const hs = open.splice(0);
  for (const h of hs) h.kill();
  await Promise.all(hs.map((h) => new Promise<void>((resolve) => { const t = setTimeout(resolve, 5000); h.onExit(() => { clearTimeout(t); resolve(); }); })));
}
afterEach(killAll);

async function until(cond: () => boolean, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function spawnShell(env: Record<string, string> = scrubEnv(process.env)): PtyHandle {
  const h = win
    ? host.spawn({ exe: `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\cmd.exe`, args: [], cwd: process.cwd(), env, cols: 100, rows: 30 })
    : host.spawn({ exe: '/bin/sh', args: [], cwd: process.cwd(), env, cols: 100, rows: 30 });
  open.push(h);
  return h;
}

describe('PtyHost with the platform shell', () => {
  it('spawns, echoes, reports the exit code', async () => {
    const h = spawnShell();
    expect(h.pid).toBeGreaterThan(0);
    expect(h.exitCode).toBeNull();
    const codes: number[] = [];
    h.onExit((c) => codes.push(c));
    h.write(win ? 'echo PING_%OS%\r' : 'echo PING_$((6*7))\r', 'strategos');
    await until(() => h.scrollback().includes(win ? 'PING_Windows_NT' : 'PING_42'), 15_000, 'echo output');
    h.write('exit 7\r', 'strategos');
    await until(() => codes.length > 0, 15_000, 'exit');
    expect(codes).toEqual([7]);
    expect(h.exitCode).toBe(7);
    // after exit: writes are ignored, onExit fires for late subscribers
    h.write('anything', 'user');
    h.resize(10, 10);
    h.kill();
    const late: number[] = [];
    h.onExit((c) => late.push(c));
    await until(() => late.length > 0, 2000, 'late onExit');
    expect(late).toEqual([7]);
  }, 60_000);

  it('resize reaches the child', async () => {
    const h = spawnShell();
    await until(() => h.scrollback().length > 0, 15_000, 'first output');
    h.resize(77, 25);
    h.write(win ? 'mode con\r' : 'stty size\r', 'strategos');
    await until(() => (win ? /Columns:\s+77/.test(h.scrollback()) : /25 77/.test(h.scrollback())), 15_000, 'resized size report');
    if (win) expect(h.scrollback()).toMatch(/Lines:\s+25/);
  }, 60_000);

  it('scrollback() is exactly the bytes onData delivered, in order', async () => {
    const h = spawnShell();
    const chunks: string[] = [];
    const off = h.onData((d) => chunks.push(d));
    h.write(win ? 'echo one&echo two&echo three\r' : 'echo one; echo two; echo three\r', 'strategos');
    await until(() => h.scrollback().includes('three'), 15_000, 'output');
    h.write('exit\r', 'strategos');
    await new Promise<void>((resolve) => h.onExit(() => resolve()));
    off();
    expect(chunks.length).toBeGreaterThan(0);
    expect(h.scrollback()).toBe(chunks.join(''));
    const late: string[] = [];
    h.onData((d) => late.push(d));
    expect(late).toEqual([]); // unsubscribed / exited handles deliver nothing more
  }, 60_000);

  it('the ring keeps the last 2 MiB of a 3 MB burst, byte for byte; the exe path may contain a space', async () => {
    const h = host.spawn({
      exe: process.execPath, // "C:/Program Files/nodejs/node.exe" on a default Windows install
      args: ['-e', "const l='0123456789abcdef'.repeat(63)+'\\n';let i=0;const t=setInterval(()=>{for(let k=0;k<200;k++)process.stdout.write(String(i++%10)+l);if(i>3000){clearInterval(t);setTimeout(()=>process.exit(0),500)}},1)"],
      cwd: process.cwd(), env: scrubEnv(process.env), cols: 120, rows: 30,
    });
    open.push(h);
    const chunks: string[] = [];
    h.onData((d) => chunks.push(d));
    const code = await new Promise<number>((resolve) => h.onExit(resolve));
    expect(code).toBe(0);
    const all = chunks.join('');
    expect(all.length).toBeGreaterThan(SCROLLBACK_LIMIT);
    expect(h.scrollback().length).toBe(SCROLLBACK_LIMIT);
    expect(h.scrollback()).toBe(all.slice(-SCROLLBACK_LIMIT));
  }, 120_000);

  it('the child sees the scrubbed environment (ANTHROPIC_* and CLAUDE_CODE_* gone, CLAUDE_CONFIG_DIR kept)', async () => {
    const src = { ...process.env, ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_SIMPLE: '1', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: join(process.cwd(), 'cfg-marker'), KEEP_ME: 'yes' };
    const h = spawnShell(scrubEnv(src));
    h.write(win
      ? 'if defined ANTHROPIC_API_KEY (echo K_SET) else (echo K_UNSET)\r\n'
      : '[ -n "$ANTHROPIC_API_KEY" ] && echo K_SET || echo K_UNSET\r',
    'strategos');
    h.write(win ? 'echo CFG_%CLAUDE_CONFIG_DIR%_KEEP_%KEEP_ME%\r' : 'echo CFG_${CLAUDE_CONFIG_DIR}_KEEP_$KEEP_ME\r', 'strategos');
    await until(() => h.scrollback().includes('_KEEP_yes'), 15_000, 'env echo');
    const sb = h.scrollback();
    expect(sb).toMatch(/^K_UNSET/m);
    expect(sb).not.toMatch(/^K_SET/m);
    expect(sb).toContain('cfg-marker');
    expect(sb).not.toContain('sk-secret');
  }, 60_000);

  it('dirtyInput and key events follow what is written', async () => {
    const h = spawnShell();
    const keys: KeyEvent[] = [];
    h.onKey((k) => keys.push(k));
    expect(h.dirtyInput).toBe(false);
    h.write('par', 'user');
    expect(h.dirtyInput).toBe(true);
    h.write('\x15', 'user'); // Ctrl+U clears the line in sh/cmd alike
    expect(h.dirtyInput).toBe(false);
    h.write('\x1b', 'user');
    await until(() => keys.length === 1, 2000, 'lone esc');
    h.write('\x1b[A', 'user'); // up arrow is a sequence, not Esc
    await new Promise((r) => setTimeout(r, 120));
    expect(keys).toEqual([{ key: 'esc', fromStrategos: false }]);
    h.write('\x03', 'strategos');
    expect(keys[1]).toEqual({ key: 'ctrl_c', fromStrategos: true });
  }, 60_000);
});

describe('PtyHost with fake-claude', () => {
  let root = '';
  let server: HookServer | undefined;
  afterEach(async () => {
    await killAll(); // the child holds its cwd open on Windows
    await server?.close();
    server = undefined;
    if (root) rmTree(root);
    root = '';
  });

  async function startFake(script: string, extraEnv: Record<string, string> = {}): Promise<{ h: PtyHandle; id: string; cfg: string; srv: HookServer }> {
    root = mkTmp('ptyfake-');
    const cfg = join(root, 'cfg');
    const work = join(root, 'work dir');
    writeText(join(cfg, '.keep'), '');
    writeText(join(work, '.keep'), '');
    const srv = (server = await startHookServer());
    const id = randomUUID();
    const settings = writeTestSettings(root, { port: srv.port, strategosId: 'p-' + id.slice(0, 6) });
    const env = scrubEnv({ ...process.env, ANTHROPIC_API_KEY: 'should-vanish' }, { set: { CLAUDE_CONFIG_DIR: cfg, FAKE_CLAUDE_SCRIPT: script, STRATEGOS_HOOK_TOKEN: 'tok', STRATEGOS_PORT: String(srv.port), FAKE_CLAUDE_STEP_MS: '1', ...extraEnv } });
    const h = host.spawn({ exe: process.execPath, args: [FAKE, '--session-id', id, '--settings', settings], cwd: work, env, cols: 120, rows: 30 });
    open.push(h);
    return { h, id, cfg, srv };
  }

  it('drives a plain turn: paste + Enter, hooks arrive, /exit gives exit code 0', async () => {
    const { h, srv } = await startFake('plain');
    await until(() => h.scrollback().includes('> '), 20_000, 'prompt');
    await pasteAndSubmit(h, 'hello fake', { delayMs: 200 });
    await srv.waitFor((x) => x.event === 'Stop', 20_000);
    expect(srv.hooks.find((x) => x.event === 'UserPromptSubmit')!.body['prompt']).toBe('hello fake');
    expect(h.scrollback()).toContain('Fake reply to: hello fake');
    expect(h.dirtyInput).toBe(false);
    const code = new Promise<number>((resolve) => h.onExit(resolve));
    h.write('/exit\r', 'user');
    expect(await code).toBe(0);
    expect(srv.events().at(-1)).toBe('SessionEnd');
  }, 90_000);

  it('a lone Esc through the pty interrupts the fake turn (and is seen as an esc key event)', async () => {
    const { h, srv, cfg } = await startFake('interrupt', { FAKE_CLAUDE_PROMPT: 'long job' });
    const keys: KeyEvent[] = [];
    h.onKey((k) => keys.push(k));
    await srv.waitFor((x) => x.event === 'PreToolUse', 20_000);
    await until(() => h.scrollback().includes('esc to interrupt'), 10_000, 'tool banner');
    h.write('\x1b', 'user');
    await until(() => h.scrollback().includes('Interrupted'), 10_000, 'interrupt output');
    await until(() => keys.length === 1, 2000, 'esc key event');
    expect(keys).toEqual([{ key: 'esc', fromStrategos: false }]);
    expect(srv.events()).not.toContain('Stop');
    expect(cfg).toBeTruthy();
    h.write('/exit\r', 'user');
    await new Promise<void>((resolve) => h.onExit(() => resolve()));
  }, 90_000);

  it('crash exit code is reported', async () => {
    const { h } = await startFake('crash', { FAKE_CLAUDE_PROMPT: 'boom' });
    expect(await new Promise<number>((resolve) => h.onExit(resolve))).toBe(1);
  }, 60_000);
});

describe('hard-killed host: its pty children disappear (plan section 9 crash test)', () => {
  it('kill -9 / taskkill /F the host, the pty child is gone within 5 s', async () => {
    const hostProc = spawn(process.execPath, [join(TOOLS, 'pty-crash-host.ts')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let childPid = 0;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('host did not report child pid')), 20_000);
      createInterface({ input: hostProc.stdout! }).on('line', (l) => {
        const m = /^child:(\d+)/.exec(l);
        if (m) { childPid = Number(m[1]); clearTimeout(t); resolve(); }
      });
    });
    const proc = getPlatform().proc;
    expect(await proc.isAlive(childPid)).toBe(true);
    hostProc.kill('SIGKILL'); // TerminateProcess on Windows: no cleanup code runs in the host
    const end = Date.now() + 5000;
    while (Date.now() < end && (await proc.isAlive(childPid))) await new Promise((r) => setTimeout(r, 100));
    const alive = await proc.isAlive(childPid);
    if (alive) await proc.killTree(childPid); // do not leak it from the test run
    expect(alive, 'pty child survived its host being killed').toBe(false);
  }, 60_000);
});
