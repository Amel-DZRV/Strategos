// The Electron half of the shell bridge (task 7.01-7.03): bridge selection, pairing over IPC, toast buttons and their effects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategosShellApi, UiNotification } from '@strategos/shared';
import { createBrowserShellBridge, createElectronShellBridge, createShellBridge } from './shell-bridge.ts';
import { createConnection, type SocketLike } from './state/connection.ts';
import { createStore } from './state/store.ts';
import { makePending, makeSession } from './test/fixtures.ts';

function fakeApi(over: Partial<StrategosShellApi> = {}): StrategosShellApi & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string) => (...a: unknown[]) => { (calls[name] ??= []).push(a.length === 1 ? a[0] : a); };
  return {
    calls,
    kind: 'electron', platform: 'win32',
    getPairCode: () => Promise.resolve('ipc-code-1'),
    notify: rec('notify'), setBadge: rec('setBadge'), focusWindow: rec('focusWindow'), openExternal: rec('openExternal'),
    onNotificationAction: rec('onNotificationAction'), onNotificationClick: rec('onNotificationClick'), onSelectOldestBlocked: rec('onSelectOldestBlocked'),
    ...over,
  };
}

describe('bridge selection', () => {
  it('uses the browser bridge unless window.strategosShell exists', () => {
    expect(createShellBridge({ document } as unknown as Window).kind).toBe('browser');
    expect(createShellBridge({ document, strategosShell: fakeApi() } as unknown as Window).kind).toBe('electron');
    expect(createShellBridge({ document, strategosShell: { kind: 'other' } } as unknown as Window).kind).toBe('browser');
    expect(createBrowserShellBridge().kind).toBe('browser');
  });
  it('forwards everything over IPC and needs no page permission', async () => {
    const api = fakeApi();
    const b = createElectronShellBridge(api);
    const n: UiNotification = { kind: 'permission', strategosId: 'a', title: 't', body: 'b', requestId: 'r', actions: ['approve', 'deny', 'open'] };
    b.notify(n);
    b.setBadge(4);
    b.focusWindow();
    b.openExternal('https://example.com/pr/1');
    b.openExternal('javascript:alert(1)');
    b.openExternal('file:///C:/x');
    expect(api.calls['notify']).toEqual([n]);
    expect(api.calls['setBadge']).toEqual([4]);
    expect(api.calls['focusWindow']).toHaveLength(1);
    expect(api.calls['openExternal']).toEqual(['https://example.com/pr/1']);
    expect(b.notificationPermission()).toBe('granted');
    expect(await b.requestNotificationPermission()).toBe('granted');
    expect(b.platform).toBe('win32');
  });
});

class NoSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null; onmessage: SocketLike['onmessage'] = null; onclose: SocketLike['onclose'] = null; onerror: SocketLike['onerror'] = null;
  send() { /* nothing */ }
  close() { /* nothing */ }
}

