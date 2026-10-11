// Reading facts out of Claude Code transcript records (plan section 4, transcript/parse.ts; checks V2, V14).
// The entry format is internal to Claude Code and changes between versions (V14), so every accessor is tolerant:
// unknown shapes give `undefined` or `unknown`, never a throw.
// Written fresh; the function names follow the plan's Bot Crossing port list.

import { stat } from 'node:fs/promises';
import { jsonLines, num, readHead, readTail } from './fsutil.ts';

export type TranscriptRecord = Record<string, unknown>;

function rec(v: unknown): TranscriptRecord | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as TranscriptRecord) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function messageOf(r: TranscriptRecord): TranscriptRecord | undefined {
  return rec(r.message);
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** First text of a message `content`: the string itself, or the first `text` block. */
export function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = rec(block);
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return '';
}

const NOISE_BLOCKS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|ide_opened_file|ide_selection|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;

/**
 * A prompt as a person would read it: injected blocks removed, a slash command shown as `/name args`,
 * whitespace collapsed, cut to `max` characters.
 */
export function cleanPrompt(text: string, max = 200): string {
  let t = text.replace(NOISE_BLOCKS, ' ');
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim();
  if (name !== undefined) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
    t = args === '' ? name : `${name} ${args}`;
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const INTERRUPT_PREFIX = '[Request interrupted by user';

/** `[Request interrupted by user]` -> 'user', `[Request interrupted by user for tool use]` -> 'tool_use'. */
export function interruptMarker(text: string): 'user' | 'tool_use' | undefined {
  const t = text.trim();
  if (!t.startsWith(INTERRUPT_PREFIX)) return undefined;
  return t.startsWith(`${INTERRUPT_PREFIX} for tool use`) ? 'tool_use' : 'user';
}

// ---------------------------------------------------------------------------
// record classification
// ---------------------------------------------------------------------------

function contentBlocks(r: TranscriptRecord): TranscriptRecord[] {
  const c = messageOf(r)?.content;
  return Array.isArray(c) ? c.map(rec).filter((b): b is TranscriptRecord => b !== undefined) : [];
}

function isRealMessage(r: TranscriptRecord): boolean {
  return (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true;
}

export type TailSignal = 'working' | 'awaiting_reply' | 'interrupt_marker';
export interface TailVerdict {
  signal: TailSignal;
  lastIsQuestion?: boolean; // awaiting_reply only: the assistant's last text ends with "?"
  at?: number; // timestamp of the deciding record, ms
}

const ENDED_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn']);

/**
 * Decide, from the records at the end of a transcript, whether the model is working, has handed the turn back,
 * or the turn was interrupted. Skips bookkeeping records (titles, snapshots, queue operations, system lines),
 * meta lines and sidechain (subagent) messages. Returns undefined when nothing decisive is present.
 */
export function classifyTail(records: readonly unknown[]): TailVerdict | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = rec(records[i]);
    if (r === undefined || !isRealMessage(r) || r.isMeta === true) continue;
    const at = Date.parse(str(r.timestamp) ?? '');
    const when = Number.isNaN(at) ? undefined : at;
    const msg = messageOf(r);

    if (r.type === 'assistant') {
      const blocks = contentBlocks(r);
      if (blocks.some((b) => b.type === 'tool_use')) return { signal: 'working', at: when };
      const stop = str(msg?.stop_reason);
      if (stop === undefined || !ENDED_STOP_REASONS.has(stop)) return { signal: 'working', at: when }; // still streaming
      const text = blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n').trimEnd();
      return { signal: 'awaiting_reply', lastIsQuestion: text.endsWith('?'), at: when };
    }

    // user record
    if (contentBlocks(r).some((b) => b.type === 'tool_result')) return { signal: 'working', at: when };
    const text = firstText(msg?.content);
    if (interruptMarker(text) !== undefined) return { signal: 'interrupt_marker', at: when };
    if (/^\s*<local-command-(stdout|stderr)>/.test(text)) return { signal: 'awaiting_reply', lastIsQuestion: false, at: when };
    return { signal: 'working', at: when };
  }
  return undefined;
}

/** True when the last decisive record is the assistant handing the turn back. */
export function awaitingReply(records: readonly unknown[]): boolean {
  return classifyTail(records)?.signal === 'awaiting_reply';
}

