// M4/M5 UI features around the app shell: context actions, palette, low-risk batch, notifications, usage gauge, marks.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { Usage } from '@strategos/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './test/cleanup.ts';
import { App } from './app.tsx';
import { ContextActions, contextActionsVisible } from './drawer/ContextActions.tsx';
import { KEY_ACTIONS } from './keys/keymap.ts';
import { resetMapModel } from './map/model.ts';
import { Token } from './map/Token.tsx';
import { clearToasts, handleNotify, permission, toasts } from './notify/notifications.tsx';
import { fuzzyFilter, fuzzyScore } from './palette/fuzzy.ts';
import { paletteCommands } from './palette/commands.ts';
import { shell } from './shell-bridge.ts';
import { now } from './state/clock.ts';
import { startViewFocus } from './state/focus.ts';
import { DEFAULT_PREFS, store } from './state/store.ts';
import { drawerOpen, drawerTab, errorNotice, lowRiskOpen, newSessionOpen, paletteOpen, replyFocusTick, selectedId, view } from './state/ui.ts';
import { installFakeTransport, type FakeTransport } from './test/fakes.ts';
import { makePending, makeSession, T0 } from './test/fixtures.ts';
import { usageTip } from './topbar/UsageGauge.tsx';

vi.mock('./drawer/TerminalPane.tsx', () => ({ TerminalPane: ({ strategosId }: { strategosId: string }) => <div data-testid="term">{strategosId}</div> }));

let t: FakeTransport;
const sent = (c?: string) => t.sent.filter((x) => x.c !== 'digest.get' && (c === undefined || x.c === c));
const load = (sessions: ReturnType<typeof makeSession>[], seq = 1, prefs = store.prefs.value) =>
  store.applyEvent({ t: 'snapshot', seq, sessions, planets: [], initiatives: [], prefs });
const press = async (key: string, init: KeyboardEventInit = {}) => { await act(() => { fireEvent.keyDown(document.body, { key, ...init }); }); };
const idle = (over: Parameters<typeof makeSession>[0] & object = { strategosId: 'a' }) =>
  makeSession({ status: 'done', ctx: { pct: 88, at: T0, source: 'statusline' }, ...over });

beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 5 * 60_000;
  view.value = 'list';
  selectedId.value = null;
  drawerOpen.value = false;
  drawerTab.value = 'term';
  paletteOpen.value = false;
  newSessionOpen.value = false;
  lowRiskOpen.value = false;
  errorNotice.value = '';
  clearToasts();
  resetMapModel();
});
afterEach(() => {
  vi.restoreAllMocks();
  load([], 0, DEFAULT_PREFS);
  store.connection.value = 'connecting';
  store.suggestions.value = [];
});

describe('context-full actions (5.05)', () => {
  it.each([
    ['done', 70, true], ['seen', 85, true], ['done', 69, false], ['working', 90, false], ['permission', 90, false],
    ['question', 90, false], ['interrupted', 90, false], ['stopped', 90, false],
  ] as const)('%s at %i%%: visible = %s', (status, pct, visible) => {
    expect(contextActionsVisible(makeSession({ strategosId: 'a', status, ctx: { pct, at: T0, source: 'statusline' } }))).toBe(visible);
  });

  it('is hidden when the context is unknown', () => {
    expect(contextActionsVisible(makeSession({ strategosId: 'a', status: 'done' }))).toBe(false);
  });

  it('offers Compact and Keepwarm, and Hand off only with the auto-handoff mod', () => {
    const { rerender } = render(<ContextActions session={idle()} />);
    expect(screen.getByRole('button', { name: 'Compact' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '60m' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '90m' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2h' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hand off' })).toBeNull();
    load([], 1, { ...store.prefs.value, mods: { autoHandoff: true } });
    rerender(<ContextActions session={idle()} />);
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeTruthy();
  });

  it('sends the slash commands', async () => {
    load([], 1, { ...store.prefs.value, mods: { autoHandoff: true } });
    render(<ContextActions session={idle()} />);
    for (const name of ['Compact', 'Hand off', '60m', '90m', '2h']) await act(() => { fireEvent.click(screen.getByRole('button', { name })); });
    expect(sent('slash.send').map((c) => (c as { cmd: string }).cmd)).toEqual(['/compact', '/handoff-now', '/keepwarm 60m', '/keepwarm 90m', '/keepwarm 2h']);
  });

  it('shows the daemon refusal', async () => {
    render(<ContextActions session={idle()} />);
    t.failNext('not allowed: busy');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Compact' })); });
    await waitFor(() => expect(errorNotice.value).toContain('not allowed: busy'));
  });

  it('appears in the drawer for an idle session and vanishes mid-turn', async () => {
    render(<App />);
    await act(() => { load([idle({ strategosId: 'a' })]); selectedId.value = 'a'; drawerOpen.value = true; });
    expect(screen.getByRole('button', { name: 'Compact' })).toBeTruthy();
    await act(() => {
      store.applyEvent({ t: 'session.upsert', seq: 2, session: idle({ strategosId: 'a', status: 'working' }) });
    });
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull();
  });
});

