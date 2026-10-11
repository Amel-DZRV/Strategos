// Initiatives, suggestions and missions (task 6.06, daemon side).
//
//   initiative.upsert / initiative.assign   persisted in state.json (`initiatives`, ring slots per initiative on the session)
//   suggestions      branch names that look like one piece of work -> `suggestion` kind 'initiative'. NOTHING is applied
//                    until the person answers `suggestion.respond {accept:true}`. A dismissal is remembered in
//                    state.dismissedSuggestions (by id and by branch key), so the same idea is not offered again.
//                    The usage tracker's 'park' suggestion goes through the same book; accepting it parks the listed
//                    sessions (a click from the person, so it is allowed to act).
//   mission.start    several sessions at once, each in its own new worktree on its own branch, tagged with the initiative;
//                    the first is the lead (the others carry parentId = lead).
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Initiative, SessionRecord } from '@strategos/shared';
import type { Git } from '../git/git.ts';
import type { WsHub } from '../server/ws-hub.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { assignRingSlot, planetColour, planetLabel } from '../sessions/launch.ts';
import type { StateStore } from '../store/state-store.ts';

// ---------------------------------------------------------------------------
// branch names -> work key (pure)
// ---------------------------------------------------------------------------

const TYPE_WORDS = new Set(['feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'refactor', 'docs', 'doc', 'test', 'tests', 'perf', 'ci', 'build', 'style', 'wip', 'claude', 'agent', 'user', 'users', 'work', 'task', 'tasks', 'part', 'story']);
const STOP_WORDS = new Set(['add', 'adds', 'update', 'updates', 'new', 'remove', 'implement', 'the', 'and', 'for', 'with', 'from', 'into', 'support', 'improve', 'cleanup', 'misc', 'temp', 'tmp', 'main', 'master', 'develop', 'dev', 'release', 'branch', 'typo', 'typos', 'bug', 'bugs', 'issue', 'some', 'more', 'make', 'use', 'move', 'rename', 'change', 'changes', 'initial']);

/** `feat/checkout-ui` -> `checkout`; `fix/ENG-123-login` -> `eng-123`; `main`, `wip`, `fix/typo` -> undefined (too generic). */
export function branchKey(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  const tokens = branch.toLowerCase().split(/[/_\-.\s]+/).filter((t) => t !== '');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (TYPE_WORDS.has(t) || STOP_WORDS.has(t)) continue;
    const next = tokens[i + 1];
    if (/^[a-z]{2,6}$/.test(t) && next !== undefined && /^\d{1,6}$/.test(next)) return `${t}-${next}`; // ticket id
    if (t.length >= 4 && !/^\d+$/.test(t)) return t;
  }
  return undefined;
}

export interface InitiativeGuess { key: string; strategosIds: string[]; branches: string[] }

const branchOf = (s: SessionRecord): string | undefined => s.git?.branch ?? s.worktree?.branch ?? s.branch;

/** Sessions without an initiative whose branches share a key; groups of two or more. Pure. */
export function guessInitiatives(sessions: readonly SessionRecord[]): InitiativeGuess[] {
  const by = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (s.archived || s.initiativeId !== undefined) continue;
    const key = branchKey(branchOf(s));
    if (key === undefined) continue;
    by.set(key, [...(by.get(key) ?? []), s]);
  }
  return [...by.entries()].filter(([, v]) => v.length >= 2).map(([key, v]) => ({
    key, strategosIds: v.map((s) => s.strategosId).sort(), branches: [...new Set(v.map((s) => branchOf(s) as string))],
  }));
}

/** A branch name safe to use as one folder name (the worktree folder). */
export function worktreeNameOf(branch: string): string {
  const n = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/\.+$/, '').slice(0, 80);
  return n === '' ? 'work' : n;
}

const titleCase = (key: string): string => key.split('-').map((w) => (w === '' ? w : (/^\d+$/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))).join(' ');

// ---------------------------------------------------------------------------
// suggestion book
// ---------------------------------------------------------------------------

