// Task 6.04: which Bash commands count as a test run. The review inbox shows "last test" only when a hook told us a
// matching command finished (PostToolUse = ok, PostToolUseFailure = failed). A session that never ran one has no
// `flags.lastTest`, and the UI says "not run": nothing here ever guesses "passing".
const cache = new Map<string, RegExp[]>();

/** config.portable.testCommandPatterns -> RegExp[] (config.ts has validated them; a bad one is skipped here anyway). Cached by content. */
export function compileTestPatterns(sources: readonly string[]): RegExp[] {
  const key = JSON.stringify(sources);
  let r = cache.get(key);
  if (r === undefined) {
    r = [];
    for (const s of sources) {
      try {
        r.push(new RegExp(s, 'i'));
      } catch {
        /* skipped */
      }
    }
    if (cache.size > 16) cache.clear();
    cache.set(key, r);
  }
  return r;
}

const COMMAND_MAX = 200;

/** The command text when this tool call is a Bash command matching a test pattern; otherwise undefined. */
export function testCommandOf(patterns: readonly RegExp[], tool: string, input: unknown): string | undefined {
  if (tool !== 'Bash' || typeof input !== 'object' || input === null) return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  if (!patterns.some((p) => p.test(command))) return undefined;
  const one = command.trim().replace(/\s+/g, ' ');
  return one.length > COMMAND_MAX ? `${one.slice(0, COMMAND_MAX - 1)}…` : one;
}

/**
 * What a finished tool call tells us about tests: ok=true after PostToolUse, ok=false after a PostToolUseFailure that is
 * not an interrupt (an interrupted run says nothing about the outcome). undefined: not a test command.
 */
export function testResultOf(patterns: readonly RegExp[], h: { hook_event_name: string; tool_name?: string; tool_input?: unknown; is_interrupt?: boolean }): { command: string; ok: boolean } | undefined {
  const command = testCommandOf(patterns, h.tool_name ?? '', h.tool_input);
  if (command === undefined) return undefined;
  if (h.hook_event_name === 'PostToolUse') return { command, ok: true };
  if (h.hook_event_name === 'PostToolUseFailure' && h.is_interrupt !== true) return { command, ok: false };
  return undefined;
}
