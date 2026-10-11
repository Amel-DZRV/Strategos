// UI commands of milestone M6 that belong to the git side: review.get, review.sendBack, pr.create, worktree.remove,
// worktree.exclude. (session.start with a worktree is in sessions/commands.ts; the manager asks the WorktreeProvider below.)
import * as path from 'node:path';
import { isLive, type SendResult } from '@strategos/shared';
import type { CommandResult, WsHub } from '../server/ws-hub.ts';
import type { SessionManager, WorktreeProvider } from '../sessions/manager.ts';
import { resolveRepo } from '../sessions/launch.ts';
import { GhError, type Gh } from './gh.ts';
import type { GitPoller } from './git-poller.ts';
import type { Git } from './git.ts';
import type { PrPoller } from './pr-poller.ts';
import type { Review } from './review.ts';
import { WorktreeError, type Worktrees } from './worktrees.ts';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The manager's view of worktree creation: path from D17 / config.machine.worktreeRoot, create, and undo for a failed start. */
export function createWorktreeProvider(deps: { worktrees: Worktrees; worktreeRoot: () => string }): WorktreeProvider {
  return {
    async create(o) {
      const p = deps.worktrees.defaultPath(o.repoRoot, o.name, deps.worktreeRoot());
      const r = await deps.worktrees.worktreeAdd(o.repoRoot, p, o.branch, o.base, { ...(o.addExclude === undefined ? {} : { addExclude: o.addExclude }) });
      return { path: r.path, branch: r.branch, base: r.base };
    },
    async discard(w) {
      // A worktree this start created a moment ago has no changes and no commits of its own, so the safety check passes.
      await deps.worktrees.worktreeRemoveSafe(w.path, { deleteBranch: true, confirmText: w.branch });
    },
  };
}

export interface GitCommandDeps {
  manager: SessionManager;
  git: Git;
  worktrees: Worktrees;
  review: Review;
  gh: Gh;
  prPoller: PrPoller;
  gitPoller: GitPoller;
  canonical: (p: string) => string;
  /** A gh call failed in a way that needs the person (login, not installed): raise the banner. */
  onGhProblem: (err: GhError) => void;
  onError?: (what: string, err: unknown) => void;
}

function fromSend(r: SendResult): CommandResult {
  return r.ok ? undefined : fail(`${r.reason}${r.message === undefined ? '' : `: ${r.message}`}`);
}

/** `origin/main` -> `main`: gh wants a branch name, not a remote-tracking ref. */
const branchName = (base: string): string => base.replace(/^(refs\/(heads|remotes\/[^/]+)\/|origin\/)/, '');

export function registerGitCommands(hub: WsHub, d: GitCommandDeps): void {
  const known = (id: string): CommandResult => (d.manager.get(id) === undefined ? fail(`no such session: ${id}`) : undefined);

  hub.registerCommand('review.get', async (c, ctx) => {
    const bad = known(c.strategosId);
    if (bad !== undefined) return bad;
    try {
      const review = await d.review.get(c.strategosId);
      ctx.send({ t: 'review', strategosId: c.strategosId, review });
      d.gitPoller.refresh(c.strategosId).catch(() => undefined); // opening the review pane is a good moment to refresh the numbers too
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  hub.registerCommand('review.sendBack', async (c) => known(c.strategosId) ?? fromSend(await d.review.sendBack(c.strategosId, c.text)));

  hub.registerCommand('pr.create', async (c) => {
    const s = d.manager.get(c.strategosId);
    if (s === undefined) return fail(`no such session: ${c.strategosId}`);
    const cwd = s.cwd;
    try {
      const base = s.worktree?.base;
      const r = await d.gh.prCreate({ cwd, title: c.title, body: c.body, draft: c.draft, ...(base === undefined ? {} : { base: branchName(base) }) });
      d.manager.update(c.strategosId, { pr: { number: r.number, url: r.url, state: c.draft ? 'DRAFT' : 'OPEN', ci: 'none', at: Date.now() } });
      d.prPoller.pollNow(c.strategosId).catch(() => undefined);
      d.gitPoller.refresh(c.strategosId).catch(() => undefined); // the push gave the branch an upstream
    } catch (err) {
      if (err instanceof GhError) {
        if (err.kind === 'auth' || err.kind === 'missing') d.onGhProblem(err);
        return fail(err.message);
      }
      d.onError?.('pr.create', err);
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  hub.registerCommand('worktree.remove', async (c) => {
    const s = d.manager.get(c.strategosId);
    if (s === undefined) return fail(`no such session: ${c.strategosId}`);
    if (s.worktree === undefined) return fail('This session does not run in a worktree.');
    if (s.pty !== undefined || isLive(s.status)) return fail('Stop the session first: its process is still running in that folder.');
    try {
      await d.worktrees.worktreeRemoveSafe(s.worktree.path, { deleteBranch: c.deleteBranch, ...(c.confirmText === undefined ? {} : { confirmText: c.confirmText }) });
    } catch (err) {
      if (err instanceof WorktreeError) return fail(err.message);
      d.onError?.('worktree.remove', err);
      return fail(err instanceof Error ? err.message : String(err));
    }
    // The folder is gone: keep the record for history, out of the way (it cannot be resumed there any more).
    d.manager.update(c.strategosId, { worktree: undefined, git: undefined, archived: true });
  });

  hub.registerCommand('worktree.exclude', async (c, ctx) => {
    try {
      const info = await resolveRepo(path.resolve(c.repoPath), d.canonical, async (cwd, args) => {
        const r = await d.git.run(cwd, args);
        return r.code === 0 ? r.stdout : null;
      });
      if (!info.isRepo) return fail(`Not a repository: ${c.repoPath}`);
      if (c.add) await d.worktrees.addExclude(info.repoRoot);
      ctx.send({ t: 'worktree.exclude', repoPath: c.repoPath, excluded: await d.worktrees.isExcluded(info.repoRoot) });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
