// Status-line tap. stdin = status JSON. Prints chained/fallback output FIRST, then fire-and-forget POST.
// argv[2] = strategosId. env STRATEGOS_CHAIN_STATUSLINE = chained command; STRATEGOS_PORT (default 47801).
import { spawn } from 'node:child_process';
import http from 'node:http';

const id = process.argv[2] || 'unknown';
const port = Number(process.env.STRATEGOS_PORT || 47801);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  let out = '';
  const chain = process.env.STRATEGOS_CHAIN_STATUSLINE;
  if (chain) {
    out = await new Promise((res) => {
      const c = spawn(chain, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let s = '';
      const t = setTimeout(() => { c.kill(); res(s); }, 200);
      c.stdout.on('data', (d) => (s += d));
      c.on('close', () => { clearTimeout(t); res(s); });
      c.on('error', () => { clearTimeout(t); res(s); });
      c.stdin.on('error', () => {});
      c.stdin.end(raw);
    });
  } else {
    let pct = '?';
    try { const j = JSON.parse(raw); const p = j?.context_window?.used_percentage; if (p != null) pct = Math.round(p); } catch {}
    out = `ctx ${pct}%`;
  }
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  try {
    const req = http.request({ host: '127.0.0.1', port, path: `/statusline/${id}`, method: 'POST', timeout: 250,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        'x-strategos-token': process.env.STRATEGOS_HOOK_TOKEN || '' } });
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.on('response', (r) => { r.resume(); r.on('end', () => process.exit(0)); });
    req.end(raw);
  } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 260).unref();
});
