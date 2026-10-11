// `strategos start | stop | status [--watch] | open [--print]`   (npm run strategos -- <command>)
//
// How the CLI talks to the daemon, and why that is safe (task 1.15):
//   The daemon listens on 127.0.0.1 only. For the CLI it exposes POST /control/<pair|status|shutdown>. A request is
//   accepted only if (1) the Host is exactly 127.0.0.1:<port>, (2) it carries NO Origin header (a browser always sends
//   one on a POST, so a web page cannot call it, not even through DNS rebinding), and (3) the header X-Strategos-Control
//   equals a random 32-byte secret that the daemon creates at every start in <home>/cli.secret with a user-only
//   permission (icacls on Windows, mode 0600 elsewhere) and deletes when it exits. Reading that file therefore needs the
//   same Windows account that runs the daemon, which is also the account that could read ~/.strategos/state.json or the
//   hook tokens in the process environment: the CLI gives a local attacker nothing they did not already have (the plan's
//   "same-user honesty" note, section 10). `open` asks for a pairing code the same way; the code is single-use, lives 60 s,
//   travels in the URL fragment (#pair=) so it never reaches a log, and is exchanged for the HttpOnly cookie by the page.
//   daemon.json holds no secret (pid, port, startedAt, version only).
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strategosHome } from './config.ts';
import { readLock } from './daemon-lock.ts';
import { readCliSecret, readDaemonInfo, statePath, type DaemonInfo } from './home-files.ts';
import { dayStamp } from './logger.ts';
import { getPlatform } from './platform/index.ts';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');

