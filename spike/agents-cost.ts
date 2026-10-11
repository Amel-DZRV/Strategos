// S13 cost probe. READ ONLY. `claude agents --json` is run 10x; sessions/*.json is read 10x; PowerShell sampler 3 samples @5s.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude } from './claude-locate.ts';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const claude = resolveClaude();
const res: any = { claude, at: new Date().toISOString() };

const t1: number[] = []; const rss: number[] = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  const r = spawnSync(claude, ['agents', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  t1.push(performance.now() - t);
  if (i === 0) res.agentsSample = (r.stdout ?? '').slice(0, 500);
}
res.agentsJsonMs = { all: t1.map(Math.round), median: Math.round(median(t1)) };

const sdir = join(homedir(), '.claude', 'sessions');
const t2: number[] = [];
let n = 0;
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  n = 0; for (const f of readdirSync(sdir)) if (f.endsWith('.json')) { JSON.parse(readFileSync(join(sdir, f), 'utf8')); n++; }
  t2.push(performance.now() - t);
}
res.sessionsFiles = { count: n, medianMs: +median(t2).toFixed(3), allMs: t2.map((x) => +x.toFixed(3)) };

// persistent PowerShell sampler: one process, 3 samples 5 s apart
const ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
let buf = ''; ps.stdout.on('data', (d) => (buf += d));
const samples: any[] = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  buf = '';
  ps.stdin.write('(Get-Process | Measure-Object WorkingSet64 -Sum).Sum; Write-Output "DONE"\n');
  while (!buf.includes('DONE')) await new Promise((r) => setTimeout(r, 5));
  samples.push({ ms: Math.round(performance.now() - t), cpuUserMs: Math.round(process.cpuUsage().user / 1000) });
  if (i < 2) await new Promise((r) => setTimeout(r, 5000));
}
ps.stdin.end('exit\n');
res.psSampler = samples;

const o = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(o, { recursive: true });
writeFileSync(join(o, 'agents-cost.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
