import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import './test/cleanup.ts';
import { App } from './app.tsx';
import { expanded } from './drawer/pending-actions.ts';
import { now } from './state/clock.ts';
import { store } from './state/store.ts';
import { drawerOpen, newSessionOpen, selectedId, stopTarget, view } from './state/ui.ts';
import { installFakeTransport, type FakeTransport } from './test/fakes.ts';
import { makePending, makeSession, T0 } from './test/fixtures.ts';

// The real TerminalPane needs xterm; this file tests the app shell around it.
vi.mock('./drawer/TerminalPane.tsx', () => ({ TerminalPane: ({ strategosId }: { strategosId: string }) => <div data-testid="term">{strategosId}</div> }));

let t: FakeTransport;
// The top bar asks for today's digest whenever it syncs; that is not what these tests are about.
const sent = () => t.sent.filter((c) => c.c !== 'digest.get');
beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 5 * 60_000;
  view.value = 'list'; // these tests cover the list view and the shell; the Map has its own tests
  selectedId.value = null;
  drawerOpen.value = false;
  newSessionOpen.value = false;
  stopTarget.value = null;
  expanded.value = new Set();
});
afterEach(() => {
  store.applyEvent({ t: 'snapshot', seq: 0, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value });
  store.connection.value = 'connecting';
});

const load = (sessions: ReturnType<typeof makeSession>[], seq = 1) =>
  store.applyEvent({ t: 'snapshot', seq, sessions, planets: [], initiatives: [], prefs: store.prefs.value });
const pressKey = async (key: string, init: KeyboardEventInit = {}) => {
  await act(() => { fireEvent.keyDown(document.body, { key, ...init }); });
};

test('renders the app name and re-renders when the store changes', async () => {
  render(<App />);
  expect(screen.getByText('Strategos')).toBeTruthy();
  await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha' })]); });
  expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
});

test('title badge counts what needs you', async () => {
  render(<App />);
  await act(() => { load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending() })]); });
  expect(document.title).toBe('(1) Strategos');
  await act(() => { load([makeSession({ strategosId: 'a', status: 'working' })], 2); });
  expect(document.title).toBe('Strategos');
});

test('the polite live region announces a session that newly needs you', async () => {
  render(<App />);
  await act(() => { load([]); });
  await act(() => {
    store.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'permission', pending: makePending() }) });
  });
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Alpha needs permission');
});

test('keys a / d / A act on the selected request', async () => {
  render(<App />);
  await act(() => {
    load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'r1', suggestions: [{}] }) })]);
    selectedId.value = 'a';
  });
  await pressKey('a');
  expect(sent().at(-1)).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'r1', decision: 'allow' });
  await pressKey('A');
  expect(sent().at(-1)).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'r1', decision: 'always', suggestionIndex: 0 });
  await pressKey('d');
  expect(drawerOpen.value).toBe(true);
  expect(document.activeElement).toBe(screen.getByLabelText('Deny message (optional)'));
});

test('key a on a truncated request opens the full card instead of approving', async () => {
  render(<App />);
  await act(() => {
    load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'r1', inputTruncated: true }) })]);
    selectedId.value = 'a';
  });
  await pressKey('a');
  expect(sent().some((c) => c.c === 'perm.decide')).toBe(false);
  expect(drawerOpen.value).toBe(true);
});

test('keys do nothing while typing in a field', async () => {
  render(<App />);
  await act(() => {
    load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending() })]);
    selectedId.value = 'a';
    drawerOpen.value = true;
  });
  const box = screen.getByLabelText('Deny message (optional)');
  await act(() => { fireEvent.keyDown(box, { key: 'a' }); });
  expect(sent()).toEqual([]);
});

test('c opens the New session dialog; it sends session.start', async () => {
  render(<App />);
  await pressKey('c');
  fireEvent.input(screen.getByLabelText(/Repository folder/), { target: { value: 'C:\\dev\\proj' } });
  fireEvent.input(screen.getByLabelText(/First prompt/), { target: { value: 'fix the build' } });
  fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'Build fix' } });
  await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
  expect(sent()).toEqual([{ c: 'session.start', repoPath: 'C:\\dev\\proj', firstPrompt: 'fix the build', name: 'Build fix' }]);
  await waitFor(() => expect(newSessionOpen.value).toBe(false));
});

test('New session needs a repo and shows the daemon error', async () => {
  render(<App />);
  await pressKey('c');
  await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Enter the repository folder'));
  expect(sent()).toEqual([]);
  t.failNext('not a git repository');
  fireEvent.input(screen.getByLabelText(/Repository folder/), { target: { value: 'C:\\x' } });
  await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not a git repository'));
  expect(newSessionOpen.value).toBe(true);
});

test('Stop asks first, then sends session.stop', async () => {
  render(<App />);
  await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'working' })]); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(sent()).toEqual([]);
  await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Stop session' })); });
  expect(sent()).toEqual([{ c: 'session.stop', strategosId: 'a' }]);
  await waitFor(() => expect(stopTarget.value).toBeNull());
});

test('Cancel in the stop dialog sends nothing', async () => {
  render(<App />);
  await act(() => { load([makeSession({ strategosId: 'a', status: 'working' })]); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(sent()).toEqual([]);
});

test('the drawer header follows live updates, and tabs switch', async () => {
  render(<App />);
  await act(() => {
    load([makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'working', cost: { lineageUsd: 1, byClaudeSession: {} } })]);
    selectedId.value = 'a';
    drawerOpen.value = true;
  });
  const drawer = screen.getByRole('complementary', { name: 'Session Alpha' });
  expect(drawer.textContent).toContain('$1.00');
  expect(screen.getByTestId('term').textContent).toBe('a');
  await act(() => {
    store.applyEvent({ t: 'session.upsert', seq: 2, session: makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'working', cost: { lineageUsd: 2.5, byClaudeSession: {} }, last: 'new message' }) });
  });
  expect(drawer.textContent).toContain('$2.50');
  expect(drawer.textContent).toContain('new message');
  fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(/chat view comes in a later milestone/)).toBeTruthy();
  expect(screen.getByTestId('term')).toBeTruthy(); // the terminal stays mounted behind the other tab
});

test('Escape closes the drawer', async () => {
  render(<App />);
  await act(() => { load([makeSession({ strategosId: 'a' })]); selectedId.value = 'a'; drawerOpen.value = true; });
  await pressKey('Escape');
  expect(drawerOpen.value).toBe(false);
});

test('the connection state is visible', async () => {
  render(<App />);
  await act(() => { store.connection.value = 'reconnecting'; });
  expect(screen.getByText(/Daemon unreachable, reconnecting/)).toBeTruthy();
});
