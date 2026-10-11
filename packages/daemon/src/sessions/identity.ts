// Lineage of Claude session ids behind one Strategos session (plan section 6 rule 4, check C3).
// Pure helpers used by the state machine; no I/O.

import type { Effect, SessionRecord } from '@strategos/shared';

export type LineageSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | (string & {});

export interface LineageInput {
  claudeSessionId?: string;
  source: LineageSource;
  transcriptPath?: string;
}

export interface LineageResult {
  patch: Partial<SessionRecord>;
  effects: Effect[];
}

/** Sum of the per-Claude-session costs: `/clear` resets Claude's own total, so we keep one number per id (C3). */
export function sumLineageCost(byClaudeSession: Record<string, number>): number {
  let total = 0;
  for (const usd of Object.values(byClaudeSession)) total += usd;
  return total;
}

/** Record the cost reported for one Claude session id (cumulative for that id) and re-sum the lineage. */
export function withSessionCost(cost: SessionRecord['cost'], claudeSessionId: string, usd: number): SessionRecord['cost'] {
  const byClaudeSession = { ...cost.byClaudeSession, [claudeSessionId]: usd };
  return { lineageUsd: sumLineageCost(byClaudeSession), byClaudeSession };
}

const MARKERS = ['clear', 'compact', 'resume', 'fork'] as const;
type Marker = (typeof MARKERS)[number];
function markerFor(source: LineageSource): Marker | undefined {
  return (MARKERS as readonly string[]).includes(source) ? (source as Marker) : undefined;
}

/**
 * Rule 4. A SessionStart with a session id we have not seen pushes it onto the lineage, makes it current,
 * adopts its transcript and restarts the read offset. A chat marker is added for clear, compact, resume and fork.
 * Whether the session then becomes `done` is the state machine's decision, not ours.
 */
export function applySessionStart(s: SessionRecord, input: LineageInput): LineageResult {
  const patch: Partial<SessionRecord> = {};
  const effects: Effect[] = [];
  const id = input.claudeSessionId;
  let restart = false;

  if (id !== undefined && !s.claudeSessionIds.includes(id)) {
    patch.claudeSessionIds = [...s.claudeSessionIds, id];
    patch.currentSessionId = id;
    patch.cost = { ...s.cost, byClaudeSession: { ...s.cost.byClaudeSession, [id]: 0 } };
    restart = true;
  } else if (id !== undefined && id !== s.currentSessionId) {
    patch.currentSessionId = id; // an id from our own lineage comes back (in-TUI /resume of an older conversation)
    restart = true;
  }
  if (input.transcriptPath !== undefined && input.transcriptPath !== s.transcriptPath) {
    patch.transcriptPath = input.transcriptPath;
    restart = true;
  }
  if (restart) {
    patch.transcriptOffset = 0;
    const path = patch.transcriptPath ?? s.transcriptPath;
    if (path !== undefined) effects.push({ e: 'transcript.follow', path, offset: 0 });
  }

  const marker = markerFor(input.source);
  if (marker !== undefined) effects.push({ e: 'chat.marker', marker });
  return { patch, effects };
}
