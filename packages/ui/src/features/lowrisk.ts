// "Approve all low-risk" (4.03, UI side). The UI cannot know exactly what the daemon's D20 rule will accept, so it
// offers the button for requests that look batch-approvable (risk exactly read or write, tool Read / Edit / Write) and
// lets the daemon decide; the confirmation lists each request and only those ids are sent.
import type { SessionRecord } from '@strategos/shared';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';

const TOOLS = new Set(['Read', 'Edit', 'Write']);

export interface LowRiskItem { strategosId: string; requestId: string; session: string; tool: string; path: string }

export function isLowRiskCandidate(s: SessionRecord): boolean {
  const p = s.pending;
  if (!p || p.kind !== 'permission' || !p.held || p.inputTruncated) return false;
  if (!TOOLS.has(p.toolName)) return false;
  return p.risk.length === 1 && (p.risk[0] === 'read' || p.risk[0] === 'write');
}

export function lowRiskItems(sessions: Iterable<SessionRecord>): LowRiskItem[] {
  const out: LowRiskItem[] = [];
  for (const s of sessions) {
    if (s.archived || !isLowRiskCandidate(s)) continue;
    const p = s.pending!;
    out.push({ strategosId: s.strategosId, requestId: p.requestId, session: s.displayName, tool: p.toolName, path: p.inputSummary });
  }
  return out;
}

/** Ask the daemon to approve exactly these requests. Rejects with the daemon's reason. */
export async function approveLowRisk(items: readonly LowRiskItem[]): Promise<void> {
  await send({ c: 'perm.approveLowRisk', initiativeId: '*', requestIds: items.map((i) => i.requestId) });
}

export const currentLowRisk = (): LowRiskItem[] => lowRiskItems(store.needsYou.value);
