import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '../test/cleanup.ts';
import { App } from '../app.tsx';
import { now } from '../state/clock.ts';
import { store } from '../state/store.ts';
import { drawerOpen, drawerTab, selectedId, setGroupBy, view } from '../state/ui.ts';
import { installFakeTransport, type FakeTransport } from '../test/fakes.ts';
import { ALL_STATUSES, makePending, makeSession, T0 } from '../test/fixtures.ts';
import { resetMapModel, scene } from './model.ts';
import { NeedsStrip } from './NeedsStrip.tsx';
import { pulseSeconds, Token } from './Token.tsx';
import type { TokenScene } from './scene.ts';

vi.mock('../drawer/TerminalPane.tsx', () => ({ TerminalPane: () => <div data-testid="term" /> }));

let t: FakeTransport;
beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 5 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(T0 + 5 * 60_000);
  view.value = 'map';
  setGroupBy('repo');
  selectedId.value = null;
  drawerOpen.value = false;
  drawerTab.value = 'term';
  resetMapModel();
});
afterEach(() => {
  vi.restoreAllMocks();
  store.applyEvent({ t: 'snapshot', seq: 0, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value });
});

const load = (sessions: ReturnType<typeof makeSession>[], seq = 1) =>
  store.applyEvent({ t: 'snapshot', seq, sessions, planets: [], initiatives: [], prefs: store.prefs.value });
const press = async (key: string, init: KeyboardEventInit = {}) => { await act(() => { fireEvent.keyDown(document.body, { key, ...init }); }); };

function tokenScene(over: Parameters<typeof makeSession>[0]): TokenScene {
  return { id: over.strategosId, group: 'g', slot: 0, x: 100, y: 100, session: makeSession(over) };
}

