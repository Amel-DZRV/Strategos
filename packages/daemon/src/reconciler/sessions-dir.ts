// Reads <CLAUDE_CONFIG_DIR>/sessions/*.json (one file per running Claude process) without writing anything.
// Shape seen on Claude Code 2.1.292: { pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, name,
// status: busy|idle|waiting, statusUpdatedAt, waitingFor?, updatedAt }. The format is internal, so parsing is tolerant.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { num } from '../transcript/fsutil.ts';

export interface SessionFile {
  file: string;
  pid: number;
  sessionId: string;
  procStart?: string;
  cwd?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  version?: string;
  status?: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
  statusUpdatedAt?: number;
  parkedJobId?: string;
}

export function normaliseStatus(v: unknown): 'busy' | 'idle' | 'waiting' | undefined {
  return v === 'busy' || v === 'idle' || v === 'waiting' ? v : undefined;
}

export function parseSessionFile(file: string, text: string): SessionFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // being rewritten, or not ours
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const pid = num(o.pid);
  if (pid === undefined || typeof o.sessionId !== 'string' || o.sessionId === '') return null;
  const s = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return {
    file,
    pid,
    sessionId: o.sessionId,
    procStart: s('procStart'),
    cwd: s('cwd'),
    kind: s('kind'),
    entrypoint: s('entrypoint'),
    name: s('name'),
    version: s('version'),
    status: normaliseStatus(o.status),
    waitingFor: s('waitingFor'),
    statusUpdatedAt: num(o.statusUpdatedAt),
    parkedJobId: s('parkedJobId'),
  };
}

/** All readable session files. A missing directory is an empty list; unreadable or half-written files are skipped. */
export async function readSessionsDir(claudeConfigDir: string): Promise<SessionFile[]> {
  const dir = join(claudeConfigDir, 'sessions');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue; // the folder also holds <pid>.<hash>.key files
    try {
      const parsed = parseSessionFile(name, await readFile(join(dir, name), 'utf8'));
      if (parsed) out.push(parsed);
    } catch {
      // vanished between readdir and read
    }
  }
  return out;
}