export interface BookEntry { id: string; kind: 'initiative' | 'park'; strategosIds: string[]; key?: string }

export interface InitiativesDeps {
  manager: SessionManager;
  store: StateStore;
  hub: WsHub;
  git: Pick<Git, 'defaultBase'>;
  now?: () => number;
  /** Delay before re-reading the sessions after a change (default 1000 ms). */
  debounceMs?: number;
  onError?: (what: string, err: unknown) => void;
}

export interface Initiatives {
  upsert(i: Initiative): Initiative;
  assign(strategosId: string, initiativeId: string | null): void;
  /** The usage tracker's (or any other) suggestion: remember it so it can be answered, then it is published by the caller. */
  remember(e: BookEntry): void;
  respond(id: string, accept: boolean): { ok: true } | { ok: false; error: string };
  missionStart(initiativeId: string, sessions: { repoPath: string; branch: string; firstPrompt: string }[]): Promise<{ started: string[]; failed: { branch: string; error: string }[] }>;
  /** Look at the sessions now and publish new initiative suggestions. */
  evaluate(): void;
  start(): void;
  stop(): void;
  pending(): BookEntry[];
}

const HEX = /^#[0-9a-f]{3,8}$/i;

export function createInitiatives(deps: InitiativesDeps): Initiatives {
  const { manager: m, store, hub } = deps;
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? (() => undefined);
  const book = new Map<string, BookEntry>();
  const offered = new Set<string>(); // ids published in this run: each only once
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const dismissed = (): ReadonlySet<string> => new Set(store.get().dismissedSuggestions);
  const remember = (id: string): void => { if (!dismissed().has(id)) store.update((st) => { st.dismissedSuggestions.push(id); }); };
  const publishInitiatives = (): void => { hub.publish({ t: 'initiatives', initiatives: store.get().initiatives }); };

  function validate(i: Initiative): Initiative {
    const name = i.name.trim();
    if (name === '' || name.length > 80) throw new Error('An initiative needs a name of 1 to 80 characters.');
    for (const f of i.contractFiles) {
      if (f.relPath === '' || path.isAbsolute(f.relPath) || f.relPath.split(/[\\/]/).includes('..')) throw new Error(`Contract file "${f.relPath}" must be a path inside the repository.`);
    }
    return { ...i, name, colour: HEX.test(i.colour) ? i.colour : planetColour(name) };
  }

  function upsert(i: Initiative): Initiative {
    const v = validate(i);
    store.update((st) => {
      const k = st.initiatives.findIndex((x) => x.id === v.id);
      if (k >= 0) st.initiatives[k] = { ...v, createdAt: (st.initiatives[k] as Initiative).createdAt };
      else st.initiatives.push(v);
    });
    publishInitiatives();
    return store.get().initiatives.find((x) => x.id === v.id) as Initiative;
  }

  function assign(strategosId: string, initiativeId: string | null): void {
    const s = m.get(strategosId);
    if (s === undefined) throw new Error(`no such session: ${strategosId}`);
    if (initiativeId !== null && !store.get().initiatives.some((x) => x.id === initiativeId)) throw new Error(`no such initiative: ${initiativeId}`);
    const by = { ...s.ringSlotByGroup };
    if (s.initiativeId !== undefined && s.initiativeId !== initiativeId) delete by[s.initiativeId];
    if (initiativeId !== null && by[initiativeId] === undefined) by[initiativeId] = assignRingSlot(m.list(), initiativeId, strategosId);
    m.update(strategosId, { initiativeId: initiativeId ?? undefined, ringSlotByGroup: by });
  }

  function evaluate(): void {
    const gone = dismissed();
    for (const g of guessInitiatives(m.list())) {
      const id = `initiative:${g.key}:${g.strategosIds.join(',')}`;
      if (gone.has(id) || gone.has(`initiative-key:${g.key}`) || offered.has(id)) continue;
      for (const [k, e] of book) if (e.kind === 'initiative' && e.key === g.key) book.delete(k); // superseded by the newer group
      offered.add(id);
      book.set(id, { id, kind: 'initiative', strategosIds: g.strategosIds, key: g.key });
      hub.publish({
        t: 'suggestion', id, kind: 'initiative', strategosIds: g.strategosIds,
        text: `These ${g.strategosIds.length} sessions look like one piece of work, "${titleCase(g.key)}" (${g.branches.join(', ')}). Group them as an initiative?`,
      });
    }
  }

  function respond(id: string, accept: boolean): { ok: true } | { ok: false; error: string } {
    const e = book.get(id);
    if (e === undefined) return { ok: false, error: 'That suggestion is no longer current.' };
    book.delete(id);
    if (!accept) {
      remember(id);
      if (e.key !== undefined) remember(`initiative-key:${e.key}`);
      return { ok: true };
    }
    if (e.kind === 'park') {
      for (const sid of e.strategosIds) {
        const s = m.get(sid);
        if (s?.pty !== undefined) m.park(sid).catch((err: unknown) => { onError(`park ${sid}`, err); });
      }
      return { ok: true };
    }
    const name = titleCase(e.key ?? 'Initiative');
    const ini = upsert({ id: randomUUID(), name, colour: planetColour(name), createdAt: now(), contractFiles: [], archived: false });
    for (const sid of e.strategosIds) if (m.get(sid) !== undefined) assign(sid, ini.id);
    return { ok: true };
  }

  async function missionStart(initiativeId: string, specs: { repoPath: string; branch: string; firstPrompt: string }[]) {
    const ini = store.get().initiatives.find((x) => x.id === initiativeId);
    if (ini === undefined) throw new Error(`no such initiative: ${initiativeId}`);
    if (ini.archived) throw new Error(`The initiative "${ini.name}" is archived.`);
    const started: string[] = [];
    const failed: { branch: string; error: string }[] = [];
    let lead: string | undefined;
    for (const spec of specs) {
      try {
        const base = await deps.git.defaultBase(spec.repoPath);
        if (base === undefined) throw new Error('No base branch found in this repository (looked for origin/HEAD, main and master).');
        const rec = await m.start({
          repoPath: spec.repoPath,
          worktree: { name: worktreeNameOf(spec.branch), branch: spec.branch, base },
          firstPrompt: spec.firstPrompt,
          name: `${ini.name}: ${planetLabel(path.basename(path.resolve(spec.repoPath)))}`,
          initiativeId,
          ...(lead === undefined ? {} : { parentId: lead }),
        });
        lead ??= rec.strategosId;
        assign(rec.strategosId, initiativeId); // fills the ring slot for the initiative group
        started.push(rec.strategosId);
      } catch (err) {
        failed.push({ branch: spec.branch, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { started, failed };
  }

  return {
    upsert, assign, respond, missionStart, evaluate,
    remember: (e) => { book.set(e.id, e); },
    pending: () => [...book.values()],
    start() {
      if (unsubscribe !== undefined) return;
      const schedule = (): void => {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          try { evaluate(); } catch (err) { onError('initiative suggestions', err); }
        }, deps.debounceMs ?? 1000);
        timer.unref();
      };
      unsubscribe = m.onChange(schedule);
      schedule();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export function registerInitiativeCommands(hub: WsHub, ini: Initiatives): void {
  const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
  hub.registerCommand('initiative.upsert', (c) => {
    try { ini.upsert(c.initiative); } catch (e) { return fail(e); }
  });
  hub.registerCommand('initiative.assign', (c) => {
    try { ini.assign(c.strategosId, c.initiativeId); } catch (e) { return fail(e); }
  });
  hub.registerCommand('suggestion.respond', (c) => {
    const r = ini.respond(c.id, c.accept);
    if (!r.ok) return r;
  });
  hub.registerCommand('mission.start', async (c) => {
    try {
      const r = await ini.missionStart(c.initiativeId, c.sessions);
      if (r.failed.length > 0) return { ok: false, error: `Started ${r.started.length} of ${c.sessions.length}. ${r.failed.map((f) => `${f.branch}: ${f.error}`).join(' | ')}` };
    } catch (e) { return fail(e); }
  });
}
