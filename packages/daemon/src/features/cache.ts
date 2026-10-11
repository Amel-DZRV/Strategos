// Prompt-cache warmth bookkeeping (task 5.07, spike S16, check C2).
//
// SessionRecord.cache comes from two places:
//   - the status line's `prompt_cache` (reducer: statusline input), the better source: Claude states warm, ttl, expires_at
//   - the transcript, when the status line is off or older Claude Code sends no `prompt_cache`: the last assistant call and
//     the TTL its cache write used (parse.cacheFromRecords)
// The status line only speaks when something happens, so a `warm: true` reading goes stale when the TTL passes: the daemon
// tick calls `expireCache` and flips it to false.
import type { SessionRecord } from '@strategos/shared';
import { cacheFromRecords } from '../transcript/parse.ts';

type Cache = NonNullable<SessionRecord['cache']>;

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const;

/** warm=true and past its expiry -> the same reading with warm=false. undefined: nothing to change. */
export function expireCache(c: Cache | undefined, now: number): Cache | undefined {
  if (c === undefined || c.warm !== true || c.expiresAt === undefined || now < c.expiresAt) return undefined;
  return { ...c, warm: false };
}

/** The status line has said nothing useful yet (no request, or no prompt_cache field): the transcript may fill in. */
function transcriptMayFill(prev: Cache | undefined): boolean {
  return prev === undefined || prev.source === 'transcript' || (prev.warm === null && prev.expiresAt === undefined);
}

/**
 * New cache reading from freshly tailed transcript records, or undefined when nothing changes (a status-line reading with
 * facts in it wins; a batch without assistant calls says nothing). The TTL of the last known reading is reused when a
 * call did not write cache.
 */
export function mergeTranscriptCache(prev: Cache | undefined, records: readonly unknown[], now: number): Cache | undefined {
  if (!transcriptMayFill(prev)) return undefined;
  const c = cacheFromRecords(records, now);
  if (c.lastCallAt === undefined) return undefined;
  if (prev?.lastCallAt !== undefined && c.lastCallAt < prev.lastCallAt) return undefined; // older than what we know
  const ttl = c.ttl ?? prev?.ttl;
  if (ttl === undefined) return { warm: null, lastCallAt: c.lastCallAt, source: 'transcript' };
  const expiresAt = c.lastCallAt + TTL_MS[ttl];
  return { warm: now < expiresAt, ttl, expiresAt, lastCallAt: c.lastCallAt, source: 'transcript' };
}

/** A status-line `{warm: null}` (nothing known) must not wipe a reading the transcript produced. */
export function keepTranscriptCache(prev: Cache | undefined, incoming: Cache | undefined): boolean {
  return prev?.source === 'transcript' && prev.warm !== null && incoming !== undefined && incoming.warm === null && incoming.expiresAt === undefined;
}
