// Transcript records -> ChatItem[] (plan task 5.01, section 5 ChatItem; spike S4/S6/S11/S17 transcript shapes).
//
// `ChatBuilder` is a pure, incremental reducer. Feed it parsed JSONL records in file order (`ingest`) and it keeps the
// item list; each call returns a tail delta `{ from, items }`: the client replaces its list from index `from` onward.
// A tool result changes an earlier tool item, a subagent thread appears after its Agent tool item and grows later, so
// `from` is the lowest top-level index that changed in this call.
//
// What the transcript looks like (fixtures/claude/2.1.292/transcripts, [ran]):
//   - one record per COMPLETED content block; a tool call is an assistant record with a `tool_use` block, its result a
//     later user record with a `tool_result` block (same `tool_use_id`) plus `toolUseResult` (Edit/Write: `structuredPatch`)
//   - slash commands: a plain user record ("/compact") or `<command-name>` markup; their `<local-command-stdout>` is noise
//   - compaction: a `system` record with subtype `compact_boundary`; the summary user record has `isCompactSummary`
//   - interrupts: a user text block "[Request interrupted by user]" (" for tool use]")
//   - subagents: records with `isSidechain` + `agentId`, in <session>/subagents/agent-<id>.jsonl (+ .meta.json with
//     `description` and the `toolUseId` of the Agent call that started it)
// Everything is read defensively (V14: the format is internal to Claude Code and changes between versions).
//
// Items are plain objects that this class keeps mutating (a tool item gains its result). Serialise them at once (the hub
// does) or copy them; do not hold on to them across `ingest` calls.
import type { ChatItem } from '@strategos/shared';
import { summarise } from '../hooks/receiver.ts';
import { interruptMarker } from './parse.ts';

type Rec = Record<string, unknown>;
type ToolItem = Extract<ChatItem, { k: 'tool' }>;
type SubagentItem = Extract<ChatItem, { k: 'subagent' }>;
type MarkerKind = Extract<ChatItem, { k: 'marker' }>['marker'];

const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const LIMITS = {
  userChars: 20_000,
  resultChars: 4_000,
  diffLines: 300,
  diffLineChars: 2_000,
  briefChars: 160,
} as const;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const NOISE_BLOCKS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|ide_opened_file|ide_selection|user-prompt-submit-hook|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

function cut(text: string, max: number, what = 'characters'): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more ${what})`;
}

/** The text of a tool_result `content` (string, or text/image blocks). */
function resultText(content: unknown): string {
  let t: string;
  if (typeof content === 'string') t = content;
  else {
    t = arr(content).map((b) => {
      const r = rec(b);
      if (r?.type === 'text') return str(r.text) ?? '';
      if (r?.type === 'image') return '[image]';
      return '';
    }).filter((s) => s !== '').join('\n');
  }
  return cut(t.replace(ANSI, ''), LIMITS.resultChars);
}

/** Text blocks of a user message, joined (a plain string content is one block). */
function userBlocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content).map((b) => {
    const r = rec(b);
    return r?.type === 'text' ? (str(r.text) ?? '') : '';
  }).filter((s) => s !== '').join('\n');
}

/**
 * What a person typed, from a user record's text. `undefined`: nothing to show (injected reminders, command output,
 * task notifications). A slash command comes back as `/name args`, a `!` shell line as `! cmd`.
 */
export function userMessage(text: string): { kind: 'text'; text: string } | { kind: 'interrupt' } | undefined {
  if (interruptMarker(text) !== undefined) return { kind: 'interrupt' };
  if (/^\s*<local-command-(stdout|stderr)>/.test(text) || /^\s*<task-notification>/.test(text)) return undefined;
  let t = text;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim();
  if (name !== undefined) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
    t = args === '' ? name : `${name} ${args}`;
  } else {
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t)?.[1]?.trim();
    if (bash !== undefined) t = `! ${bash}`;
    else t = t.replace(NOISE_BLOCKS, ' ');
  }
  t = t.trim();
  return t === '' ? undefined : { kind: 'text', text: cut(t, LIMITS.userChars) };
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

const normPath = (p: string): string => p.replace(/\\/g, '/');

function finishDiff(lines: string[]): string {
  const shown = lines.slice(0, LIMITS.diffLines).map((l) => (l.length > LIMITS.diffLineChars ? `${l.slice(0, LIMITS.diffLineChars)}…` : l));
  if (lines.length > shown.length) shown.push(`\\ ${lines.length - shown.length} more diff lines not shown`);
  return shown.join('\n');
}

const textLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/** Unified diff from the `structuredPatch` of a tool result ([{oldStart, oldLines, newStart, newLines, lines[]}]). */
export function diffFromPatch(filePath: string, patch: unknown): string | undefined {
  const hunks = arr(patch).map(rec).filter((h): h is Rec => h !== undefined);
  if (hunks.length === 0) return undefined;
  const p = normPath(filePath);
  const out = [`--- a/${p}`, `+++ b/${p}`];
  for (const h of hunks) {
    const n = (k: string): number => (typeof h[k] === 'number' ? (h[k]) : 0);
    out.push(`@@ -${n('oldStart')},${n('oldLines')} +${n('newStart')},${n('newLines')} @@`);
    for (const l of arr(h.lines)) if (typeof l === 'string') out.push(l);
  }
  return finishDiff(out);
}

/** Diff for a newly created file: every line added. */
export function diffForCreate(filePath: string, content: string): string {
  const p = normPath(filePath);
  const lines = textLines(content);
  return finishDiff([`--- /dev/null`, `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)]);
}

