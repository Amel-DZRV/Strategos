// "While you were away" digest (task 8.03). Built from the event log (events-*.jsonl: status, decision, guard, cost, error,
// wait, pr) plus the live records; nothing is kept only in memory, so "waiting today" survives a restart.
//
//   buildDigest(...)       pure: events + records -> DigestData (replay-tested against a hand-made event sequence)
//   createDigestService()  reads the log, answers digest.get, and publishes the digest by itself when the UI reports that
//                          the person is back after more than 10 minutes (`activity { idleMs }`, opt-out pref awayDigest)
import type { DigestBlocked, DigestData, DigestGroup, DigestSession, Initiative, SessionRecord, UiPrefs } from '@strategos/shared';
import type { EventRecord } from '../store/event-log.ts';

export const AWAY_IDLE_MS = 10 * 60_000;
export const DAY_MS = 86_400_000;

/** Statuses that count as "waiting for you". `done` waits too (an unseen result), but it is not a block. */
export const WAIT_STATUSES: ReadonlySet<string> = new Set(['permission', 'question', 'errored', 'trust_pending', 'interrupted', 'done']);

export interface DigestInput {
  since: number;
  until: number;
  events: readonly EventRecord[];
  sessions: readonly SessionRecord[];
  initiatives: readonly Initiative[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Acc {
  turns: number;
  lastDone: number;
  allowed: number;
  denied: number;
  guard: number;
  errors: number;
  waitingMs: number;
  blockedMs: number;
  prs: { number: number; url: string; at: number }[];
  cost: { before?: number; first?: number; last?: number };
  touched: boolean;
}

const newAcc = (): Acc => ({ turns: 0, lastDone: 0, allowed: 0, denied: 0, guard: 0, errors: 0, waitingMs: 0, blockedMs: 0, prs: [], cost: {}, touched: false });

export function buildDigest(input: DigestInput): DigestData {
  const { since, until } = input;
  const byId = new Map(input.sessions.map((s) => [s.strategosId, s]));
  const acc = new Map<string, Acc>();
  const of = (sid: string): Acc => {
    let a = acc.get(sid);
    if (a === undefined) { a = newAcc(); acc.set(sid, a); }
    return a;
  };
  const nameOf = (sid: string): string => byId.get(sid)?.displayName ?? sid;
  const blocked: DigestBlocked[] = [];
  const errors: NonNullable<DigestData['errors']> = [];
  const finishedAt = new Map<string, number>();

  const addWait = (sid: string, status: string, from: number, to: number | undefined): void => {
    const end = to ?? until;
    const a = Math.max(from, since);
    const b = Math.min(end, until);
    if (b <= a) return;
    const a2 = of(sid);
    a2.waitingMs += b - a;
    if (status !== 'done') {
      a2.blockedMs += b - a;
      blocked.push({ strategosId: sid, displayName: nameOf(sid), status, from, ...(to === undefined ? {} : { to }), ms: b - a });
    }
    a2.touched = true;
  };

  for (const e of input.events) {
    if (e.sid === undefined) continue;
    if (e.ts > until) continue;
    const d = e.data as unknown as Record<string, unknown>;
    // Cost keeps its baseline from before the window; every other type counts inside it only.
    if (e.type === 'cost') {
      const usd = num(d['usd']);
      const c = of(e.sid).cost;
      if (e.ts < since) c.before = usd;
      else { c.first ??= usd; c.last = usd; of(e.sid).touched = true; }
      continue;
    }
    if (e.type === 'wait') {
      addWait(e.sid, str(d['status']), num(d['from']), num(d['to']));
      continue;
    }
    if (e.ts < since) continue;
    const a = of(e.sid);
    switch (e.type) {
      case 'status': {
        const to = str(d['to']);
        a.touched = true;
        if (to === 'done') {
          a.turns += 1;
          a.lastDone = e.ts;
          finishedAt.set(e.sid, e.ts);
        } else if (to === 'errored') {
          a.errors += 1;
          errors.push({ strategosId: e.sid, displayName: nameOf(e.sid), at: e.ts, message: str(d['reason']) === '' ? 'The session hit an error and stopped its turn.' : str(d['reason']) });
        }
        break;
      }
      case 'decision': {
        a.touched = true;
        if (str(d['decision']) === 'deny') a.denied += 1;
        else a.allowed += 1;
        break;
      }
      case 'guard':
        a.touched = true;
        a.guard += 1;
        break;
      case 'error':
        a.touched = true;
        a.errors += 1;
        errors.push({ strategosId: e.sid, displayName: nameOf(e.sid), at: e.ts, message: str(d['message']) });
        break;
      case 'pr':
        a.touched = true;
        if (!a.prs.some((p) => p.number === num(d['number']))) a.prs.push({ number: num(d['number']), url: str(d['url']), at: e.ts });
        break;
      default:
        break;
    }
  }

  // Intervals still open: the record says when the wait began and the log has no close for it yet.
  for (const s of input.sessions) {
    if (s.waitingSince !== undefined && WAIT_STATUSES.has(s.status)) addWait(s.strategosId, s.status, s.waitingSince, undefined);
  }

  const sessions: DigestSession[] = [];
  for (const s of input.sessions) {
    const a = acc.get(s.strategosId);
    if (a === undefined || !(a.touched || a.waitingMs > 0)) continue;
    const baseline = a.cost.before ?? (s.createdAt >= since ? 0 : a.cost.first ?? 0);
    const costUsd = a.cost.last === undefined ? 0 : Math.max(0, a.cost.last - baseline);
    sessions.push({
      strategosId: s.strategosId, displayName: s.displayName, planetKey: s.planetKey,
      ...(s.last === undefined ? {} : { summary: s.last }),
      turns: a.turns, costUsd: round4(costUsd), decisions: { allowed: a.allowed, denied: a.denied },
      prs: a.prs.map((p) => ({ number: p.number, url: p.url })), finalStatus: s.status,
      ...(s.initiativeId === undefined ? {} : { initiativeId: s.initiativeId }),
      waitingMs: a.waitingMs, blockedMs: a.blockedMs, guardDenials: a.guard, errors: a.errors,
    });
  }
  sessions.sort((x, y) => (y.waitingMs ?? 0) - (x.waitingMs ?? 0) || x.displayName.localeCompare(y.displayName));
  const inDigest = new Set(sessions.map((s) => s.strategosId));

  const finished = [...finishedAt].filter(([sid]) => inDigest.has(sid)).map(([sid, at]) => ({ strategosId: sid, displayName: nameOf(sid), at, turns: acc.get(sid)!.turns }))
    .sort((x, y) => y.at - x.at);
  const prsOpened = sessions.flatMap((s) => acc.get(s.strategosId)!.prs.map((p) => ({ strategosId: s.strategosId, displayName: s.displayName, number: p.number, url: p.url, at: p.at })))
    .sort((x, y) => y.at - x.at);

  const groups = groupByInitiative(sessions, input.initiatives, acc);
  const total = (f: (s: DigestSession) => number): number => sessions.reduce((n, s) => n + f(s), 0);

  return {
    since, until, sessions,
    totals: {
      costUsd: round4(total((s) => s.costUsd)), waitingMs: total((s) => s.waitingMs ?? 0), decisions: total((s) => s.decisions.allowed + s.decisions.denied),
      guardDenials: total((s) => s.guardDenials ?? 0), blockedMs: total((s) => s.blockedMs ?? 0), errors: errors.filter((e) => inDigest.has(e.strategosId)).length,
      prs: prsOpened.length, finished: finished.length,
    },
    finished,
    blocked: blocked.filter((b) => inDigest.has(b.strategosId)).sort((x, y) => y.ms - x.ms),
    errors: errors.filter((e) => inDigest.has(e.strategosId)).sort((x, y) => y.at - x.at),
    prsOpened,
    groups,
  };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function groupByInitiative(sessions: readonly DigestSession[], initiatives: readonly Initiative[], acc: ReadonlyMap<string, Acc>): DigestGroup[] {
  const byKey = new Map<string | null, DigestGroup>();
  for (const s of sessions) {
    const ini = s.initiativeId === undefined ? undefined : initiatives.find((i) => i.id === s.initiativeId);
    const key = ini?.id ?? null;
    let g = byKey.get(key);
    if (g === undefined) {
      g = { initiativeId: key, name: ini?.name ?? 'No initiative', ...(ini === undefined ? {} : { colour: ini.colour }), strategosIds: [], costUsd: 0, finished: 0, blockedMs: 0, errors: 0, guardDenials: 0 };
      byKey.set(key, g);
    }
    g.strategosIds.push(s.strategosId);
    g.costUsd = round4(g.costUsd + s.costUsd);
    g.finished += acc.get(s.strategosId)!.lastDone > 0 ? 1 : 0;
    g.blockedMs += s.blockedMs ?? 0;
    g.errors += s.errors ?? 0;
    g.guardDenials += s.guardDenials ?? 0;
  }
  // Initiatives first (in the order they were created), "No initiative" last.
  return [...byKey.values()].sort((a, b) => {
    if (a.initiativeId === null) return 1;
    if (b.initiativeId === null) return -1;
    return initiatives.findIndex((i) => i.id === a.initiativeId) - initiatives.findIndex((i) => i.id === b.initiativeId);
  });
}

/** Something worth interrupting the person for. A digest of nothing is not published on its own. */
export function digestHasNews(d: DigestData): boolean {
  return (d.finished?.length ?? 0) + (d.blocked?.length ?? 0) + (d.errors?.length ?? 0) + (d.prsOpened?.length ?? 0) > 0
    || d.totals.guardDenials > 0 || d.totals.costUsd > 0;
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

export interface DigestServiceDeps {
  events: { read(since: number, until?: number): Promise<EventRecord[]>; append(type: 'activity', data: { idleMs: number }, sid?: string): Promise<void> };
  sessions: () => readonly SessionRecord[];
  initiatives: () => readonly Initiative[];
  prefs: () => Pick<UiPrefs, 'awayDigest'>;
  now?: () => number;
  onError?: (what: string, err: unknown) => void;
}

export interface DigestService {
  /** The digest since a time (default: the last 24 hours). */
  digest(since?: number): Promise<DigestData>;
  /**
   * The UI reports `activity { idleMs }` when the person uses it again after idleMs of nothing. When that is more than
   * 10 minutes and the pref allows it, `send` receives the digest of the time away, at most once per absence and only when
   * it holds news. Returns whether a digest was sent.
   */
  activity(connId: string, idleMs: number, send: (since: number, digest: DigestData) => void): Promise<boolean>;
  forgetConnection(connId: string): void;
}

export function createDigestService(deps: DigestServiceDeps): DigestService {
  const now = deps.now ?? Date.now;
  const lastAway = new Map<string, number>(); // connection -> when its last away digest went out

  async function digest(since: number = now() - DAY_MS): Promise<DigestData> {
    const until = now();
    const events = await deps.events.read(since - DAY_MS, until); // one extra day back: a wait or cost baseline that began before the window
    return buildDigest({ since, until, events, sessions: deps.sessions(), initiatives: deps.initiatives() });
  }

  return {
    digest,
    async activity(connId, idleMs, send) {
      if (idleMs <= AWAY_IDLE_MS) return false;
      const t = now();
      deps.events.append('activity', { idleMs }).catch((err: unknown) => { deps.onError?.('activity event', err); });
      if (deps.prefs().awayDigest === false) return false;
      // A heartbeat from the same absence (idle began before the digest we already sent) must not send it twice.
      const prev = lastAway.get(connId);
      if (prev !== undefined && idleMs > t - prev + 1000) return false;
      const since = t - idleMs;
      const d = await digest(since);
      if (!digestHasNews(d)) return false;
      lastAway.set(connId, t);
      send(since, d);
      return true;
    },
    forgetConnection(connId) { lastAway.delete(connId); },
  };
}