describe('keys and tabs', () => {
  it('t toggles terminal and chat without unmounting the terminal', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', status: 'done' })]); selectedId.value = 'a'; drawerOpen.value = true; });
    const term = screen.getByTestId('term');
    await press('t');
    expect(drawerTab.value).toBe('chat');
    expect(screen.getByTestId('term')).toBe(term); // same element: it stayed mounted
    await press('t');
    expect(drawerTab.value).toBe('term');
    expect(screen.getByTestId('term')).toBe(term);
  });

  it('r opens the chat and focuses the reply box when a reply is allowed', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', status: 'done' })]); selectedId.value = 'a'; });
    const before = replyFocusTick.value;
    await press('r');
    expect(replyFocusTick.value).toBe(before + 1);
    expect(drawerTab.value).toBe('chat');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply to this session')));
  });
});

describe('command palette (4.09)', () => {
  it('has a command for every key action', () => {
    const covered = new Set(paletteCommands().map((c) => c.action));
    for (const a of KEY_ACTIONS) expect(covered.has(a.id), `no palette command for ${a.id}`).toBe(true);
  });

  it('opens with Ctrl+K, filters fuzzily, and Enter runs the command', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha' })]); });
    await act(() => { fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true }); });
    const input = screen.getByRole('combobox');
    expect(paletteOpen.value).toBe(true);
    await act(() => { fireEvent.input(input, { target: { value: 'nws' } }); }); // "New session"
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('New session');
    await act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(paletteOpen.value).toBe(false);
    expect(screen.getByRole('dialog', { name: /New session/i })).toBeTruthy();
  });

  it('Escape closes it and a disabled command does not run', async () => {
    render(<App />);
    await act(() => { paletteOpen.value = true; });
    const input = screen.getByRole('combobox');
    await act(() => { fireEvent.input(input, { target: { value: 'approve the selected' } }); });
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-disabled')).toBe('true'); // nothing selected
    await act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(paletteOpen.value).toBe(true);
    expect(sent()).toEqual([]);
    await act(() => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(paletteOpen.value).toBe(false);
  });

  it('keys typed in the palette box do not trigger shortcuts', async () => {
    render(<App />);
    await act(() => { paletteOpen.value = true; });
    await act(() => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'c' }); });
    expect(screen.queryByRole('dialog', { name: /New session/i })).toBeNull();
  });

  it('runs a key action on the selection: approve', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', status: 'permission', pending: makePending({ requestId: 'r9' }) })]); selectedId.value = 'a'; paletteOpen.value = true; });
    const input = screen.getByRole('combobox');
    await act(() => { fireEvent.input(input, { target: { value: 'approve the selected' } }); });
    await act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(sent('perm.decide')).toEqual([{ c: 'perm.decide', strategosId: 'a', requestId: 'r9', decision: 'allow' }]);
  });

  it('fuzzy matching: in-order subsequence, shorter and word-start matches first', () => {
    expect(fuzzyScore('xyz', 'abc')).toBeNull();
    expect(fuzzyScore('nws', 'New session')).not.toBeNull();
    expect(fuzzyFilter(['Show the Map', 'Map', 'Mark seen'], 'map', (s) => s)[0]).toBe('Map');
  });
});

