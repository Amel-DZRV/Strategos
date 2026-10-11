import type { Pending, SessionRecord, Status } from '@strategos/shared';

export const T0 = 1_700_000_000_000;

export function makeSession(over: Partial<SessionRecord> & { strategosId: string }): SessionRecord {
  const id = over.strategosId;
  return {
    schema: 1, name: id, displayName: `Session ${id}`, claudeSessionIds: [`c-${id}`], currentSessionId: `c-${id}`,
    transcriptOffset: 0, repoRoot: 'C:\\dev\\strategos-app', planetKey: 'strategos-app', cwd: 'C:\\dev\\strategos-app',
    launch: { addDirs: [], extraArgs: [] }, status: 'working', statusSource: 'hook', statusSince: T0, ringSlot: 0, ringSlotByGroup: {},
    cost: { lineageUsd: 1.5, byClaudeSession: {} }, flags: { conflicts: [], contractChanged: [], guardDenials: 0 }, subagents: [],
    createdAt: T0, updatedAt: T0, lastActivityAt: T0, archived: false, view: 'term',
    ...over,
  };
}

export function makePending(over: Partial<Pending> = {}): Pending {
  return {
    requestId: 'req-1', kind: 'permission', held: true, toolName: 'Bash', inputSummary: 'npm test', inputTruncated: false,
    risk: ['run'], since: T0, ...over,
  };
}

export const ALL_STATUSES: Status[] = [
  'starting', 'trust_pending', 'working', 'permission', 'question', 'done', 'seen', 'interrupted', 'errored', 'stopped', 'parked', 'open_elsewhere',
];
