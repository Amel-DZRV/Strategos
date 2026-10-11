// S8 Option E probe: `claude --bg --settings F` then `claude attach` inside node-pty. Sandbox cwd only. Cleans up with `claude stop` + `claude rm`.
// Usage: node s8.ts   (hooklog must be running on 47801)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { resolveClaude } from './claude-locate.ts';
import { writeSettings } from './mksettings.ts';

function scrubEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (k === 'CLAUDE_CONFIG_DIR') { env[k] = v; continue; }
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_PREVIEW_') || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_') || k.startsWith('ANTHROPIC_')) continue;
    env[k] = v;
  }
  return env;
}
const claude = resolveClaude();
const cwd = 'C:\\dev\\strategos-sandbox';
const id = 'sp-bg1';
const f = writeSettings({ strategosId: id, sessionStartCommand: true });
const env = scrubEnv(process.env); env.STRATEGOS_HOOK_TOKEN = randomBytes(24).toString('hex'); env.STRATEGOS_PORT = '47801';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (args: string[]) => { const r = spawnSync(claude, args, { cwd, env, encoding: 'utf8', timeout: 60000 }); return `exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 400))}`; };

console.log('settings', f);
console.log('BG START:', run(['--bg', '--settings', f, '--name', 'spike-bg1', '--permission-mode', 'default', 'Reply with the single word ok. No tools.']));
await sleep(12000);
const list = run(['agents', '--json']);
console.log('AGENTS:', list.slice(0, 2000));
const bgId = (list.match(/\\"id\\":\\"([0-9a-f]{8})\\"[^}]*?strategos-sandbox/) ?? list.match(/"id":"([0-9a-f]{8})"/))?.[1];
console.log('bgId guess', bgId);
const target = process.argv[2] ?? bgId;
if (target) {
  const p = pty.spawn(claude, ['attach', target], { name: 'xterm-256color', cols: 120, rows: 32, cwd, env } as any);
  const Terminal = (xtermHeadless as any).Terminal ?? (xtermHeadless as any).default?.Terminal;
  const screen = new Terminal({ cols: 120, rows: 32, scrollback: 500, allowProposedApi: true });
  let raw = ''; p.onData((d) => { raw += d; screen.write(d); });
  await sleep(8000);
  const b = screen.buffer.active; const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  console.log('ATTACH SCREEN (raw bytes ' + raw.length + '):\n' + lines.slice(-30).join('\n'));
  writeFileSync(new URL('./out/s8-attach-screen.txt', import.meta.url), lines.join('\n'));
  p.write('\x1b[D'); await sleep(1500); // left arrow: back to agent view
  p.kill();
  console.log('STOP:', run(['stop', target]));
  console.log('RM:', run(['rm', target]));
}
