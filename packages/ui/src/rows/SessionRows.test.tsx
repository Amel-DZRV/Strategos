import { act, fireEvent, render, screen, within } from '@testing-library/preact';
import { glyphFor } from '@strategos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../test/cleanup.ts';
import { now } from '../state/clock.ts';
import { store } from '../state/store.ts';
import { drawerOpen, selectedId, stopTarget } from '../state/ui.ts';
import { installFakeTransport, type FakeTransport } from '../test/fakes.ts';
import { ALL_STATUSES, makePending, makeSession, T0 } from '../test/fixtures.ts';
import { NeedsStrip, SessionRows } from './SessionRows.tsx';
import { statusInfo } from '../format.ts';

let t: FakeTransport;
beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 14 * 60_000;
  selectedId.value = null;
  drawerOpen.value = false;
});
afterEach(() => {
  store.applyEvent({ t: 'snapshot', seq: 0, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value });
});

const load = (sessions: ReturnType<typeof makeSession>[]) =>
  store.applyEvent({ t: 'snapshot', seq: 1, sessions, planets: [], initiatives: [], prefs: store.prefs.value });

describe('SessionRows', () => {
  it.each(ALL_STATUSES)('shows the glyph and a text label for status %s', (status) => {
    load([makeSession({ strategosId: 'a', displayName: 'Alpha', status })]);
    render(<SessionRows />);
    const row = screen.getByRole('listitem');
    const info = statusInfo(status);
    expect(info.glyph).toBe(glyphFor(status));
    expect(within(row).getByText(info.glyph)).toBeTruthy();
    expect(within(row).getByText(info.label)).toBeTruthy(); // never colour alone
    expect(row.getAttribute('aria-label')).toContain(info.label);
  });

  it('shows name, repo and branch, context, cost and last message', () => {
    load([makeSession({
      strategosId: 'a', displayName: 'Alpha', git: { branch: 'feat/x', at: 1 }, ctx: { pct: 71.4, at: 1, source: 'statusline' },
      cost: { lineageUsd: 3.416, byClaudeSession: {} }, last: 'Hello there',
    })]);
    render(<SessionRows />);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Alpha')).toBeTruthy();
    expect(within(row).getByText(/strategos-app · feat\/x/)).toBeTruthy();
    expect(within(row).getByText('71%')).toBeTruthy();
    expect(within(row).getByText('≈$3.42')).toBeTruthy();
    expect(within(row).getByText('Hello there')).toBeTruthy();
  });

  it('shows the waiting time as a number and puts it in the aria-label', () => {
    load([makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'permission', waitingSince: T0, pending: makePending() })]);
    render(<SessionRows />);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(/14m/)).toBeTruthy();
    expect(row.getAttribute('aria-label')).toBe('Alpha, Needs permission, waiting 14m, context unknown');
  });

  it('rows are focusable and Enter opens the drawer', () => {
    load([makeSession({ strategosId: 'a' })]);
    render(<SessionRows />);
    const row = screen.getByRole('listitem');
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(drawerOpen.value).toBe(true);
    expect(selectedId.value).toBe('a');
  });

  it('puts the sessions that need you first', () => {
    load([
      makeSession({ strategosId: 'w', displayName: 'Working one', status: 'working' }),
      makeSession({ strategosId: 'p', displayName: 'Permission one', status: 'permission', waitingSince: T0, pending: makePending() }),
    ]);
    render(<SessionRows />);
    const names = screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label')?.split(',')[0]);
    expect(names).toEqual(['Permission one', 'Working one']);
  });

  it('inline Approve and Deny send perm.decide', async () => {
    load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'r9' }) })]);
    render(<SessionRows />);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(t.sent).toEqual([{ c: 'perm.decide', strategosId: 'a', requestId: 'r9', decision: 'allow' }]);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })); });
    expect(t.sent[1]).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'r9', decision: 'deny' });
  });

  it('inline Approve on a truncated request does not approve', async () => {
    load([makeSession({ strategosId: 'a', status: 'permission', waitingSince: T0, pending: makePending({ requestId: 'rt', inputTruncated: true }) })]);
    render(<SessionRows />);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(t.sent.some((c) => c.c === 'perm.decide')).toBe(false);
    expect(t.sent).toEqual([{ c: 'pending.full', strategosId: 'a', requestId: 'rt' }]);
    expect(drawerOpen.value).toBe(true);
  });

  it('Stop asks for confirmation; Resume shows only for stopped sessions', () => {
    load([
      makeSession({ strategosId: 'a', displayName: 'Live', status: 'working' }),
      makeSession({ strategosId: 'b', displayName: 'Dead', status: 'stopped' }),
    ]);
    render(<SessionRows />);
    const rows = screen.getAllByRole('listitem');
    const live = rows.find((r) => r.getAttribute('aria-label')?.startsWith('Live'))!;
    const dead = rows.find((r) => r.getAttribute('aria-label')?.startsWith('Dead'))!;
    expect(within(live).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(dead).queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(within(live).getByRole('button', { name: 'Stop' }));
    expect(stopTarget.value).toBe('a');
    expect(t.sent).toEqual([]); // nothing sent until confirmed
    fireEvent.click(within(dead).getByRole('button', { name: 'Resume' }));
    expect(t.sent).toEqual([{ c: 'session.resume', strategosId: 'b' }]);
  });
});

describe('NeedsStrip', () => {
  it('says all clear when nothing waits', () => {
    load([makeSession({ strategosId: 'a' })]);
    render(<NeedsStrip />);
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  it('lists needs-you sessions with waiting time', () => {
    load([makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'question', waitingSince: T0 })]);
    render(<NeedsStrip />);
    expect(screen.getByRole('button', { name: /Alpha, Has a question, waiting 14m/ })).toBeTruthy();
  });
});
