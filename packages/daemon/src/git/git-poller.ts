// Live git state of running sessions (task 6.01): every 15 s, for each session with a process, status + diff stat of its
// folder -> SessionRecord.git {branch, ahead, behind, dirty, diffStat, at} (and SessionRecord.branch when it moved).
// A record is only rewritten when something changed (or every 5 min as a heartbeat for `at`), so a quiet repository
// costs no `session.upsert` traffic. GIT_OPTIONAL_LOCKS=0 (exec.ts) keeps polling from fighting Claude's own git calls.
import type { SessionRecord } from '@strategos/shared';
import type { Git } from './git.ts';
import type { SessionManager } from '../sessions/manager.ts';

export interface GitPollerDeps {
  manager: Pick<SessionManager, 'list' | 'get' | 'update'> & Partial<Pick<SessionManager, 'onChange'>>;
  git: Pick<Git, 'status' | 'diffStat'>;
  intervalMs?: number;
  now?: () => number;
  onError?: (what: string, err: unknown) => void;
}

export interface GitPoller {
  start(): void;
  stop(): void;
  /** One round over every session that has a process. */
  tick(): Promise<void>;
  /** Refresh one session now, process or not (after a commit, a push, a review open). */
  refresh(id: string): Promise<void>;
}

export const DEFAULT_GIT_INTERVAL_MS = 15_000;
const HEARTBEAT_MS = 5 * 60_000;
const PARALLEL = 4;

type GitState = NonNullable<SessionRecord['git']>;

const sameGit = (a: GitState | undefined, b: GitState): boolean =>
  a !== undefined && a.branch === b.branch && a.ahead === b.ahead && a.behind === b.behind && a.dirty === b.dirty &&
  a.diffStat?.files === b.diffStat?.files && a.diffStat?.add === b.diffStat?.add && a.diffStat?.del === b.diffStat?.del;

export function createGitPoller(deps: GitPollerDeps): GitPoller {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let unsubscribe: (() => void) | undefined;
  const seeded = new Set<string>(); // sessions whose first reading was already requested
  const failing = new Set<string>(); // log a broken folder once, not every 15 s

  async function pollOne(s: SessionRecord): Promise<void> {
    try {
      const st = await deps.git.status(s.cwd);
      const stat = await deps.git.diffStat(s.cwd, s.worktree?.base);
      const g: GitState = {
        ...(st.branch === undefined ? {} : { branch: st.branch }),
        ...(st.ahead === undefined ? {} : { ahead: st.ahead }),
        ...(st.behind === undefined ? {} : { behind: st.behind }),
        dirty: st.dirty,
        ...(stat === undefined ? {} : { diffStat: stat }),
        at: now(),
      };
      failing.delete(s.strategosId);
      const cur = deps.manager.get(s.strategosId);
      if (cur === undefined) return;
      const branchMoved = st.branch !== undefined && st.branch !== cur.branch;
      if (sameGit(cur.git, g) && !branchMoved && now() - (cur.git?.at ?? 0) < HEARTBEAT_MS) return;
      deps.manager.update(s.strategosId, { git: g, ...(branchMoved ? { branch: st.branch as string } : {}) });
    } catch (err) {
      if (!failing.has(s.strategosId)) {
        failing.add(s.strategosId);
        onError(`git status (${s.strategosId})`, err);
      }
    }
  }

  const poller: GitPoller = {
    async tick() {
      if (running) return;
      running = true;
      try {
        const live = deps.manager.list().filter((s) => s.pty !== undefined);
        for (let i = 0; i < live.length; i += PARALLEL) await Promise.all(live.slice(i, i + PARALLEL).map(pollOne));
      } finally {
        running = false;
      }
    },
    async refresh(id) {
      const s = deps.manager.get(id);
      if (s !== undefined) await pollOne(s);
    },
    start() {
      if (timer !== undefined) return;
      // A session that just got a process is read at once, not 15 s later.
      unsubscribe = deps.manager.onChange?.((s) => {
        if (s.pty !== undefined && s.git === undefined && !seeded.has(s.strategosId)) {
          seeded.add(s.strategosId);
          pollOne(s).catch((err: unknown) => { onError('git poll', err); });
        }
      });
      timer = setInterval(() => { poller.tick().catch((err: unknown) => { onError('git poll', err); }); }, deps.intervalMs ?? DEFAULT_GIT_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
  return poller;
}
