// The status state machine, plan section 6. Pure: reduce(record, input, now) -> { next, effects }.
// No I/O, no clock, no randomness. The session manager applies `next` and runs the effects.
//
// Sources: H hook, P pty, T transcript inference, R reconciler inference, U user command.

import { isLive } from '@strategos/shared';
import type {
  Decision, Effect, HookMachineInput, MachineInput, Observation, Pending, SessionRecord, Status, StatusSource,
  UserMachineCommand,
} from '@strategos/shared';
import { applySessionStart, withSessionCost } from './identity.ts';

/** Rule 2: T and R may act only when no hook has arrived for this long. */
export const QUIET_MS = 10_000;
/** P-detected Esc/Ctrl+C is confirmed by a reconciler `idle` within this window. */
export const INTERRUPT_CONFIRM_MS = 5_000;
/** An unconfirmed interrupt flag is dropped after this long. */
export const INTERRUPT_DROP_MS = 10_000;
/** `trust_pending` from the reconciler counts only this soon after spawn. */
export const TRUST_WINDOW_MS = 20_000;
/** Rule 7: a hook/reconciler disagreement older than this is logged as drift. */
export const DRIFT_MS = 30_000;
const LAST_MAX = 160;
const SUBAGENTS_MAX = 50;

const NEEDS_YOU: ReadonlySet<Status> = new Set<Status>(['permission', 'question', 'errored', 'trust_pending', 'interrupted', 'done']);

