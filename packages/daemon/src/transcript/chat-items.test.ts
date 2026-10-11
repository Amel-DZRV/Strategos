import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@strategos/shared';
import { ChatBuilder, chatItemsFromRecords, diffForCreate, diffFromInput, diffFromPatch, LIMITS, userMessage } from './chat-items.ts';
import { jsonLines } from './fsutil.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../../../fixtures/claude');
const versions = readdirSync(FIX).filter((v) => /^\d/.test(v));

const load = (file: string): unknown[] => jsonLines(readFileSync(file, 'utf8'));
const golden = (name: string): string => path.join(HERE, '__golden__', `${name}.json`);
const pretty = (items: ChatItem[]): string => `${JSON.stringify(items, null, 2)}\n`;

describe.each(versions)('golden: fixture transcripts %s', (version) => {
  const dir = path.join(FIX, version, 'transcripts');
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('subagent-'));

  it('has transcript fixtures', () => { expect(files.length).toBeGreaterThan(10); });

  it.each(files)('%s', async (f) => {
    const items = chatItemsFromRecords(load(path.join(dir, f)));
    await expect(pretty(items)).toMatchFileSnapshot(golden(`${version}/${f.replace(/\.jsonl$/, '')}`));
    // Every item has a stable, unique id.
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the subagent thread nests after its Agent tool item', async () => {
    const main = load(path.join(dir, 'turn-subagent-agent-tool-background.jsonl'));
    const meta = JSON.parse(readFileSync(path.join(dir, 'subagent-agent.meta.json'), 'utf8')) as { toolUseId: string; description: string };
    const sub = load(path.join(dir, 'subagent-agent-jsonl-head-and-tail.jsonl'));
    const items = chatItemsFromRecords(main, [{ agentId: 'a895b2d673a391084', toolUseId: meta.toolUseId, brief: meta.description, records: sub }]);
    await expect(pretty(items)).toMatchFileSnapshot(golden(`${version}/turn-subagent-with-thread`));
    const i = items.findIndex((x) => x.k === 'tool' && x.tool === 'Agent');
    expect(items[i + 1]).toMatchObject({ k: 'subagent', agentId: 'a895b2d673a391084', brief: 'Read README first line' });
    const thread = (items[i + 1] as Extract<ChatItem, { k: 'subagent' }>).items;
    expect(thread.filter((x) => x.k === 'tool').map((x) => (x as { agentId?: string }).agentId)).toEqual(['a895b2d673a391084']);
    expect(thread.every((x) => x.k !== 'user')).toBe(true);
  });

  it('feeding records one at a time gives the same list, and the deltas replay to it', () => {
    for (const f of files) {
      const records = load(path.join(dir, f));
      const batch = chatItemsFromRecords(records);
      const b = new ChatBuilder();
      let client: ChatItem[] = [];
      for (const r of records) {
        const d = b.ingest([r]);
        if (d !== undefined) client = [...client.slice(0, d.from), ...structuredClone(d.items)];
      }
      expect(client, f).toEqual(batch);
    }
  });
});

describe('user messages', () => {
  it('keeps slash commands, drops command output and injected noise', () => {
    expect(userMessage('/compact')).toEqual({ kind: 'text', text: '/compact' });
    expect(userMessage('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 5</command-args>')).toEqual({ kind: 'text', text: '/review PR 5' });
    expect(userMessage('<local-command-stdout>Compacted</local-command-stdout>')).toBeUndefined();
    expect(userMessage('<system-reminder>be nice</system-reminder>')).toBeUndefined();
    expect(userMessage('<task-notification>\n<task-id>x</task-id></task-notification>')).toBeUndefined();
    expect(userMessage('fix it <system-reminder>x</system-reminder>')).toEqual({ kind: 'text', text: 'fix it' });
    expect(userMessage('<bash-input>ls -la</bash-input>')).toEqual({ kind: 'text', text: '! ls -la' });
    expect(userMessage('[Request interrupted by user for tool use]')).toEqual({ kind: 'interrupt' });
  });

  it('cuts very long prompts', () => {
    const m = userMessage('x'.repeat(LIMITS.userChars + 50));
    expect(m?.kind === 'text' && m.text.endsWith('(50 more characters)')).toBe(true);
  });

  it('skips meta, compact summaries, system-origin prompts and a doubled slash command', () => {
    const b = new ChatBuilder();
    b.ingest([
      { type: 'user', uuid: 'u1', timestamp: '2026-10-11T10:00:00Z', message: { content: '/compact' } },
      { type: 'user', uuid: 'u2', isMeta: true, message: { content: '<local-command-caveat>x</local-command-caveat>' } },
      { type: 'user', uuid: 'u3', message: { content: '<command-name>/compact</command-name>' } },
      { type: 'user', uuid: 'u4', isCompactSummary: true, message: { content: 'This session is being continued ...' } },
      { type: 'user', uuid: 'u5', origin: { kind: 'task-notification' }, message: { content: 'anything' } },
      { type: 'user', uuid: 'u6', origin: { kind: 'human' }, message: { content: 'hello' } },
    ]);
    expect(b.items().map((i) => (i.k === 'user' ? i.text : i.k))).toEqual(['/compact', 'hello']);
  });
});

