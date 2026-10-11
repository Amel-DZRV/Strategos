// Tolerant types for Claude Code hook input and output bodies.
// Verified against https://code.claude.com/docs/en/hooks on 2026-10-11 (the page shows no "last updated" date;
// Claude Code 2.1.292). Every field except hook_event_name is optional because Claude Code may omit it or change it.

export type HookEventName =
  | 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'PermissionRequest' | 'Notification' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop'
  | 'PreCompact' | 'PostCompact' | 'CwdChanged';

export const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'CwdChanged',
];

export interface HookCommon {
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  scratchpad_dir?: string;
  permission_mode?: string; // default | plan | acceptEdits | auto | dontAsk | bypassPermissions
  effort?: { level?: string }; // object, only in tool-use-context events (C4)
  agent_id?: string;
  agent_type?: string;
  [extra: string]: unknown;
}

/** One entry of permission_suggestions / updatedPermissions. */
export interface PermissionUpdateEntry {
  type?: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories' | (string & {});
  rules?: { toolName?: string; ruleContent?: string }[];
  behavior?: 'allow' | 'deny' | 'ask' | (string & {});
  destination?: 'session' | 'localSettings' | 'projectSettings' | 'userSettings' | (string & {});
  [extra: string]: unknown;
}

export interface BackgroundTask { id?: string; type?: string; status?: string; description?: string; [extra: string]: unknown }

export type SessionStartInput = HookCommon & {
  hook_event_name: 'SessionStart';
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | (string & {});
  model?: string;
  session_title?: string;
  seconds_since_last_response?: number;
  context_tokens?: number;
  prompt_cache_likely_expired?: boolean;
  estimated_cache_write_usd?: number;
};
export type SessionEndInput = HookCommon & {
  hook_event_name: 'SessionEnd';
  reason?: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | (string & {});
};
export type UserPromptSubmitInput = HookCommon & { hook_event_name: 'UserPromptSubmit'; prompt?: string; session_title?: string };
export type PreToolUseInput = HookCommon & {
  hook_event_name: 'PreToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
};
export type PostToolUseInput = HookCommon & {
  hook_event_name: 'PostToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown; // shape depends on the tool
  duration_ms?: number;
};
export type PostToolUseFailureInput = HookCommon & {
  hook_event_name: 'PostToolUseFailure';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  error?: string; // for Bash the first line is usually "Exit code N"
  is_interrupt?: boolean;
  duration_ms?: number;
};
export type PermissionRequestInput = HookCommon & {
  hook_event_name: 'PermissionRequest';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: PermissionUpdateEntry[];
};
export type NotificationInput = HookCommon & {
  hook_event_name: 'Notification';
  message?: string;
  title?: string;
  notification_type?:
    | 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog' | 'elicitation_url_dialog'
    | 'elicitation_complete' | 'elicitation_response' | 'agent_needs_input' | 'agent_completed'
    | (string & {});
};
export type StopInput = HookCommon & {
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: BackgroundTask[];
  session_crons?: { id?: string; schedule?: string; recurring?: boolean; prompt?: string }[];
};
export type StopFailureInput = HookCommon & {
  hook_event_name: 'StopFailure';
  error?:
    | 'rate_limit' | 'overloaded' | 'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold'
    | 'billing_error' | 'invalid_request' | 'model_not_found' | 'server_error' | 'max_output_tokens'
    | 'cloud_credential_error' | 'unknown' | (string & {});
  error_details?: unknown;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
};
export type SubagentStartInput = HookCommon & { hook_event_name: 'SubagentStart' };
export type SubagentStopInput = HookCommon & {
  hook_event_name: 'SubagentStop';
  stop_hook_active?: boolean;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  background_tasks?: BackgroundTask[];
};
export type PreCompactInput = HookCommon & { hook_event_name: 'PreCompact'; trigger?: 'manual' | 'auto' | (string & {}); custom_instructions?: string | null };
export type PostCompactInput = HookCommon & { hook_event_name: 'PostCompact'; trigger?: 'manual' | 'auto' | (string & {}); compact_summary?: string };
export type CwdChangedInput = HookCommon & { hook_event_name: 'CwdChanged'; old_cwd?: string; new_cwd?: string };

export type HookInput =
  | SessionStartInput | SessionEndInput | UserPromptSubmitInput | PreToolUseInput | PostToolUseInput
  | PostToolUseFailureInput | PermissionRequestInput | NotificationInput | StopInput | StopFailureInput
  | SubagentStartInput | SubagentStopInput | PreCompactInput | PostCompactInput | CwdChangedInput;

