import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.ts';
import { compileTestPatterns, testCommandOf, testResultOf } from './test-detect.ts';

const patterns = compileTestPatterns(defaultConfig(0).portable.testCommandPatterns);
const bash = (command: string, event = 'PostToolUse', extra: Record<string, unknown> = {}) => ({ hook_event_name: event, tool_name: 'Bash', tool_input: { command }, ...extra });

describe('test command detection (6.04)', () => {
  it('matches the usual test runners', () => {
    for (const c of ['npm test', 'npm run test -- --watch=false', 'pnpm test', 'yarn test', 'npx vitest run', 'jest --ci', 'python -m pytest -x', 'go test ./...', 'cargo test']) {
      expect(testCommandOf(patterns, 'Bash', { command: c }), c).toBeDefined();
    }
  });
  it('ignores other commands, other tools and odd input', () => {
    for (const c of ['ls', 'npm install', 'git status', 'echo hello']) expect(testCommandOf(patterns, 'Bash', { command: c }), c).toBeUndefined();
    expect(testCommandOf(patterns, 'Read', { command: 'npm test' })).toBeUndefined();
    expect(testCommandOf(patterns, 'Bash', undefined)).toBeUndefined();
    expect(testCommandOf(patterns, 'Bash', { command: 5 })).toBeUndefined();
    expect(testCommandOf(patterns, 'Bash', { command: '   ' })).toBeUndefined();
  });
  it('normalises whitespace and caps the stored command', () => {
    expect(testCommandOf(patterns, 'Bash', { command: 'npm   test\n  -- --run' })).toBe('npm test -- --run');
    expect(testCommandOf(patterns, 'Bash', { command: `npm test ${'x'.repeat(500)}` })?.length).toBe(200);
  });
  it('PostToolUse = ok, PostToolUseFailure = failed, an interrupt = nothing', () => {
    expect(testResultOf(patterns, bash('npm test'))).toEqual({ command: 'npm test', ok: true });
    expect(testResultOf(patterns, bash('npm test', 'PostToolUseFailure', { is_interrupt: false }))).toEqual({ command: 'npm test', ok: false });
    expect(testResultOf(patterns, bash('npm test', 'PostToolUseFailure', { is_interrupt: true }))).toBeUndefined();
    expect(testResultOf(patterns, bash('npm test', 'PreToolUse'))).toBeUndefined(); // a command that has only started proves nothing
    expect(testResultOf(patterns, bash('ls'))).toBeUndefined();
  });
  it('a bad pattern is skipped, patterns follow the config', () => {
    expect(compileTestPatterns(['(', 'mytest'])).toHaveLength(1);
    expect(testCommandOf(compileTestPatterns(['^make check$']), 'Bash', { command: 'make check' })).toBe('make check');
  });
});
