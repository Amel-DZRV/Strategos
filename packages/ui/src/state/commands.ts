// How components talk to the daemon. A Transport is the connection; tests swap in a fake with setTransport().
import type { DaemonEvent, UiCommand } from '@strategos/shared';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Not in the frozen protocol yet (see packages/ui/README.md, "Daemon requests"): ask for the full tool input of a
 * truncated pending request (D21). The reply is a `pending.full` channel event.
 */
export type PendingFullCommand = { id: string; c: 'pending.full'; strategosId: string; requestId: string };
export type AnyCommand = UiCommand | PendingFullCommand;
export type CommandInput = DistributiveOmit<AnyCommand, 'id'>;

export type Ack = Extract<DaemonEvent, { t: 'ack' }>;
/** Channel events (pty, chat, review) plus the invented `pending.full`. */
export type ChannelMessage = DaemonEvent | { t: 'pending.full'; strategosId: string; requestId: string; input: string };

/** timeoutMs: how long to wait for the ack (default 10 s; pr.create pushes a branch and takes longer). */
export interface SendOptions { timeoutMs?: number }

export interface Transport {
  /** Resolves with the daemon's ack (ok or not). Rejects when not connected, on disconnect, or after the timeout. */
  send(cmd: CommandInput, opts?: SendOptions): Promise<Ack>;
  /** Every non-seq message from the daemon (pty.data, pty.replay, chat.items, review, digest, pending.full). */
  onChannel(fn: (ev: ChannelMessage) => void): () => void;
}

const offline: Transport = {
  send: () => Promise.reject(new Error('not connected')),
  onChannel: () => () => undefined,
};

let transport: Transport = offline;
export function setTransport(t: Transport): void { transport = t; }

/** Send and throw if the daemon refuses. */
export async function send(cmd: CommandInput, opts?: SendOptions): Promise<Ack> {
  const ack = await transport.send(cmd, opts);
  if (!ack.ok) throw new Error(ack.error ?? 'command failed');
  return ack;
}

/** Send without waiting (keystrokes, resizes). Errors are swallowed: a dropped keystroke during a reconnect is expected. */
export function fire(cmd: CommandInput): void {
  transport.send(cmd).catch(() => undefined);
}

export function onChannel(fn: (ev: ChannelMessage) => void): () => void {
  return transport.onChannel(fn);
}
