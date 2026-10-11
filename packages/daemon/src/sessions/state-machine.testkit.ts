// Test helpers for the reducer and the reconciler tests. Not imported by product code.

import type { Effect, HookMachineInput, MachineInput, Observation, Pending, SessionRecord } from '@strategos/shared';
import { reduce } from './state-machine.ts';

export const T0 = 1_000_000;

export function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schema: 1,
    strategosId: 's1',
    name: 'alpha',
    displayName: 'Alpha',
    claudeSessionIds: ['c1'],
    currentSessionId: 'c1',
    transcriptOffset: 0,
    repoRoot: '/repo',
    planetKey: '/repo/.git',
    cwd: '/repo',
    launch: { addDirs: [], extraArgs: [] },
    status: 'working',
    statusSource: 'hook',
    statusSince: 0,
    transcriptPath: '/t/c1.jsonl',
    ringSlot: 0,
    ringSlotByGroup: {},
    cost: { lineageUsd: 0, byClaudeSession: {} },
    flags: { conflicts: [], contractChanged: [], guardDenials: 0 },
    subagents: [],
    pty: { pid: 100, cols: 120, rows: 30, dirtyInput: false },
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0, // long ago: inference is allowed unless a test says otherwise
    archived: false,
    view: 'term',
    ...over,
  };
}

export function makePending(over: Partial<Pending> = {}): Pending {
  return {
    requestId: 'r1',
    kind: 'permission',
    held: true,
    toolName: 'Bash',
    inputSummary: 'npm test',
    inputTruncated: false,
    risk: ['run'],
    since: T0,
    ...over,
  };
}

export function hookIn(hook: HookMachineInput): MachineInput {
  return { k: 'hook', hook };
}

export function obs(over: Partial<Observation> = {}): Observation {
  return { claudeSessionId: 'c1', pid: 100, alive: true, ownedByUs: true, source: 'sessions_dir', ...over };
}

export function run(s: SessionRecord, e: MachineInput, now = T0): { next: SessionRecord; effects: Effect[] } {
  return reduce(s, e, now);
}

export function effectsOf<T extends Effect['e']>(effects: Effect[], kind: T): Extract<Effect, { e: T }>[] {
  return effects.filter((x): x is Extract<Effect, { e: T }> => x.e === kind);
}

/** The status log lines of a result, as "from>to:source". */
export function transitions(effects: Effect[]): string[] {
  return effectsOf(effects, 'log')
    .filter((l) => l.type === 'status')
    .map((l) => `${String(l.data.from)}>${String(l.data.to)}:${String(l.data.source)}`);
}