export interface StatusReply {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
  claude: { version: string; testedRange: string; inRange: boolean; error: string | null };
  sessions: {
    strategosId: string; name: string; status: string; statusSource: string; statusSince: number; planet: string; cwd: string;
    last: string | null; pending: { tool: string; summary: string; held: boolean } | null; ctxPct: number | null; costUsd: number;
    pid: number | null; archived: boolean;
  }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

// ---------------------------------------------------------------------------
// talking to the daemon
// ---------------------------------------------------------------------------

async function control(home: string, info: DaemonInfo, name: string): Promise<{ status: number; json: unknown } | null> {
  const secret = readCliSecret(home);
  if (secret === null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/control/${name}`, {
      method: 'POST',
      headers: { 'X-Strategos-Control': secret, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  } catch {
    return null;
  }
}

/** The running daemon, proven by an answer on its control route (not just by a leftover daemon.json). */
async function liveDaemon(home: string): Promise<{ info: DaemonInfo; status: StatusReply } | null> {
  const info = readDaemonInfo(home);
  if (info === null) return null;
  const r = await control(home, info, 'status');
  return r !== null && r.status === 200 ? { info, status: r.json as StatusReply } : null;
}

function logTail(home: string, lines = 12): string {
  try {
    const dir = path.join(home, 'logs');
    const files = readdirSync(dir).filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    const last = files[files.length - 1] ?? `daemon-${dayStamp(Date.now())}.log`;
    return readFileSync(path.join(dir, last), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export async function cmdStart(home: string, out: (s: string) => void = console.log): Promise<number> {
  const running = await liveDaemon(home);
  if (running !== null) {
    out(`Strategos is already running (pid ${running.info.pid}, port ${running.info.port}).`);
    return 0;
  }
  const child = spawn(process.execPath, [MAIN], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  let exited: number | null | undefined;
  child.on('exit', (code) => { exited = code; });
  child.unref();
  const deadline = Date.now() + 30_000; // the first start also runs `claude --version` (up to 8 s)
  while (Date.now() < deadline) {
    await sleep(200);
    if (exited !== undefined) {
      out(`Strategos did not start (exit code ${String(exited)}). Last log lines:\n${logTail(home)}`);
      return 1;
    }
    const info = readDaemonInfo(home);
    if (info !== null && info.pid === child.pid && (await liveDaemon(home)) !== null) {
      out(`Strategos started (pid ${info.pid}, port ${info.port}).`);
      return 0;
    }
  }
  out(`Strategos is taking too long to start. Last log lines:\n${logTail(home)}`);
  return 1;
}

export async function cmdStop(home: string, out: (s: string) => void = console.log): Promise<number> {
  const platform = getPlatform();
  const info = readDaemonInfo(home);
  const lock = readLock(home);
  const pid = info?.pid ?? lock?.pid;
  if (pid === undefined || !(await platform.proc.isAlive(pid, info === null ? lock?.procStart : undefined))) {
    out('Strategos is not running.');
    return 0;
  }
  if (info !== null) await control(home, info, 'shutdown');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await platform.proc.isAlive(pid))) {
      out('Strategos stopped. Sessions are saved and can be resumed.');
      return 0;
    }
    await sleep(250);
  }
  out(`The daemon did not exit in 20 s; ending its process tree (pid ${pid}).`);
  await platform.proc.killTree(pid);
  return 0;
}

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
};
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function renderStatus(s: StatusReply, now = Date.now()): string {
  const head = `strategos ${s.version}  pid ${s.pid}  port ${s.port}  up ${age(now - s.startedAt)}  claude ${s.claude.error === null ? s.claude.version + (s.claude.inRange ? '' : ` (outside tested range ${s.claude.testedRange})`) : 'NOT FOUND'}`;
  if (s.sessions.length === 0) return `${head}\n(no sessions)`;
  const rows = s.sessions.filter((x) => !x.archived).map((x) => [
    x.strategosId.slice(0, 8), cut(x.name, 22), x.status, age(now - x.statusSince), x.statusSource, cut(x.planet, 16),
    x.pending !== null ? `${x.pending.held ? 'waiting' : 'in terminal'}: ${x.pending.tool} ${cut(x.pending.summary, 40)}` : cut(x.last ?? '', 50),
  ]);
  const header = ['ID', 'NAME', 'STATUS', 'FOR', 'SOURCE', 'PLANET', 'DETAIL'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [head, line(header), ...rows.map(line)].join('\n');
}

function renderOffline(home: string): string {
  try {
    const j = JSON.parse(readFileSync(statePath(home), 'utf8')) as { writtenAt?: number; sessions?: { strategosId: string; name: string; status: string; statusSince: number; statusSource: string; planetKey: string; last?: string; archived?: boolean; cwd: string; cost?: { lineageUsd: number } }[] };
    const sessions = (j.sessions ?? []).map((x) => ({
      strategosId: x.strategosId, name: x.name, status: x.status, statusSource: x.statusSource, statusSince: x.statusSince,
      planet: path.basename(path.dirname(x.planetKey)), cwd: x.cwd, last: x.last ?? null, pending: null, ctxPct: null,
      costUsd: x.cost?.lineageUsd ?? 0, pid: null, archived: x.archived === true,
    }));
    const body = renderStatus({ pid: 0, port: 0, version: '-', startedAt: Date.now(), claude: { version: '-', testedRange: '-', inRange: true, error: null }, sessions });
    return `Strategos is not running. Last saved state (read-only):\n${body.split('\n').slice(1).join('\n')}`;
  } catch {
    return 'Strategos is not running (no saved state).';
  }
}

export async function cmdStatus(home: string, o: { watch: boolean; json: boolean }, out: (s: string) => void = console.log): Promise<number> {
  const once = async (): Promise<string> => {
    const live = await liveDaemon(home);
    if (live === null) return renderOffline(home);
    return o.json ? JSON.stringify(live.status, null, 2) : renderStatus(live.status);
  };
  if (!o.watch) {
    out(await once());
    return 0;
  }
  const tty = process.stdout.isTTY === true;
  for (;;) {
    const text = await once();
    out(tty ? `\x1b[H\x1b[2J${text}\n\n(refreshing every second, Ctrl+C to leave)` : `${new Date().toISOString()}\n${text}\n`);
    await sleep(1000);
  }
}

export async function cmdOpen(home: string, o: { print: boolean }, out: (s: string) => void = console.log): Promise<number> {
  let live = await liveDaemon(home);
  if (live === null) {
    const code = await cmdStart(home, out);
    if (code !== 0) return code;
    live = await liveDaemon(home);
    if (live === null) return 1;
  }
  const r = await control(home, live.info, 'pair');
  const url = r?.status === 200 ? (r.json as { url?: string }).url : undefined;
  if (url === undefined) {
    out('The daemon did not give a pairing link. Is it running as the same user?');
    return 1;
  }
  if (o.print) {
    out(url);
    return 0;
  }
  await getPlatform().openAppWindow(url);
  out('Opened the Strategos window.');
  return 0;
}

const HELP = `strategos <command>
  start            start the daemon in the background
  stop             stop the daemon (sessions are saved and can be resumed)
  status [--watch] [--json]   show the sessions (--watch refreshes every second)
  open [--print]   open the Strategos window, already paired (--print shows the link instead)`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const home = strategosHome();
  switch (cmd) {
    case 'start': return cmdStart(home);
    case 'stop': return cmdStop(home);
    case 'status': return cmdStatus(home, { watch: rest.includes('--watch'), json: rest.includes('--json') });
    case 'open': return cmdOpen(home, { print: rest.includes('--print') });
    case undefined: case 'help': case '--help': case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${cmd}".\n${HELP}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
