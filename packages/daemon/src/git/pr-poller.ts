// Pull request and CI poller (task 6.05, R14). Every 60 s it asks `gh pr view` about each session that has a pull
// request or a pushed branch and writes SessionRecord.pr {number, url, state, review, ci, at}.
//
//   rate limit (HTTP 403/429 and friends): exponential backoff, 2 min, 4, 8, then 15 min at most; the cached `pr` of
//                 every session stays as it was. One good answer resets the backoff.
//   auth / gh missing: the "gh needs login" flag goes up (onNeedsLogin(true, message)) and the poller waits `authRetryMs`
//                 before it tries again; the first good answer lowers the flag.
//   other errors: that one session is skipped this round (a deleted worktree, a repository without a GitHub remote).
import type { SessionRecord } from '@strategos/shared';
import { GhError, type Gh } from './gh.ts';
import type { SessionManager } from '../sessions/manager.ts';

export interface PrPollerDeps {
  manager: Pick<SessionManager, 'list' | 'get' | 'update'>;
  gh: Pick<Gh, 'prView'>;
  /** Called when the "gh needs login" flag changes. */
  onNeedsLogin?: (needsLogin: boolean, message?: string) => void;
  intervalMs?: number;
  maxBackoffMs?: number;
  authRetryMs?: number;
  now?: () => number;
  onError?: (what: string, err: unknown) => void;
}

export interface PrPoller {
  start(): void;
  stop(): void;
  /** One round over every candidate session (skipped while a backoff is running). */
  tick(): Promise<void>;
  /** Poll one session now (after pr.create), whatever its state; still honours a running backoff. */
  pollNow(id: string): Promise<void>;
  status(): { needsLogin: boolean; consecutiveRateLimits: number; nextPollAt: number };
}

export const DEFAULT_PR_INTERVAL_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

/** The delay after the n-th rate limit in a row: interval * 2^n, capped. */
export function backoffDelay(intervalMs: number, n: number, maxMs: number = MAX_BACKOFF_MS): number {
  return Math.min(maxMs, intervalMs * 2 ** Math.max(1, n));
}

const branchOf = (s: SessionRecord): string | undefined => s.git?.branch ?? s.worktree?.branch ?? s.branch;

/** Sessions worth asking about: an open pull request to keep fresh, or a branch that has an upstream (it may get one). */
export function isCandidate(s: SessionRecord): boolean {
  if (s.archived || branchOf(s) === undefined) return false;
  if (s.pr !== undefined) return s.pr.state === 'OPEN' || s.pr.state === 'DRAFT';
  return s.git?.ahead !== undefined; // ahead/behind exist only when the branch has an upstream, i.e. it was pushed
}

export function createPrPoller(deps: PrPollerDeps): PrPoller {
  const now = deps.now ?? Date.now;
  const interval = deps.intervalMs ?? DEFAULT_PR_INTERVAL_MS;
  const maxBackoff = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  const authRetry = deps.authRetryMs ?? 5 * 60_000;
  const onError = deps.onError ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let nextAt = 0;
  let rateHits = 0;
  let needsLogin = false;
  let running = false;

  const setNeedsLogin = (v: boolean, message?: string): void => {
    if (needsLogin === v) return;
    needsLogin = v;
    deps.onNeedsLogin?.(v, message);
  };

  /** Returns false when the whole round should stop (rate limit or login problem). */
  async function pollOne(s: SessionRecord): Promise<boolean> {
    const branch = branchOf(s);
    if (branch === undefined) return true;
    try {
      const info = await deps.gh.prView(s.cwd, branch);
      rateHits = 0;
      setNeedsLogin(false);
      if (info === null) return true;
      const cur = deps.manager.get(s.strategosId)?.pr;
      const same = cur !== undefined && cur.number === info.number && cur.url === info.url && cur.state === info.state && cur.ci === info.ci && cur.review === info.review;
      if (!same || now() - (cur?.at ?? 0) > 5 * 60_000) {
        deps.manager.update(s.strategosId, { pr: { number: info.number, url: info.url, state: info.state, ...(info.review === undefined ? {} : { review: info.review }), ci: info.ci, at: now() } });
      }
      return true;
    } catch (err) {
      if (err instanceof GhError && err.kind === 'rate') {
        rateHits += 1;
        nextAt = now() + backoffDelay(interval, rateHits, maxBackoff);
        onError('gh rate limit', err);
        return false;
      }
      if (err instanceof GhError && (err.kind === 'auth' || err.kind === 'missing')) {
        setNeedsLogin(true, err.kind === 'missing' ? 'The GitHub CLI (gh) is not installed.' : 'The GitHub CLI needs you to log in: run "gh auth login".');
        nextAt = now() + authRetry;
        return false;
      }
      onError(`gh pr view (${s.strategosId})`, err);
      return true;
    }
  }

  const poller: PrPoller = {
    async tick() {
      if (running || now() < nextAt) return;
      running = true;
      try {
        for (const s of deps.manager.list()) {
          if (!isCandidate(s)) continue;
          if (!(await pollOne(s))) break;
        }
      } finally {
        running = false;
      }
    },
    async pollNow(id) {
      const s = deps.manager.get(id);
      if (s === undefined || now() < nextAt) return;
      await pollOne(s);
    },
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => { poller.tick().catch((err: unknown) => { onError('pr poll', err); }); }, interval);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    status: () => ({ needsLogin, consecutiveRateLimits: rateHits, nextPollAt: nextAt }),
  };
  return poller;
}