describe('Token', () => {
  test.each(ALL_STATUSES)('SVG snapshot for status %s', (status) => {
    const needs = ['permission', 'question', 'errored', 'trust_pending', 'interrupted', 'done'].includes(status);
    const s = tokenScene({
      strategosId: 'a', displayName: 'Alpha', status, ctx: { pct: 71, at: T0, source: 'statusline' },
      ...(needs ? { waitingSince: T0 } : {}), ...(status === 'permission' ? { pending: makePending() } : {}),
    });
    const { container } = render(<svg><Token t={s} selected={false} dimmed={false} reduced={false} nowMs={T0 + 5 * 60_000} tabbable onActivate={() => undefined} onFocusToken={() => undefined} onHover={() => undefined} /></svg>);
    expect(container.innerHTML).toMatchSnapshot();
  });

  test('glyph and text label together, a dashed ring and "probably" when the status is inferred', () => {
    const s = tokenScene({ strategosId: 'a', status: 'working', statusSource: 'transcript' });
    const { container } = render(<svg><Token t={s} selected dimmed={false} reduced={false} nowMs={T0} tabbable onActivate={() => undefined} onFocusToken={() => undefined} onHover={() => undefined} /></svg>);
    expect(container.querySelector('.ring')?.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(container.textContent).toContain('probably');
    expect(container.querySelector('.selring')).toBeTruthy();
    expect(container.querySelector('[role=button]')?.getAttribute('aria-label')).toContain('probably');
  });

  test('context arc: blue, amber at 70, red at 85, hollow when unknown', () => {
    const arc = (pct: number | null) => {
      const s = tokenScene({ strategosId: 'a', ctx: { pct, at: T0, source: 'statusline' } });
      const { container, unmount } = render(<svg><Token t={s} selected={false} dimmed={false} reduced={false} nowMs={T0} tabbable onActivate={() => undefined} onFocusToken={() => undefined} onHover={() => undefined} /></svg>);
      const r = [container.querySelector('.ctx')?.getAttribute('stroke') ?? null, !!container.querySelector('.ctx-null')];
      unmount();
      return r;
    };
    expect(arc(40)).toEqual(['var(--c-work)', false]);
    expect(arc(70)).toEqual(['var(--c-reply)', false]);
    expect(arc(88)).toEqual(['var(--c-approve)', false]);
    expect(arc(null)).toEqual([null, true]);
  });

  test('reduced motion: no pulse and a 4.5 ring; the waiting number stays', () => {
    const s = tokenScene({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending() });
    const draw = (reduced: boolean) => render(<svg><Token t={s} selected={false} dimmed={false} reduced={reduced} nowMs={T0 + 60_000} tabbable onActivate={() => undefined} onFocusToken={() => undefined} onHover={() => undefined} /></svg>).container;
    const normal = draw(false);
    expect(normal.querySelector('.pulse')).toBeTruthy();
    expect(normal.querySelector('.ring')?.getAttribute('stroke-width')).toBe('3');
    cleanup();
    const c = draw(true);
    expect(c.querySelector('.pulse')).toBeNull();
    expect(c.querySelector('.ring')?.getAttribute('stroke-width')).toBe('4.5');
    expect(c.textContent).toContain('1m');
  });

  test('pulse speeds up at 5 and 15 minutes', () => {
    expect([0, 4, 5, 14, 15, 60].map((m) => pulseSeconds(m * 60_000))).toEqual([1.9, 1.9, 1.2, 1.2, 0.7, 0.7]);
  });
});

describe('NeedsStrip', () => {
  test('orders by rule 5: permission, question, errored, interrupted, done; oldest first within a tier', () => {
    load([
      makeSession({ strategosId: 'd', displayName: 'D done', status: 'done', doneAt: T0, statusSince: T0 }),
      makeSession({ strategosId: 'i', displayName: 'I interrupted', status: 'interrupted', waitingSince: T0 }),
      makeSession({ strategosId: 'e', displayName: 'E errored', status: 'errored', waitingSince: T0 }),
      makeSession({ strategosId: 'q', displayName: 'Q question', status: 'question', waitingSince: T0, pending: makePending({ kind: 'question', toolName: 'AskUserQuestion' }) }),
      makeSession({ strategosId: 'p2', displayName: 'P2 newer', status: 'permission', waitingSince: T0 + 60_000, pending: makePending({ requestId: 'r2' }) }),
      makeSession({ strategosId: 'p1', displayName: 'P1 older', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'r1' }) }),
      makeSession({ strategosId: 'w', displayName: 'W working', status: 'working' }),
    ]);
    render(<NeedsStrip />);
    const order = [...document.querySelectorAll<HTMLElement>('.nchip')].map((e) => e.dataset['sid']);
    expect(order).toEqual(['p1', 'p2', 'q', 'e', 'i', 'd']);
  });

  test('chips are compact (name, repo and wait; no command or Approve); a click selects and opens the drawer', async () => {
    const long = 'x'.repeat(390);
    load([
      makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'r1', inputSummary: long, risk: ['network', 'run'] }) }),
      makeSession({ strategosId: 'b', displayName: 'Beta', status: 'permission', waitingSince: T0 + 1, pending: makePending({ requestId: 'r2', inputTruncated: true }) }),
    ]);
    render(<NeedsStrip />);
    const chipA = document.querySelector<HTMLElement>('.nchip[data-sid=a]')!;
    expect(chipA.textContent).not.toContain(long);
    expect(within(chipA).queryByText('NET')).toBeNull();
    expect(document.querySelector('.nchip button, .nchip .mbtn')).toBeNull();
    expect(chipA.textContent).toContain('Alpha');
    expect(chipA.textContent).toMatch(/waiting [0-9]+m/);
    await act(() => { fireEvent.click(chipA); });
    expect(selectedId.value).toBe('a');
    expect(drawerOpen.value).toBe(true);
    expect(t.sent.filter((c) => c.c === 'perm.decide').length).toBe(0);
    expect(chipA.classList.contains('on')).toBe(true);
  });
});

