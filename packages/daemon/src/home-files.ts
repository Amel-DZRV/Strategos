// Small read-only helpers for the files the daemon leaves in the Strategos home. The CLI imports this (and not daemon.ts,
// which pulls in node-pty).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
}

export const daemonJsonPath = (home: string): string => path.join(home, 'daemon.json');
export const cliSecretPath = (home: string): string => path.join(home, 'cli.secret');
export const statePath = (home: string): string => path.join(home, 'state.json');

/** daemon.json: `{pid, port, startedAt, version}`. No token. Null when absent or unreadable. */
export function readDaemonInfo(home: string): DaemonInfo | null {
  try {
    const j = JSON.parse(readFileSync(daemonJsonPath(home), 'utf8')) as Partial<DaemonInfo>;
    if (typeof j.pid !== 'number' || typeof j.port !== 'number') return null;
    return { pid: j.pid, port: j.port, startedAt: typeof j.startedAt === 'number' ? j.startedAt : 0, version: typeof j.version === 'string' ? j.version : '?' };
  } catch {
    return null;
  }
}

/** The CLI secret (hex), or null when the daemon is not running. */
export function readCliSecret(home: string): string | null {
  try {
    const s = readFileSync(cliSecretPath(home), 'utf8').trim();
    return s === '' ? null : s;
  } catch {
    return null;
  }
}
