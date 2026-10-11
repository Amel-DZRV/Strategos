import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ChatItem } from '@strategos/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import '../test/cleanup.ts';
import { store } from '../state/store.ts';
import { drawerTab, errorNotice } from '../state/ui.ts';
import { installFakeTransport, type FakeTransport } from '../test/fakes.ts';
import { makePending, makeSession, T0 } from '../test/fixtures.ts';
import { now } from '../state/clock.ts';
import { ChatItemView, resetOpen } from './ChatItemView.tsx';
import { ChatPane } from './ChatPane.tsx';
import { applyChatItems, feeds, feedOf, type ChatFeed } from './feed.ts';
import { renderMarkdown } from './markdown.ts';
import { replyGate } from './ReplyBox.tsx';

type Ev = Parameters<typeof applyChatItems>[1];
const u = (n: number): ChatItem => ({ k: 'user', id: `u${n}`, text: `m${n}`, at: T0 });
const ev = (over: Partial<Ev> & { items: ChatItem[] }): Ev => ({ t: 'chat.items', strategosId: 'a', from: 0, reset: false, ...over });
const ids = (f: ChatFeed) => f.items.map((i) => i.id);

describe('chat.items delta semantics', () => {
  it('a reset replaces everything and bases the list at `from`', () => {
    const f = applyChatItems(undefined, ev({ items: [u(1), u(2)], reset: true }));
    expect(f.base).toBe(0);
    expect(ids(f)).toEqual(['u1', 'u2']);
    const g = applyChatItems(f, ev({ items: [u(9)], reset: true, from: 40, truncatedBefore: 40 }));
    expect(g.base).toBe(40);
    expect(g.truncatedBefore).toBe(40);
    expect(ids(g)).toEqual(['u9']);
  });

  it('items replace the list from `from` onward: append, then replace the tail', () => {
    let f = applyChatItems(undefined, ev({ items: [u(1), u(2), u(3)], reset: true }));
    f = applyChatItems(f, ev({ from: 3, items: [u(4)] }));
    expect(ids(f)).toEqual(['u1', 'u2', 'u3', 'u4']);
    f = applyChatItems(f, ev({ from: 2, items: [{ k: 'user', id: 'u30', text: 'changed', at: T0 }] })); // item 3 changed, item 4 is gone
    expect(ids(f)).toEqual(['u1', 'u2', 'u30']);
  });

  it('with truncatedBefore the list is based at `from` and deltas use absolute indexes', () => {
    let f = applyChatItems(undefined, ev({ items: [u(100), u(101)], reset: true, from: 100, truncatedBefore: 100 }));
    expect(f.base).toBe(100);
    f = applyChatItems(f, ev({ from: 102, items: [u(102)] }));
    expect(ids(f)).toEqual(['u100', 'u101', 'u102']);
    f = applyChatItems(f, ev({ from: 101, items: [u(201)] }));
    expect(ids(f)).toEqual(['u100', 'u201']);
    expect(f.base).toBe(100);
    expect(f.truncatedBefore).toBe(100);
  });
});

describe('markdown', () => {
  it('never lets raw HTML through', () => {
    const html = renderMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<b>bold</b>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
  });

  it('linkifies, opens links safely and refuses javascript: links', () => {
    const html = renderMarkdown('see https://example.com/a and [bad](javascript:alert(1))');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
  });
});

