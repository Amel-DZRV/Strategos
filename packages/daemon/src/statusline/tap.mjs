/* global process, Buffer, setTimeout, clearTimeout */
// Strategos status-line tap (task 1.12). No dependencies and a minimal start-up: only node:net (already loaded by node itself)
// and node:fs at the top; node:http is deliberately NOT used (loading it costs tens of ms) and node:child_process is imported
// only when a chained command exists.
//
//   stdin  = the status-line JSON Claude Code pipes in on every refresh
//   argv   = <strategosId> [port]            (the port is not a secret; env STRATEGOS_PORT is the fallback)
//   env    = STRATEGOS_HOOK_TOKEN            sent as the X-Strategos-Token header (never written to a file)
//            STRATEGOS_CHAIN_STATUSLINE      the owner's original statusLine command, if there was one
//            STRATEGOS_CHAIN_TIMEOUT_MS      cap for the chained command (default 250; for tests and slow chains)
//
// Order (S5, Edit 2): 1. run the chained command with the same stdin (250 ms cap) and print its output FIRST;
// 2. then POST the JSON to http://127.0.0.1:<port>/statusline/<id>, fire and forget. Claude debounces the status line at
// 300 ms and cancels an in-flight run, so nothing here may wait on the daemon for more than a moment. Every failure is silent:
// a dead daemon must never break the owner's status line.
// Timing, measured 2026-10-11 on the Windows 10 dev machine, node 24.21, 30 runs after a warm-up, with a local server
// answering (tap.test.ts, `bash -c '"<node>" "<tap>" <id> <port>'` = how Claude starts it): p50 196 ms, p95 216 to 234 ms,
// max 239 ms, Git Bash start-up included. For scale: `node -e 0` alone is p50 132 ms; `bash -c true` is p50 125 ms (spike S5: 250 to
// 310 ms); the earlier version that used node:http and the stream stdin measured p50 247 ms, p95 259 ms.
import { readSync } from 'node:fs';
import net from 'node:net';

const id = process.argv[2] || 'unknown';
const port = Number(process.argv[3] || process.env.STRATEGOS_PORT || 0);
const token = process.env.STRATEGOS_HOOK_TOKEN || '';
const chain = process.env.STRATEGOS_CHAIN_STATUSLINE || '';
const CHAIN_CAP_MS = Number(process.env.STRATEGOS_CHAIN_TIMEOUT_MS) || 250;

// A failsafe that cannot keep the process alive: whatever happens, we are gone well before Claude's next refresh.
setTimeout(() => process.exit(0), CHAIN_CAP_MS + 400).unref();

/** Read fd 0 to the end without stream machinery (saves start-up time). EAGAIN (a non-blocking pipe) is retried until a
 *  deadline, EOF ends the input; anything else throws and the caller falls back to the stream. */
function readAllSync() {
  const chunks = [];
  const buf = Buffer.allocUnsafe(65536);
  const deadline = Date.now() + 400;
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e && e.code === 'EAGAIN' && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      if (e && (e.code === 'EOF' || e.code === 'EAGAIN')) break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readStdin(cb) {
  let raw;
  try {
    raw = readAllSync();
  } catch {
    let acc = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { acc += d; });
    process.stdin.on('error', () => cb(acc));
    process.stdin.on('end', () => cb(acc));
    return;
  }
  cb(raw);
}

/** The owner's command was written for the shell Claude runs it in (Git Bash on Windows). cmd.exe starts in ~30 ms and
 *  Git Bash in ~250 ms, so use bash only when the command needs it (tilde, variables, quotes, backticks). */
function needsBash(cmd) {
  return process.platform === 'win32' && Boolean(process.env.SHELL) && /[~$'`]/.test(cmd);
}

async function runChain(raw) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(out); } };
    let child;
    try {
      child = needsBash(chain)
        ? spawn(process.env.SHELL, ['-c', chain], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
        : spawn(chain, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve(''); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(); }, CHAIN_CAP_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stdout.on('error', () => undefined);
    child.on('close', done);
    child.on('error', done);
    child.stdin.on('error', () => undefined);
    child.stdin.end(raw);
  });
}

function fallbackLine(raw) {
  let pct = '?';
  try {
    const p = JSON.parse(raw)?.context_window?.used_percentage;
    if (p !== null && p !== undefined) pct = String(Math.round(p));
  } catch { /* not JSON */ }
  return `ctx ${pct}%`;
}

/** A hand-written HTTP/1.1 POST over a raw socket. Calls `exit` when the daemon answered, or on any failure. */
function post(raw, exit) {
  if (!port) { exit(); return; }
  const body = Buffer.from(raw, 'utf8');
  const head = `POST /statusline/${encodeURIComponent(id)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
    + `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nX-Strategos-Token: ${token.replace(/[\r\n]/g, '')}\r\nConnection: close\r\n\r\n`;
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(250, () => { socket.destroy(); exit(); });
  socket.on('error', exit);
  socket.on('data', exit); // the first bytes of the answer are enough: the daemon has the request
  socket.on('close', exit);
  socket.write(head);
  socket.write(body);
}

readStdin(async (raw) => {
  const out = chain ? await runChain(raw) : fallbackLine(raw);
  // Exit only after stdout is flushed (pipes can be asynchronous on Windows) and the POST has been answered or has failed.
  const flushed = new Promise((resolve) => {
    if (out === '') resolve();
    else process.stdout.write(out.endsWith('\n') ? out : `${out}\n`, () => resolve());
  });
  let exiting = false;
  post(raw, () => { if (!exiting) { exiting = true; flushed.then(() => process.exit(0)); } });
});
