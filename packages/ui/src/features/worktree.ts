// Client-side helpers for worktrees: branch names from session names, the "hide worktrees from git status" question
// (asked once per repo, answer remembered in this browser), and reading the daemon's refusal to remove a worktree.
import { onChannel, send } from '../state/commands.ts';

/** "Fix the login bug!" -> "fix-the-login-bug". Safe as a branch name part and as a folder name. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[-._]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 60).replace(/-+$/, '');
}

export function branchFromName(name: string): string {
  return slugify(name);
}

// --- the exclude question -----------------------------------------------------------------------------------------------
const EXCLUDE_KEY = 'strategos.excludeAnswer';
export type ExcludeAnswer = 'yes' | 'no';

function readAnswers(): Record<string, ExcludeAnswer> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(EXCLUDE_KEY) ?? '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, ExcludeAnswer>) : {};
  } catch {
    return {};
  }
}

const repoKey = (repo: string): string => repo.trim().replace(/[\\/]+$/, '').toLowerCase();

export function excludeAnswer(repo: string): ExcludeAnswer | undefined {
  const a = readAnswers()[repoKey(repo)];
  return a === 'yes' || a === 'no' ? a : undefined;
}

export function rememberExclude(repo: string, answer: ExcludeAnswer): void {
  try {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify({ ...readAnswers(), [repoKey(repo)]: answer }));
  } catch {
    // blocked storage: we will simply ask again next time
  }
}

/** Ask the daemon whether `.claude/worktrees/` is already excluded in the repo. undefined = could not tell. */
export function queryExcluded(repoPath: string, timeoutMs = 4000): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let off: () => void = () => undefined;
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    function finish(v: boolean | undefined): void {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(v);
    }
    off = onChannel((ev) => {
      if (ev.t === 'worktree.exclude' && ev.repoPath === repoPath) finish(ev.excluded);
    });
    send({ c: 'worktree.exclude', repoPath, add: false }).catch(() => finish(undefined));
  });
}

/** The person agreed: add it. */
export async function addExclude(repoPath: string): Promise<void> {
  await send({ c: 'worktree.exclude', repoPath, add: true });
}

// --- removing a worktree ------------------------------------------------------------------------------------------------
export interface RemovalRefusal {
  /** What would be lost, as the daemon wrote it (without the instruction to type). */
  details: string;
  /** The text the person has to type: the branch name. */
  confirmText: string;
}

/**
 * The daemon refuses with: `Not removed. This would lose: <parts>. To go ahead, type "<branch>" to confirm.`
 * Returns undefined for any other error.
 */
export function parseRemovalRefusal(message: string): RemovalRefusal | undefined {
  const m = /This would lose: ([\s\S]*?)\.?\s*To go ahead, type "([^"]+)" to confirm/.exec(message);
  if (!m) return undefined;
  return { details: (m[1] ?? '').trim(), confirmText: m[2] ?? '' };
}