describe('Map in the app', () => {
  const three = () => [
    makeSession({ strategosId: 'a', displayName: 'Alpha', planetKey: 'repo-one', status: 'working', createdAt: 1 }),
    makeSession({ strategosId: 'b', displayName: 'Beta', planetKey: 'repo-one', status: 'working', createdAt: 2 }),
    makeSession({ strategosId: 'c', displayName: 'Gamma', planetKey: 'repo-two', status: 'working', createdAt: 3 }),
  ];

  test('the Map is the home screen; tokens are focusable buttons with aria labels; List is secondary', async () => {
    render(<App />);
    await act(() => { load(three()); });
    const tok = screen.getByRole('button', { name: /^Alpha, Working/ });
    expect(tok.getAttribute('tabindex')).toBe('0');
    expect(screen.getAllByRole('button', { name: /, Working/ }).filter((e) => e.getAttribute('tabindex') === '0').length).toBe(1);
    expect(document.querySelector('.rows')).toBeNull();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await act(() => { fireEvent.click(screen.getByRole('menuitemradio', { name: /^List/ })); });
    expect(document.querySelector('.rows')).toBeTruthy();
    await press('L');
    expect(view.value).toBe('map');
  });

  test('Enter opens the drawer for the selected token, Esc closes it', async () => {
    render(<App />);
    await act(() => { load(three()); });
    const tok = screen.getByRole('button', { name: /^Alpha, Working/ });
    await act(() => { fireEvent.keyDown(tok, { key: 'Enter' }); });
    expect(drawerOpen.value).toBe(true);
    expect(selectedId.value).toBe('a');
    await press('Escape');
    expect(drawerOpen.value).toBe(false);
  });

  test('arrow keys and h j k l move the selection to the nearest token in that direction', async () => {
    render(<App />);
    await act(() => { load(three()); });
    const sc = scene.value;
    const pos = (id: string) => sc.tokens.find((x) => x.id === id)!;
    await act(() => { selectedId.value = 'a'; });
    // 'a' (slot 0, top) and 'b' (slot 1, bottom) share a planet; 'c' sits on the other planet
    expect(pos('b').y).toBeGreaterThan(pos('a').y);
    await press('j');
    expect(selectedId.value).toBe('b');
    await press('k');
    expect(selectedId.value).toBe('a');
    const dirToC = pos('c').x > pos('a').x ? 'ArrowRight' : 'ArrowLeft';
    await press(dirToC);
    expect(['b', 'c']).toContain(selectedId.value);
    await press('k'); // nothing above the top-most one: stays
    const top = [...sc.tokens].sort((p, q) => p.y - q.y)[0]!.id;
    await act(() => { selectedId.value = top; });
    await press('ArrowUp');
    expect(selectedId.value).toBe(top);
  });

  test('n and Shift+N walk the sessions that need you; a, d, 1-9, t, v, x, g, ? do their jobs', async () => {
    render(<App />);
    await act(() => {
      load([
        makeSession({ strategosId: 'p', displayName: 'Perm', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'rp' }) }),
        makeSession({
          strategosId: 'q', displayName: 'Ques', status: 'question', waitingSince: T0 + 1,
          pending: makePending({ requestId: 'rq', kind: 'question', toolName: 'AskUserQuestion', questions: [{ question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] }),
        }),
      ]);
    });
    await press('n');
    expect(selectedId.value).toBe('p');
    await press('n');
    expect(selectedId.value).toBe('q');
    await press('N');
    expect(selectedId.value).toBe('p');
    await press('a');
    expect(t.sent.at(-1)).toEqual({ c: 'perm.decide', strategosId: 'p', requestId: 'rp', decision: 'allow' });
    await press('n');
    await press('2');
    expect(t.sent.at(-1)).toEqual({ c: 'question.answer', strategosId: 'q', requestId: 'rq', answers: { 'Which?': 'Two' } });
    expect(drawerOpen.value).toBe(true); // n opens the drawer
    await press('t');
    expect(drawerTab.value).toBe('chat');
    await press('v');
    expect(drawerTab.value).toBe('review');
    await press('x');
    expect(t.sent.at(-1)).toEqual({ c: 'session.seen', strategosId: 'q' });
    await press('g');
    expect(t.sent.at(-1)).toEqual({ c: 'prefs.set', prefs: { groupBy: 'initiative' } });
    await press('?');
    expect(screen.getByRole('dialog', { name: 'Keys' })).toBeTruthy();
    await press('Escape');
    expect(screen.queryByRole('dialog', { name: 'Keys' })).toBeNull();
  });

  test('s and p ask before stopping or parking', async () => {
    render(<App />);
    await act(() => { load(three()); selectedId.value = 'a'; });
    await press('s');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await press('p');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Park session' })); });
    expect(t.sent.at(-1)).toEqual({ c: 'session.park', strategosId: 'a' });
  });

  test('nothing moves when a session is added or stopped (the demo of task 3.0x)', async () => {
    render(<App />);
    const base = three();
    await act(() => { load(base, 1); });
    const before = new Map(scene.value.tokens.map((x) => [x.id, [x.x, x.y]]));
    const planets = new Map(scene.value.planets.map((p) => [p.key, [p.cx, p.cy]]));
    await act(() => { store.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'd', planetKey: 'repo-one', createdAt: 9 }) }); });
    await act(() => { store.applyEvent({ t: 'session.upsert', seq: 3, session: { ...base[0]!, status: 'stopped' } }); });
    await act(() => { store.applyEvent({ t: 'session.removed', seq: 4, strategosId: 'b' }); });
    for (const x of scene.value.tokens) if (before.has(x.id)) expect([x.x, x.y]).toEqual(before.get(x.id));
    for (const p of scene.value.planets) expect([p.cx, p.cy]).toEqual(planets.get(p.key));
  });

  test('more than 8 quiet tokens collapse into +N and expand on click; needs-you tokens never collapse', async () => {
    render(<App />);
    const many = Array.from({ length: 11 }, (_, i) => makeSession({ strategosId: `w${i}`, createdAt: i + 1, status: 'working' }));
    many.push(makeSession({ strategosId: 'np', createdAt: 99, status: 'permission', waitingSince: T0, pending: makePending() }));
    await act(() => { load(many); });
    expect(document.querySelectorAll('.tok[data-status=working]').length).toBe(8);
    expect(document.querySelectorAll('.tok[data-status=permission]').length).toBe(1);
    const more = screen.getByRole('button', { name: /Show 3 more/ });
    expect(more.textContent).toBe('+3');
    await act(() => { fireEvent.click(more); });
    expect(document.querySelectorAll('.tok[data-status=working]').length).toBe(11);
  });

  test('hovering a token of an initiative dims everything else and draws its lines', async () => {
    render(<App />);
    await act(() => { store.applyEvent({ t: 'snapshot', seq: 1, sessions: [
      makeSession({ strategosId: 'a', initiativeId: 'i1', createdAt: 1 }), makeSession({ strategosId: 'b', initiativeId: 'i1', planetKey: 'other', createdAt: 2 }),
      makeSession({ strategosId: 'c', createdAt: 3 }),
    ], planets: [], initiatives: [{ id: 'i1', name: 'Init', colour: '#7b93ff', createdAt: 0, contractFiles: [], archived: false }], prefs: store.prefs.value }); });
    await act(() => { fireEvent.mouseEnter(document.querySelector('.tok[data-sid=a]')!); });
    expect(document.querySelector('.tok[data-sid=c]')?.getAttribute('style')).toContain('opacity: 0.25');
    expect(document.querySelector('.tok[data-sid=b]')?.getAttribute('style')).toContain('opacity: 1');
    expect(document.querySelectorAll('.init-lines line').length).toBe(1);
    await act(() => { fireEvent.mouseLeave(document.querySelector('.tok[data-sid=a]')!); });
    expect(document.querySelector('.init-lines')).toBeNull();
  });
});
