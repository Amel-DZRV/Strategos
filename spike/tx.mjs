// node tx.mjs <sessionId> [lastN]  : compact summary of the last N transcript records (read-only)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [, , id, n = '8'] = process.argv;
const dir = path.join(os.homedir(), '.claude', 'projects');
let f = null;
for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, id + '.jsonl'); if (fs.existsSync(p)) f = p; }
if (!f) { console.log('no transcript'); process.exit(1); }
const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log(f.replace(os.homedir(), '~'), lines.length, 'records');
for (const j of lines.slice(-Number(n))) {
  const c = j.message?.content;
  const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.type + ':' + (x.text ?? x.name ?? x.content ?? '').toString().slice(0, 80)).join(' | ') : '';
  console.log(j.timestamp, j.type, j.subtype ?? j.attachment?.type ?? '', txt.slice(0, 160));
}