describe('assistant and tool items', () => {
  const tu = (id: string, name: string, input: object, uuid = `a-${id}`) => ({ type: 'assistant', uuid, timestamp: '2026-10-11T10:00:01Z', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const tr = (id: string, content: unknown, extra: object = {}, isError = false) => ({ type: 'user', uuid: `r-${id}`, timestamp: '2026-10-11T10:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra });

  it('pairs a result with its tool item, updating it in place; the delta starts at the tool item', () => {
    const b = new ChatBuilder();
    b.ingest([{ type: 'user', uuid: 'u', message: { content: 'go' } }]);
    const d1 = b.ingest([tu('t1', 'Bash', { command: 'ls' }), { type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: 'running' }] } }]);
    expect(d1?.from).toBe(1);
    expect(b.items()[1]).toMatchObject({ k: 'tool', id: 't1', tool: 'Bash', summary: 'ls' });
    expect(b.items()[1]).not.toHaveProperty('ok');
    const d2 = b.ingest([tr('t1', [{ type: 'text', text: 'a.txt\n\u001b[31mred\u001b[0m' }])]);
    expect(d2?.from).toBe(1);
    expect(d2?.items).toHaveLength(2);
    expect(b.items()[1]).toMatchObject({ result: 'a.txt\nred', ok: true });
  });

  it('marks failures and truncates long results', () => {
    const b = new ChatBuilder();
    b.ingest([tu('t1', 'Bash', { command: 'x' }), tr('t1', 'y'.repeat(LIMITS.resultChars + 10), {}, true)]);
    const t = b.items()[0] as Extract<ChatItem, { k: 'tool' }>;
    expect(t.ok).toBe(false);
    expect(t.result).toMatch(/\(10 more characters\)$/);
  });

  it('Edit: provisional diff from the call, exact diff from structuredPatch, none when denied', () => {
    const b = new ChatBuilder();
    b.ingest([tu('e1', 'Edit', { file_path: 'C:\\r\\a.md', old_string: 'hello', new_string: 'goodbye' })]);
    expect((b.items()[0] as { diff?: string }).diff).toBe('--- a/C:/r/a.md\n+++ b/C:/r/a.md\n@@ @@\n-hello\n+goodbye');
    b.ingest([tr('e1', 'updated', { toolUseResult: { filePath: 'C:\\r\\a.md', structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' ctx', '-hello', '+goodbye'] }] } })]);
    expect((b.items()[0] as { diff?: string }).diff).toBe('--- a/C:/r/a.md\n+++ b/C:/r/a.md\n@@ -3,2 +3,2 @@\n ctx\n-hello\n+goodbye');
    const c = new ChatBuilder();
    c.ingest([tu('e2', 'Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }), tr('e2', 'rejected', { toolUseResult: 'User rejected tool use' }, true)]);
    expect(c.items()[0]).not.toHaveProperty('diff');
  });

  it('Write create and MultiEdit diffs', () => {
    expect(diffForCreate('a/b.txt', 'one\ntwo\n')).toBe('--- /dev/null\n+++ b/a/b.txt\n@@ -0,0 +1,2 @@\n+one\n+two');
    expect(diffFromInput('MultiEdit', { file_path: 'f', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }))
      .toBe('--- a/f\n+++ b/f\n@@ @@\n-a\n+b\n@@ @@\n-c\n+d');
    expect(diffFromInput('Bash', { command: 'ls' })).toBeUndefined();
    expect(diffFromPatch('f', [])).toBeUndefined();
  });

  it('truncates a huge diff', () => {
    const content = Array.from({ length: LIMITS.diffLines + 40 }, (_, i) => `line ${i}`).join('\n');
    const d = diffForCreate('big.txt', content);
    const lines = d.split('\n');
    expect(lines).toHaveLength(LIMITS.diffLines + 1);
    expect(lines.at(-1)).toMatch(/^\\ \d+ more diff lines not shown$/);
  });

  it('thinking blocks and empty text are not shown; several text blocks get distinct ids', () => {
    const b = new ChatBuilder();
    b.ingest([{ type: 'assistant', uuid: 'a', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'one' }, { type: 'text', text: '  ' }, { type: 'text', text: 'two' }] } }]);
    expect(b.items().map((i) => [i.id, (i as { md?: string }).md])).toEqual([['a:1', 'one'], ['a:3', 'two']]);
  });

  it('ignores records it does not know, and the same uuid twice (a fork copying history)', () => {
    const b = new ChatBuilder();
    const u = { type: 'user', uuid: 'same', message: { content: 'hi' } };
    expect(b.ingest([{ type: 'file-history-snapshot' }, { type: 'attachment' }, 7, null, u, u])?.items).toHaveLength(1);
    expect(b.ingest([u])).toBeUndefined();
  });
});

