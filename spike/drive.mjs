// Batch 2 driver: node drive.mjs <cmd> [args]. cmds: screen [n] | info | key <name|escaped>... | paste <text> | submit <text> | ctl <cmd text> | wait <regex> [sec] | sleep <sec> | sess <pid>
const H = 'http://127.0.0.1:47800', C = 'http://127.0.0.1:47801';
const KEYS = { esc: '\x1b', enter: '\r', left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B', tab: '\t', 'shift+tab': '\x1b[Z', 'ctrl+c': '\x03', 'ctrl+u': '\x15', 'ctrl+d': '\x04' };
const [, , cmd, ...rest] = process.argv;
const post = (u, o) => fetch(u, { method: 'POST', body: JSON.stringify(o) }).then((r) => r.text());
const screen = () => fetch(H + '/screen').then((r) => r.text());
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
if (cmd === 'screen') console.log((await screen()).split('\n').slice(-Number(rest[0] ?? 40)).join('\n'));
else if (cmd === 'info') console.log(await fetch(H + '/info').then((r) => r.text()));
else if (cmd === 'key') { for (const k of rest) { await post(H + '/input', { data: KEYS[k] ?? k }); await sleep(0.3); } console.log('ok'); }
else if (cmd === 'paste') { await post(H + '/input', { data: '\x1b[200~' + rest.join(' ') + '\x1b[201~' }); console.log('ok'); }
else if (cmd === 'submit') { await post(H + '/input', { data: '\x1b[200~' + rest.join(' ') + '\x1b[201~' }); await sleep(0.5); await post(H + '/input', { data: '\r' }); console.log('ok'); }
else if (cmd === 'ctl') { const [c, ...a] = rest; console.log(await post(C + '/ctl', { cmd: c, arg: a.join(' '), msg: a.join(' ') })); }
else if (cmd === 'wait') { const re = new RegExp(rest[0], 'i'); const end = Date.now() + Number(rest[1] ?? 60) * 1000; let s = ''; while (Date.now() < end) { s = await screen(); if (re.test(s)) { console.log('MATCH'); process.exit(0); } await sleep(1); } console.log('TIMEOUT'); process.exit(1); }
else if (cmd === 'sleep') await sleep(Number(rest[0]));
else if (cmd === 'sess') { const fs = await import('node:fs'); const os = await import('node:os'); console.log(fs.readFileSync(os.homedir() + '/.claude/sessions/' + rest[0] + '.json', 'utf8')); }
