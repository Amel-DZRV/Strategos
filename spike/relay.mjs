// Command-hook relay (S1 fallback): stdin = hook JSON; POSTs it to the hooklog server as /hook/<id>/<Event>.
// Usage: node relay.mjs <strategosId> <Event>. Fire-and-forget, exits 0 (empty stdout = no decision).
import http from 'node:http';
const [, , id = 'unknown', ev = 'Unknown'] = process.argv;
const port = Number(process.env.STRATEGOS_PORT || 47801);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port, path: `/hook/${id}/${ev}`, method: 'POST', timeout: 1500,
    headers: { 'content-type': 'application/json', 'x-strategos-token': process.env.STRATEGOS_HOOK_TOKEN || '', 'x-strategos-via': 'command-relay' } });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('response', (r) => { r.resume(); r.on('end', () => process.exit(0)); });
  req.end(raw);
});
