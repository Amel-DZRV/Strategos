import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';
import '../test/cleanup.ts';
import { now } from '../state/clock.ts';
import { errorNotice } from '../state/ui.ts';
import { installFakeTransport, type FakeTransport } from '../test/fakes.ts';
import { makePending, makeSession, T0 } from '../test/fixtures.ts';
import { PendingCard } from './PendingCard.tsx';
import { expanded, fullInput } from './pending-actions.ts';

let t: FakeTransport;
beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 2 * 60_000;
  expanded.value = new Set();
  fullInput.value = {};
  errorNotice.value = '';
});

const perm = (p = {}) => makeSession({ strategosId: 'a', status: 'permission', pending: makePending(p) });
const click = async (name: string | RegExp) => { await act(() => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('PendingCard (permission)', () => {
  it('shows tool, risk chips, input and waiting time', () => {
    render(<PendingCard session={perm({ risk: ['network', 'run'], inputSummary: 'curl example.com' })} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('NET')).toBeTruthy();
    expect(screen.getByText('RUN')).toBeTruthy();
    expect(screen.getByText('curl example.com')).toBeTruthy();
    expect(screen.getByText('waiting 2m')).toBeTruthy();
  });

  it('Approve sends perm.decide allow', async () => {
    render(<PendingCard session={perm({ requestId: 'r7' })} />);
    await click('Approve');
    expect(t.sent).toEqual([{ c: 'perm.decide', strategosId: 'a', requestId: 'r7', decision: 'allow' }]);
  });

  it('Deny sends deny, with the optional message when typed', async () => {
    render(<PendingCard session={perm({ requestId: 'r7' })} />);
    await click('Deny');
    expect(t.sent[0]).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'r7', decision: 'deny' });
    fireEvent.input(screen.getByLabelText('Deny message (optional)'), { target: { value: ' use pnpm instead ' } });
    await click('Deny');
    expect(t.sent[1]).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'r7', decision: 'deny', message: 'use pnpm instead' });
  });

  it('Enter in the message box denies', async () => {
    render(<PendingCard session={perm({ requestId: 'r7' })} />);
    const box = screen.getByLabelText('Deny message (optional)');
    fireEvent.input(box, { target: { value: 'no' } });
    await act(() => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(t.sent).toEqual([{ c: 'perm.decide', strategosId: 'a', requestId: 'r7', decision: 'deny', message: 'no' }]);
  });

  it('shows Always only when the daemon offered suggestions, and sends suggestionIndex', async () => {
    const { unmount } = render(<PendingCard session={perm()} />);
    expect(screen.queryByRole('button', { name: /Always/ })).toBeNull();
    unmount();
    render(<PendingCard session={perm({ requestId: 'r7', suggestions: [{ rule: 1 }] })} />);
    await click('Always allow');
    expect(t.sent).toEqual([{ c: 'perm.decide', strategosId: 'a', requestId: 'r7', decision: 'always', suggestionIndex: 0 }]);
  });

  it('Answer in terminal sends perm.release', async () => {
    render(<PendingCard session={perm({ requestId: 'r7' })} />);
    await click('Answer in terminal');
    expect(t.sent).toEqual([{ c: 'perm.release', strategosId: 'a', requestId: 'r7' }]);
  });

  it('a request that is not held offers no approve or deny', () => {
    render(<PendingCard session={perm({ held: false })} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText(/Answer it in the terminal/)).toBeTruthy();
  });

  it('shows an error and keeps the card when the daemon refuses', async () => {
    t.failNext('request already answered');
    render(<PendingCard session={perm()} />);
    await click('Approve');
    expect(errorNotice.value).toContain('request already answered');
  });
});

describe('PendingCard (truncated input, D21)', () => {
  const trunc = () => perm({ requestId: 'rt', inputTruncated: true });

  it('Approve does not approve: it asks for the full input first', async () => {
    render(<PendingCard session={trunc()} />);
    expect(screen.getByText(/cut short/)).toBeTruthy();
    await click(/Approve/);
    expect(t.sent).toEqual([{ c: 'pending.full', strategosId: 'a', requestId: 'rt' }]);
    expect(t.sent.some((c) => c.c === 'perm.decide')).toBe(false);
  });

  it('Always is blocked the same way', async () => {
    render(<PendingCard session={perm({ requestId: 'rt', inputTruncated: true, suggestions: [{}] })} />);
    await click('Always allow');
    expect(t.sent.some((c) => c.c === 'perm.decide')).toBe(false);
  });

  it('after the full input has been shown, Approve works', async () => {
    const { rerender } = render(<PendingCard session={trunc()} />);
    await click(/Approve/);
    await act(() => { t.emit({ t: 'pending.full', strategosId: 'a', requestId: 'rt', input: 'the whole command' }); });
    rerender(<PendingCard session={trunc()} />);
    expect(screen.getByText('the whole command')).toBeTruthy();
    await click('Approve');
    expect(t.sent.at(-1)).toEqual({ c: 'perm.decide', strategosId: 'a', requestId: 'rt', decision: 'allow' });
  });

  it('stays blocked when the daemon cannot give the full input', async () => {
    t.failNext('unknown command');
    render(<PendingCard session={trunc()} />);
    await click(/Approve/);
    expect(errorNotice.value).toContain('unknown command');
    await click(/Approve/);
    expect(t.sent.some((c) => c.c === 'perm.decide')).toBe(false);
  });

  it('Deny is never blocked', async () => {
    render(<PendingCard session={trunc()} />);
    await click('Deny');
    expect(t.sent[0]).toMatchObject({ c: 'perm.decide', decision: 'deny' });
  });
});

describe('PendingCard (question)', () => {
  const q = (over = {}) => makeSession({
    strategosId: 'a', status: 'question',
    pending: makePending({
      kind: 'question', requestId: 'rq', toolName: 'AskUserQuestion', risk: [],
      questions: [{ question: 'Which scope?', header: 'Scope', options: [{ label: 'Per key' }, { label: 'Per IP', description: 'simpler' }] }],
      ...over,
    }),
  });

  it('sends the chosen option as the answer, keyed by the question', async () => {
    render(<PendingCard session={q()} />);
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Per IP/ }));
    await click('Send answer');
    expect(t.sent).toEqual([{ c: 'question.answer', strategosId: 'a', requestId: 'rq', answers: { 'Which scope?': 'Per IP' } }]);
  });

  it('joins several choices for a multi-select question', async () => {
    render(<PendingCard session={q({ questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    await click('Send answer');
    expect(t.sent[0]).toMatchObject({ answers: { 'Which?': 'A, C' } });
  });

  it('Answer in terminal releases the request', async () => {
    render(<PendingCard session={q()} />);
    await click('Answer in terminal');
    expect(t.sent).toEqual([{ c: 'perm.release', strategosId: 'a', requestId: 'rq' }]);
  });
});