/** A provisional diff from the tool call itself (shown while the request waits for approval). Hunk line numbers are unknown, so `@@ @@`. */
export function diffFromInput(tool: string, input: Rec): string | undefined {
  const file = str(input.file_path);
  if (file === undefined) return undefined;
  const p = normPath(file);
  if (tool === 'Write') {
    return typeof input.content === 'string' ? diffForCreate(file, input.content) : undefined;
  }
  const edits: { o: string; n: string }[] = [];
  if (tool === 'Edit') edits.push({ o: str(input.old_string) ?? '', n: str(input.new_string) ?? '' });
  else if (tool === 'MultiEdit') {
    for (const e of arr(input.edits)) {
      const r = rec(e);
      if (r !== undefined) edits.push({ o: str(r.old_string) ?? '', n: str(r.new_string) ?? '' });
    }
  }
  if (edits.length === 0) return undefined;
  const out = [`--- a/${p}`, `+++ b/${p}`];
  for (const e of edits) {
    out.push('@@ @@');
    for (const l of textLines(e.o)) out.push(`-${l}`);
    for (const l of textLines(e.n)) out.push(`+${l}`);
  }
  return finishDiff(out);
}

/** The exact diff from `toolUseResult` (Edit/MultiEdit: structuredPatch; Write: create content or structuredPatch). */
function diffFromResult(tur: unknown, fallbackPath: string | undefined): string | undefined {
  const r = rec(tur);
  if (r === undefined) return undefined;
  const file = str(r.filePath) ?? fallbackPath;
  if (file === undefined) return undefined;
  const fromPatch = diffFromPatch(file, r.structuredPatch);
  if (fromPatch !== undefined) return fromPatch;
  if (r.type === 'create' && typeof r.content === 'string') return diffForCreate(file, r.content);
  return undefined;
}

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

export interface ChatDelta {
  /** Index in the top-level list of the first item that changed. */
  from: number;
  /** The list from `from` to the end. */
  items: ChatItem[];
}

export interface SubagentDecl {
  agentId: string;
  /** The `tool_use_id` of the Agent call that started it (meta.json `toolUseId`). */
  toolUseId?: string;
  brief?: string;
}

interface Sub {
  item: SubagentItem;
}

export class ChatBuilder {
  readonly #items: ChatItem[] = [];
  /** Time of each top-level item (a subagent thread takes the time of its Agent call); lets a marker find its place. */
  readonly #ats: number[] = [];
  readonly #tools = new Map<string, { item: ToolItem; agentId: string | undefined }>();
  readonly #subs = new Map<string, Sub>();
  readonly #seen = new Set<string>();
  #dirty = Infinity;
  #seq = 0;
  #lastAt = 0;

  /** The current list. Do not keep it across `ingest` calls (see the file comment). */
  items(): readonly ChatItem[] {
    return this.#items;
  }

  get length(): number {
    return this.#items.length;
  }

  // ---- public API -----------------------------------------------------------

