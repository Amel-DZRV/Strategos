import { vi } from 'vitest';
import type { Ack, ChannelMessage, CommandInput, Transport } from '../state/commands.ts';
import { setTransport } from '../state/commands.ts';

export interface FakeTransport extends Transport {
  sent: CommandInput[];
  emit(ev: ChannelMessage): void;
  /** Make the next send() answer with this error. */
  failNext(error: string): void;
}

/** A Transport that records commands and acks them ok. Installed as the app transport. */
export function installFakeTransport(): FakeTransport {
  const listeners = new Set<(ev: ChannelMessage) => void>();
  let nextError: string | null = null;
  const t: FakeTransport = {
    sent: [],
    send: vi.fn((cmd: CommandInput): Promise<Ack> => {
      t.sent.push(cmd);
      const error = nextError;
      nextError = null;
      return Promise.resolve(error === null ? { t: 'ack', id: 'x', ok: true } : { t: 'ack', id: 'x', ok: false, error });
    }),
    onChannel: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    emit: (ev) => { for (const fn of listeners) fn(ev); },
    failNext: (e) => { nextError = e; },
  };
  setTransport(t);
  return t;
}
