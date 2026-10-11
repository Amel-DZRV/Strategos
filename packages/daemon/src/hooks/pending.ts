// The pending registry (plan section 4.1, D13, D21, rule 8).
//
// A "held" request is a hook HTTP request whose response we keep open until the owner decides. This file owns those open
// responses and nothing else: whether a session is in `permission` or `question` is the reducer's business. The two meet
// through two seams:
//   - the injected `dispatch(sid, input)` feeds a MachineInput to the reducer (and applies its non-hook effects) and
//     returns the effects it produced;
//   - `applyEffects(sid, effects)` takes those effects back and carries out the two that concern us: `hook.respond`
//     (resolve the right held response) and `audit` (append to audit.jsonl with the entry's details and connId).
//
// Facts from the spike ([ran], spike/REPORT.md):
//   - Answering Yes in the TUI does NOT close our held request; Esc in the TUI DOES (the connection closes with
//     res.writableFinished === false). So "client closed" means cancelled-in-terminal, while an "answered in the TUI" request
//     is released by evidence (PostToolUse, Stop, ...) through the reducer's `hook.respond no_decision`.
//   - AskUserQuestion is answered through PreToolUse (permissionDecision allow + updatedInput {questions, answers}), never
//     through a bare allow.
//   - "always" passes the chosen permission_suggestions entry back verbatim as updatedPermissions.
// Nothing here ever allows anything by itself: every allow comes from a UI decision that reached `decide`.
import type { ServerResponse } from 'node:http';
import type { Decision, Effect, MachineInput, Pending } from '@strategos/shared';
import type { AuditEntry, AuditLog, AuditVia } from '../store/audit-log.ts';

export const DEFAULT_HOLD_TIMEOUT_SEC = 86_400;
export const DEFAULT_RELEASE_MARGIN_SEC = 30;

export type ReleaseWhy = 'terminal-focus' | 'user' | 'expiry' | 'shutdown';

export type DecisionError = 'not_found' | 'answers_required' | 'not_a_question' | 'rejected';
export type Result = { ok: true } | { ok: false; error: DecisionError };

/** What the registry needs from a held HTTP response. `responderFromRes` adapts a ServerResponse. */
export interface HookResponder {
  /** Send 200 with a JSON body, or an empty 200 for `null` (= no decision). False when the client is already gone. */
  respond(body: Record<string, unknown> | null): boolean;
  /** Called once if the CLIENT closed the connection before we answered. */
  onClientClose(cb: () => void): void;
  readonly open: boolean;
}

/**
 * Node detail ([ran]): detect the disconnect on the response/socket 'close' with `!res.writableFinished`.
 * `req` 'close' fires as soon as the request body was read, so it says nothing about the client.
 */
export function responderFromRes(res: ServerResponse): HookResponder {
  let ended = false;
  let gone = false;
  const cbs: (() => void)[] = [];
  const onClose = (): void => {
    if (ended || gone || res.writableFinished) return;
    gone = true;
    for (const cb of cbs.splice(0)) cb();
  };
  res.once('close', onClose);
  res.socket?.once('close', onClose);
  return {
    get open() {
      return !ended && !gone && !res.destroyed;
    },
    respond(body) {
      if (ended || gone || res.destroyed) return false;
      ended = true;
      if (body === null) {
        res.writeHead(200, { 'Content-Length': '0' }).end();
      } else {
        const text = JSON.stringify(body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) }).end(text);
      }
      return true;
    },
    onClientClose(cb) {
      if (gone) cb();
      else cbs.push(cb);
    },
  };
}

export interface HeldMeta {
  /** PreToolUse is only held for AskUserQuestion. */
  event: 'PermissionRequest' | 'PreToolUse';
  /** The full tool_input. Kept in memory only (D21); never logged. */
  fullInput: Record<string, unknown>;
  claudeSessionId?: string;
}

export interface FullRequest {
  sid: string;
  requestId: string;
  event: HeldMeta['event'];
  toolName: string;
  toolInput: Record<string, unknown>;
  pending: Pending;
}

export interface PendingRegistryDeps {
  dispatch: (sid: string, input: MachineInput) => Effect[];
  audit?: Pick<AuditLog, 'append'>;
  now?: () => number;
  holdTimeoutSec?: number;
  releaseMarginSec?: number;
  /** Called when writing the audit line fails. */
  onError?: (err: unknown) => void;
}

