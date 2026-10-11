import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../test/fixtures.ts';
import { createConnection, type SocketLike } from './connection.ts';
import { createStore, DEFAULT_PREFS } from './store.ts';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(d: string) { this.sent.push(JSON.parse(d) as Record<string, unknown>); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(ev: unknown) { this.onmessage?.({ data: JSON.stringify(ev) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;
const snapshot = (seq: number) => ({ t: 'snapshot', seq, sessions: [makeSession({ strategosId: 'a' })], planets: [], initiatives: [], prefs: DEFAULT_PREFS });

function setup(over: { hash?: string; fetchStatus?: (url: string) => number } = {}) {
  const store = createStore();
  const replaceState = vi.fn();
  const fetchMock = vi.fn((url: string) => Promise.resolve({ status: over.fetchStatus?.(url) ?? 204 } as Response));
  const conn = createConnection({
    store,
    location: { hash: over.hash ?? '', pathname: '/', search: '', host: '127.0.0.1:4000', protocol: 'http:' },
    history: { replaceState },
    fetch: fetchMock as unknown as typeof fetch,
    WebSocket: FakeSocket,
    random: () => 1,
  });
  return { store, conn, replaceState, fetchMock };
}

beforeEach(() => { FakeSocket.all = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('pairing', () => {
  it('strips the code from the URL, posts it, then connects', async () => {
    const { conn, replaceState, fetchMock } = setup({ hash: '#pair=abc_DEF-1' });
    await conn.start();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pair');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'abc_DEF-1' });
    expect(FakeSocket.all).toHaveLength(1);
    expect(last().url).toBe('ws://127.0.0.1:4000/ws');
  });

  it('does not touch the URL or post when there is no code', async () => {
    const { conn, replaceState, fetchMock } = setup();
    await conn.start();
    expect(replaceState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reports unpaired when the code is refused and there is no cookie', async () => {
    const { conn, store } = setup({ hash: '#pair=bad', fetchStatus: () => 401 });
    await conn.start();
    expect(store.connection.value).toBe('unpaired');
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('socket lifecycle', () => {
  it('goes open, applies hello and snapshot', async () => {
    const { conn, store } = setup();
    await conn.start();
    expect(store.connection.value).toBe('connecting');
    last().open();
    expect(store.connection.value).toBe('open');
    last().recv({ t: 'hello', protocol: 1, daemonVersion: '1', claudeVersion: '2', testedRange: '2.x', inRange: true });
    last().recv(snapshot(3));
    expect(store.hello.value?.daemonVersion).toBe('1');
    expect(store.sessions.value.has('a')).toBe(true);
  });

  it('reconnects with growing backoff, and resets after a good open', async () => {
    const { conn, store } = setup();
    await conn.start();
    last().open();
    last().drop();
    expect(store.connection.value).toBe('reconnecting');
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500); // base * 2^0 (random = 1 gives the full delay)
    expect(FakeSocket.all).toHaveLength(2);
    last().drop(); // never opened: the next wait is 1000
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    expect(conn.attempts).toBe(0);
    expect(store.connection.value).toBe('open');
  });

  it('caps the backoff at 10 seconds', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    for (let i = 0; i < 12; i++) {
      last().drop();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const n = FakeSocket.all.length;
    last().drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('after a daemon restart, takes the new snapshot (lower seq) without a page reload', async () => {
    const { conn, store } = setup();
    await conn.start();
    last().open();
    last().recv(snapshot(40));
    last().drop();
    await vi.advanceTimersByTimeAsync(500);
    last().open();
    last().recv(snapshot(0));
    expect(store.lastSeq).toBe(0);
    last().recv({ t: 'session.removed', seq: 1, strategosId: 'a' });
    expect(store.sessions.value.has('a')).toBe(false);
  });

  it('gives up and reports unpaired when the cookie is gone before the first open', async () => {
    const { conn, store } = setup({ fetchStatus: (u) => (u === '/api/session' ? 401 : 204) });
    await conn.start();
    last().drop(); // refused upgrade
    await vi.advanceTimersByTimeAsync(500);
    expect(store.connection.value).toBe('unpaired');
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('stops on a protocol mismatch', async () => {
    const { conn, store } = setup();
    await conn.start();
    last().open();
    last().recv({ t: 'hello', protocol: 2, daemonVersion: '1', claudeVersion: '2', testedRange: '', inRange: true });
    expect(store.connection.value).toBe('incompatible');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('seq gaps', () => {
  it('sends one resync when a delta skips a number, and recovers on the new snapshot', async () => {
    const { conn, store } = setup();
    await conn.start();
    last().open();
    last().recv(snapshot(1));
    last().recv({ t: 'session.removed', seq: 5, strategosId: 'a' });
    last().recv({ t: 'session.removed', seq: 6, strategosId: 'a' }); // still a gap: no second resync yet
    const resyncs = last().sent.filter((m) => m['c'] === 'resync');
    expect(resyncs).toHaveLength(1);
    expect(store.sessions.value.has('a')).toBe(true);
    last().recv(snapshot(6));
    last().recv({ t: 'session.removed', seq: 7, strategosId: 'a' });
    expect(store.sessions.value.has('a')).toBe(false);
  });
});

describe('commands', () => {
  it('rejects when not connected', async () => {
    const { conn } = setup();
    await expect(conn.send({ c: 'resync' })).rejects.toThrow('not connected');
  });

  it('sends with an id and resolves with the ack', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    const p = conn.send({ c: 'session.stop', strategosId: 'a' });
    const sent = last().sent[0]!;
    expect(sent).toMatchObject({ c: 'session.stop', strategosId: 'a' });
    expect(typeof sent['id']).toBe('string');
    last().recv({ t: 'ack', id: sent['id'], ok: false, error: 'nope' });
    await expect(p).resolves.toEqual({ t: 'ack', id: sent['id'], ok: false, error: 'nope' });
  });

  it('gives different ids to different commands', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    void conn.send({ c: 'resync' });
    void conn.send({ c: 'resync' });
    expect(last().sent[0]!['id']).not.toBe(last().sent[1]!['id']);
  });

  it('times out when no ack arrives', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    const p = conn.send({ c: 'session.stop', strategosId: 'a' });
    const assertion = expect(p).rejects.toThrow(/no answer/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('rejects pending commands when the socket drops', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    const p = conn.send({ c: 'session.stop', strategosId: 'a' });
    const assertion = expect(p).rejects.toThrow('disconnected');
    last().drop();
    await assertion;
  });

  it('passes channel events to listeners, including pending.full', async () => {
    const { conn } = setup();
    await conn.start();
    last().open();
    const seen: string[] = [];
    const off = conn.onChannel((ev) => seen.push(ev.t));
    last().recv({ t: 'pty.data', strategosId: 'a', data: 'x' });
    last().recv({ t: 'pending.full', strategosId: 'a', requestId: 'r', input: 'full' });
    off();
    last().recv({ t: 'pty.data', strategosId: 'a', data: 'y' });
    expect(seen).toEqual(['pty.data', 'pending.full']);
  });
});