/** The interrupt markers (V2) among `records`, in order. */
export function interruptMarkers(records: readonly unknown[]): { kind: 'user' | 'tool_use'; at?: number }[] {
  const out: { kind: 'user' | 'tool_use'; at?: number }[] = [];
  for (const raw of records) {
    const r = rec(raw);
    if (r === undefined || r.type !== 'user') continue;
    const kind = interruptMarker(firstText(messageOf(r)?.content));
    if (kind !== undefined) {
      const at = Date.parse(str(r.timestamp) ?? '');
      out.push({ kind, at: Number.isNaN(at) ? undefined : at });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// cache fallback (C2): when the status line is unavailable, infer the prompt-cache TTL from usage
// ---------------------------------------------------------------------------

export interface TranscriptCache {
  warm: boolean | null;
  ttl?: '5m' | '1h';
  expiresAt?: number;
  lastCallAt?: number;
  source: 'transcript';
}

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const;

/**
 * Cache state from assistant `usage` records: the last call time, and the TTL from the most recent record that wrote
 * cache (`cache_creation.ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`). `warm` is null when no TTL is known.
 */
export function cacheFromRecords(records: readonly unknown[], now: number): TranscriptCache {
  let lastCallAt: number | undefined;
  let ttl: '5m' | '1h' | undefined;
  for (let i = records.length - 1; i >= 0 && (lastCallAt === undefined || ttl === undefined); i--) {
    const r = rec(records[i]);
    const usage = rec(messageOf(r ?? {})?.usage);
    if (r === undefined || r.type !== 'assistant' || usage === undefined || r.isSidechain === true) continue;
    if (lastCallAt === undefined) {
      const at = Date.parse(str(r.timestamp) ?? '');
      if (!Number.isNaN(at)) lastCallAt = at;
    }
    if (ttl === undefined) {
      const created = rec(usage.cache_creation);
      if ((num(created?.ephemeral_1h_input_tokens) ?? 0) > 0) ttl = '1h';
      else if ((num(created?.ephemeral_5m_input_tokens) ?? 0) > 0) ttl = '5m';
    }
  }
  if (ttl === undefined || lastCallAt === undefined) return { warm: null, ttl, lastCallAt, source: 'transcript' };
  const expiresAt = lastCallAt + TTL_MS[ttl];
  return { warm: now < expiresAt, ttl, expiresAt, lastCallAt, source: 'transcript' };
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

export type TitleSource = 'custom' | 'ai' | 'summary' | 'prompt';
export interface TranscriptMeta {
  title?: string;
  titleSource?: TitleSource;
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  startedAt?: number;
  lastAt?: number;
  sizeBytes: number;
}

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 512 * 1024;
const metaCache = new Map<string, { mtimeMs: number; size: number; meta: TranscriptMeta }>();

/** Build metadata from records already read (head records first, then tail records). Later titles win. */
export function metaFromRecords(records: readonly unknown[], sizeBytes: number): TranscriptMeta {
  const m: TranscriptMeta = { sizeBytes };
  for (const raw of records) {
    const r = rec(raw);
    if (r === undefined) continue;
    if (r.type === 'custom-title') m.customTitle = str(r.customTitle) ?? m.customTitle;
    else if (r.type === 'ai-title') m.aiTitle = str(r.aiTitle) ?? m.aiTitle;
    else if (r.type === 'summary') m.summary = str(r.summary) ?? m.summary;
    m.sessionId ??= str(r.sessionId);
    m.cwd ??= str(r.cwd);
    m.gitBranch ??= str(r.gitBranch);
    m.version ??= str(r.version);
    m.entrypoint ??= str(r.entrypoint);
    const at = Date.parse(str(r.timestamp) ?? '');
    if (!Number.isNaN(at)) {
      m.startedAt = m.startedAt === undefined ? at : Math.min(m.startedAt, at);
      m.lastAt = m.lastAt === undefined ? at : Math.max(m.lastAt, at);
    }
    if (m.firstPrompt === undefined && r.type === 'user' && r.isMeta !== true && r.isSidechain !== true) {
      const content = messageOf(r)?.content;
      const hasToolResult = Array.isArray(content) && contentBlocks(r).some((b) => b.type === 'tool_result');
      const p = hasToolResult ? '' : cleanPrompt(firstText(content));
      if (p !== '' && interruptMarker(p) === undefined) m.firstPrompt = p;
    }
  }
  if (m.customTitle) [m.title, m.titleSource] = [m.customTitle, 'custom'];
  else if (m.aiTitle) [m.title, m.titleSource] = [m.aiTitle, 'ai'];
  else if (m.summary) [m.title, m.titleSource] = [m.summary, 'summary'];
  else if (m.firstPrompt) [m.title, m.titleSource] = [m.firstPrompt, 'prompt'];
  return m;
}

/**
 * Title and identity facts for a transcript file: custom title > AI title > summary > first prompt.
 * Reads only the head and tail of the file, and caches by (mtime, size). Returns null if the file is unreadable.
 */
export async function readTranscriptMeta(path: string): Promise<TranscriptMeta | null> {
  try {
    const st = await stat(path);
    const hit = metaCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.meta;
    const head = jsonLines(await readHead(path, HEAD_BYTES));
    const tail = st.size > HEAD_BYTES ? jsonLines(await readTail(path, TAIL_BYTES)) : [];
    const meta = metaFromRecords([...head, ...tail], st.size);
    metaCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    return null;
  }
}

export function clearMetaCache(): void {
  metaCache.clear();
}
