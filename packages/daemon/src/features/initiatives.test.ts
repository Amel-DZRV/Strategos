import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, Initiative, SessionRecord, StartOptions } from '@strategos/shared';
import { emptyState, type StateFile, type StateStore } from '../store/state-store.ts';
import type { WsHub } from '../server/ws-hub.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { branchKey, createInitiatives, guessInitiatives, worktreeNameOf } from './initiatives.ts';

function rec(id: string, branch: string | undefined, o: Partial<SessionRecord> = {}): SessionRecord {
  return {
    strategosId: id, name: id, cwd: `/r/${id}`, ...(branch === undefined ? {} : { branch }), ringSlotByGroup: {}, archived: false, pty: { pid: 1, cols: 1, rows: 1, dirtyInput: false }, ...o,
  } as SessionRecord;
}

describe('branchKey', () => {
  it('drops type words and generic words, keeps the first real word', () => {
    expect(branchKey('feat/checkout-ui')).toBe('checkout');
    expect(branchKey('fix/checkout-api')).toBe('checkout');
    expect(branchKey('claude/add-checkout_flow')).toBe('checkout');
  });
  it('a ticket id is the key, so the same ticket groups across repos and different tickets do not', () => {
    expect(branchKey('feat/ENG-123-login')).toBe('eng-123');
    expect(branchKey('fix/eng-123-api')).toBe('eng-123');
    expect(branchKey('feat/ENG-124-signup')).toBe('eng-124');
  });
  it('generic or short branches have no key', () => {
    for (const b of ['main', 'master', 'develop', 'wip', 'fix/typo', 'feat/add-x', 'release', '']) expect(branchKey(b), b).toBeUndefined();
    expect(branchKey(undefined)).toBeUndefined();
  });
});

describe('guessInitiatives', () => {
  it('groups two or more sessions without an initiative; archived and already-grouped ones are left alone', () => {
    const g = guessInitiatives([
      rec('a', 'feat/checkout-ui'), rec('b', 'feat/checkout-api'), rec('c', 'feat/search'),
      rec('d', 'feat/payments-x', { initiativeId: 'i' }), rec('e', 'feat/payments-y'), rec('f', 'feat/payments-z', { archived: true }),
    ]);
    expect(g).toEqual([{ key: 'checkout', strategosIds: ['a', 'b'], branches: ['feat/checkout-ui', 'feat/checkout-api'] }]);
  });
  it('prefers the live git branch over the stale record branch', () => {
    const g = guessInitiatives([rec('a', 'main', { git: { branch: 'feat/billing-a', at: 1 } }), rec('b', 'feat/billing-b')]);
    expect(g[0]?.key).toBe('billing');
  });
});

describe('worktreeNameOf', () => {
  it('makes one safe folder name out of a branch', () => {
    expect(worktreeNameOf('feat/checkout-ui')).toBe('feat-checkout-ui');
    expect(worktreeNameOf('../../etc')).toBe('etc');
    expect(worktreeNameOf('///')).toBe('work');
    expect(worktreeNameOf('a b:c*')).toBe('a-b-c-');
  });
});

// ---- the book, with a stub manager ----------------------------------------------

function rig(sessions: SessionRecord[], initiatives: Initiative[] = []) {
  const map = new Map(sessions.map((s) => [s.strategosId, s]));
  const state: StateFile = { ...emptyState(), initiatives: [...initiatives] };
  const store = { get: () => state, update: (f: (s: StateFile) => void | StateFile) => { const r = f(state); if (r !== undefined) Object.assign(state, r); } } as unknown as StateStore;
  const events: DaemonEvent[] = [];
  const hub = { publish: (d: object) => { events.push(d as DaemonEvent); return 1; } } as unknown as WsHub;
  const parked: string[] = [];
  const started: StartOptions[] = [];
  const manager = {
    list: () => [...map.values()], get: (id: string) => map.get(id),
    update: (id: string, p: Partial<SessionRecord>) => { const s = map.get(id); if (s === undefined) return undefined; const n = { ...s, ...p }; map.set(id, n); return n; },
    park: (id: string) => { parked.push(id); return Promise.resolve(); },
    onChange: () => () => undefined,
    start: vi.fn((o: StartOptions) => {
      if (o.worktree?.branch === 'taken') return Promise.reject(new Error('The branch "taken" already exists.'));
      const r = rec(`s${started.length + 1}`, o.worktree?.branch, { ...(o.initiativeId === undefined ? {} : { initiativeId: o.initiativeId }), ...(o.parentId === undefined ? {} : { parentId: o.parentId }), name: o.name ?? '' });
      started.push(o);
      map.set(r.strategosId, r);
      return Promise.resolve(r);
    }),
  } as unknown as SessionManager;
  const ini = createInitiatives({ manager, store, hub, git: { defaultBase: (cwd) => Promise.resolve(cwd.includes('nobase') ? undefined : 'main') }, now: () => 5 });
  const suggestions = (): Extract<DaemonEvent, { t: 'suggestion' }>[] => events.filter((e): e is Extract<DaemonEvent, { t: 'suggestion' }> => e.t === 'suggestion');
  return { ini, map, state, events, parked, started, suggestions };
}

