import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { appendBytes, makeTmpDir, removeDir, writeText } from '../testing/tmp-fs.ts';
import {
  awaitingReply, cacheFromRecords, classifyTail, cleanPrompt, clearMetaCache, firstText, interruptMarker,
  interruptMarkers, metaFromRecords, readTranscriptMeta,
} from './parse.ts';

// Synthetic records in the shape of Claude Code 2.1.x transcripts (no personal content).
const ts = (n: number): string => new Date(Date.UTC(2026, 9, 7, 9, 0, n)).toISOString();
const user = (text: string, n = 0, extra: object = {}) => ({ type: 'user', timestamp: ts(n), message: { role: 'user', content: text }, ...extra });
const userBlocks = (blocks: object[], n = 0) => ({ type: 'user', timestamp: ts(n), message: { role: 'user', content: blocks } });
const assistant = (blocks: object[], stop: string | null, n = 0, usage?: object, extra: object = {}) => ({
  type: 'assistant', timestamp: ts(n), message: { role: 'assistant', content: blocks, stop_reason: stop, usage }, ...extra,
});
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } };
const toolResult = { type: 'tool_result', tool_use_id: 't1', content: 'ok' };

describe('firstText / cleanPrompt / interruptMarker', () => {
  it('firstText', () => {
    expect(firstText('plain')).toBe('plain');
    expect(firstText([{ type: 'tool_use' }, { type: 'text', text: 'hi' }, { type: 'text', text: 'later' }])).toBe('hi');
    expect(firstText([{ type: 'text', text: 5 }, null, 'x'])).toBe('');
    expect(firstText(undefined)).toBe('');
  });

  it('cleanPrompt removes injected blocks and collapses whitespace', () => {
    expect(cleanPrompt('<system-reminder>ignore\nme</system-reminder>\n  Fix   the\n bug ')).toBe('Fix the bug');
    expect(cleanPrompt('<local-command-caveat>x</local-command-caveat>')).toBe('');
    expect(cleanPrompt('<ide_opened_file>a.ts</ide_opened_file>Why?')).toBe('Why?');
  });

  it('cleanPrompt shows slash commands as /name args', () => {
    expect(cleanPrompt('<command-message>m</command-message>\n<command-name>/review</command-name>\n<command-args>PR 5</command-args>')).toBe('/review PR 5');
    expect(cleanPrompt('<command-name>/clear</command-name>')).toBe('/clear');
  });

  it('cleanPrompt truncates with an ellipsis', () => {
    const out = cleanPrompt('a'.repeat(300), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('…')).toBe(true);
    expect(cleanPrompt('short', 50)).toBe('short');
  });

  it('interrupt markers (V2): both spellings', () => {
    expect(interruptMarker('[Request interrupted by user]')).toBe('user');
    expect(interruptMarker('  [Request interrupted by user for tool use]\n')).toBe('tool_use');
    expect(interruptMarker('please [Request interrupted by user]')).toBeUndefined();
    expect(interruptMarker('hello')).toBeUndefined();
  });
});

