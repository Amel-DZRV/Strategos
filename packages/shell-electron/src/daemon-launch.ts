// Find the daemon, or start it, and ask it for pairing codes. The IO half of discovery.ts.
//
// The daemon runs under the owner's system Node, detached, exactly like `strategos start` (cli.ts): closing the window
// or quitting the shell does not stop sessions (D7). Electron's own Node is NOT used by default; see the README note
// "ELECTRON_RUN_AS_NODE" for the one-hour test that decided this.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findLiveDaemon, findNode, requestPairCode, strategosHome, type ControlReply, type DaemonInfo, type DiscoveryDeps } from './discovery.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export const realDiscovery: DiscoveryDeps = {
  readInfo(home) {
    const j = readJson<Partial<DaemonInfo>>(path.join(home, 'daemon.json'));
    if (j === null || typeof j.pid !== 'number' || typeof j.port !== 'number') return null;
    return { pid: j.pid, port: j.port, startedAt: typeof j.startedAt === 'number' ? j.startedAt : 0, version: typeof j.version === 'string' ? j.version : '?' };
  },
  readSecret(home) {
    try {
      const s = readFileSync(path.join(home, 'cli.secret'), 'utf8').trim();
      return s === '' ? null : s;
    } catch {
      return null;
    }
  },
  async control(info, secret, name): Promise<ControlReply | null> {
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
  },
};

export const homeDir = (): string => strategosHome(process.env, os.homedir());

function registryNodePath(): string | null {
  if (process.platform !== 'win32') return null;
  for (const key of ['HKLM\\SOFTWARE\\Node.js', 'HKCU\\SOFTWARE\\Node.js']) {
    const r = spawnSync('reg', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(r.stdout ?? '');
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export function systemNode(): string | null {
  return findNode({ platform: process.platform, env: process.env, exists: existsSync, registryInstallPath: registryNodePath });
}

function logTail(home: string, lines = 12): string {
  try {
    const dir = path.join(home, 'logs');
    const files = readdirSync(dir).filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    const last = files[files.length - 1];
    if (last === undefined) return '(no log yet)';
    return readFileSync(path.join(dir, last), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

export class DaemonUnavailable extends Error {}

export interface EnsureOptions {
  /** The daemon entry script: packages/daemon/src/main.ts (run from source) or the packaged bundle. */
  entry: string;
  /** Extra environment for a daemon this call starts (the packaged app points it at the bundled UI). */
  env?: Record<string, string>;
  onStarting?: () => void;
  timeoutMs?: number;
}

/** The live daemon, started first if there is none. Throws DaemonUnavailable with a message the owner can read. */
export async function ensureDaemon(home: string, o: EnsureOptions): Promise<DaemonInfo> {
  const live = await findLiveDaemon(home, realDiscovery);
  if (live !== null) return live;
  const node = systemNode();
  if (node === null) throw new DaemonUnavailable('Strategos needs Node.js (version 24 or newer) to run its background service, and none was found. Install it from nodejs.org, then start Strategos again.');
  if (!existsSync(o.entry)) throw new DaemonUnavailable(`The Strategos service file is missing: ${o.entry}`);
  o.onStarting?.();
  const env = { ...process.env, ...o.env };
  delete env['ELECTRON_RUN_AS_NODE']; // the child is plain Node; the variable would leak into every Claude session it starts
  const child = spawn(node, [o.entry], { detached: true, stdio: 'ignore', windowsHide: true, env });
  let exited: number | null | undefined;
  child.on('exit', (code) => { exited = code; });
  child.unref();
  const deadline = Date.now() + (o.timeoutMs ?? 30_000); // the first start also runs `claude --version` (up to 8 s)
  while (Date.now() < deadline) {
    await sleep(200);
    if (exited !== undefined) throw new DaemonUnavailable(`The Strategos service stopped right after starting (exit code ${String(exited)}). Last log lines:\n${logTail(home)}`);
    const info = await findLiveDaemon(home, realDiscovery);
    if (info !== null && info.pid === child.pid) return info;
  }
  throw new DaemonUnavailable(`The Strategos service is taking too long to start. Last log lines:\n${logTail(home)}`);
}

export const pairCode = (home: string, info: DaemonInfo): Promise<string | null> => requestPairCode(home, info, realDiscovery);
