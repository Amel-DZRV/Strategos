import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Initiative } from '@strategos/shared';
import { makeTmpDir, removeDir } from '../testing/tmp-fs.ts';
import {
  addConflict, createConflictTracker, editedPath, pruneConflicts, relInTree,
  type ConflictTracker, type TrackedSession,
} from './conflicts.ts';

const MIN = 60_000;
let root: string;
beforeEach(() => { root = makeTmpDir('strategos-conf-'); });
afterEach(() => removeDir(root));

let clock = 0;
const sess = (id: string, name: string, tree: string, extra: Partial<TrackedSession> = {}): TrackedSession => ({
  strategosId: id, name, planetKey: 'planet-A', cwd: tree, worktree: { path: tree }, ...extra,
});

interface Rig { t: ConflictTracker; sessions: Map<string, TrackedSession>; initiatives: Initiative[]; trackerOff: { v: boolean } }
function rig(list: TrackedSession[], initiatives: Initiative[] = [], windowMs = 30 * MIN): Rig {
  clock = 1_000_000;
  const sessions = new Map(list.map((s) => [s.strategosId, s]));
  const off = { v: false };
  const t = createConflictTracker({
    session: (id) => sessions.get(id), sessions: () => [...sessions.values()], initiatives: () => initiatives,
    now: () => clock, windowMs, trackerOff: () => off.v, planetLabel: () => 'api',
  });
  return { t, sessions, initiatives, trackerOff: off };
}
const edit = (r: Rig, sid: string, file: string, o: { tool?: string; agentId?: string } = {}) =>
  r.t.onEdit({ sid, tool: o.tool ?? 'Edit', toolInput: { file_path: file }, ...(o.agentId === undefined ? {} : { agentId: o.agentId }) });

const A = path.resolve(path.sep, 'work', 'api');
const B = path.resolve(path.sep, 'work', 'api-wt');
const fileIn = (tree: string, rel: string): string => path.join(tree, ...rel.split('/'));

describe('what counts as an edit', () => {
  it('Edit, Write, MultiEdit and NotebookEdit name their file', () => {
    expect(editedPath('Edit', { file_path: 'a.ts' })).toBe('a.ts');
    expect(editedPath('Write', { file_path: 'b.ts' })).toBe('b.ts');
    expect(editedPath('MultiEdit', { file_path: 'c.ts', edits: [] })).toBe('c.ts');
    expect(editedPath('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(editedPath('Bash', { command: 'sed -i s/a/b/ x' })).toBeUndefined();
    expect(editedPath('Read', { file_path: 'a.ts' })).toBeUndefined();
    expect(editedPath('Edit', undefined)).toBeUndefined();
    expect(editedPath('Edit', { file_path: 3 })).toBeUndefined();
  });

  it('relative paths are repo-relative to the session working tree; outside files are ignored', () => {
    const s = sess('1', 'one', A);
    expect(relInTree(s, fileIn(A, 'src/a.ts'))).toBe('src/a.ts');
    expect(relInTree(s, 'src/a.ts')).toBe('src/a.ts');
    expect(relInTree(s, path.join(A, '..', 'other', 'a.ts'))).toBeUndefined();
    expect(relInTree(s, A)).toBeUndefined();
  });

  it('finds the working tree by its .git entry when the session has no worktree record', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'pkg', 'inner'), { recursive: true });
    const linked = path.join(root, 'linked');
    mkdirSync(linked, { recursive: true });
    writeFileSync(path.join(linked, '.git'), 'gitdir: elsewhere');
    expect(relInTree({ strategosId: '1', name: 'n', planetKey: 'p', cwd: path.join(repo, 'pkg', 'inner') }, path.join(repo, 'pkg', 'x.ts'))).toBe('pkg/x.ts');
    expect(relInTree({ strategosId: '2', name: 'n', planetKey: 'p', cwd: linked }, path.join(linked, 'y.ts'))).toBe('y.ts');
  });
});