const INI: Initiative = { id: 'i1', name: 'Checkout', colour: '#112233', createdAt: 1, contractFiles: [], archived: false };

describe('initiative.upsert and assign', () => {
  it('stores and publishes; keeps createdAt on update; validates', () => {
    const r = rig([]);
    r.ini.upsert(INI);
    r.ini.upsert({ ...INI, name: ' Checkout v2 ', createdAt: 99, colour: 'red' });
    expect(r.state.initiatives).toHaveLength(1);
    expect(r.state.initiatives[0]).toMatchObject({ id: 'i1', name: 'Checkout v2', createdAt: 1 });
    expect(r.state.initiatives[0]?.colour).toMatch(/^#[0-9a-f]{6}$/i); // a bad colour is replaced
    expect(r.events.filter((e) => e.t === 'initiatives')).toHaveLength(2);
    expect(() => r.ini.upsert({ ...INI, name: '  ' })).toThrow(/name/);
    expect(() => r.ini.upsert({ ...INI, contractFiles: [{ planetKey: 'p', relPath: '../secrets' }] })).toThrow(/inside the repository/);
    expect(() => r.ini.upsert({ ...INI, contractFiles: [{ planetKey: 'p', relPath: '/etc/passwd' }] })).toThrow(/inside the repository/);
  });

  it('assign sets the id and a sticky ring slot per initiative, null clears both, unknown ids are refused', () => {
    const r = rig([rec('a', 'x'), rec('b', 'y')], [INI]);
    r.ini.assign('a', 'i1');
    r.ini.assign('b', 'i1');
    expect(r.map.get('a')).toMatchObject({ initiativeId: 'i1', ringSlotByGroup: { i1: 0 } });
    expect(r.map.get('b')?.ringSlotByGroup).toEqual({ i1: 1 });
    r.ini.assign('a', null);
    expect(r.map.get('a')?.initiativeId).toBeUndefined();
    expect(r.map.get('a')?.ringSlotByGroup).toEqual({});
    expect(() => r.ini.assign('a', 'nope')).toThrow(/no such initiative/);
    expect(() => r.ini.assign('zzz', 'i1')).toThrow(/no such session/);
  });
});

describe('suggestions never apply by themselves', () => {
  const two = (): SessionRecord[] => [rec('a', 'feat/checkout-ui'), rec('b', 'feat/checkout-api')];

  it('publishes once, applies nothing, and a re-evaluation does not repeat it', () => {
    const r = rig(two());
    r.ini.evaluate();
    r.ini.evaluate();
    expect(r.suggestions()).toHaveLength(1);
    expect(r.suggestions()[0]).toMatchObject({ kind: 'initiative', strategosIds: ['a', 'b'] });
    expect(r.suggestions()[0]?.text).toMatch(/Checkout/);
    expect(r.state.initiatives).toEqual([]);
    expect(r.map.get('a')?.initiativeId).toBeUndefined();
  });

  it('accept creates the initiative and assigns the listed sessions', () => {
    const r = rig(two());
    r.ini.evaluate();
    expect(r.ini.respond(r.suggestions()[0]!.id, true)).toEqual({ ok: true });
    expect(r.state.initiatives).toHaveLength(1);
    expect(r.state.initiatives[0]).toMatchObject({ name: 'Checkout', archived: false });
    const id = r.state.initiatives[0]!.id;
    expect(r.map.get('a')?.initiativeId).toBe(id);
    expect(r.map.get('b')?.initiativeId).toBe(id);
    expect(r.ini.respond(r.suggestions()[0]!.id, true)).toMatchObject({ ok: false }); // answered once
  });

  it('dismiss is remembered in state (by id and by key) and the idea does not come back, even with a third session', () => {
    const r = rig(two());
    r.ini.evaluate();
    r.ini.respond(r.suggestions()[0]!.id, false);
    expect(r.state.dismissedSuggestions).toEqual([r.suggestions()[0]!.id, 'initiative-key:checkout']);
    expect(r.state.initiatives).toEqual([]);
    r.map.set('c', rec('c', 'feat/checkout-docs'));
    r.ini.evaluate();
    expect(r.suggestions()).toHaveLength(1);
    // and a fresh daemon with the same state stays quiet
    const again = rig(two());
    again.state.dismissedSuggestions.push(...r.state.dismissedSuggestions);
    again.ini.evaluate();
    expect(again.suggestions()).toHaveLength(0);
  });

  it('a bigger group replaces the older, unanswered suggestion', () => {
    const r = rig(two());
    r.ini.evaluate();
    const first = r.suggestions()[0]!.id;
    r.map.set('c', rec('c', 'feat/checkout-docs'));
    r.ini.evaluate();
    expect(r.suggestions()).toHaveLength(2);
    expect(r.ini.respond(first, true)).toMatchObject({ ok: false });
    expect(r.ini.respond(r.suggestions()[1]!.id, true)).toEqual({ ok: true });
    expect([...r.map.values()].every((s) => s.initiativeId !== undefined)).toBe(true);
  });

  it('accepting a park suggestion parks the listed sessions that have a process, and only those', () => {
    const r = rig([rec('a', 'x'), rec('b', 'y', { pty: undefined }), rec('c', 'z')]);
    r.ini.remember({ id: 'park-1', kind: 'park', strategosIds: ['a', 'b'] });
    expect(r.ini.respond('park-1', true)).toEqual({ ok: true });
    expect(r.parked).toEqual(['a']);
    r.ini.remember({ id: 'park-2', kind: 'park', strategosIds: ['c'] });
    expect(r.ini.respond('park-2', false)).toEqual({ ok: true });
    expect(r.parked).toEqual(['a']); // declined: nothing parked
    expect(r.state.dismissedSuggestions).toContain('park-2');
  });
});

describe('mission.start', () => {
  it('starts every session in its own worktree on its branch, tagged with the initiative; the first is the lead', async () => {
    const r = rig([], [INI]);
    const res = await r.ini.missionStart('i1', [
      { repoPath: 'C:/work/api', branch: 'feat/checkout-api', firstPrompt: 'build the api' },
      { repoPath: 'C:/work/web', branch: 'feat/checkout-ui', firstPrompt: 'build the ui' },
    ]);
    expect(res.failed).toEqual([]);
    expect(res.started).toEqual(['s1', 's2']);
    expect(r.started[0]).toMatchObject({ repoPath: 'C:/work/api', worktree: { name: 'feat-checkout-api', branch: 'feat/checkout-api', base: 'main' }, firstPrompt: 'build the api', initiativeId: 'i1' });
    expect(r.started[0]?.parentId).toBeUndefined();
    expect(r.started[1]?.parentId).toBe('s1');
    expect(r.map.get('s1')?.ringSlotByGroup).toEqual({ i1: 0 });
    expect(r.map.get('s2')?.ringSlotByGroup).toEqual({ i1: 1 });
  });

  it('one failure does not stop the others and is reported per branch', async () => {
    const r = rig([], [INI]);
    const res = await r.ini.missionStart('i1', [
      { repoPath: 'C:/work/api', branch: 'taken', firstPrompt: 'a' },
      { repoPath: 'C:/work/nobase', branch: 'feat/x', firstPrompt: 'b' },
      { repoPath: 'C:/work/web', branch: 'feat/checkout-ui', firstPrompt: 'c' },
    ]);
    expect(res.started).toEqual(['s1']);
    expect(res.failed.map((f) => f.branch)).toEqual(['taken', 'feat/x']);
    expect(res.failed[0]?.error).toMatch(/already exists/);
    expect(res.failed[1]?.error).toMatch(/No base branch/);
    expect(r.started[0]?.parentId).toBeUndefined(); // the lead is the first one that really started
  });

  it('unknown or archived initiatives are refused before anything starts', async () => {
    const r = rig([], [{ ...INI, archived: true }]);
    await expect(r.ini.missionStart('nope', [{ repoPath: 'r', branch: 'b', firstPrompt: 'p' }])).rejects.toThrow(/no such initiative/);
    await expect(r.ini.missionStart('i1', [{ repoPath: 'r', branch: 'b', firstPrompt: 'p' }])).rejects.toThrow(/archived/);
    expect(r.started).toEqual([]);
  });
});