describe('Approve all low-risk (4.03)', () => {
  const perm = (id: string, tool: string, risk: ('read' | 'write' | 'run' | 'delete')[], extra = {}) => makeSession({
    strategosId: id, displayName: `S-${id}`, status: 'permission', waitingSince: T0,
    pending: makePending({ requestId: `req-${id}`, toolName: tool, risk, inputSummary: `src/${id}.ts`, ...extra }),
  });

  it('is hidden when nothing is batch-approvable', async () => {
    render(<App />);
    await act(() => { load([perm('a', 'Bash', ['run']), perm('b', 'Edit', ['write', 'run']), perm('c', 'Read', ['delete'])]); });
    expect(screen.queryByRole('button', { name: /Approve all low-risk/ })).toBeNull();
  });

  it('lists each request in a confirmation and sends exactly those ids', async () => {
    render(<App />);
    await act(() => { load([perm('a', 'Read', ['read']), perm('b', 'Edit', ['write']), perm('c', 'Bash', ['run']), perm('d', 'Write', ['write'])]); });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: /Approve all low-risk \(3\)/ })); });
    const dlg = screen.getByRole('alertdialog');
    const items = within(dlg).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items.join('|')).toContain('S-a');
    expect(items.join('|')).toContain('src/b.ts');
    expect(items.join('|')).not.toContain('S-c');
    expect(sent('perm.approveLowRisk')).toEqual([]); // nothing until confirmed
    await act(() => { fireEvent.click(within(dlg).getByRole('button', { name: 'Approve 3' })); });
    expect(sent('perm.approveLowRisk')).toEqual([{ c: 'perm.approveLowRisk', initiativeId: '*', requestIds: ['req-a', 'req-b', 'req-d'] }]);
    await waitFor(() => expect(within(dlg).getByText(/Sent\./)).toBeTruthy());
  });

  it('shows the daemon refusal and keeps the dialog', async () => {
    render(<App />);
    await act(() => { load([perm('a', 'Read', ['read'])]); lowRiskOpen.value = true; });
    t.failNext('nothing to approve');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Approve 1' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nothing to approve'));
    expect(lowRiskOpen.value).toBe(true);
  });

  it('Cancel sends nothing', async () => {
    render(<App />);
    await act(() => { load([perm('a', 'Read', ['read'])]); lowRiskOpen.value = true; });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(sent('perm.approveLowRisk')).toEqual([]);
    expect(lowRiskOpen.value).toBe(false);
  });
});

describe('notifications (2.09)', () => {
  const notifyEv = (seq: number) => ({ t: 'notify' as const, seq, kind: 'permission' as const, strategosId: 'a', title: 'Alpha needs permission', body: 'Bash: npm test', requestId: 'r1' });

  it('a snapshot never raises a notification, even with sessions waiting', async () => {
    const spy = vi.spyOn(shell, 'notify');
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', status: 'permission', pending: makePending() })]); });
    expect(spy).not.toHaveBeenCalled();
    expect(toasts.value).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  it('a notify event shows a toast and goes to the shell', async () => {
    const spy = vi.spyOn(shell, 'notify').mockImplementation(() => undefined);
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha' })]); });
    await act(() => { store.applyEvent(notifyEv(2)); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ kind: 'permission', strategosId: 'a', title: 'Alpha needs permission', requestId: 'r1' });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).toContain('Bash: npm test');
  });

  it('a repeated seq (resync replay) does not notify twice', async () => {
    const spy = vi.spyOn(shell, 'notify').mockImplementation(() => undefined);
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a' })]); });
    await act(() => { store.applyEvent(notifyEv(2)); store.applyEvent(notifyEv(2)); });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('clicking the toast selects the session and opens its drawer', async () => {
    vi.spyOn(shell, 'notify').mockImplementation(() => undefined);
    const focus = vi.spyOn(shell, 'focusWindow').mockImplementation(() => undefined);
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha' }), makeSession({ strategosId: 'b' })]); selectedId.value = 'b'; });
    await act(() => { store.applyEvent(notifyEv(2)); });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: /Alpha needs permission/ })); });
    expect(selectedId.value).toBe('a');
    expect(drawerOpen.value).toBe(true);
    expect(focus).toHaveBeenCalled();
    expect(toasts.value).toEqual([]);
  });

  it('no desktop notification when the owner turned notifications off, but the toast stays', async () => {
    const spy = vi.spyOn(shell, 'notify').mockImplementation(() => undefined);
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a' })], 1, { ...store.prefs.value, notifications: { ...store.prefs.value.notifications, enabled: false } }); });
    await act(() => { handleNotify(notifyEv(2)); });
    expect(spy).not.toHaveBeenCalled();
    expect(toasts.value).toHaveLength(1);
  });

  it('asks the browser for permission only when the button is clicked', async () => {
    const ask = vi.spyOn(shell, 'requestNotificationPermission').mockResolvedValue('granted');
    permission.value = 'default';
    render(<App />);
    expect(ask).not.toHaveBeenCalled();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Enable notifications' })); });
    expect(ask).toHaveBeenCalledTimes(1);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Enable notifications' })).toBeNull());
  });

  it('title shows the needs-you count', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', status: 'permission', pending: makePending(), waitingSince: T0 }), makeSession({ strategosId: 'b', status: 'question', waitingSince: T0 })]); });
    expect(document.title).toBe('(2) Strategos');
  });
});

