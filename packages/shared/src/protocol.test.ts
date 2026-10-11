import { describe, expect, test } from 'vitest';
import { isSeqEvent, parseUiCommand, PROTOCOL } from './protocol.ts';
import type { UiCommand, UiCommandKind } from './protocol.ts';

const init = { id: 'i1', name: 'n', colour: '#fff', createdAt: 1, contractFiles: [{ planetKey: 'p', relPath: 'a.ts' }], archived: false };
const rule = { id: 'r', description: 'd', tool: 'Bash', pattern: 'rm\\s+-rf', enabled: true };

// One valid sample per command kind. The Record type forces this list to stay complete.
const VALID: Record<UiCommandKind, Record<string, unknown>> = {
  'session.start': { repoPath: 'C:/r', worktree: { name: 'w', branch: 'b', base: 'main' }, firstPrompt: 'hi' },
  'session.stop': { strategosId: 's' }, 'session.park': { strategosId: 's' }, 'session.resume': { strategosId: 's' },
  'session.forget': { strategosId: 's' }, 'session.seen': { strategosId: 's' },
  'session.archive': { strategosId: 's', on: true },
  'session.resumeAll': {},
  'resync': {},
  'pty.subscribe': { strategosId: 's', cols: 80, rows: 24 },
  'pty.unsubscribe': { strategosId: 's' },
  'pty.input': { strategosId: 's', data: 'ls\r' },
  'pty.resize': { strategosId: 's', cols: 100, rows: 30 },
  'pty.focus': { strategosId: 's' },
  'perm.decide': { strategosId: 's', requestId: 'q', decision: 'always', suggestionIndex: 0 },
  'perm.release': { strategosId: 's', requestId: 'q' },
  'pending.full': { strategosId: 's', requestId: 'q' },
  'perm.approveLowRisk': { initiativeId: 'i', requestIds: ['q'] },
  'view.focus': { strategosId: null },
  'question.answer': { strategosId: 's', requestId: 'q', answers: { Q: 'A' } },
  'reply.send': { strategosId: 's', text: 'go' },
  'slash.send': { strategosId: 's', cmd: '/keepwarm 90m' },
  'chat.subscribe': { strategosId: 's', from: 0 },
  'review.get': { strategosId: 's' },
  'review.sendBack': { strategosId: 's', text: 'fix' },
  'pr.create': { strategosId: 's', title: 't', body: 'b', draft: true },
  'worktree.remove': { strategosId: 's', deleteBranch: false },
  'initiative.upsert': { initiative: init },
  'initiative.assign': { strategosId: 's', initiativeId: null },
  'mission.start': { initiativeId: 'i', sessions: [{ repoPath: 'r', branch: 'b', firstPrompt: 'p' }] },
  'suggestion.respond': { id: 'x', accept: false },
  'layout.setPlanetCell': { planetKey: 'p', col: 1, row: 0 },
  'prefs.set': { prefs: { groupBy: 'initiative' } },
  'guards.set': { rules: [rule] },
  'digest.get': {},
  'activity': { idleMs: 1200 },
};

describe('parseUiCommand', () => {
  test('protocol is 1', () => expect(PROTOCOL).toBe(1));

  for (const [c, rest] of Object.entries(VALID)) {
    test(`accepts ${c}`, () => {
      const msg = { id: 'm1', c, ...rest };
      const r = parseUiCommand(msg);
      expect('error' in r).toBe(false);
      expect((r as UiCommand).c).toBe(c);
    });
  }

  test('rejects non-objects, missing id, unknown c', () => {
    expect(parseUiCommand(null)).toHaveProperty('error');
    expect(parseUiCommand([])).toHaveProperty('error');
    expect(parseUiCommand('x')).toHaveProperty('error');
    expect(parseUiCommand({ c: 'session.stop', strategosId: 's' })).toHaveProperty('error');
    expect(parseUiCommand({ id: '', c: 'session.stop', strategosId: 's' })).toHaveProperty('error');
    expect(parseUiCommand({ id: '1', c: 'nope' })).toEqual({ error: 'unknown command', id: '1' });
    expect(parseUiCommand({ id: '1', c: '__proto__' })).toHaveProperty('error');
    expect(parseUiCommand({ id: '1', c: 'toString' })).toHaveProperty('error');
  });

  test('rejects malformed fields', () => {
    const bad: Record<string, unknown>[] = [
      { c: 'session.start' },
      { c: 'session.start', repoPath: 'r', worktree: { name: 'w' } },
      { c: 'session.stop' },
      { c: 'session.archive', strategosId: 's', on: 'yes' },
      { c: 'pty.subscribe', strategosId: 's', cols: 0, rows: 24 },
      { c: 'pty.resize', strategosId: 's', cols: 80.5, rows: 24 },
      { c: 'pty.input', strategosId: 's', data: 5 },
      { c: 'perm.decide', strategosId: 's', requestId: 'q', decision: 'maybe' },
      { c: 'perm.decide', strategosId: 's', decision: 'allow' },
      { c: 'perm.decide', strategosId: 's', requestId: 'q', decision: 'allow', suggestionIndex: -1 },
      { c: 'question.answer', strategosId: 's', requestId: 'q', answers: { a: 1 } },
      { c: 'slash.send', strategosId: 's', cmd: '/rm -rf' },
      { c: 'slash.send', strategosId: 's', cmd: '/keepwarm 5h' },
      { c: 'chat.subscribe', strategosId: 's', from: -1 },
      { c: 'initiative.upsert', initiative: { id: 'i' } },
      { c: 'initiative.assign', strategosId: 's', initiativeId: 5 },
      { c: 'mission.start', initiativeId: 'i', sessions: [] },
      { c: 'layout.setPlanetCell', planetKey: 'p', col: 1.5, row: 0 },
      { c: 'prefs.set', prefs: [] },
      { c: 'guards.set', rules: [{ ...rule, pattern: '(' }] },
      { c: 'guards.set', rules: 'x' },
      { c: 'digest.get', since: 'x' },
      { c: 'activity', idleMs: -1 },
    ];
    for (const b of bad) {
      const r = parseUiCommand({ id: 'z', ...b });
      expect(r, JSON.stringify(b)).toHaveProperty('error');
      expect((r as { id?: string }).id).toBe('z');
    }
  });
});

describe('isSeqEvent', () => {
  test('recognises events with a numeric seq', () => {
    expect(isSeqEvent({ t: 'usage', seq: 4, usage: { at: 1 } })).toBe(true);
    expect(isSeqEvent({ t: 'pty.data', strategosId: 's', data: '' })).toBe(false);
    expect(isSeqEvent({ t: 'usage', seq: '4' })).toBe(false);
    expect(isSeqEvent(null)).toBe(false);
  });
});
