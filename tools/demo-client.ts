// M1 demo client: pairs with the running daemon like the UI would, starts ONE session and prints its statuses.
// Usage: node tools/demo-client.ts <repoPath> "<first prompt>"   (the daemon must be running: npm run strategos -- start)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const home = process.env['STRATEGOS_HOME'] ?? join(homedir(), '.strategos');
const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port: number };
const secret = readFileSync(join(home, 'cli.secret'), 'utf8').trim();
const base = `http://127.0.0.1:${info.port}`;
const [repoPath, firstPrompt] = process.argv.slice(2);
if (!repoPath || !firstPrompt) throw new Error('usage: demo-client.ts <repoPath> <prompt>');

const pair = await fetch(`${base}/control/pair`, { method: 'POST', headers: { 'X-Strategos-Control': secret }, body: '{}' });
const code = new URL(((await pair.json()) as { url: string }).url).hash.replace('#pair=', '');
const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { headers: { Origin: base, Cookie: cookie } });
const t0 = Date.now();
const log = (s: string): void => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
let sid: string | undefined;
let last = '';
let stopping = false;
const send = (o: object): void => ws.send(JSON.stringify({ id: Math.random().toString(36).slice(2), ...o }));

ws.on('message', (d) => {
  const ev = JSON.parse(d.toString()) as Record<string, any>;
  if (ev.t === 'hello') log(`hello claude ${ev.claudeVersion} inRange=${ev.inRange}`);
  if (ev.t === 'ack' && !ev.ok) log(`ack error: ${ev.error}`);
  if (ev.t === 'session.upsert' && (sid === undefined || ev.session.strategosId === sid)) {
    const s = ev.session;
    sid ??= s.strategosId;
    const line = `${s.status} (${s.statusSource})${s.pending ? ` pending=${s.pending.toolName}` : ''}${s.last ? ` last="${s.last}"` : ''}`;
    if (line !== last) { last = line; log(`session ${s.name}: ${line}`); }
    if (s.status === 'permission') { log('a permission request appeared; not approving it from the demo'); }
    if (s.status === 'done' && !stopping) { stopping = true; log('done -> stopping'); setTimeout(() => send({ c: 'session.stop', strategosId: sid }), 1500); }
    if (s.status === 'stopped' && stopping) { log('stopped'); ws.close(); }
  }
});
ws.on('open', () => { send({ c: 'session.start', repoPath, firstPrompt, name: 'demo-ok' }); });
ws.on('close', () => process.exit(0));
setTimeout(() => { log('timeout'); process.exit(2); }, 120_000);
