// The hook receiver (plan section 4 `hooks/receiver`, section 6, section 10).
//
//   http.ts (auth, caps, JSON)  ->  receiver  ->  parseHookBody  ->  HookMachineInput  ->  dispatch (reducer)
//                                                                  \-> PendingRegistry (held events)
//
// Rules this file keeps:
//   - It never answers a hook with a decision unless a UI decision (through the registry) or a guard deny produced it.
//     Everything else is an empty 200 = no decision = the normal TUI dialog.
//   - Held events: PermissionRequest (any tool) and PreToolUse for AskUserQuestion. The request is registered in the
//     registry BEFORE the reducer sees it, so effects that refer to it (supersede, release on evidence) can resolve it.
//   - One PreToolUse "*" hook arrives for every tool (the settings file has a single URL), so the receiver decides by
//     tool_name: AskUserQuestion is held, every other tool goes to `checkGuards`, which can only deny.
//   - Fail open: a throwing reducer, guard or classifier ends in an empty 200, never in a hung or approving response.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  isHookParseError, parseHookBody,
  type Effect, type HookInput, type HookMachineInput, type MachineInput, type Pending, type PendingQuestion,
  type PermissionRequestInput, type PreToolUseInput, type RiskClass,
} from '@strategos/shared';
import type { AuditLog } from '../store/audit-log.ts';
import { testResultOf } from '../git/test-detect.ts';
import { reply } from '../server/guards.ts';
import { responderFromRes, type PendingRegistry } from './pending.ts';

export const SUMMARY_MAX = 400;

export type GuardVerdict = { deny: false } | { deny: true; ruleId: string; reason: string };

export interface ReceiverDeps {
  registry: PendingRegistry;
  /** Feed the reducer (and apply its non-hook effects); returns the effects it produced. */
  dispatch: (sid: string, input: MachineInput) => Effect[];
  /** Guards (task 4.04). PreToolUse for non-AskUserQuestion tools only. Guards only ever deny. */
  checkGuards?: (sid: string, ev: PreToolUseInput) => GuardVerdict;
  /** Risk classes of a tool call (task 4.03). Default: none. */
  classifyRisk?: (sid: string, tool: string, input: Record<string, unknown>) => RiskClass[];
  /** Task 6.04: compiled config.portable.testCommandPatterns. A matching Bash command that finishes sets flags.lastTest. */
  testPatterns?: () => readonly RegExp[];
  audit?: Pick<AuditLog, 'append'>;
  /** A guard denied a tool call (task 4.04 counts these in `flags.guardDenials`). */
  onGuardDeny?: (sid: string, info: { ruleId: string; reason: string; tool: string; requestId: string }) => void;
  /**
   * Task 5.06 / D9: called for every PostToolUse after the reducer saw it. A returned string goes back to Claude as the
   * hook's `additionalContext` (a short plain note); undefined keeps the empty 200.
   */
  onPostToolUse?: (sid: string, ev: { tool: string; toolInput: Record<string, unknown> | undefined; toolUseId?: string; agentId?: string }) => string | undefined;
  onError?: (err: unknown, where: string) => void;
  now?: () => number;
  newRequestId?: () => string;
}