describe('same-file clashes', () => {
  it('two sessions in two worktrees: both are warned, once, and the editor gets the note', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B)]);
    expect(edit(r, '1', fileIn(A, 'src/db.ts'))).toEqual({ warnings: [], contract: [] });
    clock += 4 * MIN;
    const out = edit(r, '2', fileIn(B, 'src/db.ts'));
    expect(out.warnings).toEqual([
      { sid: '2', conflict: { file: 'src/db.ts', other: 'alpha', at: clock } },
      { sid: '1', conflict: { file: 'src/db.ts', other: 'beta', at: clock } },
    ]);
    expect(out.note).toBe('Note from Strategos: alpha also edited src/db.ts in the last 4 min; check before overwriting.');
  });

  it('warns once per change: more edits by the same side are quiet, a new edit by the other side warns again', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B)]);
    edit(r, '1', fileIn(A, 'f.ts'));
    clock += MIN;
    expect(edit(r, '2', fileIn(B, 'f.ts')).warnings).toHaveLength(2);
    clock += MIN;
    expect(edit(r, '2', fileIn(B, 'f.ts')).warnings).toHaveLength(0); // beta again: alpha has done nothing new
    clock += MIN;
    expect(edit(r, '1', fileIn(A, 'f.ts')).warnings).toHaveLength(2); // alpha changed it again
    clock += MIN;
    expect(edit(r, '1', fileIn(A, 'f.ts')).warnings).toHaveLength(0);
  });

  it('the same folder and main-agent edits: the mod covers it, so a flag but no note', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', A)]);
    edit(r, '1', fileIn(A, 'f.ts'));
    clock += MIN;
    const out = edit(r, '2', fileIn(A, 'f.ts'));
    expect(out.warnings).toHaveLength(2);
    expect(out.note).toBeUndefined();
  });

  it('a subagent edit (either side) gets the note even in the same folder', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', A)]);
    edit(r, '1', fileIn(A, 'f.ts'), { agentId: 'sub1' });
    clock += 2 * MIN;
    expect(edit(r, '2', fileIn(A, 'f.ts')).note).toMatch(/alpha also edited f\.ts in the last 2 min/);
    const r2 = rig([sess('1', 'alpha', A), sess('2', 'beta', A)]);
    edit(r2, '1', fileIn(A, 'f.ts'));
    clock += MIN;
    expect(edit(r2, '2', fileIn(A, 'f.ts'), { agentId: 'sub9' }).note).toMatch(/alpha also edited/);
  });

  it('with the tracker mod switched off for Strategos sessions every clash gets the note', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', A)]);
    r.trackerOff.v = true;
    edit(r, '1', fileIn(A, 'f.ts'));
    clock += MIN;
    expect(edit(r, '2', fileIn(A, 'f.ts')).note).toBeDefined();
  });

  it('names several others in one note', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B), sess('3', 'gamma', path.resolve(path.sep, 'work', 'api-wt2'))]);
    edit(r, '1', fileIn(A, 'f.ts'));
    edit(r, '2', fileIn(B, 'f.ts'));
    clock += 3 * MIN;
    const out = edit(r, '3', fileIn(path.resolve(path.sep, 'work', 'api-wt2'), 'f.ts'));
    expect(out.note).toMatch(/alpha and beta also edited f\.ts/);
    expect(out.warnings).toHaveLength(4);
  });

  it('an edit older than the window is forgotten', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B)]);
    edit(r, '1', fileIn(A, 'f.ts'));
    clock += 31 * MIN;
    expect(edit(r, '2', fileIn(B, 'f.ts')).warnings).toEqual([]);
    clock += MIN;
    expect(edit(r, '1', fileIn(A, 'f.ts')).warnings).toHaveLength(2); // beta's edit is fresh; the 31-min-old warning state is gone
  });

  it('different files, different planets, the same session, and non-edit tools never clash', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B), sess('3', 'delta', B, { planetKey: 'planet-B' })]);
    edit(r, '1', fileIn(A, 'f.ts'));
    expect(edit(r, '2', fileIn(B, 'g.ts')).warnings).toEqual([]);
    expect(edit(r, '3', fileIn(B, 'f.ts')).warnings).toEqual([]); // same relative path in another repo
    expect(edit(r, '1', fileIn(A, 'f.ts')).warnings).toEqual([]); // alone
    expect(r.t.onEdit({ sid: '2', tool: 'Bash', toolInput: { command: 'echo > f.ts' } }).warnings).toEqual([]);
    expect(r.t.onEdit({ sid: 'ghost', tool: 'Edit', toolInput: { file_path: 'f.ts' } })).toEqual({ warnings: [], contract: [] });
  });

  it('forget removes a session from the history', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B)]);
    edit(r, '1', fileIn(A, 'f.ts'));
    r.t.forget('1');
    expect(edit(r, '2', fileIn(B, 'f.ts')).warnings).toEqual([]);
  });

  it('sweep drops old state', () => {
    const r = rig([sess('1', 'alpha', A), sess('2', 'beta', B)]);
    edit(r, '1', fileIn(A, 'f.ts'));
    clock += 40 * MIN;
    r.t.sweep();
    expect(edit(r, '2', fileIn(B, 'f.ts')).warnings).toEqual([]);
  });
});