describe('pairing over IPC', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  function setup(o: { hash?: string; sessionStatus?: number; code?: string | null | Error }) {
    const replaceState = vi.fn();
    const fetchMock = vi.fn((url: string) => Promise.resolve({ status: url === '/api/session' ? (o.sessionStatus ?? 401) : 204 } as Response));
    const conn = createConnection({
      store: createStore(),
      location: { hash: o.hash ?? '', pathname: '/', search: '', host: '127.0.0.1:4000', protocol: 'http:' },
      history: { replaceState },
      fetch: fetchMock as unknown as typeof fetch,
      WebSocket: NoSocket,
      random: () => 1,
      getPairCode: () => (o.code instanceof Error ? Promise.reject(o.code) : Promise.resolve(o.code === undefined ? 'ipc-code-1' : o.code)),
    });
    return { conn, replaceState, fetchMock };
  }
  it('posts the code that came over IPC; the address bar is never involved', async () => {
    const { conn, replaceState, fetchMock } = setup({});
    await conn.start();
    const post = fetchMock.mock.calls.find((c) => (c as unknown as [string])[0] === '/api/pair') as unknown as [string, RequestInit];
    expect(JSON.parse(post[1].body as string)).toEqual({ code: 'ipc-code-1' });
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('reuses a cookie from an earlier run instead of spending a code', async () => {
    const { conn, fetchMock } = setup({ sessionStatus: 200 });
    await conn.start();
    expect(fetchMock.mock.calls.some((c) => (c as unknown as [string])[0] === '/api/pair')).toBe(false);
  });
  it('falls back to the URL fragment when IPC gives nothing', async () => {
    for (const code of [null, new Error('no ipc')]) {
      const { conn, replaceState, fetchMock } = setup({ code, hash: '#pair=frag-code' });
      await conn.start();
      expect(replaceState).toHaveBeenCalledWith(null, '', '/');
      const post = fetchMock.mock.calls.find((c) => (c as unknown as [string])[0] === '/api/pair') as unknown as [string, RequestInit];
      expect(JSON.parse(post[1].body as string)).toEqual({ code: 'frag-code' });
    }
  });
});

describe('toast buttons', () => {
  const wt = 'C:\\dev\\strategos-app';
  async function load() {
    vi.resetModules();
    const api = fakeApi();
    (window as unknown as { strategosShell?: StrategosShellApi }).strategosShell = api;
    const notifications = await import('./notify/notifications.tsx');
    const { store } = await import('./state/store.ts');
    const commands = await import('./state/commands.ts');
    const ui = await import('./state/ui.ts');
    const sent: Record<string, unknown>[] = [];
    let reply: () => Promise<{ t: 'ack'; id: string; ok: boolean; error?: string }> = () => Promise.resolve({ t: 'ack', id: 'x', ok: true });
    commands.setTransport({ send: (c) => { sent.push(c as Record<string, unknown>); return reply(); }, onChannel: () => () => undefined });
    return { api, notifications, store, ui, sent, setReply: (f: typeof reply) => { reply = f; } };
  }
  afterEach(() => { delete (window as unknown as { strategosShell?: unknown }).strategosShell; });

  const pend = (tool: string, summary: string, over = {}) => makePending({ requestId: 'rq', toolName: tool, inputSummary: summary, risk: [], ...over });
  const ev = (id = 's1') => ({ t: 'notify' as const, seq: 1, kind: 'permission' as const, strategosId: id, title: 'needs permission', body: 'x', requestId: 'rq' });

  it('offers Approve for an Edit inside the worktree and shows the path', async () => {
    const m = await load();
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, pending: pend('Edit', `${wt}\\src\\a.ts`) })]]);
    m.notifications.handleNotify({ ...ev(), body: `${wt}\\src\\a.ts` });
    const n = (m.api.calls['notify']![0]) as UiNotification;
    expect(n.actions).toEqual(['approve', 'deny', 'open']);
    expect(n.body).toBe(`${wt}\\src\\a.ts`);
  });
  it('withholds Approve for Bash, dotfiles, outside paths and cut input', async () => {
    const m = await load();
    const cases: [string, string, object][] = [
      ['Bash', 'npm test', {}], ['Edit', `${wt}\\.git\\config`, {}], ['Write', `${wt}\\.claude\\settings.json`, {}], ['Edit', 'C:\\other\\a.ts', {}],
      ['Edit', `${wt}\\src\\a.ts`, { inputTruncated: true }],
    ];
    for (const [tool, summary, extra] of cases) {
      m.api.calls['notify'] = [];
      m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, pending: pend(tool, summary, extra) })]]);
      m.notifications.handleNotify(ev());
      expect((m.api.calls['notify']![0] as UiNotification).actions, `${tool} ${summary}`).toEqual(['deny', 'open']);
    }
  });
  it('uses the worktree path when the session has one', async () => {
    const m = await load();
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, worktree: { path: 'C:\\wt\\feat', branch: 'feat', base: 'main', createdByStrategos: true }, pending: pend('Edit', 'C:\\wt\\feat\\a.ts') })]]);
    m.notifications.handleNotify(ev());
    expect((m.api.calls['notify']![0] as UiNotification).actions).toContain('approve');
    m.api.calls['notify'] = [];
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, worktree: { path: 'C:\\wt\\feat', branch: 'feat', base: 'main', createdByStrategos: true }, pending: pend('Edit', `${wt}\\a.ts`) })]]);
    m.notifications.handleNotify(ev());
    expect((m.api.calls['notify']![0] as UiNotification).actions).toEqual(['deny', 'open']);
  });
  it('sends no buttons for notifications without a matching pending request', async () => {
    const m = await load();
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', cwd: wt })]]);
    m.notifications.handleNotify({ t: 'notify', seq: 1, kind: 'done', strategosId: 's1', title: 'done', body: 'x' });
    expect((m.api.calls['notify']![0] as UiNotification).actions).toBeUndefined();
  });

  it('Approve and Deny send perm.decide with via toast; Open shows the session', async () => {
    const m = await load();
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, pending: pend('Edit', `${wt}\\a.ts`) })]]);
    m.notifications.handleNotificationAction({ requestId: 'rq', action: 'approve' });
    m.notifications.handleNotificationAction({ requestId: 'rq', action: 'deny' });
    expect(m.sent).toEqual([
      { c: 'perm.decide', strategosId: 's1', requestId: 'rq', decision: 'allow', via: 'toast' },
      { c: 'perm.decide', strategosId: 's1', requestId: 'rq', decision: 'deny', via: 'toast' },
    ]);
    m.notifications.handleNotificationAction({ requestId: 'rq', action: 'open' });
    expect(m.ui.selectedId.value).toBe('s1');
    expect(m.ui.drawerOpen.value).toBe(true);
    expect(m.api.calls['focusWindow']).toBeDefined();
  });
  it('ignores a button for a request that is already answered', async () => {
    const m = await load();
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', cwd: wt })]]);
    m.notifications.handleNotificationAction({ requestId: 'gone', action: 'approve' });
    expect(m.sent).toEqual([]);
  });
  it('a refused toast approval shows the error and opens the session', async () => {
    const m = await load();
    m.setReply(() => Promise.resolve({ t: 'ack', id: 'x', ok: false, error: 'this request cannot be approved from a notification' }));
    m.store.sessions.value = new Map([['s1', makeSession({ strategosId: 's1', status: 'permission', cwd: wt, pending: pend('Edit', `${wt}\\a.ts`) })]]);
    m.notifications.handleNotificationAction({ requestId: 'rq', action: 'approve' });
    await vi.waitFor(() => expect(m.ui.errorNotice.value).toContain('cannot be approved from a notification'));
    expect(m.ui.selectedId.value).toBe('s1');
  });
  it('the tray click selects the session that has waited longest', async () => {
    const m = await load();
    m.store.sessions.value = new Map([
      ['new', makeSession({ strategosId: 'new', status: 'permission', waitingSince: 2000, statusSince: 2000, pending: pend('Bash', 'x') })],
      ['old', makeSession({ strategosId: 'old', status: 'permission', waitingSince: 1000, statusSince: 1000, pending: pend('Bash', 'y', { requestId: 'r2' }) })],
      ['idle', makeSession({ strategosId: 'idle', status: 'working' })],
    ]);
    m.notifications.showOldestBlocked();
    expect(m.ui.selectedId.value).toBe('old');
  });
});
