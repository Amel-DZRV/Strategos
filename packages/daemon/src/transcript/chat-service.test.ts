import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatItem } from '@strategos/shared';
import { appendBytes, makeTmpDir, removeDir, truncateTo, writeText } from '../testing/tmp-fs.ts';
import { createChatService, type ChatItemsEvent, type ChatService } from './chat-service.ts';
import { FileTailer } from './tailer.ts';

let dir: string;
let svc: ChatService | undefined;
let tailer: FileTailer;
beforeEach(() => {
  dir = makeTmpDir();
  tailer = new FileTailer({ pollMs: 20 });
});
afterEach(() => {
  svc?.dispose();
  svc = undefined;
  removeDir(dir);
});

const T0 = Date.UTC(2026, 9, 11, 10, 0, 0);
const iso = (s: number): string => new Date(T0 + s * 1000).toISOString();
const line = (o: object): string => `${JSON.stringify(o)}\n`;
const user = (id: string, text: string, s: number): string => line({ type: 'user', uuid: id, timestamp: iso(s), message: { content: text } });
const asst = (id: string, text: string, s: number): string => line({ type: 'assistant', uuid: id, timestamp: iso(s), message: { content: [{ type: 'text', text }] } });

interface Rec { claudeSessionIds: string[]; currentSessionId: string; transcriptPath?: string }
function make(rec: Rec, o: { markers?: { marker: string; at: number }[]; maxInitial?: number } = {}): { svc: ChatService; rec: Rec; change: () => void } {
  const listeners = new Set<(sid: string) => void>();
  const r = rec;
  svc = createChatService({
    tailer, maxInitial: o.maxInitial ?? 2000, subagentPollMs: 30, idleMs: 50,
    session: (sid) => (sid === 's1' ? r : undefined),
    markers: () => o.markers ?? [],
    onSessionChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  });
  return { svc, rec: r, change: () => { for (const l of listeners) l('s1'); } };
}
const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const texts = (items: readonly ChatItem[]): string[] => items.map((i) => (i.k === 'user' ? `U:${i.text}` : i.k === 'assistant' ? `A:${i.md}` : i.k === 'marker' ? `M:${i.marker}` : i.k));