describe('contract files', () => {
  const API = 'planet-A';
  const ini = (files: Initiative['contractFiles'], extra: Partial<Initiative> = {}): Initiative => ({ id: 'I1', name: 'Checkout', colour: '#fff', createdAt: 0, contractFiles: files, archived: false, ...extra });

  it('marks the initiative’s other sessions and queues one note each, delivered once', () => {
    const web = path.resolve(path.sep, 'work', 'web');
    const r = rig(
      [sess('1', 'api-work', A, { initiativeId: 'I1' }), sess('2', 'web-work', web, { initiativeId: 'I1', planetKey: 'planet-W' }), sess('3', 'stranger', B), sess('4', 'old', B, { initiativeId: 'I1', archived: true })],
      [ini([{ planetKey: API, relPath: 'openapi/spec.yaml' }])],
    );
    const out = edit(r, '1', fileIn(A, 'openapi/spec.yaml'));
    expect(out.contract).toEqual([{ sid: '2', relPath: 'openapi/spec.yaml' }]);
    expect(out.note).toBeUndefined(); // the editor needs no note about its own change
    expect(r.t.takeNotes('2')).toEqual(['Note from Strategos: api-work changed the contract file openapi/spec.yaml (api) of initiative "Checkout"; check that your work still matches it.']);
    expect(r.t.takeNotes('2')).toEqual([]);
    expect(r.t.takeNotes('3')).toEqual([]);
  });

  it('ignores edits by sessions outside the initiative, other files, and archived initiatives', () => {
    const web = path.resolve(path.sep, 'work', 'web');
    const files = [{ planetKey: API, relPath: 'spec.yaml' }];
    const r = rig([sess('1', 'a', A), sess('2', 'b', web, { initiativeId: 'I1' })], [ini(files)]);
    expect(edit(r, '1', fileIn(A, 'spec.yaml')).contract).toEqual([]); // 1 is not in I1
    const r2 = rig([sess('1', 'a', A, { initiativeId: 'I1' }), sess('2', 'b', web, { initiativeId: 'I1' })], [ini(files)]);
    expect(edit(r2, '1', fileIn(A, 'other.yaml')).contract).toEqual([]);
    const r3 = rig([sess('1', 'a', A, { initiativeId: 'I1' }), sess('2', 'b', web, { initiativeId: 'I1' })], [ini(files, { archived: true })]);
    expect(edit(r3, '1', fileIn(A, 'spec.yaml')).contract).toEqual([]);
  });

  it('a contract file edited by two worktrees still clashes the normal way too', () => {
    const r = rig([sess('1', 'a', A, { initiativeId: 'I1' }), sess('2', 'b', B, { initiativeId: 'I1' })], [ini([{ planetKey: API, relPath: 'spec.yaml' }])]);
    edit(r, '1', fileIn(A, 'spec.yaml'));
    clock += MIN;
    const out = edit(r, '2', fileIn(B, 'spec.yaml'));
    expect(out.warnings).toHaveLength(2);
    expect(out.contract).toEqual([{ sid: '1', relPath: 'spec.yaml' }]);
  });
});

describe('flag helpers', () => {
  it('addConflict keeps one entry per (file, other), newest last, at most 20', () => {
    let l = addConflict([], { file: 'a', other: 'x', at: 1 });
    l = addConflict(l, { file: 'b', other: 'x', at: 2 });
    l = addConflict(l, { file: 'a', other: 'x', at: 3 });
    expect(l).toEqual([{ file: 'b', other: 'x', at: 2 }, { file: 'a', other: 'x', at: 3 }]);
    for (let i = 0; i < 30; i++) l = addConflict(l, { file: `f${i}`, other: 'y', at: 10 + i });
    expect(l).toHaveLength(20);
    expect(l.at(-1)?.file).toBe('f29');
  });
  it('pruneConflicts drops the old ones and returns the same array when nothing expired', () => {
    const l = [{ file: 'a', other: 'x', at: 0 }, { file: 'b', other: 'x', at: 25 * MIN }];
    expect(pruneConflicts(l, 29 * MIN)).toBe(l);
    expect(pruneConflicts(l, 31 * MIN)).toEqual([l[1]]);
  });
});
