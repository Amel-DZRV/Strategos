import { describe, expect, test } from 'vitest';
import { HOOK_EVENTS, isHookParseError, parseHookBody } from './hooks.ts';
import type { HookEventName, PermissionRequestOutput, PreToolUseOutput } from './hooks.ts';

const common = { session_id: 's1', transcript_path: 'C:/t.jsonl', cwd: 'C:/r', permission_mode: 'default' };

const SAMPLES: Record<HookEventName, Record<string, unknown>> = {
  SessionStart: { source: 'clear', model: 'm' },
  SessionEnd: { reason: 'prompt_input_exit' },
  UserPromptSubmit: { prompt: 'hello' },
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', effort: { level: 'high' } },
  PostToolUse: { tool_name: 'Write', tool_input: {}, tool_use_id: 't', tool_response: { filePath: 'a', type: 'create' } },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: {}, tool_use_id: 't', error: 'Exit code 1', is_interrupt: false },
  PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'rm x' }, permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'rm x' }] }] },
  Notification: { message: 'needs input', notification_type: 'permission_prompt' },
  Stop: { stop_hook_active: false, last_assistant_message: 'done?' },
  StopFailure: { error: 'rate_limit', last_assistant_message: 'API Error' },
  SubagentStart: { agent_id: 'a1', agent_type: 'Explore' },
  SubagentStop: { agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: 'x' },
  PreCompact: { trigger: 'manual', custom_instructions: null },
  PostCompact: { trigger: 'auto', compact_summary: 'sum' },
  CwdChanged: { old_cwd: 'a', new_cwd: 'b' },
};

describe('parseHookBody', () => {
  for (const ev of HOOK_EVENTS) {
    test(`parses ${ev}`, () => {
      const r = parseHookBody(ev, { ...common, hook_event_name: ev, ...SAMPLES[ev] });
      expect(isHookParseError(r)).toBe(false);
      if (!isHookParseError(r)) {
        expect(r.hook_event_name).toBe(ev);
        expect(r.session_id).toBe('s1');
        for (const [k, v] of Object.entries(SAMPLES[ev])) expect((r as Record<string, unknown>)[k]).toEqual(v);
      }
    });
  }

  test('url event wins over body; unknown extras pass through', () => {
    const r = parseHookBody('Stop', { hook_event_name: 'PreToolUse', future_field: 1 });
    expect(r).toMatchObject({ hook_event_name: 'Stop', future_field: 1 });
  });

  test('wrong-typed known fields are dropped, never thrown', () => {
    const r = parseHookBody('PreToolUse', { session_id: 5, tool_name: 'Bash', tool_input: 'oops', effort: 'high' });
    expect(r).toEqual({ tool_name: 'Bash', hook_event_name: 'PreToolUse' });
  });

  test('errors', () => {
    expect(parseHookBody('Bogus', {})).toHaveProperty('error');
    expect(parseHookBody('Stop', null)).toHaveProperty('error');
    expect(parseHookBody('Stop', [])).toHaveProperty('error');
    expect(parseHookBody('Stop', 'x')).toHaveProperty('error');
    expect(parseHookBody('__proto__', {})).toHaveProperty('error');
    expect(parseHookBody('Stop', JSON.parse('{"__proto__": {"x": 1}}'))).not.toHaveProperty('x');
  });
});

describe('response shapes', () => {
  test('compile-time shapes', () => {
    const pre = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { answers: {} } } } satisfies PreToolUseOutput;
    const perm = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no', interrupt: false } } } satisfies PermissionRequestOutput;
    expect(pre.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(perm.hookSpecificOutput.decision.behavior).toBe('deny');
  });
});