describe('chat service', () => {
  it('sends the whole history first (reset), then live appends with their index', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'hello', 1) + asst('a1', 'hi', 2));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ t: 'chat.items', strategosId: 's1', from: 0, reset: true });
    expect(evs[0]!.truncatedBefore).toBeUndefined();
    expect(texts(evs[0]!.items)).toEqual(['U:hello', 'A:hi']);

    appendBytes(f, user('u2', 'more', 3));
    await until(() => evs.length === 2, 'live append');
    expect(evs[1]).toMatchObject({ from: 2, reset: false });
    expect(texts(evs[1]!.items)).toEqual(['U:more']);
  });

  it('a tool result updates the earlier tool item: the delta starts at that item', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'go', 1) + line({ type: 'assistant', uuid: 'a1', timestamp: iso(2), message: { content: [{ type: 'tool_use', id: 'T', name: 'Bash', input: { command: 'ls' } }] } }));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    appendBytes(f, line({ type: 'user', uuid: 'r1', timestamp: iso(3), message: { content: [{ type: 'tool_result', tool_use_id: 'T', content: 'a.txt' }] } }));
    await until(() => evs.length === 2, 'update');
    expect(evs[1]!.from).toBe(1);
    expect(evs[1]!.items[0]).toMatchObject({ k: 'tool', id: 'T', result: 'a.txt', ok: true });
  });

  it('caps the first payload and says how much was left out; from>0 resumes without a reset', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, Array.from({ length: 10 }, (_, i) => user(`u${i}`, `m${i}`, i)).join(''));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f }, { maxInitial: 4 });
    const a: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => a.push(e));
    expect(a[0]).toMatchObject({ from: 6, reset: true, truncatedBefore: 6 });
    expect(a[0]!.items).toHaveLength(4);

    const b: ChatItemsEvent[] = [];
    await s.subscribe('s1', 8, (e) => b.push(e));
    expect(b[0]).toMatchObject({ from: 8, reset: false });
    expect(texts(b[0]!.items)).toEqual(['U:m8', 'U:m9']);

    // a delta older than what the first subscriber holds is trimmed to its window
    appendBytes(f, user('u10', 'm10', 11));
    await until(() => a.length === 2, 'append');
    expect(a[1]).toMatchObject({ from: 10 });
  });

  it('a client claiming more than exists gets a full reset', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'x', 1));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 99, (e) => evs.push(e));
    expect(evs[0]).toMatchObject({ from: 0, reset: true });
  });

  it('joins the lineage in order with the manager markers between the transcripts', async () => {
    const f1 = path.join(dir, 'c1.jsonl');
    const f2 = path.join(dir, 'c2.jsonl');
    const f3 = path.join(dir, 'c3.jsonl');
    writeText(f1, user('u1', 'one', 10) + asst('a1', 'first', 11));
    writeText(f2, user('u2', 'two', 100) + asst('a2', 'second', 101));
    writeText(f3, user('u3', 'three', 200));
    const { svc: s } = make(
      { claudeSessionIds: ['c1', 'c2', 'c3'], currentSessionId: 'c3', transcriptPath: f3 },
      { markers: [{ marker: 'clear', at: T0 + 99_000 }, { marker: 'compact', at: T0 + 150_000 }, { marker: 'interrupted', at: T0 + 160_000 }] },
    );
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    // c2's marker is the clear; c3 has no marker nearby: an unknown switch. compact/interrupted are not lineage markers.
    expect(texts(evs[0]!.items)).toEqual(['U:one', 'A:first', 'M:clear', 'U:two', 'A:second', 'M:unknown', 'U:three']);
  });

  it('a /clear while watching adds the marker and follows the new transcript', async () => {
    const f1 = path.join(dir, 'c1.jsonl');
    const f2 = path.join(dir, 'c2.jsonl');
    writeText(f1, user('u1', 'one', 10));
    const markers: { marker: string; at: number }[] = [];
    const { svc: s, rec, change } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f1 }, { markers });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    // the file does not exist yet when the lineage changes
    markers.push({ marker: 'clear', at: T0 + 50_000 });
    rec.claudeSessionIds = ['c1', 'c2'];
    rec.currentSessionId = 'c2';
    rec.transcriptPath = f2;
    change();
    await until(() => evs.some((e) => e.items.some((i) => i.k === 'marker')), 'marker');
    writeText(f2, user('u2', 'two', 60));
    await until(() => evs.some((e) => e.items.some((i) => i.k === 'user' && i.text === 'two')), 'new transcript');
    const client = replay(evs);
    expect(texts(client)).toEqual(['U:one', 'M:clear', 'U:two']);
  });

  it('a transcript that is rewritten shorter resets everybody', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'one', 1) + user('u2', 'two', 2));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    truncateTo(f, 0);
    writeText(f, user('u9', 'fresh', 5));
    await until(() => evs.filter((e) => e.reset).length === 2, 'reset');
    expect(texts(evs.at(-1)!.items)).toEqual(['U:fresh']);
  });

  it('builds subagent threads from subagents/agent-*.jsonl next to the transcript, including ones that appear later', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'go', 1) + line({ type: 'assistant', uuid: 'a1', timestamp: iso(2), message: { content: [{ type: 'tool_use', id: 'TU', name: 'Agent', input: { description: 'dig' } }] } }) + asst('a2', 'waiting', 3));
    const sub = path.join(dir, 'c1', 'subagents');
    writeText(path.join(sub, 'agent-aa.meta.json'), JSON.stringify({ description: 'dig around', toolUseId: 'TU' }));
    writeText(path.join(sub, 'agent-aa.jsonl'), line({ type: 'user', uuid: 's1', isSidechain: true, agentId: 'aa', timestamp: iso(4), message: { content: 'look' } }) + asst('s2', 'found it', 5));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    expect(evs[0]!.items.map((i) => i.k)).toEqual(['user', 'tool', 'subagent', 'assistant']);
    const first = evs[0]!.items[2] as Extract<ChatItem, { k: 'subagent' }>;
    expect(first).toMatchObject({ agentId: 'aa', brief: 'dig around' });
    expect(texts(first.items)).toEqual(['A:found it']);

    appendBytes(path.join(sub, 'agent-aa.jsonl'), asst('s3', 'and more', 6));
    await until(() => evs.length === 2, 'subagent growth');
    expect(evs[1]!.from).toBe(2);
    expect((evs[1]!.items[0] as Extract<ChatItem, { k: 'subagent' }>).items).toHaveLength(2);

    writeText(path.join(sub, 'agent-bb.jsonl'), asst('t1', 'second helper', 7));
    await until(() => replay(evs).some((i) => i.k === 'subagent' && i.agentId === 'bb'), 'second subagent');
  });

  it('unknown session rejects; unsubscribe stops delivery; an idle session is dropped from memory', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, user('u1', 'x', 1));
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    await expect(s.subscribe('nope', 0, () => undefined)).rejects.toThrow(/no such session/);
    const evs: ChatItemsEvent[] = [];
    const off = await s.subscribe('s1', 0, (e) => evs.push(e));
    expect(s.peek('s1')).toHaveLength(1);
    off();
    appendBytes(f, user('u2', 'y', 2));
    await new Promise((r) => setTimeout(r, 120));
    expect(evs).toHaveLength(1);
    expect(s.peek('s1')).toBeUndefined(); // idleMs is 50 here
  });

  it('survives garbage lines and a session whose transcript is not known yet', async () => {
    const f = path.join(dir, 'c1.jsonl');
    writeText(f, `not json\n${user('u1', 'ok', 1)}{"partial"`);
    const { svc: s } = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1', transcriptPath: f });
    const evs: ChatItemsEvent[] = [];
    await s.subscribe('s1', 0, (e) => evs.push(e));
    expect(texts(evs[0]!.items)).toEqual(['U:ok']);
    const b = make({ claudeSessionIds: ['c1'], currentSessionId: 'c1' });
    const evs2: ChatItemsEvent[] = [];
    await b.svc.subscribe('s1', 0, (e) => evs2.push(e));
    expect(evs2[0]).toMatchObject({ items: [], reset: true });
  });
});

/** What a client holds after applying the events in order. */
function replay(evs: ChatItemsEvent[]): ChatItem[] {
  let list: ChatItem[] = [];
  for (const e of evs) list = e.reset ? [...e.items] : [...list.slice(0, e.from), ...e.items];
  return list;
}
