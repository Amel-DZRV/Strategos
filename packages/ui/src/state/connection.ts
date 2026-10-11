// Pairing, the WebSocket, reconnect with backoff, seq-gap resync, and the command/ack plumbing (plan D5, section 10).
//
// Pairing: the daemon opens the window at http://127.0.0.1:<port>/#pair=<code>. The code lives in the URL fragment
// (never sent to a server or a log). We strip it from the address bar first, then POST it to /api/pair; the daemon
// answers with an HttpOnly cookie that the WebSocket upgrade carries. A reload later needs no code.
import { isDaemonEvent, isSeqEvent, PROTOCOL, type DaemonEvent } from '@strategos/shared';
import type { Ack, ChannelMessage, CommandInput, Transport } from './commands.ts';
import type { Store } from './store.ts';

/** The part of WebSocket we use, so tests can pass a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface ConnectionDeps {
  store: Store;
  location?: Pick<Location, 'hash' | 'pathname' | 'search' | 'host' | 'protocol'>;
  history?: Pick<History, 'replaceState'>;
  fetch?: typeof fetch;
  WebSocket?: SocketCtor;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  random?: () => number;
  commandTimeoutMs?: number;
  backoff?: { baseMs: number; maxMs: number };
}

const OPEN = 1;

export interface Connection extends Transport {
  start(): Promise<void>;
  stop(): void;
  /** Reconnect delay used for the next attempt (for tests). */
  readonly attempts: number;
}

export function createConnection(deps: ConnectionDeps): Connection {
  const { store } = deps;
  const loc = deps.location ?? window.location;
  const hist = deps.history ?? window.history;
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const Sock: SocketCtor = deps.WebSocket ?? (WebSocket as unknown as SocketCtor);
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = deps.random ?? Math.random;
  const timeoutMs = deps.commandTimeoutMs ?? 10_000;
  const base = deps.backoff?.baseMs ?? 500;
  const cap = deps.backoff?.maxMs ?? 10_000;

  let ws: SocketLike | null = null;
  let attempts = 0;
  let everOpened = false;
  let stopped = false;
  let retryTimer: unknown = null;
  let resyncing = false;
  let nextId = 1;
  const pending = new Map<string, { resolve: (a: Ack) => void; reject: (e: Error) => void; timer: unknown }>();
  const listeners = new Set<(ev: ChannelMessage) => void>();

  const wsUrl = () => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  const newId = () => `c${nextId++}-${Math.floor(random() * 1e9).toString(36)}`;

  function failPending(reason: string): void {
    for (const [id, p] of pending) {
      clearT(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function transmit(cmd: CommandInput, id: string): void {
    ws?.send(JSON.stringify({ ...cmd, id }));
  }

  function send(cmd: CommandInput): Promise<Ack> {
    if (ws === null || ws.readyState !== OPEN) return Promise.reject(new Error('not connected'));
    const id = newId();
    return new Promise<Ack>((resolve, reject) => {
      const timer = setT(() => {
        pending.delete(id);
        reject(new Error(`no answer from the daemon (${cmd.c})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        transmit(cmd, id);
      } catch (e) {
        clearT(timer);
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function requestResync(): void {
    if (resyncing) return;
    resyncing = true;
    send({ c: 'resync' }).catch(() => undefined).finally(() => { resyncing = false; });
  }

  function onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // pending.full is outside the frozen protocol (isDaemonEvent would drop it): route it as a channel message.
    if (typeof msg === 'object' && msg !== null && (msg as { t?: unknown }).t === 'pending.full') {
      for (const fn of listeners) fn(msg as ChannelMessage);
      return;
    }
    if (!isDaemonEvent(msg)) return;
    const ev: DaemonEvent = msg;
    if (ev.t === 'ack') {
      const p = pending.get(ev.id);
      if (p) {
        clearT(p.timer);
        pending.delete(ev.id);
        p.resolve(ev);
      }
      return;
    }
    if (ev.t === 'hello' && ev.protocol !== PROTOCOL) {
      store.connection.value = 'incompatible';
      stopped = true;
      ws?.close(1000, 'protocol mismatch');
      return;
    }
    if (isSeqEvent(ev) || ev.t === 'hello' || ev.t === 'digest') {
      const r = store.applyEvent(ev);
      if (ev.t === 'snapshot') resyncing = false;
      if (r === 'gap') requestResync();
      if (ev.t !== 'digest') return;
    }
    for (const fn of listeners) fn(ev);
  }

  async function checkPaired(): Promise<boolean> {
    try {
      const r = await doFetch('/api/session', { credentials: 'same-origin' });
      return r.status !== 401;
    } catch {
      return true; // the daemon is simply down
    }
  }

  function scheduleRetry(): void {
    if (stopped) return;
    const delay = Math.min(cap, base * 2 ** attempts) * (0.5 + random() / 2);
    attempts++;
    retryTimer = setT(() => {
      retryTimer = null;
      void attempt();
    }, delay);
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    if (!everOpened && attempts > 0 && !(await checkPaired())) {
      store.connection.value = 'unpaired';
      return; // nothing to retry: the owner must open the window from Strategos again
    }
    connect();
  }

  function connect(): void {
    if (stopped) return;
    store.connection.value = everOpened ? 'reconnecting' : 'connecting';
    let sock: SocketLike;
    try {
      sock = new Sock(wsUrl());
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      everOpened = true;
      attempts = 0;
      store.connection.value = 'open';
    };
    sock.onmessage = (e) => onMessage(e.data);
    sock.onerror = () => undefined; // onclose follows
    sock.onclose = () => {
      if (ws === sock) ws = null;
      store.markDisconnected();
      resyncing = false;
      failPending('disconnected');
      if (stopped) return;
      if (store.connection.value !== 'incompatible') store.connection.value = everOpened ? 'reconnecting' : 'connecting';
      scheduleRetry();
    };
  }

  async function pair(): Promise<void> {
    const m = /(?:^|[#&])pair=([^&]+)/.exec(loc.hash);
    if (m === null) return;
    const code = decodeURIComponent(m[1]!);
    hist.replaceState(null, '', loc.pathname + loc.search); // the code must not stay in the address bar or history
    try {
      const r = await doFetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        credentials: 'same-origin',
      });
      if (r.status === 401) store.connection.value = 'unpaired';
    } catch {
      // daemon down: the reconnect loop keeps trying; the code is lost, which is the safe direction
    }
  }

  return {
    async start() {
      stopped = false;
      await pair();
      if (store.connection.value === 'unpaired') {
        // A rejected code may still be followed by a good cookie from an earlier pairing.
        if (await checkPaired()) connect();
        return;
      }
      connect();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) clearT(retryTimer);
      retryTimer = null;
      ws?.close(1000, 'ui closed');
      ws = null;
      failPending('stopped');
    },
    send,
    onChannel(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    get attempts() { return attempts; },
  };
}
