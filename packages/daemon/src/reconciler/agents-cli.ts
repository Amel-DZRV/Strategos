// `claude agents --json`: Claude Code's supported way to read session state from outside (plan C5, section 6 source R).
// The exe path and the exec function are injected, so this file starts no process on its own and tests use a fake.
// The output shape is not frozen, so the parser accepts a bare array or an object holding the array, and several
// spellings of each field. Anything it cannot read is dropped, never thrown.

import type { Observation } from '@strategos/shared';
import { num } from '../transcript/fsutil.ts';
import { normaliseStatus } from './sessions-dir.ts';

export interface ExecResult {
  stdout: string;
  stderr?: string;
  code: number | null;
}
export type ExecFn = (exe: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export interface AgentRow {
  sessionId: string;
  pid?: number;
  status?: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
  kind?: string;
  cwd?: string;
  name?: string;
  statusUpdatedAt?: number;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

// `state` is the coarser field some versions emit instead of (or beside) `status`.
const STATE_TO_STATUS: Record<string, 'busy' | 'idle' | 'waiting'> = {
  working: 'busy', running: 'busy', blocked: 'waiting', waiting: 'waiting', done: 'idle', idle: 'idle', failed: 'idle', stopped: 'idle',
};

export function parseAgentsJson(text: string): AgentRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  let list: unknown = raw;
  if (!Array.isArray(raw) && typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    list = pick(o, ['agents', 'sessions', 'items', 'data']);
  }
  if (!Array.isArray(list)) return [];
  const rows: AgentRow[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = pick(o, ['sessionId', 'session_id', 'id']);
    if (typeof id !== 'string' || id === '') continue;
    const state = pick(o, ['state']);
    const status = normaliseStatus(pick(o, ['status'])) ?? (typeof state === 'string' ? STATE_TO_STATUS[state] : undefined);
    const waitingFor = pick(o, ['waitingFor', 'waiting_for']);
    const kind = pick(o, ['kind']);
    const cwd = pick(o, ['cwd']);
    const name = pick(o, ['name']);
    rows.push({
      sessionId: id,
      pid: num(pick(o, ['pid'])),
      status,
      waitingFor: typeof waitingFor === 'string' ? waitingFor : undefined,
      kind: typeof kind === 'string' ? kind : undefined,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      name: typeof name === 'string' ? name : undefined,
      statusUpdatedAt: num(pick(o, ['statusUpdatedAt', 'status_updated_at'])),
    });
  }
  return rows;
}

/** Run `<exe> agents --json`. Returns null if the command failed or timed out (the caller keeps its last answer). */
export async function runAgentsCli(exec: ExecFn, exe: string, timeoutMs = 20_000): Promise<AgentRow[] | null> {
  try {
    const r = await exec(exe, ['agents', '--json'], { timeoutMs });
    if (r.code !== 0) return null;
    return parseAgentsJson(r.stdout);
  } catch {
    return null;
  }
}

export function rowToObservation(row: AgentRow, extra: Pick<Observation, 'alive' | 'ownedByUs'> & { strategosId?: string }): Observation {
  return {
    strategosId: extra.strategosId,
    claudeSessionId: row.sessionId,
    pid: row.pid ?? 0,
    alive: extra.alive,
    ownedByUs: extra.ownedByUs,
    status: row.status,
    waitingFor: row.waitingFor,
    statusUpdatedAt: row.statusUpdatedAt,
    source: 'agents_cli',
  };
}