export interface PendingRegistry {
  hold(sid: string, p: Pending, res: HookResponder, meta: HeldMeta): void;
  /** `meta.connId` is the UI connection that decided; it lands in the audit log. */
  decide(sid: string, requestId: string, d: Decision, meta?: { connId?: string }): Result;
  release(sid: string, requestId: string, why: ReleaseWhy, meta?: { connId?: string }): Result;
  /** The client closed the connection: answered or cancelled in the TUI (Esc). */
  onClosed(sid: string, requestId: string): void;
  /** Carry out `hook.respond` and `audit` effects. Call this with the effects of EVERY dispatch (the receiver does for hooks). */
  applyEffects(sid: string, effects: readonly Effect[]): void;
  /** The full tool input of a held request, for the UI's full card (D21). */
  getFull(sid: string, requestId: string): FullRequest | undefined;
  has(sid: string, requestId: string): boolean;
  /** The auto-release time for a request held now: hook timeout minus the margin. */
  defaultExpiry(): number;
  /** The reducer did not take this request: answer it with an empty 200 (no decision) without a reducer input. */
  abandon(sid: string, requestId: string): void;
  /** Release every held request of one session without a decision (session forgotten). No reducer input. */
  dropSession(sid: string): void;
  /** Shutdown: dispatch a `release shutdown` for each, then answer anything left with an empty 200. */
  releaseAll(): void;
  readonly size: number;
}

interface Held {
  sid: string;
  requestId: string;
  p: Pending;
  meta: HeldMeta;
  res: HookResponder;
  timer: NodeJS.Timeout | undefined;
  connId: string | undefined;
  done: boolean;
}

// ---------------------------------------------------------------------------
// Response bodies. Shapes: packages/shared/src/hooks.ts and fixtures/claude/2.1.292/hooks/RESPONSE-*.json
// ---------------------------------------------------------------------------

type BodyOrNull = Record<string, unknown> | null;

/** Pure: the JSON for a held request, or null for "no decision" (an empty 200). */
export function buildHookResponse(
  event: HeldMeta['event'],
  response: 'allow' | 'deny' | 'always' | 'answers' | 'no_decision',
  d: Decision | undefined,
  fullInput: Record<string, unknown>,
  suggestions: readonly unknown[] | undefined,
): BodyOrNull {
  if (response === 'no_decision') return null;
  if (event === 'PreToolUse') {
    // AskUserQuestion: only an answer (or a decline) means anything here.
    if (response === 'answers' && d?.kind === 'answers') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...fullInput, answers: d.answers },
        },
      };
    }
    if (response === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: (d?.kind === 'deny' ? d.message : undefined) ?? 'Declined in Strategos',
        },
      };
    }
    return null;
  }
  // PermissionRequest
  if (response === 'deny') {
    const message = d?.kind === 'deny' ? d.message : undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', ...(message !== undefined && message !== '' ? { message } : {}) },
      },
    };
  }
  if (response === 'answers' && d?.kind === 'answers') {
    // The second request AskUserQuestion raises after its PreToolUse was released. [inf] Not exercised against real Claude:
    // the documented path is PreToolUse; this is the same updatedInput on the PermissionRequest.
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...fullInput, answers: d.answers } },
      },
    };
  }
  if (response === 'always') {
    const i = d?.kind === 'always' ? (d.suggestionIndex ?? 0) : 0;
    const suggestion = suggestions?.[i];
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', ...(suggestion !== undefined ? { updatedPermissions: [suggestion] } : {}) },
      },
    };
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
}

