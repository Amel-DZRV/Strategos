// Stuck / loop detection (task 8.01). One detector per session, fed by the same inputs the reducer sees. It only ever sets
// a badge (`flags.stuck`); nothing is stopped, denied or answered because of it.
//
//   repeat           the same tool with the same input three times in a row (per agent: a subagent has its own streak)
//   failures         three tool failures in a row (a success resets; an interrupt is not a failure, S12)
//   ctx_no_progress  context at 90% or more and no Edit/Write/MultiEdit/NotebookEdit among the last 10 tool starts
//   quiet            working for 20 minutes or more and no tool start for 5 minutes, unless a Bash call is still running
//
// Cleared by progress (a different tool call, a success, an edit, any tool start for `quiet`) and by the end of the turn
// (Stop, StopFailure, SessionEnd, an interrupt, or any status other than working/permission/question).
import { createHash } from 'node:crypto';
import type { HookMachineInput, MachineInput, SessionRecord, Status } from '@strategos/shared';

export type StuckReason = NonNullable<SessionRecord['flags']['stuck']>['reason'];
export interface StuckFlag { reason: StuckReason; since: number }

export const STUCK_LIMITS = {
  repeat: 3,
  failures: 3,
  ctxPct: 90,
  ctxWindow: 10,
  quietWorkingMs: 20 * 60_000,
  quietToolMs: 5 * 60_000,
} as const;

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Held by the person, not by Claude: never part of a loop. */
const IGNORED_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

const hashOf = (tool: string, summary: string): string => createHash('sha1').update(tool).update('\0').update(summary).digest('hex').slice(0, 16);

interface Stream { lastHash?: string; repeat: number; failures: number }

export interface StuckDetector {
  /** Feed one machine input together with the record AFTER the reducer ran on it. Returns the flag the record should carry. */
  observe(input: MachineInput, next: Pick<SessionRecord, 'status' | 'ctx'>, now: number): StuckFlag | undefined;
  /** The current verdict without feeding anything (tests, debugging). */
  current(): StuckFlag | undefined;
}

export function createStuckDetector(): StuckDetector {
  const streams = new Map<string, Stream>();
  const recent: string[] = []; // tool names of the last tool starts, any agent
  const running = new Map<string, string>(); // toolUseId (or a counter key) -> tool, started and not finished
  let anon = 0;
  let ctxPct: number | null = null;
  let turnStart: number | undefined;
  let lastToolStart: number | undefined;
  let lastToolEnd: number | undefined;
  let workingSince: number | undefined; // last time the status became `working`
  let status: Status | undefined;
  let flag: StuckFlag | undefined;

  const stream = (agent: string | undefined): Stream => {
    const k = agent ?? '';
    let s = streams.get(k);
    if (s === undefined) { s = { repeat: 0, failures: 0 }; streams.set(k, s); }
    return s;
  };

  function resetTurn(): void {
    streams.clear();
    recent.length = 0;
    running.clear();
    turnStart = undefined;
    lastToolStart = undefined;
    lastToolEnd = undefined;
  }

  function toolStart(h: Extract<HookMachineInput, { event: 'PreToolUse' }>, now: number): void {
    if (IGNORED_TOOLS.has(h.tool)) return;
    const s = stream(h.agentId);
    const hash = hashOf(h.tool, h.summary);
    s.repeat = s.lastHash === hash ? s.repeat + 1 : 1;
    s.lastHash = hash;
    recent.push(h.tool);
    if (recent.length > STUCK_LIMITS.ctxWindow) recent.shift();
    running.set(h.toolUseId ?? `anon-${++anon}`, h.tool);
    lastToolStart = now;
    turnStart ??= now;
  }

  function toolEnd(h: { tool: string; toolUseId?: string; agentId?: string }, failed: boolean, interrupt: boolean, now: number): void {
    lastToolEnd = now;
    if (IGNORED_TOOLS.has(h.tool)) return;
    if (h.toolUseId !== undefined) running.delete(h.toolUseId);
    else for (const [k, tool] of running) if (tool === h.tool) { running.delete(k); break; }
    const s = stream(h.agentId);
    if (interrupt) { // S12: Esc during a tool is the person stopping Claude, never a failure and never a loop
      streams.clear();
      return;
    }
    s.failures = failed ? s.failures + 1 : 0;
  }

  function verdict(now: number): { reason: StuckReason } | undefined {
    for (const s of streams.values()) if (s.repeat >= STUCK_LIMITS.repeat) return { reason: 'repeat' };
    for (const s of streams.values()) if (s.failures >= STUCK_LIMITS.failures) return { reason: 'failures' };
    if (ctxPct !== null && ctxPct >= STUCK_LIMITS.ctxPct && recent.length >= STUCK_LIMITS.ctxWindow && !recent.some((t) => EDIT_TOOLS.has(t))) return { reason: 'ctx_no_progress' };
    if (status === 'working' && turnStart !== undefined && now - turnStart >= STUCK_LIMITS.quietWorkingMs) {
      const base = Math.max(lastToolStart ?? turnStart, lastToolEnd ?? 0, workingSince ?? 0);
      const bashRunning = [...running.values()].includes('Bash');
      if (!bashRunning && now - base >= STUCK_LIMITS.quietToolMs) return { reason: 'quiet' };
    }
    return undefined;
  }

  function settle(now: number): StuckFlag | undefined {
    const v = verdict(now);
    if (v === undefined) flag = undefined;
    else if (flag?.reason !== v.reason) flag = { reason: v.reason, since: now };
    return flag;
  }

  return {
    observe(input, next, now) {
      const prevStatus = status;
      status = next.status;
      if (next.status === 'working' && prevStatus !== 'working') workingSince = now;
      if (input.k === 'statusline' && input.ctx !== undefined) ctxPct = input.ctx.pct; // only a fresh reading counts (a stale record must not undo PostCompact)

      if (input.k === 'hook') {
        const h = input.hook;
        switch (h.event) {
          case 'UserPromptSubmit': resetTurn(); turnStart = now; workingSince = now; break;
          case 'PreToolUse': toolStart(h, now); break;
          case 'PostToolUse': toolEnd(h, false, false, now); break;
          case 'PostToolUseFailure': toolEnd(h, true, h.isInterrupt, now); break;
          case 'PostCompact': ctxPct = null; recent.length = 0; break; // a compaction is the answer to a full context
          case 'Stop': case 'StopFailure': case 'SessionEnd': resetTurn(); break;
          case 'SessionStart': if (h.source === 'clear' || h.source === 'compact') { resetTurn(); ctxPct = null; } break;
          default: break;
        }
      } else if (input.k === 'pty.exit' || input.k === 'daemon.restart') {
        resetTurn();
        ctxPct = null;
      }
      // The turn is over for anything that is not working or waiting on the person.
      if (next.status !== 'working' && next.status !== 'permission' && next.status !== 'question') resetTurn();
      return settle(now);
    },
    current: () => flag,
  };
}

export function sameStuck(a: StuckFlag | undefined, b: StuckFlag | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.reason === b.reason && a.since === b.since);
}
