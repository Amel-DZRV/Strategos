// Scenario data for tools/fake-claude.ts. Pure JSON-compatible data, so a scenario can also be a .json file
// (FAKE_CLAUDE_SCRIPT=<name or path>). Strings may use {{prompt}}, {{sessionId}}, {{cwd}}, {{transcript}}, {{answers}}.

export type Step =
  | { op: 'print'; text: string }
  | { op: 'sleep'; ms: number }
  /** POST a hook to every configured http hook that matches (event, tool). Waits for the responses, ignores them. */
  | { op: 'hook'; event: string; tool?: string; input?: Record<string, unknown>; toolId?: string; agentId?: string; body?: Record<string, unknown> }
  /** POST and wait for a decision (PermissionRequest / PreToolUse). Falls back to a keypress in the terminal. */
  | { op: 'hold'; event: 'PermissionRequest' | 'PreToolUse'; tool: string; input: Record<string, unknown>; toolId?: string; agentId?: string; onAllow?: Step[]; onDeny?: Step[] }
  /** Append a transcript record. With `agentId` it goes to that subagent's file. */
  | { op: 'tx'; kind: 'user' | 'assistant' | 'toolUse' | 'toolResult' | 'interrupt'; text?: string; tool?: string; input?: Record<string, unknown>; toolId?: string; content?: string; isError?: boolean; agentId?: string; toolInterrupt?: boolean }
  | { op: 'status'; status: string; waitingFor?: string }
  /** Same as the user typing /clear: SessionEnd(clear), new session id, SessionStart(clear). */
  | { op: 'clear' }
  /** Block until the user presses Esc or Ctrl+C (throws Interrupted) or the timeout passes. */
  | { op: 'waitInterrupt'; timeoutMs?: number }
  /** Exit. Without `sessionEnd` no SessionEnd hook is posted (a crash). */
  | { op: 'exit'; code: number; sessionEnd?: string };

export interface Scenario {
  /** Print a workspace-trust dialog and wait for Enter before SessionStart (hooks are silent until trust, V10). */
  trust?: boolean;
  /** Steps for the n-th submitted prompt; the last entry repeats. */
  turns: Step[][];
}

const toolTurn = (tool: string, input: Record<string, unknown>, reply: string): Step[] => [
  { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
  { op: 'tx', kind: 'user', text: '{{prompt}}' },
  { op: 'status', status: 'busy' },
  { op: 'print', text: '\r\n\x1b[2m* Thinking...\x1b[0m\r\n' },
  { op: 'tx', kind: 'toolUse', tool, input, toolId: 't1' },
  { op: 'hook', event: 'PreToolUse', tool, input, toolId: 't1' },
  { op: 'print', text: `\x1b[32m*\x1b[0m ${tool}(${JSON.stringify(input).slice(0, 60)})\r\n` },
  { op: 'hook', event: 'PostToolUse', tool, input, toolId: 't1', body: { tool_response: { ok: true }, duration_ms: 12 } },
  { op: 'tx', kind: 'toolResult', toolId: 't1', content: 'ok' },
  { op: 'tx', kind: 'assistant', text: reply },
  { op: 'print', text: `\x1b[32m*\x1b[0m ${reply}\r\n` },
  { op: 'status', status: 'idle' },
  { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: reply } },
];

const plain: Scenario = { turns: [toolTurn('Read', { file_path: 'README.md' }, 'Fake reply to: {{prompt}}')] };

const permissionTurn: Step[] = [
  { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
  { op: 'tx', kind: 'user', text: '{{prompt}}' },
  { op: 'status', status: 'busy' },
  { op: 'tx', kind: 'toolUse', tool: 'Bash', input: { command: 'rm -rf /', description: 'frightening but never executed' }, toolId: 't1' },
  { op: 'hook', event: 'PreToolUse', tool: 'Bash', input: { command: 'rm -rf /', description: 'frightening but never executed' }, toolId: 't1' },
  {
    op: 'hold', event: 'PermissionRequest', tool: 'Bash', toolId: 't1',
    input: { command: 'rm -rf /', description: 'frightening but never executed' },
    onAllow: [
      { op: 'print', text: '\x1b[32m*\x1b[0m Bash ran (pretend)\r\n' },
      { op: 'hook', event: 'PostToolUse', tool: 'Bash', input: { command: 'rm -rf /' }, toolId: 't1', body: { tool_response: { stdout: '' }, duration_ms: 5 } },
      { op: 'tx', kind: 'toolResult', toolId: 't1', content: '(pretend output)' },
      { op: 'tx', kind: 'assistant', text: 'Done.' },
      { op: 'status', status: 'idle' },
      { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: 'Done.' } },
    ],
    onDeny: [
      { op: 'print', text: '\x1b[31m*\x1b[0m Denied\r\n' },
      { op: 'tx', kind: 'toolResult', toolId: 't1', content: "The user doesn't want to proceed with this tool use.", isError: true },
      { op: 'tx', kind: 'assistant', text: 'Understood, I will not run it.' },
      { op: 'status', status: 'idle' },
      { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: 'Understood, I will not run it.' } },
    ],
  },
];

const AUQ_INPUT = {
  questions: [{ question: 'Which flavour?', header: 'Flavour', multiSelect: false, options: [{ label: 'Vanilla', description: 'plain' }, { label: 'Chocolate', description: 'rich' }] }],
};