// ---------------------------------------------------------------------------
// Response shapes (the JSON body of a 2xx hook response)
// ---------------------------------------------------------------------------

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask'; // docs also list 'defer' (non-interactive -p only; unused, V20)
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>; // replaces the whole tool input; AskUserQuestion: echo questions + add answers
    additionalContext?: string;
  };
}
export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>; // allow only
      updatedPermissions?: PermissionUpdateEntry[]; // allow only
      message?: string; // deny only
      interrupt?: boolean; // deny only
    };
  };
}
export interface PostToolUseOutput {
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?: { hookEventName: 'PostToolUse'; additionalContext?: string; updatedToolOutput?: unknown };
}
export type HookOutput = PreToolUseOutput | PermissionRequestOutput | PostToolUseOutput | Record<string, never>;

// ---------------------------------------------------------------------------
// Tolerant parser
// ---------------------------------------------------------------------------

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'stringOrNull';
const COMMON: Record<string, Kind> = {
  session_id: 'string', prompt_id: 'string', transcript_path: 'string', cwd: 'string', scratchpad_dir: 'string',
  permission_mode: 'string', effort: 'object', agent_id: 'string', agent_type: 'string',
};
const PER_EVENT: Record<HookEventName, Record<string, Kind>> = {
  SessionStart: { source: 'string', model: 'string', session_title: 'string', seconds_since_last_response: 'number', context_tokens: 'number', prompt_cache_likely_expired: 'boolean', estimated_cache_write_usd: 'number' },
  SessionEnd: { reason: 'string' },
  UserPromptSubmit: { prompt: 'string', session_title: 'string' },
  PreToolUse: { tool_name: 'string', tool_input: 'object', tool_use_id: 'string' },
  PostToolUse: { tool_name: 'string', tool_input: 'object', tool_use_id: 'string', duration_ms: 'number' },
  PostToolUseFailure: { tool_name: 'string', tool_input: 'object', tool_use_id: 'string', error: 'string', is_interrupt: 'boolean', duration_ms: 'number' },
  PermissionRequest: { tool_name: 'string', tool_input: 'object', permission_suggestions: 'array' },
  Notification: { message: 'string', title: 'string', notification_type: 'string' },
  Stop: { stop_hook_active: 'boolean', last_assistant_message: 'string', background_tasks: 'array', session_crons: 'array' },
  StopFailure: { error: 'string', last_assistant_message: 'string', stop_hook_active: 'boolean' },
  SubagentStart: {},
  SubagentStop: { stop_hook_active: 'boolean', agent_transcript_path: 'string', last_assistant_message: 'string', background_tasks: 'array' },
  PreCompact: { trigger: 'string', custom_instructions: 'stringOrNull' },
  PostCompact: { trigger: 'string', compact_summary: 'string' },
  CwdChanged: { old_cwd: 'string', new_cwd: 'string' },
};

function kindOk(v: unknown, k: Kind): boolean {
  switch (k) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'stringOrNull': return v === null || typeof v === 'string';
  }
}

export function isHookEventName(s: unknown): s is HookEventName {
  return typeof s === 'string' && (HOOK_EVENTS as readonly string[]).includes(s);
}

/**
 * Parse a hook request body. Never throws. `event` comes from the URL path and wins over body.hook_event_name.
 * Unknown extra fields pass through; known fields of the wrong type are dropped (tolerant, not strict).
 */
export type HookParseError = { error: string; hook_event_name?: undefined };

/** StopFailure/PostToolUseFailure inputs carry their own `error` field, so discriminate with this guard, not `"error" in r`. */
export function isHookParseError(r: HookInput | HookParseError): r is HookParseError {
  return r.hook_event_name === undefined;
}

export function parseHookBody(event: string, body: unknown): HookInput | HookParseError {
  try {
    if (!isHookEventName(event)) return { error: `unknown hook event: ${String(event).slice(0, 40)}` };
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'hook body must be a JSON object' };
    const src = body as Record<string, unknown>;
    const spec = { ...COMMON, ...PER_EVENT[event] };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (key === '__proto__') continue;
      const want = spec[key];
      if (want !== undefined && !kindOk(value, want)) continue;
      out[key] = value;
    }
    out['hook_event_name'] = event;
    return out as HookInput;
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'unparseable hook body' };
  }
}
