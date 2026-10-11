import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '@strategos/shared';
import { toastAllowRefusal } from './risk.ts';

const wt = path.resolve('toast-wt');
function rig(over: { toolName?: string; truncated?: boolean; input?: Record<string, unknown>; kind?: string; event?: string } = {}) {
  const pending = {
    requestId: 'r1', kind: over.kind ?? 'permission', held: true, toolName: over.toolName ?? 'Edit', inputSummary: '', inputTruncated: over.truncated ?? false, risk: [], since: 0,
  };
  const s = { strategosId: 's1', cwd: wt, launch: { addDirs: [], extraArgs: [] }, pending } as unknown as SessionRecord;
  const registry = {
    getFull: () => (over.input === undefined ? undefined : { sid: 's1', requestId: 'r1', event: over.event ?? 'PermissionRequest', toolName: pending.toolName, toolInput: over.input, pending }),
  } as unknown as Parameters<typeof toastAllowRefusal>[0]['registry'];
  return { s, d: { registry } };
}

describe('toastAllowRefusal (an allow with via toast)', () => {
  it('allows an Edit inside the worktree', () => {
    const r = rig({ input: { file_path: path.join(wt, 'src', 'a.ts') } });
    expect(toastAllowRefusal(r.d, r.s, 'r1')).toBeNull();
  });
  it('refuses Bash, dotfiles, outside paths, truncated input (D21) and missing full input', () => {
    const cases = [
      rig({ toolName: 'Bash', input: { command: 'ls' } }),
      rig({ input: { file_path: path.join(wt, '.git', 'config') } }),
      rig({ input: { file_path: path.resolve('elsewhere', 'a.ts') } }),
      rig({ truncated: true, input: { file_path: path.join(wt, 'a.ts') } }),
      rig({}),
      rig({ event: 'PreToolUse', input: { file_path: path.join(wt, 'a.ts') } }),
    ];
    for (const c of cases) expect(toastAllowRefusal(c.d, c.s, 'r1')).not.toBeNull();
  });
  it('refuses a request id that is no longer pending, and questions', () => {
    const r = rig({ input: { file_path: path.join(wt, 'a.ts') } });
    expect(toastAllowRefusal(r.d, r.s, 'other')).not.toBeNull();
    expect(toastAllowRefusal(r.d, undefined, 'r1')).not.toBeNull();
    const q = rig({ kind: 'question', toolName: 'AskUserQuestion', input: { file_path: path.join(wt, 'a.ts') } });
    expect(toastAllowRefusal(q.d, q.s, 'r1')).not.toBeNull();
  });
});