export interface HookReceiver {
  /** Plug into `server.setHookHandler`. */
  handle: (sid: string, event: string, body: unknown, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Forget per-session memory (the last PreToolUse). */
  forget(sid: string): void;
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function rawSummary(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': return str(i['command']) ?? JSON.stringify(i);
    case 'Edit': case 'Write': case 'MultiEdit': case 'Read':
      return str(i['file_path']) ?? JSON.stringify(i);
    case 'NotebookEdit': return str(i['notebook_path']) ?? str(i['file_path']) ?? JSON.stringify(i);
    case 'WebFetch': return str(i['url']) ?? JSON.stringify(i);
    case 'WebSearch': return str(i['query']) ?? JSON.stringify(i);
    case 'Grep': case 'Glob': return str(i['pattern']) ?? JSON.stringify(i);
    case 'Task': case 'Agent': return str(i['description']) ?? str(i['prompt']) ?? JSON.stringify(i);
    case 'AskUserQuestion': {
      const q = Array.isArray(i['questions']) ? (i['questions'][0] as { question?: unknown } | undefined) : undefined;
      return str(q?.question) ?? 'A question';
    }
    default: return Object.keys(i).length === 0 ? tool : JSON.stringify(i);
  }
}

/** <= 400 chars, plus whether anything was cut (D21: a cut summary forces the full card before Approve). */
export function summarise(tool: string, input: Record<string, unknown> | undefined): { text: string; truncated: boolean } {
  const text = rawSummary(tool, input);
  return text.length > SUMMARY_MAX ? { text: text.slice(0, SUMMARY_MAX), truncated: true } : { text, truncated: false };
}

function questionsOf(input: Record<string, unknown> | undefined): PendingQuestion[] | undefined {
  const raw = input?.['questions'];
  if (!Array.isArray(raw)) return undefined;
  const out: PendingQuestion[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (typeof q !== 'object' || q === null) continue;
    const options = Array.isArray(q['options'])
      ? (q['options'] as Record<string, unknown>[]).flatMap((o) =>
        typeof o?.['label'] === 'string'
          ? [{ label: o['label'], ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}) }]
          : [])
      : [];
    out.push({
      question: str(q['question']) ?? '',
      ...(typeof q['header'] === 'string' ? { header: q['header'] } : {}),
      ...(typeof q['multiSelect'] === 'boolean' ? { multiSelect: q['multiSelect'] } : {}),
      options,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the receiver
// ---------------------------------------------------------------------------

export function createHookReceiver(deps: ReceiverDeps): HookReceiver {
  const now = deps.now ?? Date.now;
  const newId = deps.newRequestId ?? randomUUID;
  const onError = deps.onError ?? ((): void => undefined);
  /** The last PreToolUse of each session: PermissionRequest bodies carry no tool_use_id, the PreToolUse before them does. */
  const lastPre = new Map<string, { tool: string; inputJson: string; toolUseId: string }>();

  function base(h: HookInput): Record<string, unknown> {
    return {
      ...(h.session_id === undefined ? {} : { claudeSessionId: h.session_id }),
      ...(h.agent_id === undefined || h.agent_id === '' ? {} : { agentId: h.agent_id }),
      ...(h.agent_type === undefined || h.agent_type === '' ? {} : { agentType: h.agent_type }),
      ...(h.cwd === undefined ? {} : { cwd: h.cwd }),
      ...(h.permission_mode === undefined ? {} : { permissionMode: h.permission_mode }),
      ...(h.effort?.level === undefined ? {} : { effort: h.effort.level }),
      ...(h.transcript_path === undefined ? {} : { transcriptPath: h.transcript_path }),
    };
  }

  interface Normalised {
    input: HookMachineInput;
    held?: { pending: Pending; event: 'PermissionRequest' | 'PreToolUse'; fullInput: Record<string, unknown> };
  }

  function makePending(sid: string, o: {
    kind: Pending['kind']; held: boolean; tool: string; toolUseId?: string; agentId?: string;
    input: Record<string, unknown>; suggestions?: unknown[];
  }): Pending {
    const s = summarise(o.tool, o.input);
    let risk: RiskClass[] = []; // TODO(4.03): the real classifier (features/risk.ts) is injected as deps.classifyRisk
    try {
      risk = deps.classifyRisk?.(sid, o.tool, o.input) ?? [];
    } catch (err) {
      onError(err, 'classifyRisk');
    }
    const at = now();
    return {
      requestId: newId(),
      kind: o.kind,
      held: o.held,
      toolName: o.tool,
      ...(o.toolUseId === undefined ? {} : { toolUseId: o.toolUseId }),
      ...(o.agentId === undefined ? {} : { agentId: o.agentId }),
      inputSummary: s.text,
      inputTruncated: s.truncated,
      risk,
      ...(o.suggestions === undefined ? {} : { suggestions: o.suggestions }),
      ...(o.kind === 'question' ? (() => { const q = questionsOf(o.input); return q === undefined ? {} : { questions: q }; })() : {}),
      since: at,
      ...(o.held ? { expiresAt: deps.registry.defaultExpiry() } : {}),
    };
  }

  function normalise(sid: string, h: HookInput): Normalised {
    const b = base(h);
    const agentId = typeof b['agentId'] === 'string' ? b['agentId'] : undefined;
    switch (h.hook_event_name) {
      case 'SessionStart':
        return { input: { ...b, event: 'SessionStart', source: h.source ?? 'startup', ...(h.model === undefined ? {} : { model: h.model }) } as HookMachineInput };
      case 'SessionEnd':
        return { input: { ...b, event: 'SessionEnd', reason: h.reason ?? 'other' } as HookMachineInput };
      case 'UserPromptSubmit':
        return { input: { ...b, event: 'UserPromptSubmit' } as HookMachineInput };
      case 'PreToolUse': {
        const tool = h.tool_name ?? 'unknown';
        const input = h.tool_input ?? {};
        if (h.tool_use_id !== undefined) lastPre.set(sid, { tool, inputJson: JSON.stringify(input), toolUseId: h.tool_use_id });
        const s = summarise(tool, input);
        if (tool === 'AskUserQuestion') {
          const pending = makePending(sid, { kind: 'question', held: true, tool, toolUseId: h.tool_use_id, agentId, input });
          return {
            input: { ...b, event: 'PreToolUse', tool, ...(h.tool_use_id === undefined ? {} : { toolUseId: h.tool_use_id }), summary: s.text, pending } as HookMachineInput,
            held: { pending, event: 'PreToolUse', fullInput: input },
          };
        }
        return { input: { ...b, event: 'PreToolUse', tool, ...(h.tool_use_id === undefined ? {} : { toolUseId: h.tool_use_id }), summary: s.text } as HookMachineInput };
      }
      case 'PostToolUse': {
        const tool = h.tool_name ?? 'unknown';
        const testResult = deps.testPatterns === undefined ? undefined : testResultOf(deps.testPatterns(), h);
        return { input: { ...b, event: 'PostToolUse', tool, ...(h.tool_use_id === undefined ? {} : { toolUseId: h.tool_use_id }), summary: summarise(tool, h.tool_input).text, ...(testResult === undefined ? {} : { testResult }) } as HookMachineInput };
      }
      case 'PostToolUseFailure': {
        const tool = h.tool_name ?? 'unknown';
        const testResult = deps.testPatterns === undefined ? undefined : testResultOf(deps.testPatterns(), h);
        return {
          input: {
            ...b, event: 'PostToolUseFailure', tool, isInterrupt: h.is_interrupt === true, ...(testResult === undefined ? {} : { testResult }),
            ...(h.tool_use_id === undefined ? {} : { toolUseId: h.tool_use_id }),
            summary: summarise(tool, h.tool_input).text,
            ...(h.error === undefined ? {} : { error: h.error.slice(0, SUMMARY_MAX) }),
          } as HookMachineInput,
        };
      }
      case 'PermissionRequest': {
        const p: PermissionRequestInput = h;
        const tool = p.tool_name ?? 'unknown';
        const input = p.tool_input ?? {};
        const pre = lastPre.get(sid);
        const toolUseId = pre !== undefined && pre.tool === tool && pre.inputJson === JSON.stringify(input) ? pre.toolUseId : undefined;
        const pending = makePending(sid, {
          kind: tool === 'AskUserQuestion' ? 'question' : 'permission', held: true, tool, toolUseId, agentId, input,
          ...(p.permission_suggestions === undefined ? {} : { suggestions: p.permission_suggestions }),
        });
        return { input: { ...b, event: 'PermissionRequest', pending } as HookMachineInput, held: { pending, event: 'PermissionRequest', fullInput: input } };
      }
      case 'Notification': {
        const type = h.notification_type;
        const message = h.message;
        // elicitation_dialog is a question we cannot answer from here: not held (answer in terminal).
        if (type === 'elicitation_dialog') {
          const pending = makePending(sid, { kind: 'question', held: false, tool: 'elicitation', input: { message: message ?? '' } });
          pending.inputSummary = (message ?? 'A question is waiting').slice(0, SUMMARY_MAX);
          pending.inputTruncated = (message ?? '').length > SUMMARY_MAX;
          return { input: { ...b, event: 'Notification', ...(type === undefined ? {} : { notificationType: type }), ...(message === undefined ? {} : { message }), pending } as HookMachineInput };
        }
        return { input: { ...b, event: 'Notification', ...(type === undefined ? {} : { notificationType: type }), ...(message === undefined ? {} : { message }) } as HookMachineInput };
      }
      case 'Stop':
        return { input: { ...b, event: 'Stop', ...(h.last_assistant_message === undefined ? {} : { lastMessage: h.last_assistant_message }) } as HookMachineInput };
      case 'StopFailure':
        return { input: { ...b, event: 'StopFailure', ...(h.error === undefined ? {} : { error: h.error }), ...(h.last_assistant_message === undefined ? {} : { lastMessage: h.last_assistant_message }) } as HookMachineInput };
      case 'SubagentStart':
        return { input: { ...b, event: 'SubagentStart' } as HookMachineInput };
      case 'SubagentStop':
        return { input: { ...b, event: 'SubagentStop' } as HookMachineInput };
      case 'PreCompact':
        return { input: { ...b, event: 'PreCompact' } as HookMachineInput };
      case 'PostCompact':
        return { input: { ...b, event: 'PostCompact' } as HookMachineInput };
      case 'CwdChanged':
        return { input: { ...b, event: 'CwdChanged', ...(h.new_cwd === undefined ? {} : { newCwd: h.new_cwd }) } as HookMachineInput };
    }
  }

  const answeredNotify = (fx: readonly Effect[], requestId: string): boolean =>
    fx.some((e) => e.e === 'notify' && e.requestId === requestId);

  function guard(sid: string, h: PreToolUseInput, res: ServerResponse): boolean {
    if (deps.checkGuards === undefined) return false;
    let v: GuardVerdict;
    try {
      v = deps.checkGuards(sid, h);
    } catch (err) {
      onError(err, 'checkGuards'); // fail open
      return false;
    }
    if (!v.deny) return false;
    const tool = h.tool_name ?? 'unknown';
    const requestId = h.tool_use_id ?? newId();
    const summary = summarise(tool, h.tool_input);
    deps.audit?.append({
      sid, ...(h.session_id === undefined ? {} : { claudeSessionId: h.session_id }), requestId, tool,
      inputSummary: summary.text, risk: [], decision: 'deny', via: 'guard',
    }).catch((err: unknown) => onError(err, 'audit'));
    try {
      deps.onGuardDeny?.(sid, { ruleId: v.ruleId, reason: v.reason, tool, requestId });
    } catch (err) {
      onError(err, 'onGuardDeny');
    }
    const body = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }).end(body);
    return true;
  }

  async function handle(sid: string, event: string, body: unknown, _req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = parseHookBody(event, body);
    if (isHookParseError(parsed)) {
      reply(res, parsed.error.startsWith('unknown hook event') ? 404 : 400);
      return;
    }
    let n: Normalised;
    try {
      n = normalise(sid, parsed);
    } catch (err) {
      onError(err, 'normalise');
      reply(res, 200);
      return;
    }

    if (n.held !== undefined) {
      const { pending, event: heldEvent, fullInput } = n.held;
      deps.registry.hold(sid, pending, responderFromRes(res), {
        event: heldEvent, fullInput, ...(parsed.session_id === undefined ? {} : { claudeSessionId: parsed.session_id }),
      });
      try {
        const fx = deps.dispatch(sid, { k: 'hook', hook: n.input });
        deps.registry.applyEffects(sid, fx);
        // The reducer takes a request by raising a `notify` for it. Anything else (a stopped record, a stale request) is
        // answered with no decision so the TUI shows its own dialog.
        if (!answeredNotify(fx, pending.requestId)) deps.registry.abandon(sid, pending.requestId);
      } catch (err) {
        onError(err, 'dispatch');
        deps.registry.abandon(sid, pending.requestId);
      }
      return;
    }

    try {
      deps.registry.applyEffects(sid, deps.dispatch(sid, { k: 'hook', hook: n.input }));
    } catch (err) {
      onError(err, 'dispatch');
    }
    if (parsed.hook_event_name === 'SessionEnd') lastPre.delete(sid);
    if (parsed.hook_event_name === 'PreToolUse' && guard(sid, parsed, res)) return;
    if (parsed.hook_event_name === 'PostToolUse' && deps.onPostToolUse !== undefined) {
      let note: string | undefined;
      try {
        const agentId = typeof parsed.agent_id === 'string' && parsed.agent_id !== '' ? parsed.agent_id : undefined;
        note = deps.onPostToolUse(sid, {
          tool: parsed.tool_name ?? 'unknown', toolInput: parsed.tool_input,
          ...(parsed.tool_use_id === undefined ? {} : { toolUseId: parsed.tool_use_id }),
          ...(agentId === undefined ? {} : { agentId }),
        });
      } catch (err) {
        onError(err, 'onPostToolUse'); // fail open: the empty 200
      }
      if (note !== undefined && note !== '') {
        const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(out)) }).end(out);
        return;
      }
    }
    reply(res, 200); // empty 200 = no decision
  }

  return {
    handle,
    forget(sid) {
      lastPre.delete(sid);
    },
  };
}
