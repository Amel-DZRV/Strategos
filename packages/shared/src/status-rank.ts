import type { SessionRecord, Status } from './types.ts';

/** Needs-you tiers, plan §6 rule 5: permission > question > errored > trust_pending > interrupted > done (unseen). Lower = more urgent. */
const RANK = {
  permission: 0,
  question: 1,
  errored: 2,
  trust_pending: 3,
  interrupted: 4,
  done: 5,
} as const satisfies Partial<Record<Status, number>>;

export function needsYouRank(status: Status): number | null {
  return status in RANK ? RANK[status as keyof typeof RANK] : null;
}

type RankInput = Pick<SessionRecord, 'status' | 'doneAt' | 'seenAt' | 'waitingSince' | 'statusSince'>;

/** done counts only while unseen (never seen, or seenAt < doneAt). */
export function isNeedsYou(rec: RankInput): boolean {
  if (needsYouRank(rec.status) === null) return false;
  if (rec.status === 'done' && rec.seenAt !== undefined && rec.doneAt !== undefined && rec.seenAt >= rec.doneAt) return false;
  return true;
}

function since(rec: RankInput): number {
  return rec.waitingSince ?? rec.statusSince;
}

/** Sort comparator: rank first, then oldest waitingSince first. Records that do not need you sort last. */
export function compareNeedsYou(a: RankInput, b: RankInput): number {
  const ra = isNeedsYou(a) ? (needsYouRank(a.status) ?? Infinity) : Infinity;
  const rb = isNeedsYou(b) ? (needsYouRank(b.status) ?? Infinity) : Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return since(a) - since(b);
}

/** Token glyphs, plan §7. Glyph plus colour, never colour alone. */
export const STATUS_GLYPH = {
  permission: '◆', // diamond
  question: '?',
  working: '●', // filled circle
  done: '✓', // check
  seen: '·', // middle dot (dimmed check)
  interrupted: '⏸', // pause
  errored: '✕', // x
  stopped: '○', // hollow circle
  parked: 'z',
  open_elsewhere: '⇱', // corner arrow
  trust_pending: '⚑', // flag
  starting: '…', // ellipsis (not listed in §7; chosen here)
} as const satisfies Record<Status, string>;

export function glyphFor(status: Status): string {
  return STATUS_GLYPH[status];
}

/** Statuses where a Strategos-owned Claude process is (or may be) running. errored counts: StopFailure leaves the process alive. */
export function isLive(status: Status): boolean {
  switch (status) {
    case 'stopped':
    case 'parked':
    case 'open_elsewhere':
      return false;
    default:
      return true;
  }
}
