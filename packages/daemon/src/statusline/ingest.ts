// Status-line ingest (task 1.12): the JSON that tap.mjs forwards -> a MachineInput 'statusline' plus a Usage reading.
// Shapes: fixtures/claude/2.1.292/statusline/*.json ([ran], spike S5, S11, S16). Everything is optional and checked.
//
//   - Before the first request of a session `used_percentage` is null, `current_usage` is null and `prompt_cache` and
//     `rate_limits` are absent: ctx.pct is null, the cache is `{warm: null}` (unknown), usage is undefined.
//   - `cost.total_cost_usd` belongs to ONE Claude session id (/clear and /branch start from 0, /resume carries the old
//     total): the machine input carries the id and the reducer keeps one number per id (C3).
//   - Times: Claude sends epoch SECONDS (`prompt_cache.expires_at`, `rate_limits.*.resets_at`); everything in Strategos is
//     epoch MILLISECONDS, so they are converted here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Effect, MachineInput, Usage } from '@strategos/shared';
import { reply } from '../server/guards.ts';

export type StatusLineMachineInput = Extract<MachineInput, { k: 'statusline' }>;

export interface StatusLineIngest {
  input: StatusLineMachineInput;
  /** The rate-limit reading, when the body carried one. */
  usage?: Usage;
  claudeSessionId?: string;
  transcriptPath?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function ctxOf(cw: unknown, at: number): StatusLineMachineInput['ctx'] {
  if (!isObj(cw)) return undefined;
  const pct = num(cw['used_percentage']);
  const window = num(cw['context_window_size']);
  let tokens: number | undefined;
  const cu = cw['current_usage'];
  if (isObj(cu)) {
    // What the next request will send: fresh input + cache writes + cache reads (matches total_input_tokens, [ran]).
    tokens = (num(cu['input_tokens']) ?? 0) + (num(cu['cache_creation_input_tokens']) ?? 0) + (num(cu['cache_read_input_tokens']) ?? 0);
  } else {
    const total = num(cw['total_input_tokens']);
    if (total !== undefined && total > 0) tokens = total;
  }
  return { pct: pct ?? null, ...(tokens === undefined ? {} : { tokens }), ...(window === undefined ? {} : { window }), at, source: 'statusline' };
}

function cacheOf(pc: unknown): StatusLineMachineInput['cache'] {
  if (!isObj(pc)) return { warm: null, source: 'statusline' }; // no request yet, or an older Claude Code: unknown
  const warm = typeof pc['warm'] === 'boolean' ? pc['warm'] : null;
  const ttl = pc['ttl'] === '5m' || pc['ttl'] === '1h' ? pc['ttl'] : undefined;
  const expiresSec = num(pc['expires_at']);
  const expiresAt = expiresSec === undefined ? undefined : Math.round(expiresSec * 1000);
  // [inf, matches spike S16: expires_at = last request + ttl] the time of the last request that refreshed the cache.
  const ttlMs = ttl === '5m' ? 300_000 : ttl === '1h' ? 3_600_000 : undefined;
  const lastCallAt = expiresAt !== undefined && ttlMs !== undefined ? expiresAt - ttlMs : undefined;
  return {
    warm,
    ...(ttl === undefined ? {} : { ttl }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(lastCallAt === undefined ? {} : { lastCallAt }),
    source: 'statusline',
  };
}

function usageOf(rl: unknown, at: number): Usage | undefined {
  if (!isObj(rl)) return undefined;
  const win = (v: unknown): { pct: number; resetsAt: number } | undefined => {
    if (!isObj(v)) return undefined;
    const pct = num(v['used_percentage']);
    const resets = num(v['resets_at']);
    return pct === undefined || resets === undefined ? undefined : { pct, resetsAt: Math.round(resets * 1000) };
  };
  const fiveHour = win(rl['five_hour']);
  const sevenDay = win(rl['seven_day']);
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  return { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }), at };
}

/** Never throws. Returns null when the body is not an object. */
export function ingestStatusLine(body: unknown, now: number): StatusLineIngest | null {
  if (!isObj(body)) return null;
  const claudeSessionId = str(body['session_id']);
  const cost = isObj(body['cost']) ? num(body['cost']['total_cost_usd']) : undefined;
  const model = isObj(body['model']) ? str(body['model']['id']) ?? str(body['model']['display_name']) : str(body['model']);
  const ctx = ctxOf(body['context_window'], now);
  const input: StatusLineMachineInput = {
    k: 'statusline',
    ...(ctx === undefined ? {} : { ctx }),
    ...(claudeSessionId !== undefined && cost !== undefined ? { cost: { claudeSessionId, usd: cost } } : {}),
    ...(model === undefined ? {} : { model }),
    cache: cacheOf(body['prompt_cache']),
  };
  const usage = usageOf(body['rate_limits'], now);
  const transcriptPath = str(body['transcript_path']);
  return {
    input,
    ...(usage === undefined ? {} : { usage }),
    ...(claudeSessionId === undefined ? {} : { claudeSessionId }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

export interface StatusLineHandlerDeps {
  dispatch: (sid: string, input: MachineInput) => Effect[];
  /** A rate-limit reading (account-wide: feed the usage tracker, task 4.x). */
  onUsage?: (sid: string, usage: Usage) => void;
  onError?: (err: unknown) => void;
  now?: () => number;
}

/** Plug into `server.setStatusLineHandler`. Answers 204 at once: the tap does not wait for more. */
export function createStatusLineHandler(deps: StatusLineHandlerDeps): (sid: string, body: unknown, req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now;
  return (sid, body, _req, res) => {
    const r = ingestStatusLine(body, now());
    if (r === null) return reply(res, 400);
    try {
      deps.dispatch(sid, r.input);
      if (r.usage !== undefined) deps.onUsage?.(sid, r.usage);
    } catch (err) {
      deps.onError?.(err);
    }
    reply(res, 204);
  };
}