describe('view.focus', () => {
  it('tells the daemon which session the open drawer shows, and null when it closes', async () => {
    store.connection.value = 'open';
    load([makeSession({ strategosId: 'a' })]);
    const stop = startViewFocus();
    expect(sent('view.focus')).toEqual([]); // nothing to say yet: a new connection holds null
    await act(() => { selectedId.value = 'a'; drawerOpen.value = true; });
    expect(sent('view.focus')).toEqual([{ c: 'view.focus', strategosId: 'a' }]);
    await act(() => { drawerOpen.value = false; });
    expect(sent('view.focus').at(-1)).toEqual({ c: 'view.focus', strategosId: null });
    stop();
  });

  it('sends null when the window is hidden and the session again when it is shown', async () => {
    store.connection.value = 'open';
    load([makeSession({ strategosId: 'a' })]);
    selectedId.value = 'a';
    drawerOpen.value = true;
    const stop = startViewFocus();
    expect(sent('view.focus')).toEqual([{ c: 'view.focus', strategosId: 'a' }]);
    const vis = vi.spyOn(document, 'visibilityState', 'get');
    vis.mockReturnValue('hidden');
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(sent('view.focus').at(-1)).toEqual({ c: 'view.focus', strategosId: null });
    vis.mockReturnValue('visible');
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(sent('view.focus').at(-1)).toEqual({ c: 'view.focus', strategosId: 'a' });
    stop();
  });

  it('tells a new connection again', async () => {
    store.connection.value = 'open';
    load([makeSession({ strategosId: 'a' })]);
    selectedId.value = 'a';
    drawerOpen.value = true;
    const stop = startViewFocus();
    await act(() => { store.connection.value = 'reconnecting'; });
    await act(() => { store.connection.value = 'open'; });
    expect(sent('view.focus').filter((c) => (c as { strategosId: string | null }).strategosId === 'a')).toHaveLength(2);
    stop();
  });
});

