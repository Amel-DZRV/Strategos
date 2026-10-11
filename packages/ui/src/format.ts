import { glyphFor, isLive, type RiskClass, type SessionRecord, type Status } from '@strategos/shared';

export interface StatusInfo {
  label: string;
  glyph: string;
  /** CSS variable name for the status colour. */
  colour: string;
}

const C_APPROVE = 'var(--c-approve)';
const C_REPLY = 'var(--c-reply)';
const C_READY = 'var(--c-ready)';
const C_WORK = 'var(--c-work)';
const C_CRASH = 'var(--c-crash)';

const LABELS: Record<Status, [string, string]> = {
  starting: ['Starting', C_WORK],
  trust_pending: ['Needs folder trust', C_REPLY],
  working: ['Working', C_WORK],
  permission: ['Needs permission', C_APPROVE],
  question: ['Has a question', C_REPLY],
  done: ['Done', C_READY],
  seen: ['Done (seen)', C_CRASH],
  interrupted: ['Interrupted', C_REPLY],
  errored: ['Errored', C_APPROVE],
  stopped: ['Stopped', C_CRASH],
  parked: ['Parked', C_CRASH],
  open_elsewhere: ['Open elsewhere', C_CRASH],
};

/** Glyph plus label plus colour: status is never shown by colour alone. */
export function statusInfo(status: Status): StatusInfo {
  const [label, colour] = LABELS[status];
  return { label, glyph: glyphFor(status), colour };
}

export const RISK_LABEL: Record<RiskClass, string> = {
  read: 'READ', write: 'WRITE', run: 'RUN', network: 'NET', delete: 'DEL', outside_repo: 'OUTSIDE',
};

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** "45s", "14m", "1h 05m". */
export function fmtWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** When the session started waiting for the owner (or sat in its current status). */
export function waitingMs(s: SessionRecord, now: number): number {
  return now - (s.waitingSince ?? s.statusSince);
}

export function ctxPct(s: SessionRecord): number | null {
  const p = s.ctx?.pct;
  return typeof p === 'number' ? Math.round(p) : null;
}

export function ctxColour(pct: number): string {
  return pct >= 85 ? C_APPROVE : pct >= 70 ? C_REPLY : C_WORK;
}

export function canStop(s: SessionRecord): boolean {
  return isLive(s.status);
}

export function canResume(s: SessionRecord): boolean {
  return s.status === 'stopped' || s.status === 'parked';
}

export function repoName(s: SessionRecord): string {
  const parts = s.repoRoot.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? s.repoRoot;
}

export function branchOf(s: SessionRecord): string {
  return s.git?.branch ?? s.branch ?? s.worktree?.branch ?? '';
}

export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