export function createPendingRegistry(deps: PendingRegistryDeps): PendingRegistry {
  const now = deps.now ?? Date.now;
  const holdSec = deps.holdTimeoutSec ?? DEFAULT_HOLD_TIMEOUT_SEC;
  const marginSec = deps.releaseMarginSec ?? DEFAULT_RELEASE_MARGIN_SEC;
  const held = new Map<string, Held>(); // by requestId

  const defaultExpiry = (): number => now() + Math.max(0, holdSec - marginSec) * 1000;

  function finish(h: Held): void {
    h.done = true;
    if (h.timer !== undefined) clearTimeout(h.timer);
    h.timer = undefined;
  }

  function sweep(): void {
    for (const [id, h] of held) if (h.done) held.delete(id);
  }

  function auditLine(h: Held, decision: AuditEntry['decision'], via: string): void {
    if (deps.audit === undefined) return;
    const entry: Omit<AuditEntry, 'ts'> = {
      sid: h.sid,
      requestId: h.requestId,
      tool: h.p.toolName,
      inputSummary: h.p.inputSummary,
      risk: h.p.risk,
      decision,
      via: via as AuditVia,
      ...(h.meta.claudeSessionId === undefined ? {} : { claudeSessionId: h.meta.claudeSessionId }),
      ...(h.connId === undefined ? {} : { connId: h.connId }),
    };
    deps.audit.append(entry).catch((err: unknown) => deps.onError?.(err));
  }

  function applyEffects(sid: string, effects: readonly Effect[]): void {
    for (const fx of effects) {
      if (fx.e === 'hook.respond') {
        const h = held.get(fx.requestId);
        if (h === undefined || h.sid !== sid || h.done) continue;
        const body = buildHookResponse(h.meta.event, fx.response, fx.decision, h.meta.fullInput, h.p.suggestions);
        finish(h);
        h.res.respond(body);
      } else if (fx.e === 'audit') {
        const h = held.get(fx.requestId);
        if (h !== undefined && h.sid === sid) auditLine(h, fx.decision, fx.via);
      }
    }
    sweep();
  }

  function validate(h: Held, d: Decision): DecisionError | null {
    if (h.meta.event === 'PreToolUse' && (d.kind === 'allow' || d.kind === 'always')) return 'answers_required'; // "allow alone is not sufficient"
    if (d.kind === 'answers' && h.p.kind !== 'question') return 'not_a_question';
    return null;
  }

  /** The reducer did not take the request (or took it back): never leave a response dangling. */
  function orphan(h: Held): void {
    if (h.done) return;
    finish(h);
    h.res.respond(null);
    sweep();
  }

  const self: PendingRegistry = {
    hold(sid, p, res, meta) {
      const h: Held = { sid, requestId: p.requestId, p, meta, res, timer: undefined, connId: undefined, done: false };
      held.set(p.requestId, h);
      const expiresAt = p.expiresAt ?? defaultExpiry();
      const t = setTimeout(() => {
        h.timer = undefined;
        self.release(sid, p.requestId, 'expiry');
      }, Math.max(0, expiresAt - now()));
      t.unref();
      h.timer = t;
      res.onClientClose(() => self.onClosed(sid, p.requestId));
    },

    decide(sid, requestId, d, meta) {
      const h = held.get(requestId);
      if (h === undefined || h.sid !== sid || h.done) return { ok: false, error: 'not_found' };
      const bad = validate(h, d);
      if (bad !== null) return { ok: false, error: bad };
      h.connId = meta?.connId;
      applyEffects(sid, deps.dispatch(sid, { k: 'user', u: { cmd: 'decide', requestId, decision: d } }));
      if (h.done) return { ok: true };
      orphan(h);
      return { ok: false, error: 'rejected' };
    },

    release(sid, requestId, why, meta) {
      const h = held.get(requestId);
      if (h === undefined || h.sid !== sid || h.done) return { ok: false, error: 'not_found' };
      h.connId = meta?.connId;
      applyEffects(sid, deps.dispatch(sid, { k: 'user', u: { cmd: 'release', requestId, why } }));
      if (h.done) return { ok: true };
      orphan(h);
      return { ok: false, error: 'rejected' };
    },

    onClosed(sid, requestId) {
      const h = held.get(requestId);
      if (h === undefined || h.sid !== sid || h.done) return;
      finish(h);
      applyEffects(sid, deps.dispatch(sid, { k: 'hold.closed', requestId }));
    },

    applyEffects,

    getFull(sid, requestId) {
      const h = held.get(requestId);
      if (h === undefined || h.sid !== sid || h.done) return undefined;
      return { sid, requestId, event: h.meta.event, toolName: h.p.toolName, toolInput: h.meta.fullInput, pending: h.p };
    },

    has(sid, requestId) {
      const h = held.get(requestId);
      return h !== undefined && h.sid === sid && !h.done;
    },

    defaultExpiry,

    abandon(sid, requestId) {
      const h = held.get(requestId);
      if (h !== undefined && h.sid === sid) orphan(h);
    },

    dropSession(sid) {
      for (const h of [...held.values()]) if (h.sid === sid) orphan(h);
    },

    releaseAll() {
      for (const h of [...held.values()]) {
        if (h.done) continue;
        try {
          self.release(h.sid, h.requestId, 'shutdown');
        } catch (err) {
          deps.onError?.(err);
        }
        orphan(h);
      }
    },

    get size() {
      let n = 0;
      for (const h of held.values()) if (!h.done) n++;
      return n;
    },
  };
  return self;
}
