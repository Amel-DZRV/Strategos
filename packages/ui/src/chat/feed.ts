// Client side of `chat.items` (plan 5.01): the list a session's chat view shows, kept as items from an absolute index.
// Items in an event REPLACE the client's list from `from` onward. After a reset (or when the history was cut,
// `truncatedBefore`), the list is based at `from`.
import { signal } from '@preact/signals';
import type { ChatItem, DaemonEvent } from '@strategos/shared';
import { fire, onChannel } from '../state/commands.ts';
import { store } from '../state/store.ts';

type ChatItemsEvent = Extract<DaemonEvent, { t: 'chat.items' }>;

export interface ChatFeed {
  /** Absolute index of items[0]. */
  base: number;
  items: readonly ChatItem[];
  /** How many older items the daemon left out of the history it sent. */
  truncatedBefore: number;
  /** Bumped on every change, so views can tell "new items" from "same list". */
  rev: number;
}

export const EMPTY_FEED: ChatFeed = { base: 0, items: [], truncatedBefore: 0, rev: 0 };

/** Pure: apply one event to a feed. */
export function applyChatItems(prev: ChatFeed | undefined, ev: ChatItemsEvent): ChatFeed {
  const rev = (prev?.rev ?? 0) + 1;
  if (ev.reset || prev === undefined) {
    return { base: ev.from, items: ev.items, truncatedBefore: ev.truncatedBefore ?? 0, rev };
  }
  if (ev.from < prev.base) {
    // The daemon changed items we no longer hold: rebase on what it sent.
    return { base: ev.from, items: ev.items, truncatedBefore: ev.truncatedBefore ?? prev.truncatedBefore, rev };
  }
  const keep = Math.min(prev.items.length, ev.from - prev.base);
  return {
    base: prev.base, items: [...prev.items.slice(0, keep), ...ev.items], truncatedBefore: ev.truncatedBefore ?? prev.truncatedBefore, rev,
  };
}

export const feeds = signal<ReadonlyMap<string, ChatFeed>>(new Map());

export function feedOf(id: string): ChatFeed {
  return feeds.value.get(id) ?? EMPTY_FEED;
}

function setFeed(id: string, f: ChatFeed | undefined): void {
  const next = new Map(feeds.value);
  if (f) next.set(id, f);
  else next.delete(id);
  feeds.value = next;
}

export function dropFeed(id: string): void { setFeed(id, undefined); }

export function receive(ev: ChatItemsEvent): void {
  setFeed(ev.strategosId, applyChatItems(feeds.value.get(ev.strategosId), ev));
}

/**
 * Follow one session's chat while a view is showing it: subscribe now and after every reconnect (the daemon forgets
 * subscriptions with the socket), unsubscribe on stop. Returns the stop function.
 */
export function followChat(strategosId: string): () => void {
  const off = onChannel((ev) => { if (ev.t === 'chat.items' && ev.strategosId === strategosId) receive(ev); });
  let wasOpen = false;
  let stopped = false;
  const check = () => {
    const open = store.connection.value === 'open' && store.synced.value;
    if (open && !wasOpen && !stopped) fire({ c: 'chat.subscribe', strategosId, from: 0 });
    wasOpen = open;
  };
  check();
  const stopWatch = store.connection.subscribe(check);
  const stopSynced = store.synced.subscribe(check);
  return () => {
    stopped = true;
    off();
    stopWatch();
    stopSynced();
    fire({ c: 'chat.unsubscribe', strategosId });
  };
}
