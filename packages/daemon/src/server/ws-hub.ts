// WebSocket hub (plan section 5 / D5), protocol v1.
//   connect  -> `hello`, then `snapshot` (carries the current seq)
//   deltas   -> publish() assigns an increasing seq and sends to every connection
//   commands -> parseUiCommand, routed to registerCommand() handlers, always answered with `ack`
//   channels -> pty.data / chat.items / ... go only to subscribers and carry no seq
//   resync   -> the client sends {c:'resync', id}; it gets a fresh snapshot and an ack. (Not in the frozen
//               UiCommand union, so it is handled here before parseUiCommand. See the lane report.)
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  PROTOCOL, parseUiCommand,
  type DaemonEvent, type SeqEvent, type UiCommand, type UiCommandKind,
} from '@strategos/shared';
import { CAPS } from './guards.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event that takes a seq: everything except the per-connection snapshot. */
export type Delta = DistributiveOmit<Exclude<SeqEvent, { t: 'snapshot' }>, 'seq'>;
/** Events that go to subscribers only and carry no seq. */
export type ChannelEvent = Exclude<DaemonEvent, SeqEvent | { t: 'hello' } | { t: 'ack' }>;
export type SnapshotBody = DistributiveOmit<Extract<DaemonEvent, { t: 'snapshot' }>, 't' | 'seq'>;
export type HelloBody = DistributiveOmit<Extract<DaemonEvent, { t: 'hello' }>, 't' | 'protocol'>;

/** The command type for one kind (UiCommand members share a `c` union, so Extract alone does not work). */
export type CommandFor<K extends UiCommandKind> = UiCommand extends infer U ? (U extends { c: infer C } ? ([K] extends [C] ? U & { c: K } : never) : never) : never;

export interface CommandContext {
  connId: string;
  /** Send an event to just this connection (a channel event such as pty.replay). */
  send(ev: ChannelEvent): void;
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
}
/** Resolve for ok, return `{ ok: false, error }` or throw for a failed ack. */
export type CommandResult = void | { ok: false; error: string };
export type CommandHandler<C extends UiCommand = UiCommand> = (cmd: C, ctx: CommandContext) => CommandResult | Promise<CommandResult>;

export interface WsHubOptions {
  maxCommandBytes?: number;
  maxBufferedBytes?: number;
  pingIntervalMs?: number;
}

export interface WsHub {
  /** Called by http.ts after the guards passed. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  registerCommand<K extends UiCommandKind>(c: K, handler: CommandHandler<CommandFor<K>>): void;
  setHelloProvider(p: () => HelloBody): void;
  setSnapshotProvider(p: () => SnapshotBody): void;
  /** Broadcast an ordered delta. Returns the seq it was given. */
  publish(delta: Delta): number;
  /** Send to one connection. */
  send(connId: string, ev: ChannelEvent): boolean;
  /** Send to every connection subscribed to `channel` (e.g. `pty:<strategosId>`). Returns how many got it. */
  publishTo(channel: string, ev: ChannelEvent): number;
  subscribe(connId: string, channel: string): void;
  unsubscribe(connId: string, channel: string): void;
  subscriberCount(channel: string): number;
  onConnect(cb: (connId: string) => void): () => void;
  onDisconnect(cb: (connId: string) => void): () => void;
  readonly seq: number;
  readonly connectionCount: number;
  close(): Promise<void>;
}

interface Conn {
  id: string;
  ws: WebSocket;
  channels: Set<string>;
  alive: boolean;
}