  /**
   * Feed records in file order. `agentId` says they come from that subagent's file (records carrying `isSidechain` + `agentId`
   * in the main file are routed the same way). Returns what changed, or undefined when nothing did.
   */
  ingest(records: readonly unknown[], o: { agentId?: string } = {}): ChatDelta | undefined {
    this.#dirty = Infinity;
    for (const raw of records) {
      const r = rec(raw);
      if (r === undefined) continue;
      try {
        this.#record(r, o.agentId ?? (r.isSidechain === true ? str(r.agentId) : undefined));
      } catch {
        // a record shape we did not expect: skip it, keep the rest
      }
    }
    return this.#take();
  }

  /** Make (or update) the thread of a subagent. It appears right after the Agent tool item it belongs to. */
  declareSubagent(d: SubagentDecl): ChatDelta | undefined {
    this.#dirty = Infinity;
    const sub = this.#sub(d.agentId, d.toolUseId);
    if (d.brief !== undefined && d.brief !== '' && sub.item.brief !== d.brief) {
      sub.item.brief = d.brief.length > LIMITS.briefChars ? `${d.brief.slice(0, LIMITS.briefChars - 1)}…` : d.brief;
      this.#touchSub(sub);
    }
    return this.#take();
  }

  /**
   * A lineage marker (/clear, resume, fork) placed by time: before the first item that is newer than `at` (at the end when
   * none is). Same marker twice: ignored.
   */
  addMarker(marker: MarkerKind, at: number): ChatDelta | undefined {
    this.#dirty = Infinity;
    const id = `marker:${marker}:${at}`;
    if (!this.#items.some((i) => i.k === 'marker' && i.id === id)) {
      let i = this.#items.length;
      while (i > 0 && (this.#ats[i - 1] ?? 0) > at) i--;
      this.#items.splice(i, 0, { k: 'marker', id, marker, at });
      this.#ats.splice(i, 0, at);
      this.#mark(i);
    }
    return this.#take();
  }

  // ---- internals -----------------------------------------------------------------

  #take(): ChatDelta | undefined {
    if (this.#dirty === Infinity) return undefined;
    const from = Math.min(this.#dirty, this.#items.length);
    this.#dirty = Infinity;
    return { from, items: this.#items.slice(from) };
  }

  #mark(i: number): void {
    if (i >= 0 && i < this.#dirty) this.#dirty = i;
  }

  #push(item: ChatItem): void {
    this.#mark(this.#items.length);
    this.#items.push(item);
    this.#ats.push(item.k === 'subagent' ? this.#lastAt : item.at ?? this.#lastAt);
  }

  #touchSub(sub: Sub): void {
    this.#mark(this.#items.lastIndexOf(sub.item));
  }

  #sub(agentId: string, toolUseId?: string): Sub {
    let sub = this.#subs.get(agentId);
    if (sub === undefined) {
      sub = { item: { k: 'subagent', id: `subagent:${agentId}`, agentId, brief: '', items: [] } };
      this.#subs.set(agentId, sub);
      const parent = toolUseId === undefined ? undefined : this.#tools.get(toolUseId);
      const at = parent === undefined ? -1 : this.#items.lastIndexOf(parent.item);
      if (at >= 0) {
        this.#items.splice(at + 1, 0, sub.item);
        this.#ats.splice(at + 1, 0, this.#ats[at] ?? this.#lastAt);
        this.#mark(at + 1);
      } else {
        this.#push(sub.item);
      }
    }
    return sub;
  }

  #id(r: Rec): string {
    return str(r.uuid) ?? `rec:${this.#seq}`;
  }