describe('ChatItemView', () => {
  beforeEach(() => { resetOpen(); });
  const view = (item: ChatItem) => render(<ChatItemView item={item} />);

  it('user bubble', () => {
    const { container } = view(u(1));
    expect(container.querySelector('.user')?.textContent).toBe('m1');
  });

  it('assistant markdown renders elements, not escaped text', () => {
    const { container } = view({ k: 'assistant', id: 'a', at: T0, md: 'a **bold** word\n\n- one\n- two' });
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('assistant text with HTML in it creates no elements', () => {
    const { container } = view({ k: 'assistant', id: 'a', at: T0, md: '<img src=x onerror=alert(1)> <iframe src="x"></iframe>' });
    expect(container.querySelector('img, iframe, script')).toBeNull();
  });

  it('tool card is collapsed, shows name and summary, and expands to the result', () => {
    view({ k: 'tool', id: 't', tool: 'Bash', summary: 'npm test', ok: true, result: 'Tests 42 passed' });
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.queryByText('Tests 42 passed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.getByText('Tests 42 passed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.queryByText('Tests 42 passed')).toBeNull();
  });

  it('tool states: running, ok, failed', () => {
    const { container, rerender } = view({ k: 'tool', id: 't', tool: 'Bash', summary: 'x' });
    expect(container.textContent).toContain('RUNNING');
    rerender(<ChatItemView item={{ k: 'tool', id: 't', tool: 'Bash', summary: 'x', ok: false, result: 'boom' }} />);
    expect(container.textContent).toContain('FAILED');
  });

  it('an Edit shows a coloured unified diff', () => {
    const diff = '--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new';
    const { container } = view({ k: 'tool', id: 't', tool: 'Edit', summary: 'f.ts', ok: true, diff });
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(container.querySelector('.da')?.textContent).toBe('+new\n');
    expect(container.querySelector('.dd')?.textContent).toBe('-old\n');
    expect(container.querySelector('.dk')?.textContent).toContain('@@ -1,2 +1,2 @@');
    expect(container.querySelectorAll('.dh')).toHaveLength(2);
    expect(container.querySelector('.dc')?.textContent).toBe(' keep\n');
  });

  it('a sub-agent thread is collapsible and nests its items', () => {
    const { container } = view({
      k: 'subagent', id: 's', agentId: 'a1', brief: 'Explore the repo',
      items: [{ k: 'assistant', id: 'x', at: T0, md: 'inside' }, { k: 'tool', id: 'y', tool: 'Grep', summary: 'foo', ok: true }],
    });
    expect(screen.getByText('Explore the repo')).toBeTruthy();
    expect(screen.getByText('2 steps')).toBeTruthy();
    expect(container.textContent).not.toContain('inside');
    fireEvent.click(screen.getByRole('button', { name: /Sub-agent/ }));
    expect(container.textContent).toContain('inside');
    expect(container.textContent).toContain('Grep');
  });

  it('compact, interrupted and marker items are thin separators', () => {
    const { container } = render(
      <div>
        <ChatItemView item={{ k: 'compact', id: 'c', at: T0 }} />
        <ChatItemView item={{ k: 'interrupted', id: 'i', at: T0 }} />
        <ChatItemView item={{ k: 'marker', id: 'm1', marker: 'clear', at: T0 }} />
        <ChatItemView item={{ k: 'marker', id: 'm2', marker: 'unknown', at: T0 }} />
      </div>,
    );
    const seps = [...container.querySelectorAll('[role=separator]')].map((e) => e.textContent);
    expect(seps).toEqual(['Context compacted', 'Interrupted', 'Conversation cleared', 'Conversation history changed']);
  });
});

describe('reply gating', () => {
  it.each([
    ['done', undefined, true], ['seen', undefined, true], ['interrupted', undefined, true],
    ['working', undefined, false], ['permission', undefined, false], ['stopped', undefined, false], ['errored', undefined, false],
    ['question', makePending({ kind: 'question', held: true }), false],
    ['question', makePending({ kind: 'question', held: false }), true],
  ] as const)('%s with %j: allowed = %s', (status, pending, ok) => {
    expect(replyGate(makeSession({ strategosId: 'a', status, ...(pending ? { pending } : {}) })).ok).toBe(ok);
  });
});

describe('ChatPane', () => {
  let t: FakeTransport;
  beforeEach(() => {
    t = installFakeTransport();
    now.value = T0 + 60_000;
    feeds.value = new Map();
    errorNotice.value = '';
    drawerTab.value = 'chat';
    resetOpen();
    store.connection.value = 'open';
    store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], initiatives: [], prefs: store.prefs.value });
  });

  const mount = (over: Parameters<typeof makeSession>[0] = { strategosId: 'a', status: 'done' }, active = true) =>
    render(<ChatPane session={makeSession(over)} active={active} />);
  const emit = (e: Ev) => act(() => { t.emit(e); });
  const sent = (c: string) => t.sent.filter((x) => x.c === c);

  it('subscribes when shown and unsubscribes when it goes away', () => {
    const { unmount } = mount();
    expect(sent('chat.subscribe')).toEqual([{ c: 'chat.subscribe', strategosId: 'a', from: 0 }]);
    unmount();
    expect(sent('chat.unsubscribe')).toEqual([{ c: 'chat.unsubscribe', strategosId: 'a' }]);
  });

  it('does not subscribe while its tab is hidden', () => {
    mount({ strategosId: 'a', status: 'done' }, false);
    expect(sent('chat.subscribe')).toEqual([]);
  });

  it('renders items as they arrive and follows deltas', async () => {
    mount();
    expect(screen.getByText('Loading the conversation…')).toBeTruthy();
    await emit(ev({ items: [u(1), { k: 'assistant', id: 'a1', at: T0, md: 'hello **there**' }], reset: true }));
    expect(screen.getByText('m1')).toBeTruthy();
    expect(screen.getByText('there').tagName).toBe('STRONG');
    await emit(ev({ from: 2, items: [u(3)] }));
    expect(screen.getByText('m3')).toBeTruthy();
    expect(feedOf('a').items).toHaveLength(3);
  });

  it('shows how many older items were left out', async () => {
    mount();
    await emit(ev({ items: [u(50)], reset: true, from: 50, truncatedBefore: 50 }));
    expect(screen.getByText('50 earlier items are not shown.')).toBeTruthy();
  });

  it('renders only a window of a 5000-item transcript', async () => {
    const { container } = mount();
    const items = Array.from({ length: 5000 }, (_, i) => u(i));
    await emit(ev({ items, reset: true }));
    const rows = container.querySelectorAll('.vrow').length;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(200);
    expect(screen.getByText('m0')).toBeTruthy(); // the window starts at the top until the list is scrolled
  });

  it('shows the activity line from SessionRecord.now while working', () => {
    mount({ strategosId: 'a', status: 'working', now: { tool: 'Bash', summary: 'npm test', since: T0 } });
    expect(screen.getByTestId('activity').textContent).toContain('Running Bash: npm test…');
  });

  it('has no activity line when not working', () => {
    mount({ strategosId: 'a', status: 'done' });
    expect(screen.queryByTestId('activity')).toBeNull();
  });

  it('shows the pending card inline with its actions', () => {
    mount({ strategosId: 'a', status: 'permission', pending: makePending({ inputSummary: 'cargo build --release' }) });
    expect(screen.getByText('cargo build --release')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeTruthy();
  });

  describe('reply box', () => {
    const box = () => screen.getByLabelText('Reply to this session') as HTMLTextAreaElement;
    const type = (v: string) => fireEvent.input(box(), { target: { value: v } });

    it('is disabled while the session is working, with the reason', () => {
      mount({ strategosId: 'a', status: 'working' });
      expect(box().disabled).toBe(true);
      expect(screen.getByText('Claude is working. You can reply when it stops.')).toBeTruthy();
    });

    it('Enter sends reply.send and clears the box', async () => {
      mount();
      type('please continue');
      await act(() => { fireEvent.keyDown(box(), { key: 'Enter' }); });
      expect(sent('reply.send')).toEqual([{ c: 'reply.send', strategosId: 'a', text: 'please continue' }]);
      await waitFor(() => expect(box().value).toBe(''));
    });

    it('Shift+Enter does not send', async () => {
      mount();
      type('line one');
      await act(() => { fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true }); });
      expect(sent('reply.send')).toEqual([]);
      expect(box().value).toBe('line one');
    });

    it('shows the daemon refusal (half-typed terminal input) and keeps the text', async () => {
      mount();
      t.failNext('The terminal has half-typed input.');
      type('hello');
      await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The terminal has half-typed input.')).toBeTruthy();
      expect(box().value).toBe('hello');
    });

    it('does not send empty text', async () => {
      mount();
      await act(() => { fireEvent.keyDown(box(), { key: 'Enter' }); });
      expect(sent('reply.send')).toEqual([]);
    });
  });
});

