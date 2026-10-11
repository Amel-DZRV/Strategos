// Hosts a claude.exe (or --exe substitute) in node-pty, served to a browser via xterm over WS on 127.0.0.1:47800.
// Control: POST /input {data}  |  GET /screen  (plain text of the headless xterm buffer, last ~200 lines)  |  GET /info
// Flags (batch 2: --perm <mode> --extra "a b" --settings-file F): --conpty-dll --resume <id> --no-agentview --prompt "<text>" --cwd <dir> --name <n> --exe <path> --exe-args "<a b>" --port N --hook-port N --no-settings
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import xtermHeadless from '@xterm/headless';
import { resolveClaude } from './claude-locate.ts';
import { writeSettings } from './mksettings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

export function scrubEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (k === 'CLAUDE_CONFIG_DIR') { env[k] = v; continue; }
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_PREVIEW_') || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_') || k.startsWith('ANTHROPIC_')) continue;
    env[k] = v;
  }
  return env;
}

const PORT = Number(opt('--port') ?? 47800);
const HOOK_PORT = Number(opt('--hook-port') ?? 47801);
const sessionId = randomUUID();
const strategosId = 'sp-' + sessionId.slice(0, 8);
const name = opt('--name') ?? 'spike-' + strategosId;
const cwd = opt('--cwd') ?? 'C:\\dev\\strategos-sandbox';
const exe = opt('--exe') ?? resolveClaude();
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

let cmdArgs: string[];
let settingsFile = '';
if (opt('--exe')) {
  cmdArgs = (opt('--exe-args') ?? '').split(' ').filter(Boolean);
} else {
  settingsFile = writeSettings({ strategosId, port: HOOK_PORT, disableAgentView: !flag('--no-agentview'), sessionStartCommand: flag('--ss-command') });
  if (opt('--settings-file')) settingsFile = opt('--settings-file')!;
  cmdArgs = flag('--resume') || opt('--resume')
    ? ['--resume', opt('--resume')!, '--settings', settingsFile, '--name', name]
    : ['--session-id', sessionId, '--settings', settingsFile, '--name', name];
  if (opt('--perm')) cmdArgs.push('--permission-mode', opt('--perm')!);
  if (opt('--extra')) cmdArgs.push(...opt('--extra')!.split(' ').filter(Boolean));
}
const env = scrubEnv(process.env);
env.STRATEGOS_HOOK_TOKEN = randomBytes(24).toString('hex');
env.STRATEGOS_PORT = String(HOOK_PORT);
try { writeFileSync(join(outDir, 'token-' + strategosId + '.txt'), env.STRATEGOS_HOOK_TOKEN); } catch {}

const cols = 120, rows = 32;
const p = pty.spawn(exe, cmdArgs, { name: 'xterm-256color', cols, rows, cwd, env, useConptyDll: flag('--conpty-dll') } as any);
console.log(`[hostpty] exe=${exe}\n[hostpty] args=${JSON.stringify(cmdArgs)}\n[hostpty] cwd=${cwd} pid=${p.pid} strategosId=${strategosId} sessionId=${sessionId} conptyDll=${flag('--conpty-dll')}`);

const rawLog = createWriteStream(join(outDir, `pty-${strategosId}.log`));
const Terminal = (xtermHeadless as any).Terminal ?? (xtermHeadless as any).default?.Terminal;
const screen = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
const clients = new Set<any>();
let replay = '';
p.onData((d) => {
  rawLog.write(d);
  screen.write(d);
  replay = (replay + d).slice(-200_000);
  for (const c of clients) if (c.readyState === 1) c.send(d);
});
let exited: number | null = null;
p.onExit(({ exitCode, signal }) => {
  exited = exitCode;
  console.log(`[hostpty] exit code=${exitCode} signal=${signal}`);
  rawLog.end();
  for (const c of clients) c.close();
  setTimeout(() => process.exit(exitCode), 300);
});

function screenText(max = 200): string {
  const b = screen.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-max).join('\n');
}

const prompt = opt('--prompt');
if (prompt) setTimeout(() => { p.write('\x1b[200~' + prompt + '\x1b[201~'); setTimeout(() => p.write('\r'), 400); }, Number(opt('--prompt-delay') ?? 8000));

const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const staticFiles: Record<string, string> = {
  '/': join(here, 'page', 'index.html'), '/index.html': join(here, 'page', 'index.html'),
  '/xterm.js': join(here, 'node_modules/@xterm/xterm/lib/xterm.js'), '/xterm.css': join(here, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/addon-fit.js': join(here, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
};
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/screen') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(screenText()); return; }
  if (req.method === 'GET' && url === '/info') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ strategosId, sessionId, pid: p.pid, exe, args: cmdArgs, exited, settingsFile })); return; }
  if (req.method === 'POST' && url === '/input') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { const { data } = JSON.parse(b); if (typeof data !== 'string') throw 0; if (exited === null) p.write(data); res.writeHead(200).end('ok'); }
      catch { res.writeHead(400).end('bad body, need {data}'); }
    });
    return;
  }
  const f = staticFiles[url];
  if (req.method === 'GET' && f && existsSync(f)) { res.writeHead(200, { 'content-type': mime[f.slice(f.lastIndexOf('.'))] ?? 'text/plain' }); createReadStream(f).pipe(res); return; }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (req.url !== '/ws' || (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    clients.add(ws); ws.send(replay);
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(m.toString());
        if (msg.t === 'in' && exited === null) p.write(msg.data);
        else if (msg.t === 'resize' && exited === null) { p.resize(msg.cols, msg.rows); screen.resize(msg.cols, msg.rows); }
      } catch {}
    });
    ws.on('close', () => clients.delete(ws));
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`[hostpty] http://127.0.0.1:${PORT}/  (control: POST /input, GET /screen, GET /info)`));