describe('usage gauge and park suggestion (4.08)', () => {
  const usage: Usage = {
    fiveHour: { pct: 62.4, resetsAt: T0 + 5 * 60_000 + 2 * 3_600_000 }, sevenDay: { pct: 31, resetsAt: T0 + 5 * 60_000 + 4 * 86_400_000 },
    burnPctPerHour: 14, etaFull: T0 + 5 * 60_000 + 160 * 60_000, at: T0,
  };

  it('shows both windows with percentages, burn rate and ETA in the tooltip', async () => {
    render(<App />);
    const t1 = Date.now(); // the app clock runs on real time
    const live: Usage = { ...usage, fiveHour: { pct: 62.4, resetsAt: t1 + 7_200_000 }, etaFull: t1 + 160 * 60_000 + 30_000 };
    await act(() => { store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value, usage: live }); });
    const gauge = document.querySelector('.gauge')!;
    expect(gauge.textContent).toContain('62%');
    expect(gauge.textContent).toContain('31%');
    expect(gauge.querySelectorAll('.bar')).toHaveLength(2);
    const tip = within(screen.getByRole('tooltip')).getByText(/Burn rate/);
    expect(tip.textContent).toContain('14%');
    expect(gauge.textContent).toContain('full in 2h 40m');
  });

  it('usageTip lists what the daemon sent and nothing it did not', () => {
    expect(usageTip({ fiveHour: usage.fiveHour!, at: T0 }, T0)).toHaveLength(1);
    expect(usageTip(usage, T0 + 5 * 60_000)).toHaveLength(4);
  });

  it('a park suggestion is a banner; Accept and Dismiss answer it', async () => {
    render(<App />);
    await act(() => { load([]); });
    await act(() => { store.applyEvent({ t: 'suggestion', seq: 2, id: 'sg1', kind: 'park', text: 'Park idle sessions?', strategosIds: ['a'] }); });
    expect(screen.getByText('Park idle sessions?')).toBeTruthy();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Accept' })); });
    expect(sent('suggestion.respond')).toEqual([{ c: 'suggestion.respond', suggestionId: 'sg1', accept: true }]);
    await waitFor(() => expect(screen.queryByText('Park idle sessions?')).toBeNull());

    await act(() => { store.applyEvent({ t: 'suggestion', seq: 3, id: 'sg2', kind: 'park', text: 'Park again?', strategosIds: [] }); });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(sent('suggestion.respond').at(-1)).toEqual({ c: 'suggestion.respond', suggestionId: 'sg2', accept: false });
  });

  it('a refused answer keeps the banner and shows the reason', async () => {
    render(<App />);
    await act(() => { load([]); });
    await act(() => { store.applyEvent({ t: 'suggestion', seq: 2, id: 'sg1', kind: 'park', text: 'Park idle sessions?', strategosIds: [] }); });
    t.failNext('unknown suggestion');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Accept' })); });
    await waitFor(() => expect(errorNotice.value).toContain('unknown suggestion'));
    expect(screen.getByText('Park idle sessions?')).toBeTruthy();
  });

  it('an initiative suggestion is a banner; Accept and Dismiss answer it by suggestionId, nothing is applied by itself', async () => {
    render(<App />);
    await act(() => { load([]); });
    await act(() => { store.applyEvent({ t: 'suggestion', seq: 2, id: 'sg9', kind: 'initiative', text: 'These 3 sessions look related: checkout — group them?', strategosIds: ['a', 'b', 'c'] }); });
    expect(screen.getByText(/look related: checkout/)).toBeTruthy();
    expect(sent('initiative.upsert')).toEqual([]);
    expect(sent('initiative.assign')).toEqual([]);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Accept' })); });
    expect(sent('suggestion.respond')).toEqual([{ c: 'suggestion.respond', suggestionId: 'sg9', accept: true }]);
    await waitFor(() => expect(screen.queryByText(/look related/)).toBeNull());
    await act(() => { store.applyEvent({ t: 'suggestion', seq: 3, id: 'sg10', kind: 'initiative', text: 'Group these?', strategosIds: [] }); });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(sent('suggestion.respond').at(-1)).toEqual({ c: 'suggestion.respond', suggestionId: 'sg10', accept: false });
  });
});

describe('marks on the token (4.04)', () => {
  const tok = (flags: Parameters<typeof makeSession>[0]['flags']) => ({
    id: 'a', group: 'g', slot: 0, x: 100, y: 100, session: makeSession({ strategosId: 'a', ...(flags ? { flags } : {}) }),
  });
  const draw = (flags?: Parameters<typeof makeSession>[0]['flags']) => render(
    <svg><Token t={tok(flags)} selected={false} dimmed={false} reduced={false} nowMs={T0} tabbable onActivate={() => undefined} onFocusToken={() => undefined} onHover={() => undefined} /></svg>,
  );

  it('no guard mark without denials', () => {
    expect(draw().container.querySelector('.mark-guard')).toBeNull();
  });

  it('a guard mark with the number of blocked commands in its tooltip', () => {
    const { container } = draw({ conflicts: [], contractChanged: [], guardDenials: 3 });
    expect(container.querySelector('.mark-guard title')?.textContent).toBe('3 commands blocked by safety rules');
  });

  it('singular', () => {
    const { container } = draw({ conflicts: [], contractChanged: [], guardDenials: 1 });
    expect(container.querySelector('.mark-guard title')?.textContent).toBe('1 command blocked by safety rules');
  });

  it('the conflict mark still shows for a conflict', () => {
    expect(draw({ conflicts: [{ file: 'a.ts', other: 'b', at: T0 }], contractChanged: [], guardDenials: 0 }).container.querySelector('.mark-conflict')).toBeTruthy();
  });
});
