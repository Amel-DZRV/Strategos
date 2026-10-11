import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync, utimesSync } from 'node:fs';
import { createFakeClaudeHome, interruptRecord, listing, type FakeHome } from './fake-claude-home.ts';
import { compareSnapshots, snapshotClaudeDir } from './snapshot-claude-dir.ts';
import { appendText, mkTmp, rmTree, writeText } from './tmp-fs.ts';

describe('fake-claude-home', () => {
  let home: FakeHome | undefined;
  afterEach(() => { home?.cleanup(); home = undefined; });

  it('builds projects/<enc>/<id>.jsonl, sessions/<pid>.json and subagent folders', () => {
    home = createFakeClaudeHome();
    const cwd = 'C:\\dev\\My Repo';
    const s = home.addSession({ cwd, pid: 4242, status: 'busy', name: 'n' });
    expect(s.transcriptPath).toBe(join(home.root, 'projects', 'C--dev-My-Repo', `${s.sessionId}.jsonl`));
    const recs = readFileSync(s.transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(recs[1].parentUuid).toBe(recs[0].uuid);
    expect(JSON.parse(readFileSync(join(home.sessionsDir, '4242.json'), 'utf8'))).toMatchObject({ pid: 4242, sessionId: s.sessionId, cwd, status: 'busy', name: 'n', kind: 'interactive' });
    const sub = home.addSubagent({ cwd, sessionId: s.sessionId, agentId: 'agent-1' });
    expect(sub).toBe(join(home.projectDir(cwd), s.sessionId, 'subagents', 'agent-1.jsonl'));
    expect(listing(home.root).filter((l) => l.includes('subagents')).length).toBe(3); // dir + jsonl + meta
  });

  it('accepts raw strings for partial and corrupt lines, and can append', () => {
    home = createFakeClaudeHome();
    const s = home.addSession({ cwd: '/x/y', records: ['{"type":"user"}\n', '{"type":"assis'] });
    expect(readFileSync(s.transcriptPath, 'utf8')).toBe('{"type":"user"}\n{"type":"assis');
    home.appendToTranscript('/x/y', s.sessionId, ['tant"}\n', interruptRecord({ sessionId: s.sessionId, cwd: '/x/y' })]);
    expect(readFileSync(s.transcriptPath, 'utf8')).toContain('[Request interrupted by user]');
  });

  it('listing() detects create, remove, resize and touch; equal when untouched', () => {
    home = createFakeClaudeHome();
    const s = home.addSession({ cwd: '/a/b', pid: 1 });
    const before = listing(home.root);
    expect(listing(home.root)).toEqual(before);
    appendText(s.transcriptPath, 'x');
    expect(listing(home.root)).not.toEqual(before);
    const base = listing(home.root);
    utimesSync(s.transcriptPath, new Date(1_000_000), new Date(1_000_000));
    expect(listing(home.root)).not.toEqual(base);
    const other = listing(home.root);
    writeText(join(home.root, 'new.txt'), '');
    expect(listing(home.root)).not.toEqual(other);
  });
});

describe('snapshot-claude-dir', () => {
  it('hashes settings files, lists the top level, and reports changes (read only)', () => {
    const dir = mkTmp('snap-');
    try {
      writeText(join(dir, 'settings.json'), '{"a":1}');
      writeText(join(dir, 'projects', 'p.txt'), 'x');
      const a = snapshotClaudeDir(dir);
      expect(a.settingsJson).toMatch(/^[0-9a-f]{64}$/);
      expect(a.settingsLocalJson).toBeNull();
      expect(a.topLevel).toEqual(['projects/', 'settings.json']);
      writeText(join(dir, 'sessions', '1.json'), '{}');
      const b = snapshotClaudeDir(dir);
      expect(compareSnapshots(a, b)).toEqual({ added: ['sessions/'], removed: [] });
      writeText(join(dir, 'settings.local.json'), '{}');
      expect(() => compareSnapshots(b, snapshotClaudeDir(dir))).toThrow(/settings.local.json/);
      writeText(join(dir, 'settings.json'), '{"a":2}');
      expect(() => compareSnapshots(a, snapshotClaudeDir(dir))).toThrow(/settings.json changed/);
    } finally { rmTree(dir); }
  });

  it('a missing directory is an empty snapshot', () => {
    expect(snapshotClaudeDir(join(mkTmp('snap-'), 'nope'))).toMatchObject({ settingsJson: null, topLevel: [] });
  });
});
