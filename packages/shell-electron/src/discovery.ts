// Find the running daemon, or the system Node that can start it. All file and process access goes through small
// injected functions, so the logic is tested with a fake home (discovery.test.ts).
//
// Same rules as the CLI (packages/daemon/src/cli.ts): daemon.json says where the daemon listens, but only an answer on
// POST /control/status proves it is alive (a leftover file proves nothing). The pairing code comes from POST
// /control/pair, authenticated by the secret in <home>/cli.secret. daemon.json itself holds no secret.
import * as path from 'node:path';

export interface DaemonInfo { pid: number; port: number; startedAt: number; version: string }

/** Same rule as strategosHome() in the daemon's config.ts (kept here so the shell does not import the daemon). */
export function strategosHome(env: Record<string, string | undefined>, homedir: string): string {
  const o = env['STRATEGOS_HOME'];
  return o !== undefined && o !== '' ? path.resolve(o) : path.join(homedir, '.strategos');
}

export interface ControlReply { status: number; json: unknown }

export interface DiscoveryDeps {
  readInfo(home: string): DaemonInfo | null;
  readSecret(home: string): string | null;
  /** POST http://127.0.0.1:<port>/control/<name> with the secret. null when nothing answered. */
  control(info: DaemonInfo, secret: string, name: 'status' | 'pair'): Promise<ControlReply | null>;
}

/** The daemon that answers on its control route right now, or null. */
export async function findLiveDaemon(home: string, deps: DiscoveryDeps): Promise<DaemonInfo | null> {
  const info = deps.readInfo(home);
  if (info === null) return null;
  const secret = deps.readSecret(home);
  if (secret === null) return null;
  const r = await deps.control(info, secret, 'status');
  return r !== null && r.status === 200 ? info : null;
}

/** The code part of `http://127.0.0.1:<port>/#pair=<code>`, only if the link points at this daemon. */
export function codeFromPairUrl(url: string, port: number): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== String(port)) return null;
  const m = /(?:^|[#&])pair=([^&]+)/.exec(u.hash);
  if (m === null) return null;
  try {
    const code = decodeURIComponent(m[1]!);
    return code === '' ? null : code;
  } catch {
    return null;
  }
}

/** A fresh one-time pairing code (60 s, single use) from the live daemon. Held in memory only. */
export async function requestPairCode(home: string, info: DaemonInfo, deps: DiscoveryDeps): Promise<string | null> {
  const secret = deps.readSecret(home);
  if (secret === null) return null;
  const r = await deps.control(info, secret, 'pair');
  if (r === null || r.status !== 200) return null;
  const url = (r.json as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? codeFromPairUrl(url, info.port) : null;
}

// ---------------------------------------------------------------------------
// system Node (D7: the daemon runs under the owner's Node, not inside Electron)
// ---------------------------------------------------------------------------

export interface NodeFinderDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(p: string): boolean;
  /** Windows: the install folder from HKLM\SOFTWARE\Node.js (or HKCU), null when missing. */
  registryInstallPath?(): string | null;
}

/** Candidate paths of the node executable, in order of preference. */
export function nodeCandidates(d: NodeFinderDeps): string[] {
  const win = d.platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exe = win ? 'node.exe' : 'node';
  const out: string[] = [];
  const pathVar = d.env['PATH'] ?? d.env['Path'] ?? '';
  for (const dir of pathVar.split(win ? ';' : ':')) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (clean !== '') out.push(P.join(clean, exe));
  }
  if (win) {
    const reg = d.registryInstallPath?.();
    if (reg) out.push(P.join(reg, exe));
    for (const base of [d.env['ProgramFiles'], d.env['ProgramW6432'], d.env['LOCALAPPDATA'] === undefined ? undefined : P.join(d.env['LOCALAPPDATA'], 'Programs')]) {
      if (base) out.push(P.join(base, 'nodejs', exe));
    }
  } else {
    out.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node');
  }
  return out;
}

/** The first node executable that exists. Electron's own binary never counts: it is not on the list. */
export function findNode(d: NodeFinderDeps): string | null {
  const seen = new Set<string>();
  for (const c of nodeCandidates(d)) {
    const key = d.platform === 'win32' ? c.toLowerCase() : c;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.exists(c)) return c;
  }
  return null;
}