describe('classifyTail / awaitingReply', () => {
  it('assistant end_turn -> awaiting_reply, with the question flag and time', () => {
    const v = classifyTail([user('hi'), assistant([text('Done.')], 'end_turn', 5)]);
    expect(v).toEqual({ signal: 'awaiting_reply', lastIsQuestion: false, at: Date.parse(ts(5)) });
    expect(classifyTail([assistant([text('Shall I go on?  ')], 'end_turn')])?.lastIsQuestion).toBe(true);
    expect(awaitingReply([assistant([text('x')], 'end_turn')])).toBe(true);
  });

  it('assistant with a tool_use, a null stop_reason, or an unknown one -> working', () => {
    expect(classifyTail([assistant([text('run'), toolUse], 'tool_use')])?.signal).toBe('working');
    expect(classifyTail([assistant([text('partial')], null)])?.signal).toBe('working');
    expect(classifyTail([assistant([text('x')], 'weird')])?.signal).toBe('working');
    expect(awaitingReply([assistant([toolUse], 'end_turn')])).toBe(false);
  });

  it('a user prompt or a tool_result last -> working', () => {
    expect(classifyTail([assistant([text('x')], 'end_turn'), user('next please')])?.signal).toBe('working');
    expect(classifyTail([assistant([toolUse], 'tool_use'), userBlocks([toolResult])])?.signal).toBe('working');
  });

  it('interrupt markers, both spellings, in string and block content', () => {
    expect(classifyTail([user('go'), userBlocks([text('[Request interrupted by user]')], 3)])).toMatchObject({ signal: 'interrupt_marker', at: Date.parse(ts(3)) });
    expect(classifyTail([assistant([toolUse], 'tool_use'), userBlocks([text('[Request interrupted by user for tool use]')])])?.signal).toBe('interrupt_marker');
    expect(classifyTail([user('[Request interrupted by user]')])?.signal).toBe('interrupt_marker');
  });

  it('local command output means the session is idle', () => {
    expect(classifyTail([user('<command-name>/clear</command-name>'), user('<local-command-stdout>cleared</local-command-stdout>')])).toMatchObject({ signal: 'awaiting_reply', lastIsQuestion: false });
    expect(classifyTail([user('<local-command-stderr>x</local-command-stderr>')])?.signal).toBe('awaiting_reply');
    expect(classifyTail([user('<command-name>/review</command-name>')])?.signal).toBe('working');
  });

  it('skips bookkeeping, meta, system, sidechain and malformed records', () => {
    const tail = [
      assistant([text('Finished.')], 'end_turn', 1),
      { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(2) },
      { type: 'custom-title', customTitle: 't' },
      { type: 'last-prompt', lastPrompt: 'p' },
      { type: 'file-history-snapshot' },
      { type: 'queue-operation', operation: 'enqueue' },
      user('<local-command-caveat>c</local-command-caveat>', 3, { isMeta: true }),
      assistant([toolUse], 'tool_use', 4, undefined, { isSidechain: true }),
      null,
      'junk',
      [],
    ];
    expect(classifyTail(tail)).toMatchObject({ signal: 'awaiting_reply', at: Date.parse(ts(1)) });
  });

  it('returns undefined for nothing decisive; a missing timestamp gives no time', () => {
    expect(classifyTail([])).toBeUndefined();
    expect(classifyTail([{ type: 'system' }])).toBeUndefined();
    expect(awaitingReply([])).toBe(false);
    expect(classifyTail([{ type: 'user', message: { content: 'hi' } }])?.at).toBeUndefined();
  });

  it('assistant message without usable content blocks', () => {
    expect(classifyTail([{ type: 'assistant', message: { stop_reason: 'end_turn' } }])).toMatchObject({ signal: 'awaiting_reply', lastIsQuestion: false });
    expect(classifyTail([{ type: 'assistant', message: { stop_reason: 'end_turn', content: 'oops' } }])?.signal).toBe('awaiting_reply');
    expect(classifyTail([{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text' }, 5] } }])?.signal).toBe('awaiting_reply');
  });

  it('interruptMarkers lists them in order', () => {
    const recs = [user('a'), user('[Request interrupted by user]', 1), assistant([text('x')], 'end_turn'), userBlocks([text('[Request interrupted by user for tool use]')]), { type: 'user' }, 5];
    expect(interruptMarkers(recs)).toEqual([{ kind: 'user', at: Date.parse(ts(1)) }, { kind: 'tool_use', at: Date.parse(ts(0)) }]);
    expect(interruptMarkers([{ type: 'user', message: { content: '[Request interrupted by user]' } }])).toEqual([{ kind: 'user', at: undefined }]);
  });
});

describe('cacheFromRecords (C2 fallback)', () => {
  const usage = (c5: number, c1: number) => ({ input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 } });
  const t = (n: number) => Date.parse(ts(n));

  it('1h cache writes -> 1h TTL; warm until lastCall + 1h', () => {
    const recs = [assistant([text('a')], 'end_turn', 10, usage(0, 2542))];
    expect(cacheFromRecords(recs, t(10) + 59 * 60_000)).toEqual({ warm: true, ttl: '1h', expiresAt: t(10) + 3_600_000, lastCallAt: t(10), source: 'transcript' });
    expect(cacheFromRecords(recs, t(10) + 61 * 60_000).warm).toBe(false);
  });

  it('5m cache writes -> 5m TTL', () => {
    const recs = [assistant([text('a')], 'end_turn', 10, usage(5076, 0))];
    const c = cacheFromRecords(recs, t(10) + 4 * 60_000);
    expect(c).toMatchObject({ warm: true, ttl: '5m' });
    expect(cacheFromRecords(recs, t(10) + 6 * 60_000).warm).toBe(false);
  });

  it('takes the TTL from the newest record that wrote cache and the time from the newest call', () => {
    const recs = [
      assistant([text('a')], 'tool_use', 10, usage(0, 100)),
      assistant([text('b')], 'end_turn', 20, usage(0, 0)), // read-only call: no new writes
    ];
    expect(cacheFromRecords(recs, t(20))).toMatchObject({ ttl: '1h', lastCallAt: t(20), warm: true });
  });

  it('unknown TTL or no calls -> warm null', () => {
    expect(cacheFromRecords([assistant([text('a')], 'end_turn', 1, usage(0, 0))], t(2))).toMatchObject({ warm: null, ttl: undefined, lastCallAt: t(1) });
    expect(cacheFromRecords([], 0)).toEqual({ warm: null, ttl: undefined, lastCallAt: undefined, source: 'transcript' });
    expect(cacheFromRecords([assistant([text('a')], 'end_turn', 1, { cache_creation: 5 })], 0).warm).toBeNull();
  });

  it('ignores sidechain and usage-less records', () => {
    const recs = [assistant([text('a')], 'end_turn', 10, usage(0, 9)), assistant([text('b')], 'end_turn', 99, usage(1, 0), { isSidechain: true }), assistant([text('c')], 'end_turn', 98)];
    expect(cacheFromRecords(recs, t(10))).toMatchObject({ ttl: '1h', lastCallAt: t(10) });
  });

  it('a record with an unparseable timestamp gives no call time', () => {
    const r = { type: 'assistant', timestamp: 'nope', message: { usage: usage(1, 0) } };
    expect(cacheFromRecords([r], 0)).toMatchObject({ warm: null, ttl: '5m', lastCallAt: undefined });
  });
});

describe('metaFromRecords: title priority', () => {
  const base = [user('Fix the login bug', 1, { sessionId: 's', cwd: '~/repo', gitBranch: 'main', version: '2.1.292', entrypoint: 'cli' })];
  it('custom > ai > summary > first prompt', () => {
    const all = [...base, { type: 'summary', summary: 'S' }, { type: 'ai-title', aiTitle: 'A' }, { type: 'custom-title', customTitle: 'C' }];
    expect(metaFromRecords(all, 1)).toMatchObject({ title: 'C', titleSource: 'custom' });
    expect(metaFromRecords(all.slice(0, 3), 1)).toMatchObject({ title: 'A', titleSource: 'ai' });
    expect(metaFromRecords(all.slice(0, 2), 1)).toMatchObject({ title: 'S', titleSource: 'summary' });
    expect(metaFromRecords(base, 1)).toMatchObject({ title: 'Fix the login bug', titleSource: 'prompt' });
    expect(metaFromRecords([], 0)).toEqual({ sizeBytes: 0 });
  });

  it('the latest title of a kind wins; empty or non-string titles are ignored', () => {
    const m = metaFromRecords([{ type: 'custom-title', customTitle: 'old' }, { type: 'custom-title', customTitle: 'new' }, { type: 'custom-title', customTitle: 5 }, { type: 'ai-title', aiTitle: '' }], 0);
    expect(m).toMatchObject({ title: 'new', customTitle: 'new' });
  });

  it('identity facts come from the first record that has them; times span the file', () => {
    const m = metaFromRecords([...base, assistant([text('x')], 'end_turn', 9, undefined, { cwd: '~/other' })], 10);
    expect(m).toMatchObject({ sessionId: 's', cwd: '~/repo', gitBranch: 'main', version: '2.1.292', entrypoint: 'cli', startedAt: Date.parse(ts(1)), lastAt: Date.parse(ts(9)), sizeBytes: 10 });
  });

  it('first prompt skips meta lines, sidechains, tool results, interrupt markers and empty cleaned text', () => {
    const m = metaFromRecords([
      user('<local-command-caveat>c</local-command-caveat>', 0, { isMeta: true }),
      user('x', 0, { isSidechain: true }),
      userBlocks([toolResult]),
      user('[Request interrupted by user]'),
      user('<system-reminder>only noise</system-reminder>'),
      user('The real question'),
      user('a later prompt'),
    ], 0);
    expect(m.firstPrompt).toBe('The real question');
    expect(metaFromRecords([userBlocks([text('block prompt')])], 0).firstPrompt).toBe('block prompt');
    expect(metaFromRecords([42, 'x', null], 0)).toEqual({ sizeBytes: 0 });
  });
});

describe('readTranscriptMeta', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = makeTmpDir();
    file = join(dir, 's.jsonl');
    clearMetaCache();
  });
  afterEach(() => removeDir(dir));
  const lines = (recs: unknown[]): string => recs.map((r) => `${JSON.stringify(r)}\n`).join('');

  it('reads a small file and caches by mtime and size', async () => {
    writeText(file, lines([user('Hello there', 1, { sessionId: 's1' })]));
    const a = await readTranscriptMeta(file);
    expect(a).toMatchObject({ title: 'Hello there', sessionId: 's1' });
    expect(await readTranscriptMeta(file)).toBe(a); // same object from the cache
    appendBytes(file, lines([{ type: 'custom-title', customTitle: 'Renamed' }]));
    expect(await readTranscriptMeta(file)).toMatchObject({ title: 'Renamed', titleSource: 'custom' });
  });

  it('a big file: first prompt from the head, the final title from the tail, without reading the middle', async () => {
    const filler = lines(Array.from({ length: 6000 }, (_, i) => assistant([text(`filler ${i} ${'y'.repeat(100)}`)], 'end_turn', 2)));
    writeText(file, lines([user('Opening request', 1)]) + filler + lines([{ type: 'custom-title', customTitle: 'Late title' }]));
    const m = await readTranscriptMeta(file);
    expect(m).toMatchObject({ firstPrompt: 'Opening request', title: 'Late title', titleSource: 'custom' });
    expect(m?.sizeBytes).toBeGreaterThan(512 * 1024);
  });

  it('returns null for a missing file', async () => {
    expect(await readTranscriptMeta(join(dir, 'nope.jsonl'))).toBeNull();
  });
});