interface Ctx {
  s: SessionRecord; // working copy
  fx: Effect[];
  now: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(c: Ctx, type: 'status' | 'drift' | 'error', data: Record<string, unknown>): void {
  c.fx.push({ e: 'log', type, data: { strategosId: c.s.strategosId, at: c.now, ...data } });
}

/** Change status (and/or its source). Rule 5 (waitingSince) and rule 7 (log with source) live here. */
function setStatus(c: Ctx, to: Status, source: StatusSource, why: string, extra?: Record<string, unknown>): void {
  const s = c.s;
  const from = s.status;
  if (from === to && s.statusSource === source) return;
  if (from !== to) {
    s.status = to;
    s.statusSince = c.now;
    s.waitingSince = NEEDS_YOU.has(to) ? c.now : undefined;
  }
  s.statusSource = source;
  log(c, 'status', { from, to, source, why, ...extra });
}

function quiet(c: Ctx): boolean {
  return c.now - c.s.lastActivityAt >= QUIET_MS;
}

function hasPending(c: Ctx): boolean {
  return c.s.pending !== undefined;
}

function markDone(c: Ctx, source: StatusSource, why: string, notify: boolean): void {
  const wasDone = c.s.status === 'done';
  c.s.doneAt = c.now;
  c.s.now = undefined;
  c.s.pending = undefined;
  c.s.interruptPendingAt = undefined;
  setStatus(c, 'done', source, why);
  if (notify && !wasDone) {
    c.fx.push({ e: 'notify', kind: 'done', title: c.s.displayName, body: c.s.last ?? 'Finished' });
  }
}

function markSeen(c: Ctx, source: StatusSource, why: string): void {
  c.s.seenAt = c.now;
  c.s.interruptPendingAt = undefined;
  setStatus(c, 'seen', source, why);
}

function markInterrupted(c: Ctx, source: StatusSource, why: string): void {
  const was = c.s.status;
  c.s.interruptPendingAt = undefined;
  c.s.now = undefined;
  c.s.pending = undefined;
  setStatus(c, 'interrupted', source, why);
  if (was !== 'interrupted') c.fx.push({ e: 'chat.marker', marker: 'interrupted' });
}

function toWorking(c: Ctx, source: StatusSource, why: string): void {
  c.s.pending = undefined;
  setStatus(c, 'working', source, why);
}

function enterPending(c: Ctx, p: Pending, source: StatusSource, why: string): void {
  c.s.pending = p;
  c.s.now = undefined;
  setStatus(c, p.kind, source, why, { requestId: p.requestId, held: p.held, agentId: p.agentId });
  c.fx.push({ e: 'notify', kind: p.kind, title: c.s.displayName, body: p.inputSummary, requestId: p.requestId });
}

function releasePending(c: Ctx, p: Pending, via: string): void {
  c.fx.push({ e: 'hook.respond', requestId: p.requestId, response: 'no_decision' });
  c.fx.push({ e: 'audit', requestId: p.requestId, decision: 'release', via });
}

// ---------------------------------------------------------------------------
// hooks (H)
// ---------------------------------------------------------------------------

function upsertSubagent(c: Ctx, agentId: string, running: boolean, type: string | undefined): void {
  const list = c.s.subagents;
  const i = list.findIndex((a) => a.agentId === agentId);
  const prev = i >= 0 ? list[i] : undefined;
  let entry;
  if (running) {
    entry = { agentId, type: type ?? prev?.type, running: true, startedAt: c.now };
  } else {
    entry = { agentId, type: type ?? prev?.type, running: false, startedAt: prev?.startedAt ?? c.now, endedAt: c.now };
  }
  const next = i >= 0 ? list.map((a, j) => (j === i ? entry : a)) : [...list, entry];
  c.s.subagents = next.slice(-SUBAGENTS_MAX);
}

function onHook(c: Ctx, h: HookMachineInput): void {
  const s = c.s;
  if (h.event !== 'SessionStart' && h.claudeSessionId !== undefined && !s.claudeSessionIds.includes(h.claudeSessionId)) {
    // Not from this lineage (for instance a `claude -p` run by the session's own Bash tool): never touch status.
    log(c, 'error', { why: 'hook_from_unknown_session', event: h.event, claudeSessionId: h.claudeSessionId });
    return;
  }
  s.lastActivityAt = c.now;
  if (h.model !== undefined) s.model = h.model;
  if (h.permissionMode !== undefined) s.permissionMode = h.permissionMode;
  if (h.effort !== undefined) s.effort = h.effort;

  // Rule 3: events from a subagent update `subagents` and `now` only ...
  if (h.event === 'SubagentStart' || h.event === 'SubagentStop') {
    if (h.agentId !== undefined) upsertSubagent(c, h.agentId, h.event === 'SubagentStart', h.agentType);
    return;
  }
  const req: Pending | undefined = h.event === 'PermissionRequest' || h.event === 'PreToolUse' ? h.pending : undefined;
  const isBlockingRequest = req !== undefined;
  if (h.agentId !== undefined && !isBlockingRequest) {
    // ... except PermissionRequest and AskUserQuestion, which block the session like the main agent's.
    if (h.event === 'PreToolUse') {
      s.now = { tool: h.tool, summary: h.summary, since: c.now, agentId: h.agentId };
    } else if ((h.event === 'PostToolUse' || h.event === 'PostToolUseFailure') && s.now?.agentId === h.agentId) {
      s.now = undefined;
    }
    return;
  }

  // Rule 8: while a hold is open, no hook event touches `pending` or the status.
  if (s.pending?.held === true) {
    if (req !== undefined) releasePending(c, req, 'superseded'); // let the TUI show the second dialog itself
    log(c, 'error', { why: 'hook_ignored_while_held', event: h.event, requestId: s.pending.requestId });
    return;
  }

  // Hooks that reach a stopped, parked or open_elsewhere record carry no status information.
  if (!isLive(s.status)) return;

  switch (h.event) {
    case 'SessionStart': {
      const l = applySessionStart(s, { claudeSessionId: h.claudeSessionId, source: h.source, transcriptPath: h.transcriptPath });
      Object.assign(s, l.patch);
      c.fx.push(...l.effects);
      if (h.source === 'clear' || h.source === 'resume' || h.source === 'fork') {
        markDone(c, 'hook', `SessionStart:${h.source}`, false); // fresh prompt (rule 4)
      } else if (h.source !== 'compact' && (s.status === 'starting' || s.status === 'trust_pending')) {
        if (s.launch.firstPrompt !== undefined) {
          setStatus(c, 'working', 'hook', 'SessionStart:startup');
        } else {
          s.doneAt = c.now;
          markSeen(c, 'hook', 'SessionStart:startup'); // idle at an empty prompt: nothing to look at
        }
      }
      break;
    }
    case 'SessionEnd':
      if (h.reason !== 'clear' && h.reason !== 'resume') {
        s.pending = undefined;
        s.now = undefined;
        setStatus(c, 'stopped', 'hook', `SessionEnd:${h.reason}`);
      }
      break;
    case 'UserPromptSubmit':
      s.now = undefined;
      s.interruptPendingAt = undefined;
      s.lastIsQuestion = false;
      toWorking(c, 'hook', 'UserPromptSubmit');
      break;
    case 'PreToolUse':
      if (h.pending !== undefined) {
        enterPending(c, h.pending, 'hook', `PreToolUse:${h.tool}`);
      } else if (h.tool !== 'AskUserQuestion') {
        s.now = { tool: h.tool, summary: h.summary, since: c.now };
        toWorking(c, 'hook', `PreToolUse:${h.tool}`);
      }
      break;
    case 'PostToolUse':
      s.now = undefined;
      if (h.testResult !== undefined) {
        s.flags = { ...s.flags, lastTest: { command: h.testResult.command, ok: h.testResult.ok, at: c.now } };
      }
      toWorking(c, 'hook', `PostToolUse:${h.tool}`);
      break;
    case 'PostToolUseFailure':
      if (h.isInterrupt) {
        markInterrupted(c, 'hook', `PostToolUseFailure:${h.tool}`);
      } else {
        s.now = undefined;
        toWorking(c, 'hook', `PostToolUseFailure:${h.tool}`);
      }
      break;
    case 'PermissionRequest':
      enterPending(c, h.pending, 'hook', `PermissionRequest:${h.pending.toolName}`);
      break;
    case 'Notification':
      if (h.pending !== undefined) enterPending(c, h.pending, 'hook', `Notification:${h.notificationType ?? 'unknown'}`);
      break;
    case 'Stop':
      s.lastIsQuestion = h.lastMessage?.trimEnd().endsWith('?') ?? false; // rule 6
      if (h.lastMessage !== undefined) s.last = h.lastMessage.slice(0, LAST_MAX);
      markDone(c, 'hook', 'Stop', true);
      break;
    case 'StopFailure':
      s.now = undefined;
      s.pending = undefined;
      s.interruptPendingAt = undefined;
      if (h.lastMessage !== undefined) s.last = h.lastMessage.slice(0, LAST_MAX);
      setStatus(c, 'errored', 'hook', 'StopFailure', { error: h.error });
      c.fx.push({ e: 'notify', kind: 'errored', title: s.displayName, body: h.error ?? 'The turn failed' });
      break;
    case 'PreCompact':
      s.now = { tool: 'compact', summary: 'Compacting the conversation', since: c.now };
      toWorking(c, 'hook', 'PreCompact');
      break;
    case 'PostCompact':
      s.now = undefined;
      break;
    case 'CwdChanged':
      if (h.newCwd !== undefined) s.cwd = h.newCwd;
      break;
  }

  // Any hook at all proves hooks work, so it ends `starting` and `trust_pending` (SessionStart handled above).
  if (s.status === 'starting' || s.status === 'trust_pending') setStatus(c, 'working', 'hook', `hook:${h.event}`);
}

// ---------------------------------------------------------------------------
// transcript inference (T)
// ---------------------------------------------------------------------------

function onTranscript(c: Ctx, e: Extract<MachineInput, { k: 'transcript' }>): void {
  const s = c.s;
  if (!isLive(s.status)) return;
  if (hasPending(c)) return; // rule 1
  switch (e.signal) {
    case 'working':
      if (quiet(c) && s.status !== 'working' && s.status !== 'errored') {
        setStatus(c, 'working', 'transcript', 'transcript:working');
      }
      break;
    case 'awaiting_reply':
      if (quiet(c) && (s.status === 'working' || s.status === 'starting' || s.status === 'trust_pending')) {
        s.lastIsQuestion = e.lastIsQuestion ?? false;
        markDone(c, 'transcript', 'transcript:awaiting_reply', true);
        s.doneAt = e.at ?? c.now;
      }
      break;
    case 'interrupt_marker':
      // A pty-detected Esc/Ctrl+C is confirmed by the marker; without that flag it is plain inference (rule 2).
      if (s.interruptPendingAt !== undefined || (s.status === 'working' && quiet(c))) {
        markInterrupted(c, 'transcript', 'transcript:interrupt_marker');
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// reconciler inference (R)
// ---------------------------------------------------------------------------

function agrees(obs: Observation, st: Status): boolean {
  switch (obs.status) {
    case 'busy': return st === 'working';
    case 'idle': return st === 'done' || st === 'seen' || st === 'interrupted' || st === 'errored';
    case 'waiting': return st === 'permission' || st === 'question' || st === 'trust_pending';
    default: return true;
  }
}

function onReconciler(c: Ctx, obs: Observation): void {
  const s = c.s;
  if (obs.claudeSessionId !== s.currentSessionId) return;

  if (!obs.alive) {
    if (!obs.ownedByUs && s.status === 'open_elsewhere') setStatus(c, 'stopped', 'reconciler', 'open_elsewhere:gone');
    return;
  }
  if (!obs.ownedByUs) {
    // Someone else's process holds our current Claude id and we have no process of our own.
    if (s.pty === undefined && s.status !== 'open_elsewhere') {
      s.pending = undefined;
      s.now = undefined;
      setStatus(c, 'open_elsewhere', 'reconciler', 'open_elsewhere', { pid: obs.pid });
    }
    return;
  }
  if (!isLive(s.status)) return;

  const waitingFor = obs.waitingFor ?? '';
  if (obs.status === 'waiting' && waitingFor.includes('dialog open')) {
    if (s.status === 'starting' && c.now - s.statusSince <= TRUST_WINDOW_MS) {
      setStatus(c, 'trust_pending', 'reconciler', 'waitingFor:dialog open');
    }
  } else if (!hasPending(c)) {
    // Rule 1: nothing below may run while a request is pending. Rule 2: only after 10 s with no hook.
    const idleAfterInterrupt = s.interruptPendingAt !== undefined && c.now - s.interruptPendingAt <= INTERRUPT_CONFIRM_MS;
    if (obs.status === 'idle' && idleAfterInterrupt) {
      markInterrupted(c, 'reconciler', 'reconciler:idle after Esc');
    } else if (quiet(c)) {
      if (obs.status === 'waiting' && waitingFor.includes('permission prompt')) {
        const p: Pending = {
          requestId: `reconciler-${obs.claudeSessionId}-${c.now}`,
          kind: 'permission',
          held: false, // answer in the terminal
          toolName: s.now?.tool ?? 'unknown',
          inputSummary: s.now?.summary ?? 'Waiting for your answer in the terminal',
          inputTruncated: false,
          risk: [],
          since: c.now,
        };
        enterPending(c, p, 'reconciler', 'waitingFor:permission prompt');
      } else if (obs.status === 'busy') {
        if (s.status !== 'working' && s.status !== 'errored') {
          setStatus(c, 'working', 'reconciler', 'reconciler:busy');
        }
      } else if (obs.status === 'idle') {
        if (s.status === 'working') markDone(c, 'reconciler', 'reconciler:idle', true);
        else if (s.status === 'starting' || s.status === 'trust_pending') markSeen(c, 'reconciler', 'reconciler:idle');
      }
    }
  }

  // Rule 7: a hook state that the reconciler has contradicted for more than 30 s is drift.
  if (
    s.statusSource === 'hook' && s.status !== 'starting' && !agrees(obs, s.status) &&
    c.now - s.lastActivityAt >= DRIFT_MS
  ) {
    log(c, 'drift', { hookStatus: s.status, reconcilerStatus: obs.status, waitingFor: obs.waitingFor, quietMs: c.now - s.lastActivityAt });
  }
}

// ---------------------------------------------------------------------------
// user commands (U)
// ---------------------------------------------------------------------------

function onUser(c: Ctx, u: UserMachineCommand): void {
  const s = c.s;
  switch (u.cmd) {
    case 'start':
    case 'resume':
      if (s.pty !== undefined || s.status === 'open_elsewhere') {
        log(c, 'error', { why: 'start_refused', status: s.status, hasPty: s.pty !== undefined });
        return;
      }
      s.pending = undefined;
      s.now = undefined;
      s.interruptPendingAt = undefined;
      s.exitCode = undefined;
      s.lastActivityAt = c.now;
      setStatus(c, 'starting', 'user', u.cmd);
      c.s.statusSince = c.now; // restart the trust window even when already `starting`
      c.fx.push({ e: 'spawn', resume: u.cmd === 'resume' });
      break;
    case 'stop':
    case 'park':
      if (s.pty !== undefined) {
        c.fx.push({ e: 'pty.kill', park: u.cmd === 'park' });
      } else {
        setStatus(c, u.cmd === 'park' ? 'parked' : 'stopped', 'user', u.cmd);
      }
      break;
    case 'seen':
      if (s.status === 'done' || s.status === 'interrupted') markSeen(c, 'user', 'seen');
      break;
    case 'decide':
      onDecide(c, u.requestId, u.decision);
      break;
    case 'release': {
      const p = s.pending;
      if (p === undefined || p.requestId !== u.requestId || !p.held) {
        log(c, 'error', { why: 'release_unmatched', requestId: u.requestId });
        return;
      }
      releasePending(c, p, u.why);
      s.pending = { ...p, held: false, expiresAt: undefined }; // the TUI now shows the dialog; status stays
      log(c, 'status', { from: s.status, to: s.status, source: 'user', why: `release:${u.why}`, requestId: p.requestId });
      break;
    }
  }
}

function onDecide(c: Ctx, requestId: string, d: Decision): void {
  const p = c.s.pending;
  if (p === undefined || p.requestId !== requestId || !p.held) {
    log(c, 'error', { why: 'decide_unmatched', requestId });
    return;
  }
  c.fx.push({ e: 'hook.respond', requestId, response: d.kind, decision: d });
  c.fx.push({ e: 'audit', requestId, decision: d.kind === 'answers' ? 'answer' : d.kind, via: d.via ?? 'ui' });
  c.s.now = undefined;
  toWorking(c, 'user', `decide:${d.kind}`);
}

// ---------------------------------------------------------------------------
// everything else
// ---------------------------------------------------------------------------

function onHoldClosed(c: Ctx, requestId: string): void {
  const p = c.s.pending;
  if (p === undefined || p.requestId !== requestId || !p.held) return;
  c.fx.push({ e: 'audit', requestId, decision: 'release', via: 'terminal' });
  toWorking(c, 'hook', 'hold.closed');
}

function onPtyExit(c: Ctx, e: Extract<MachineInput, { k: 'pty.exit' }>): void {
  const s = c.s;
  if (s.pending?.held === true) releasePending(c, s.pending, 'pty.exit');
  s.pending = undefined;
  s.pty = undefined;
  s.now = undefined;
  s.interruptPendingAt = undefined;
  s.exitCode = e.code ?? undefined;
  s.subagents = s.subagents.map((a) => (a.running ? { ...a, running: false, endedAt: c.now } : a));
  if (e.after === 'park') {
    setStatus(c, 'parked', 'pty', 'pty.exit:park');
  } else if (e.after === 'stop') {
    setStatus(c, 'stopped', 'pty', 'pty.exit:stop');
  } else if (s.status === 'stopped' || s.status === 'parked' || s.status === 'open_elsewhere') {
    // already ended (SessionEnd) or not ours: keep
  } else if (e.code === 0) {
    setStatus(c, 'stopped', 'pty', 'pty.exit:0');
  } else {
    setStatus(c, 'errored', 'pty', 'pty.exit:nonzero', { code: e.code });
    c.fx.push({ e: 'notify', kind: 'errored', title: s.displayName, body: `The process exited unexpectedly (code ${e.code ?? 'signal'})` });
  }
}

function onTick(c: Ctx): void {
  const s = c.s;
  if (s.interruptPendingAt !== undefined && c.now - s.interruptPendingAt >= INTERRUPT_DROP_MS) {
    log(c, 'status', { from: s.status, to: s.status, source: 'pty', why: 'interrupt_unconfirmed' });
    s.interruptPendingAt = undefined;
  }
  const p = s.pending;
  if (p?.held === true && p.expiresAt !== undefined && c.now >= p.expiresAt) {
    releasePending(c, p, 'expiry');
    s.pending = { ...p, held: false, expiresAt: undefined };
    log(c, 'status', { from: s.status, to: s.status, source: 'user', why: 'release:expiry', requestId: p.requestId });
  }
}

function onStatusline(c: Ctx, e: Extract<MachineInput, { k: 'statusline' }>): void {
  const s = c.s;
  if (e.ctx !== undefined) s.ctx = e.ctx;
  if (e.cost !== undefined) s.cost = withSessionCost(s.cost, e.cost.claudeSessionId, e.cost.usd);
  if (e.model !== undefined) s.model = e.model;
  if (e.cache !== undefined) s.cache = e.cache;
}

function onRestart(c: Ctx): void {
  const s = c.s;
  s.pending = undefined;
  s.pty = undefined;
  s.now = undefined;
  s.interruptPendingAt = undefined;
  s.subagents = s.subagents.map((a) => (a.running ? { ...a, running: false, endedAt: c.now } : a));
  if (s.status !== 'parked') setStatus(c, 'stopped', 'pty', 'daemon.restart');
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function reduce(s: SessionRecord, e: MachineInput, now: number): { next: SessionRecord; effects: Effect[] } {
  const c: Ctx = { s: { ...s }, fx: [], now };
  switch (e.k) {
    case 'hook': onHook(c, e.hook); break;
    case 'hold.closed': onHoldClosed(c, e.requestId); break;
    case 'pty.exit': onPtyExit(c, e); break;
    case 'pty.trust_dialog':
      if (s.status === 'starting') setStatus(c, 'trust_pending', 'pty', 'pty:trust_dialog');
      break;
    case 'pty.key':
      // Keys that Strategos itself sent (stop sequence, release) are not the owner interrupting.
      if (!e.fromStrategos && (s.status === 'working' || s.status === 'permission')) c.s.interruptPendingAt = now;
      break;
    case 'transcript': onTranscript(c, e); break;
    case 'reconciler': onReconciler(c, e.obs); break;
    case 'statusline': onStatusline(c, e); break;
    case 'user': onUser(c, e.u); break;
    case 'daemon.restart': onRestart(c); break;
    case 'tick': onTick(c); break;
  }

  // Unchanged -> hand back the same object so callers can skip persisting.
  const keys = Object.keys(c.s) as (keyof SessionRecord)[];
  const changed = keys.some((k) => c.s[k] !== s[k]);
  if (!changed) return { next: s, effects: c.fx };
  c.s.updatedAt = now;
  c.fx.push({ e: 'persist' });
  return { next: c.s, effects: c.fx };
}