  #at(r: Rec): number {
    const t = Date.parse(str(r.timestamp) ?? '');
    if (!Number.isNaN(t)) this.#lastAt = t;
    return this.#lastAt;
  }

  /** Append to the thread (main list, or the items of a subagent). */
  #add(item: ChatItem, agentId: string | undefined): void {
    if (agentId === undefined) {
      this.#push(item);
      return;
    }
    const sub = this.#sub(agentId);
    sub.item.items.push(item);
    this.#touchSub(sub);
  }

  #record(r: Rec, agentId: string | undefined): void {
    this.#seq += 1;
    const uuid = str(r.uuid);
    if (uuid !== undefined) {
      if (this.#seen.has(uuid)) return; // a fork copies history into its own transcript
      this.#seen.add(uuid);
    }
    const at = this.#at(r);
    switch (r.type) {
      case 'system':
        if (r.subtype === 'compact_boundary') this.#add({ k: 'compact', id: this.#id(r), at }, agentId);
        return;
      case 'user':
        this.#user(r, agentId, at);
        return;
      case 'assistant':
        this.#assistant(r, agentId, at);
        return;
      default:
    }
  }

  #user(r: Rec, agentId: string | undefined, at: number): void {
    if (r.isMeta === true || r.isCompactSummary === true) return;
    const content = rec(r.message)?.content;
    const results = arr(content).map(rec).filter((b): b is Rec => b?.type === 'tool_result');
    for (const b of results) this.#result(b, r, results.length === 1, agentId);

    const text = userBlocksText(content);
    if (text === '') return;
    const origin = str(rec(r.origin)?.kind);
    if (origin !== undefined && origin !== 'human') return; // task notifications and other system-made prompts
    const m = userMessage(text);
    if (m === undefined) return;
    const id = this.#id(r);
    if (m.kind === 'interrupt') {
      this.#add({ k: 'interrupted', id, at }, agentId);
      return;
    }
    if (agentId !== undefined) {
      // The first user record of a subagent file is the brief the main agent gave it.
      const sub = this.#sub(agentId);
      if (sub.item.brief === '') {
        sub.item.brief = m.text.length > LIMITS.briefChars ? `${m.text.slice(0, LIMITS.briefChars - 1)}…` : m.text;
        this.#touchSub(sub);
      }
      return;
    }
    // The plain and the markup record of one slash command (a compact boundary can sit between them).
    if (m.text.startsWith('/') && this.#items.slice(-3).some((p) => p.k === 'user' && p.text === m.text)) return;
    this.#push({ k: 'user', id, text: m.text, at });
  }

  #assistant(r: Rec, agentId: string | undefined, at: number): void {
    const content = rec(r.message)?.content;
    const base = this.#id(r);
    if (typeof content === 'string') {
      if (content.trim() !== '') this.#add({ k: 'assistant', id: base, md: content, at }, agentId);
      return;
    }
    const blocks = arr(content).map(rec).filter((b): b is Rec => b !== undefined);
    blocks.forEach((b, i) => {
      const id = blocks.length === 1 ? base : `${base}:${i}`;
      if (b.type === 'text') {
        const md = str(b.text) ?? '';
        if (md.trim() !== '') this.#add({ k: 'assistant', id, md, at }, agentId);
      } else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        const input = rec(b.input) ?? {};
        const toolId = str(b.id) ?? id;
        const diff = diffFromInput(name, input);
        const item: ToolItem = {
          k: 'tool', id: toolId, tool: name, summary: summarise(name, input).text, at,
          ...(diff === undefined ? {} : { diff }),
          ...(agentId === undefined ? {} : { agentId }),
        };
        this.#tools.set(toolId, { item, agentId });
        this.#add(item, agentId);
      }
    });
  }

  #result(b: Rec, r: Rec, single: boolean, agentId: string | undefined): void {
    const id = str(b.tool_use_id);
    const hit = id === undefined ? undefined : this.#tools.get(id);
    if (hit === undefined) return;
    const { item } = hit;
    item.result = resultText(b.content);
    item.ok = b.is_error !== true;
    if (single && item.ok) {
      const diff = diffFromResult(r.toolUseResult, str(rec(r.toolUseResult)?.filePath));
      if (diff !== undefined) item.diff = diff;
    } else if (item.ok === false && item.diff !== undefined) {
      delete item.diff; // denied or failed: nothing was written
    }
    // mark the top-level item that holds it
    const owner = hit.agentId ?? agentId;
    if (owner === undefined) this.#mark(this.#items.lastIndexOf(item));
    else {
      const sub = this.#subs.get(owner);
      if (sub !== undefined) this.#touchSub(sub);
    }
  }
}

/** Build the whole list from records in one go (tests and the initial load). */
export function chatItemsFromRecords(records: readonly unknown[], subagents: { agentId: string; toolUseId?: string; brief?: string; records: readonly unknown[] }[] = []): ChatItem[] {
  const b = new ChatBuilder();
  b.ingest(records);
  for (const s of subagents) {
    b.declareSubagent({ agentId: s.agentId, ...(s.toolUseId === undefined ? {} : { toolUseId: s.toolUseId }), ...(s.brief === undefined ? {} : { brief: s.brief }) });
    b.ingest(s.records, { agentId: s.agentId });
  }
  return structuredClone([...b.items()]);
}
