// tap.mjs end to end: a real node process started through a real shell (Git Bash on Windows, sh elsewhere), exactly like
// Claude Code starts the status line command, talking to a local HTTP server that plays the daemon.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statusLineCommand, forwardSlashes } from '../hooks/settings-writer.ts';
import { mkTmp, rmTree, writeText } from '../../../../tools/tmp-fs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAP = path.join(HERE, 'tap.mjs');
const SAMPLE = readFileSync(path.resolve(HERE, '../../../../fixtures/claude/2.1.292/statusline/statusline-after-turns-with-rate-limits-and-cache.json'), 'utf8');
const SAMPLE_BODY = JSON.stringify((JSON.parse(SAMPLE) as { body: unknown }).body);

function findShell(): { file: string; args: (cmd: string) => string[]; name: string } {
  if (process.platform === 'win32') {
    const candidates = [process.env['SHELL'], 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
    for (const c of candidates) if (c && /bash(\.exe)?$/i.test(c) && existsSync(c)) return { file: c, args: (cmd) => ['-c', cmd], name: 'git-bash' };
    return { file: 'powershell.exe', args: (cmd) => ['-NoProfile', '-Command', cmd], name: 'powershell' };
  }
  return { file: '/bin/sh', args: (cmd) => ['-c', cmd], name: 'sh' };
}
const SHELL = findShell();

interface Hit { at: number; url: string; headers: Record<string, string | string[] | undefined>; body: string }

let server: Server;
let port: number;
const hits: Hit[] = [];
let tmp: string;
let slowChain: string;
let stampChain: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ at: Date.now(), url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  tmp = mkTmp('tap-');
  slowChain = writeText(path.join(tmp, 'sp ace', 'slow.mjs'), 'setTimeout(() => process.stdout.write("LATE\\n"), 3000);');
  stampChain = writeText(path.join(tmp, 'sp ace', 'stamp.mjs'), [
    'let s = ""; process.stdin.on("data", (d) => (s += d));',
    'process.stdin.on("end", () => setTimeout(() => process.stdout.write("CHAIN len=" + s.length + " at=" + Date.now() + "\\n"), 120));',
  ].join('\n'));
});
afterAll(async () => {
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  rmTree(tmp);
});

interface RunResult { code: number | null; stdout: string; ms: number }

function runTap(o: { chainMs?: number; chain?: string; port?: number; stdin?: string; token?: string | null; shellEnv?: boolean } = {}): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, STRATEGOS_HOOK_TOKEN: o.token === null ? '' : (o.token ?? 'tok-xyz') };
  delete env['STRATEGOS_CHAIN_STATUSLINE'];
  delete env['STRATEGOS_PORT'];
  if (o.chain !== undefined) env['STRATEGOS_CHAIN_STATUSLINE'] = o.chain;
  if (o.chainMs !== undefined) env['STRATEGOS_CHAIN_TIMEOUT_MS'] = String(o.chainMs);
  if (SHELL.name === 'git-bash') env['SHELL'] = SHELL.file;
  // The same string the settings writer injects: a quoted node path (it may contain a space), the tap, the id and the port.
  const command = statusLineCommand({ nodePath: process.execPath, tapPath: TAP, strategosId: 'sid-1', port: o.port ?? port });
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(SHELL.file, SHELL.args(SHELL.name === 'powershell' ? `& ${command.replace(/^"([^"]+)"/, "'$1'").replace(/ "([^"]+)"/g, " '$1'")}` : command), { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.stdin ?? SAMPLE_BODY);
    child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - t0 }));
  });
}

describe(`tap.mjs under ${SHELL.name}`, () => {
  it('uses the same command the settings writer injects (quoted node path, forward slashes)', () => {
    const c = statusLineCommand({ nodePath: process.execPath, tapPath: TAP, strategosId: 'sid-1', port: 1234 });
    expect(c.startsWith(`"${forwardSlashes(process.execPath)}" "${forwardSlashes(TAP)}" sid-1 1234`)).toBe(true);
  });

  it('prints the chained line first, then POSTs the same stdin with the token header; exits 0', async () => {
    const before = hits.length;
    const r = await runTap({ chain: `"${forwardSlashes(process.execPath)}" "${forwardSlashes(stampChain)}"`, chainMs: 8000 });
    expect(r.code).toBe(0);
    const m = /^CHAIN len=(\d+) at=(\d+)\n$/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Buffer.byteLength(SAMPLE_BODY)); // the chain got the full stdin
    expect(hits).toHaveLength(before + 1);
    const hit = hits[before]!;
    expect(hit.url).toBe('/statusline/sid-1');
    expect(hit.headers['x-strategos-token']).toBe('tok-xyz');
    expect(hit.body).toBe(SAMPLE_BODY);
    // order: the POST must not leave before the chained command has produced its line (print FIRST, POST second)
    expect(hit.at).toBeGreaterThanOrEqual(Number(m![2]));
  });

  it('without a chain it prints a short fallback line (ctx %) and still POSTs', async () => {
    const before = hits.length;
    const r = await runTap();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ctx 5%\n');
    expect(hits).toHaveLength(before + 1);
  });

  it('a null used_percentage prints ctx ?%', async () => {
    const r = await runTap({ stdin: JSON.stringify({ context_window: { used_percentage: null } }) });
    expect(r.stdout).toBe('ctx ?%\n');
  });

  it('a chained command slower than 250 ms is cut off; the tap still POSTs and exits fast', async () => {
    const before = hits.length;
    const r = await runTap({ chain: `"${forwardSlashes(process.execPath)}" "${forwardSlashes(slowChain)}"` });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('LATE');
    expect(r.ms).toBeLessThan(2500);
    expect(hits).toHaveLength(before + 1);
  }, 15_000);

  it('a bash-only chained command (variables, quotes) works', async () => {
    if (SHELL.name !== 'git-bash' && process.platform === 'win32') return; // cmd.exe would run it; the bash route is a Windows detail
    const r = await runTap({ chain: 'echo "hello $STRATEGOS_HOOK_TOKEN"' });
    expect(r.stdout.trim()).toBe('hello tok-xyz');
  });

  it('a dead daemon never breaks the status line: the line is printed and the exit code is 0', async () => {
    const r = await runTap({ chain: `"${forwardSlashes(process.execPath)}" "${forwardSlashes(stampChain)}"`, chainMs: 8000, port: 1 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^CHAIN /);
  });

  it('garbage on stdin is forwarded as is and does not crash the tap', async () => {
    const before = hits.length;
    const r = await runTap({ stdin: 'not json' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ctx ?%\n');
    expect(hits[before]?.body).toBe('not json');
  });
});

describe('tap runtime (30 runs through the shell)', () => {
  it('p50 and p95 wall time, shell start included', async () => {
    const runs: number[] = [];
    await runTap(); // warm the disk cache
    for (let i = 0; i < 30; i++) runs.push((await runTap()).ms);
    runs.sort((a, b) => a - b);
    const p = (q: number): number => runs[Math.min(runs.length - 1, Math.ceil(q * runs.length) - 1)]!;
    console.info(`tap under ${SHELL.name}: n=${runs.length} p50=${p(0.5).toFixed(0)} ms p95=${p(0.95).toFixed(0)} ms max=${runs.at(-1)!.toFixed(0)} ms`);
    // Plan 1.12 aims at 300 ms p95 for the tap itself. The shell's own start-up (Git Bash: 250 to 310 ms here, S5) is not ours,
    // and CI machines are slower, so the hard bound is loose: it catches a regression to seconds, not to 350 ms.
    expect(p(0.95)).toBeLessThan(1500);
  }, 120_000);
});