const questionTurn: Step[] = [
  { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
  { op: 'tx', kind: 'user', text: '{{prompt}}' },
  { op: 'status', status: 'busy' },
  { op: 'tx', kind: 'toolUse', tool: 'AskUserQuestion', input: AUQ_INPUT, toolId: 't1' },
  {
    op: 'hold', event: 'PreToolUse', tool: 'AskUserQuestion', input: AUQ_INPUT, toolId: 't1',
    onAllow: [
      { op: 'hook', event: 'PostToolUse', tool: 'AskUserQuestion', input: AUQ_INPUT, toolId: 't1', body: { tool_response: { answers: '{{answers}}' } } },
      { op: 'tx', kind: 'toolResult', toolId: 't1', content: '{{answers}}' },
      { op: 'tx', kind: 'assistant', text: 'You chose: {{answers}}' },
      { op: 'status', status: 'idle' },
      { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: 'You chose: {{answers}}' } },
    ],
    onDeny: [
      { op: 'tx', kind: 'toolResult', toolId: 't1', content: 'The user declined to answer.', isError: true },
      { op: 'status', status: 'idle' },
      { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: '' } },
    ],
  },
];

const subagentSteps = (permission: boolean): Step[] => [
  { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
  { op: 'tx', kind: 'user', text: '{{prompt}}' },
  { op: 'status', status: 'busy' },
  { op: 'tx', kind: 'toolUse', tool: 'Task', input: { description: 'look around', subagent_type: 'general-purpose' }, toolId: 'task1' },
  { op: 'hook', event: 'PreToolUse', tool: 'Task', input: { description: 'look around', subagent_type: 'general-purpose' }, toolId: 'task1' },
  { op: 'hook', event: 'SubagentStart', agentId: 'agent-fake1', body: { agent_type: 'general-purpose' } },
  { op: 'tx', kind: 'user', text: 'look around', agentId: 'agent-fake1' },
  { op: 'hook', event: 'PreToolUse', tool: 'Read', input: { file_path: 'a.txt' }, toolId: 's1', agentId: 'agent-fake1' },
  ...(permission ? [{
    op: 'hold', event: 'PermissionRequest', tool: 'Bash', toolId: 's2', agentId: 'agent-fake1', input: { command: 'git push --force' },
    onAllow: [{ op: 'print', text: 'subagent: allowed\r\n' }],
    onDeny: [{ op: 'print', text: 'subagent: denied\r\n' }],
  } satisfies Step] : []),
  { op: 'hook', event: 'PostToolUse', tool: 'Read', input: { file_path: 'a.txt' }, toolId: 's1', agentId: 'agent-fake1', body: { tool_response: { ok: true } } },
  { op: 'tx', kind: 'assistant', text: 'Subagent report.', agentId: 'agent-fake1' },
  { op: 'hook', event: 'SubagentStop', agentId: 'agent-fake1', body: { last_assistant_message: 'Subagent report.' } },
  { op: 'hook', event: 'PostToolUse', tool: 'Task', input: { description: 'look around' }, toolId: 'task1', body: { tool_response: { ok: true } } },
  { op: 'tx', kind: 'toolResult', toolId: 'task1', content: 'Subagent report.' },
  { op: 'tx', kind: 'assistant', text: 'All done.' },
  { op: 'status', status: 'idle' },
  { op: 'hook', event: 'Stop', body: { stop_hook_active: false, last_assistant_message: 'All done.' } },
];

const interruptTurn: Step[] = [
  { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
  { op: 'tx', kind: 'user', text: '{{prompt}}' },
  { op: 'status', status: 'busy' },
  { op: 'tx', kind: 'toolUse', tool: 'Bash', input: { command: 'sleep 600' }, toolId: 't1' },
  { op: 'hook', event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep 600' }, toolId: 't1' },
  { op: 'print', text: '\x1b[32m*\x1b[0m Bash(sleep 600) running... (esc to interrupt)\r\n' },
  { op: 'waitInterrupt', timeoutMs: 120_000 },
  { op: 'status', status: 'idle' },
  { op: 'hook', event: 'Stop', body: { stop_hook_active: false } }, // only reached on timeout; an interrupt skips Stop (V1)
];

const crash: Scenario = {
  turns: [[
    { op: 'hook', event: 'UserPromptSubmit', body: { prompt: '{{prompt}}' } },
    { op: 'print', text: 'Segmentation fault (pretend)\r\n' },
    { op: 'exit', code: 1 },
  ]],
};

export const builtinScenarios: Record<string, Scenario> = {
  plain,
  permission: { turns: [permissionTurn] },
  question: { turns: [questionTurn] },
  subagent: { turns: [subagentSteps(false)] },
  'subagent-permission': { turns: [subagentSteps(true)] },
  clear: { turns: [[...toolTurn('Read', { file_path: 'README.md' }, 'Before clear.'), { op: 'clear' }], toolTurn('Read', { file_path: 'README.md' }, 'After clear: {{prompt}}')] },
  interrupt: { turns: [interruptTurn, toolTurn('Read', { file_path: 'README.md' }, 'Back after interrupt: {{prompt}}')] },
  crash,
  trust: { trust: true, turns: plain.turns },
};
