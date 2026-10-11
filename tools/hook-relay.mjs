// Command-hook relay (plan: SessionStart does not arrive over type:"http" in Claude 2.1.292, so it is a command hook).
// stdin = hook JSON; POSTs it to the daemon as /hook/<strategosId>/<Event> with the token from env. Fire-and-forget, exits 0
// (empty stdout = no decision).  Usage: node hook-relay.mjs <strategosId> <Event>   Env: STRATEGOS_PORT, STRATEGOS_HOOK_TOKEN
// Adapted from spike/relay.mjs.
import http from 'node:http';

const [, , id = 'unknown', ev = 'Unknown'] = process.argv;
const port = Number(process.env.STRATEGOS_PORT || 0);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const req = http.request({
    host: '127.0.0.1', port, path: `/hook/${encodeURIComponent(id)}/${encodeURIComponent(ev)}`, method: 'POST', timeout: 1500,
    headers: { 'content-type': 'application/json', 'x-strategos-token': process.env.STRATEGOS_HOOK_TOKEN || '', 'x-strategos-via': 'command-relay' },
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('response', (r) => { r.resume(); r.on('end', () => process.exit(0)); });
  req.end(raw);
});