export function createWsHub(opts: WsHubOptions = {}): WsHub {
  const maxCommandBytes = opts.maxCommandBytes ?? CAPS.uiCommand;
  const maxBuffered = opts.maxBufferedBytes ?? 16 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload: CAPS.wsFrame, perMessageDeflate: false });
  const conns = new Map<string, Conn>();
  const handlers = new Map<string, CommandHandler<never>>();
  const channelSubs = new Map<string, Set<string>>();
  const connectCbs = new Set<(id: string) => void>();
  const disconnectCbs = new Set<(id: string) => void>();
  let seq = 0;
  let hello: () => HelloBody = () => ({ daemonVersion: '0.0.0', claudeVersion: 'unknown', testedRange: '', inRange: true });
  let snapshot: () => SnapshotBody = () => ({ sessions: [], planets: [], initiatives: [], prefs: { groupBy: 'repo', notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true }, keymap: {} } });

  function transmit(c: Conn, ev: DaemonEvent | { t: 'snapshot' }): boolean {
    if (c.ws.readyState !== c.ws.OPEN) return false;
    if (c.ws.bufferedAmount > maxBuffered) {
      // A reader that cannot keep up would make us hold unbounded memory. It reconnects and gets a fresh snapshot.
      c.ws.close(1013, 'slow consumer');
      return false;
    }
    c.ws.send(JSON.stringify(ev));
    return true;
  }

  function sendSnapshot(c: Conn): void {
    transmit(c, { t: 'snapshot', seq, ...snapshot() } as DaemonEvent);
  }

  function ack(c: Conn, id: string, error?: string): void {
    transmit(c, error === undefined ? { t: 'ack', id, ok: true } : { t: 'ack', id, ok: false, error });
  }

  function subscribe(connId: string, channel: string): void {
    const c = conns.get(connId);
    if (!c) return;
    c.channels.add(channel);
    let set = channelSubs.get(channel);
    if (!set) channelSubs.set(channel, (set = new Set()));
    set.add(connId);
  }
  function unsubscribe(connId: string, channel: string): void {
    conns.get(connId)?.channels.delete(channel);
    const set = channelSubs.get(channel);
    if (set) {
      set.delete(connId);
      if (set.size === 0) channelSubs.delete(channel);
    }
  }

  async function onMessage(c: Conn, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      c.ws.close(1003, 'text frames only');
      return;
    }
    const text = rawToString(data);
    if (Buffer.byteLength(text) > maxCommandBytes) {
      c.ws.close(1009, 'command too large');
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      ack(c, '', 'message is not valid JSON');
      return;
    }
    if (typeof msg === 'object' && msg !== null && (msg as { c?: unknown }).c === 'resync' && typeof (msg as { id?: unknown }).id === 'string') {
      sendSnapshot(c);
      ack(c, (msg as { id: string }).id);
      return;
    }
    const parsed = parseUiCommand(msg);
    if ('error' in parsed) {
      ack(c, parsed.id ?? '', parsed.error);
      return;
    }
    const handler = handlers.get(parsed.c) as CommandHandler | undefined;
    if (!handler) {
      ack(c, parsed.id, `${parsed.c}: not implemented`);
      return;
    }
    const ctx: CommandContext = {
      connId: c.id,
      send: (ev) => { transmit(c, ev); },
      subscribe: (ch) => subscribe(c.id, ch),
      unsubscribe: (ch) => unsubscribe(c.id, ch),
    };
    try {
      const r = await handler(parsed, ctx);
      if (r && r.ok === false) ack(c, parsed.id, r.error);
      else ack(c, parsed.id);
    } catch (e) {
      ack(c, parsed.id, e instanceof Error ? e.message : String(e));
    }
  }

  function rawToString(d: RawData): string {
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return Buffer.concat(d).toString('utf8');
    if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
    return d.toString('utf8');
  }

  function attach(ws: WebSocket): void {
    const c: Conn = { id: randomBytes(8).toString('hex'), ws, channels: new Set(), alive: true };
    conns.set(c.id, c);
    ws.on('pong', () => { c.alive = true; });
    // Messages from one connection are handled one at a time, so acks keep the order of the commands.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      chain = chain.then(() => onMessage(c, data, isBinary)).catch(() => undefined);
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      for (const ch of [...c.channels]) unsubscribe(c.id, ch);
      conns.delete(c.id);
      for (const cb of disconnectCbs) cb(c.id);
    });
    // hello then snapshot, synchronously, so no delta can slip in between them.
    transmit(c, { t: 'hello', protocol: PROTOCOL, ...hello() });
    sendSnapshot(c);
    for (const cb of connectCbs) cb(c.id);
  }

  const pinger = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }, opts.pingIntervalMs ?? 30_000);
  pinger.unref();

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
    },
    registerCommand(c, handler) {
      if (handlers.has(c)) throw new Error(`command ${c} already has a handler`);
      handlers.set(c, handler as unknown as CommandHandler<never>);
    },
    setHelloProvider(p) { hello = p; },
    setSnapshotProvider(p) { snapshot = p; },
    publish(delta) {
      seq += 1;
      const text = JSON.stringify({ ...delta, seq });
      for (const c of conns.values()) {
        if (c.ws.readyState !== c.ws.OPEN) continue;
        if (c.ws.bufferedAmount > maxBuffered) c.ws.close(1013, 'slow consumer');
        else c.ws.send(text);
      }
      return seq;
    },
    send(connId, ev) {
      const c = conns.get(connId);
      return c ? transmit(c, ev) : false;
    },
    publishTo(channel, ev) {
      const set = channelSubs.get(channel);
      if (!set) return 0;
      const text = JSON.stringify(ev);
      let n = 0;
      for (const id of set) {
        const c = conns.get(id);
        if (!c || c.ws.readyState !== c.ws.OPEN) continue;
        if (c.ws.bufferedAmount > maxBuffered) c.ws.close(1013, 'slow consumer');
        else {
          c.ws.send(text);
          n += 1;
        }
      }
      return n;
    },
    subscribe,
    unsubscribe,
    subscriberCount: (channel) => channelSubs.get(channel)?.size ?? 0,
    onConnect(cb) { connectCbs.add(cb); return () => connectCbs.delete(cb); },
    onDisconnect(cb) { disconnectCbs.add(cb); return () => disconnectCbs.delete(cb); },
    get seq() { return seq; },
    get connectionCount() { return conns.size; },
    close() {
      clearInterval(pinger);
      for (const c of conns.values()) c.ws.close(1001, 'daemon shutting down');
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          for (const c of conns.values()) c.ws.terminate();
        }, 500);
        t.unref();
        wss.close(() => { clearTimeout(t); resolve(); });
      });
    },
  };
}