describe('compaction, interrupts, markers, subagents', () => {
  it('compact boundary and interrupt records become markers; the delta start is the first new item', () => {
    const b = new ChatBuilder();
    b.ingest([{ type: 'user', uuid: 'u', message: { content: 'go' } }]);
    const d = b.ingest([
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: '2026-10-11T10:00:00Z' },
      { type: 'user', uuid: 'i1', timestamp: '2026-10-11T10:00:01Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'system', subtype: 'turn_duration', uuid: 'td' },
    ]);
    expect(d?.from).toBe(1);
    expect(b.items().slice(1).map((i) => [i.k, i.id])).toEqual([['compact', 'c1'], ['interrupted', 'i1']]);
  });

  it('lineage markers go at the end, once', () => {
    const b = new ChatBuilder();
    b.ingest([{ type: 'user', uuid: 'u', message: { content: 'go' } }]);
    expect(b.addMarker('clear', 5)?.from).toBe(1);
    expect(b.addMarker('clear', 5)).toBeUndefined();
    expect(b.items()[1]).toMatchObject({ k: 'marker', marker: 'clear', at: 5 });
  });

  it('a marker goes before the first item that is newer than it', () => {
    const b = new ChatBuilder();
    const rec = (id: string, s: number) => ({ type: 'user', uuid: id, timestamp: new Date(Date.UTC(2026, 9, 11, 10, 0, s)).toISOString(), message: { content: id } });
    b.ingest([rec('a', 1), rec('b', 2), rec('c', 10), rec('d', 11)]);
    const d = b.addMarker('resume', Date.UTC(2026, 9, 11, 10, 0, 5));
    expect(d?.from).toBe(2);
    expect(b.items().map((i) => i.id)).toEqual(['a', 'b', 'marker:resume:1791712805000', 'c', 'd']);
  });

  it('a live subagent file grows its thread; a late result in it updates the parent item', () => {
    const b = new ChatBuilder();
    b.ingest([
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'T', name: 'Agent', input: { description: 'dig', prompt: 'p' } }] } },
      { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'later text' }] } },
    ]);
    const d0 = b.declareSubagent({ agentId: 'ag1', toolUseId: 'T', brief: 'dig' });
    expect(d0?.from).toBe(1); // inserted between the Agent tool and the next item
    expect(b.items().map((i) => i.k)).toEqual(['tool', 'subagent', 'assistant']);
    const d1 = b.ingest([{ type: 'assistant', uuid: 's1', isSidechain: true, agentId: 'ag1', message: { content: [{ type: 'tool_use', id: 'R', name: 'Read', input: { file_path: 'x' } }] } }], { agentId: 'ag1' });
    expect(d1?.from).toBe(1);
    const d2 = b.ingest([{ type: 'user', uuid: 's2', isSidechain: true, agentId: 'ag1', message: { content: [{ type: 'tool_result', tool_use_id: 'R', content: 'data' }] } }], { agentId: 'ag1' });
    expect(d2?.from).toBe(1);
    const sub = b.items()[1] as Extract<ChatItem, { k: 'subagent' }>;
    expect(sub.items[0]).toMatchObject({ k: 'tool', agentId: 'ag1', result: 'data', ok: true });
  });

  it('sidechain records inside the main file are routed to their subagent', () => {
    const b = new ChatBuilder();
    b.ingest([{ type: 'assistant', uuid: 's1', isSidechain: true, agentId: 'zz', message: { content: [{ type: 'text', text: 'inside' }] } }]);
    expect(b.items()).toHaveLength(1);
    expect(b.items()[0]).toMatchObject({ k: 'subagent', agentId: 'zz' });
  });
});
