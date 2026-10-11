// Strategos status-line tap (task 1.12). No dependencies; keep start-up minimal (only node:http at the top).
//
//   stdin  = the status-line JSON Claude Code pipes in on every refresh
//   argv   = <strategosId> [port]            (the port is not a secret; env STRATEGOS_PORT is the fallback)
//   env    = STRATEGOS_HOOK_TOKEN            sent as the X-Strategos-Token header (never written to a file)
//            STRATEGOS_CHAIN_STATUSLINE      the owner's original statusLine command, if there was one
//
// Order (S5, Edit 2): 1. run the chained command with the same stdin (250 ms cap) and print its output FIRST;
// 2. then POST the JSON to http://127.0.0.1:<port>/statusline/<id>, fire and forget. Claude debounces the status line at
// 300 ms and cancels an in-flight run, so nothing here may wait on the daemon for more than a moment. Every failure is silent:
// a dead daemon must never break the owner's status line.
//
// Timing under Git Bash (30 runs, Windows 10, node 24; numbers are recorded in tap.test.ts):
// measured with `bash -c '"<node>" tap.mjs id port < sample.json'`.
import http from 'node:http';

const id = process.argv[2] || 'unknown';
const port = Number(process.argv[3] || process.env.STRATEGOS_PORT || 0);
const token = process.env.STRATEGOS_HOOK_TOKEN || '';
const chain = process.env.STRATEGOS_CHAIN_STATUSLINE || '';
const CHAIN_CAP_MS = 250;

// A failsafe that cannot keep the process alive: whatever happens, we are gone well before Claude's next refresh.
setTimeout(() => process.exit(0), 600).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('error', () => undefined);
process.stdin.on('end', () => { void main(); });

/** The owner's command was written for the shell Claude runs it in (Git Bash on Windows). cmd.exe starts in ~30 ms and
 *  Git Bash in ~250 ms, so use bash only when the command needs it (tilde, variables, quotes, backticks). */
function needsBash(cmd) {
  return process.platform === 'win32' && Boolean(process.env.SHELL) && /[~$'`]/.test(cmd);
}

async function runChain() {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(out); } };
    let child;
    try {
      child = needsBash(chain)
        ? spawn(process.env.SHELL, ['-c', chain], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
        : spawn(chain, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve(''); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(); }, CHAIN_CAP_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stdout.on('error', () => undefined);
    child.on('close', done);
    child.on('error', done);
    child.stdin.on('error', () => undefined);
    child.stdin.end(raw);
  });
}

function fallbackLine() {
  let pct = '?';
  try {
    const p = JSON.parse(raw)?.context_window?.used_percentage;
    if (p !== null && p !== undefined) pct = String(Math.round(p));
  } catch { /* not JSON */ }
  return `ctx ${pct}%`;
}

function post(exit) {
  if (!port) { exit(); return; }
  try {
    const req = http.request({
      host: '127.0.0.1', port, path: `/statusline/${encodeURIComponent(id)}`, method: 'POST', agent: false, timeout: 250,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        'x-strategos-token': token,
        connection: 'close',
      },
    });
    req.on('error', exit);
    req.on('timeout', () => { req.destroy(); exit(); });
    req.on('response', (r) => { r.resume(); r.on('end', exit); });
    req.end(raw);
  } catch { exit(); }
}

async function main() {
  const out = chain ? await runChain() : fallbackLine();
  // Exit only after stdout is flushed (pipes can be asynchronous on Windows) and the POST has been answered or has failed.
  const flushed = new Promise((resolve) => {
    if (out === '') resolve();
    else process.stdout.write(out.endsWith('\n') ? out : `${out}\n`, () => resolve());
  });
  post(() => { flushed.then(() => process.exit(0)); });
}
