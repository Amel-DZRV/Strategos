// GitHub CLI wrapper (plan 4.1 `Gh`, task 6.05, R14). `gh` through exec.ts: argument arrays only (D16).
//
// Network rules (plan section 10: git and gh are the only network users):
//   * prView is a read.
//   * prCreate is the one network WRITE, and only the UI command pr.create reaches it: it pushes the branch first when
//     (and only when) the branch has no upstream (`git push -u origin <branch>`), then `gh pr create`.
//   * authStatus is `gh auth status`, read-only.
import type { PrCreate, PrInfo } from '@strategos/shared';
import { defaultExec, type Exec, type ExecResult } from './exec.ts';
import type { Git } from './git.ts';

export type GhErrorKind = 'auth' | 'rate' | 'missing' | 'other';

export class GhError extends Error {
  readonly kind: GhErrorKind;
  constructor(kind: GhErrorKind, message: string) {
    super(message);
    this.name = 'GhError';
    this.kind = kind;
  }
}

export interface Gh {
  prCreate(o: PrCreate): Promise<{ number: number; url: string; existing: boolean; pushed: boolean }>;
  /** null when the branch has no pull request. Throws GhError (auth, rate, missing, other). */
  prView(cwd: string, branch: string): Promise<PrInfo | null>;
  authStatus(): Promise<{ ok: boolean; message: string }>;
}

const AUTH_RE = /gh auth login|not logged in|authentication (failed|required)|bad credentials|http 401|requires authentication|could not read username|no oauth token|token .* (expired|invalid)|gh_token/i;
const RATE_RE = /http 403|http 429|rate limit|secondary rate|abuse detection|too many requests|retry-after/i;
const NO_PR_RE = /no pull requests? found|could not find any pull request/i;

/** Sort a failed gh/git call into what the poller needs to know. */
export function classifyGhFailure(r: ExecResult): GhErrorKind {
  if (r.spawnError === 'ENOENT') return 'missing';
  const text = `${r.stderr}\n${r.stdout}`;
  if (AUTH_RE.test(text)) return 'auth';
  if (RATE_RE.test(text)) return 'rate';
  return 'other';
}

const firstLines = (r: ExecResult): string => (r.stderr.trim() || r.stdout.trim() || r.spawnError || `exit ${r.code}`).split(/\r?\n/).slice(0, 4).join(' | ');

type Check = { __typename?: string; status?: string; conclusion?: string; state?: string };

/** statusCheckRollup -> one dot: any failure wins, then anything still running, then pass; no checks = none. */
export function ciOf(rollup: unknown): PrInfo['ci'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup as Check[]) {
    const conclusion = (c.conclusion ?? '').toUpperCase();
    const state = (c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion) || ['FAILURE', 'ERROR'].includes(state)) return 'fail';
    if (c.__typename === 'StatusContext' || (c.state !== undefined && c.status === undefined)) {
      if (state === 'PENDING' || state === 'EXPECTED') pending = true;
    } else if (status !== 'COMPLETED' || conclusion === '') {
      pending = true;
    }
  }
  return pending ? 'pending' : 'pass';
}

export function parsePrView(json: string): PrInfo {
  const j = JSON.parse(json) as { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown; reviewDecision?: unknown; statusCheckRollup?: unknown };
  if (typeof j.number !== 'number' || typeof j.url !== 'string') throw new GhError('other', 'gh pr view: unexpected output');
  const raw = typeof j.state === 'string' ? j.state.toUpperCase() : 'OPEN';
  const state: PrInfo['state'] = raw === 'MERGED' ? 'MERGED' : raw === 'CLOSED' ? 'CLOSED' : j.isDraft === true ? 'DRAFT' : 'OPEN';
  const review = typeof j.reviewDecision === 'string' && j.reviewDecision !== '' ? j.reviewDecision.toLowerCase() : undefined;
  return { number: j.number, url: j.url, state, ...(review === undefined ? {} : { review }), ci: ciOf(j.statusCheckRollup) };
}

const BODY_ARG_MAX = 20_000; // longer bodies go over stdin (Windows command lines top out near 32k)

export function createGh(deps: { git: Git; exec?: Exec }): Gh {
  const exec = deps.exec ?? defaultExec;
  const { git } = deps;

  const view = async (cwd: string, branch: string): Promise<PrInfo | null> => {
    const r = await exec('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,statusCheckRollup'], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (NO_PR_RE.test(`${r.stderr}\n${r.stdout}`)) return null;
      throw new GhError(classifyGhFailure(r), `gh pr view: ${firstLines(r)}`);
    }
    return parsePrView(r.stdout);
  };

  return {
    prView: view,

    async authStatus() {
      const r = await exec('gh', ['auth', 'status'], { timeoutMs: 15_000 });
      return { ok: r.code === 0, message: firstLines(r) };
    },

    async prCreate(o) {
      if (o.title.trim() === '') throw new GhError('other', 'The pull request needs a title.');
      const head = o.head ?? (await git.currentBranch(o.cwd));
      if (head === undefined || head === '') throw new GhError('other', 'The session is on a detached HEAD: switch to a branch before opening a pull request.');
      if (head.startsWith('-') || (await git.run(o.cwd, ['check-ref-format', '--branch', head])).code !== 0) throw new GhError('other', `"${head}" is not a valid branch name.`);
      if (o.base !== undefined && (o.base === '' || o.base.startsWith('-'))) throw new GhError('other', `"${o.base}" is not a valid base branch.`);

      // A pull request for this branch may exist already: report it instead of failing or duplicating.
      const existing = await view(o.cwd, head).catch((err: unknown) => {
        if (err instanceof GhError && err.kind !== 'other') throw err;
        return null;
      });
      if (existing !== null && existing.state !== 'CLOSED' && existing.state !== 'MERGED') return { number: existing.number, url: existing.url, existing: true, pushed: false };

      let pushed = false;
      if ((await git.upstream(o.cwd, head)) === undefined) {
        if ((await git.run(o.cwd, ['remote', 'get-url', 'origin'])).code !== 0) throw new GhError('other', 'This repository has no "origin" remote to push to.');
        // The one allowed network write besides gh itself. Only reached from the pr.create command.
        const p = await git.run(o.cwd, ['push', '-u', 'origin', head], { timeoutMs: 120_000 });
        if (p.code !== 0) throw new GhError(classifyGhFailure(p) === 'auth' ? 'auth' : 'other', `git push: ${firstLines(p)}`);
        pushed = true;
      }

      const long = o.body.length > BODY_ARG_MAX;
      const args = ['pr', 'create', ...(o.draft ? ['--draft'] : []), '--title', o.title, ...(long ? ['--body-file', '-'] : ['--body', o.body]), '--head', head, ...(o.base === undefined ? [] : ['--base', o.base])];
      const r = await exec('gh', args, { cwd: o.cwd, timeoutMs: 120_000, ...(long ? { input: o.body } : {}) });
      if (r.code !== 0) throw new GhError(classifyGhFailure(r), `gh pr create: ${firstLines(r)}`);
      const url = /https?:\/\/\S+\/pull\/\d+/.exec(r.stdout)?.[0];
      const number = url === undefined ? undefined : Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (url === undefined || number === undefined || !Number.isFinite(number)) throw new GhError('other', `gh pr create printed no pull request address: ${firstLines(r)}`);
      return { number, url, existing: false, pushed };
    },
  };
}
