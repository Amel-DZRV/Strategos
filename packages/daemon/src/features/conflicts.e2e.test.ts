// End to end for conflict warnings (task 5.06): a real daemon, two fake-claude sessions in two worktree folders of one temp
// repo (plus a third in the first folder), hooks posted by hand with each session's token. Checks the flags the UI sees
// on both sessions and the PostToolUse response that carries the note to Claude (D9).
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Initiative, SessionRecord } from '@strategos/shared';
import { mkTmp } from '../../../../tools/tmp-fs.ts';
import { startRig, makeRepo, type Rig, type UiClient } from '../daemon.testkit.ts';
import { getPlatform } from '../platform/index.ts';
import { resolveRepo } from '../sessions/launch.ts';
import { http, type Reply } from '../server/testkit.ts';

const T = 90_000;
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, windowsHide: true, stdio: 'ignore' });
};

interface World { r: Rig; ui: UiClient; main: string; wt: string; planetKey: string }

async function world(withInitiative: boolean): Promise<World> {
  // the long form of the path: canonical() is textual, so an 8.3 spelling of the temp dir would give worktrees another planet
  const main = realpathSync.native(makeRepo('conflict-repo'));
  git(main, 'commit', '--allow-empty', '-m', 'init');
  const wt = path.join(path.dirname(main), 'conflict-repo-wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feature-b', wt);
  const planetKey = (await resolveRepo(main, getPlatform().paths.canonical)).planetKey;
  const home = path.join(mkTmp('strategos-conf-home-'), 'strategos-home');
  if (withInitiative) {
    mkdirSync(home, { recursive: true });
    const ini: Initiative = { id: 'I1', name: 'Checkout', colour: '#8ab', createdAt: 1, archived: false, contractFiles: [{ planetKey, relPath: 'api/spec.yaml' }] };
    writeFileSync(path.join(home, 'state.json'), JSON.stringify({ schema: 1, writtenAt: 1, daemonVersion: '0', sessions: [], initiatives: [ini], layout: { planetCells: {}, groupCells: {} }, dismissedSuggestions: [] }));
  }
  const r = await startRig({ home, repo: main, daemon: { notifyQuietMs: 0 } });
  r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
  rigs.push(r);
  return { r, ui: await r.ui(), main, wt, planetKey };
}

async function start(w: World, name: string, repoPath: string, extra: Record<string, unknown> = {}): Promise<SessionRecord> {
  const s = await w.ui.start(name, repoPath, 'hello', extra);
  await w.ui.waitStatus(s.strategosId, 'done');
  return w.ui.of(s.strategosId);
}

function post(w: World, s: SessionRecord, event: string, body: Record<string, unknown>): Promise<Reply> {
  return http(w.r.daemon.port, {
    method: 'POST', path: `/hook/${s.strategosId}/${event}`,
    headers: { 'x-strategos-token': w.r.daemon.manager.tokenFor(s.strategosId) ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: w.ui.of(s.strategosId).currentSessionId, ...body }),
  });
}
const editHook = (w: World, s: SessionRecord, file: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
  post(w, s, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_use_id: 'tu', tool_response: {}, ...extra });
const contextOf = (rep: Reply): string | undefined => {
  const t = rep.body.toString();
  return t === '' ? undefined : (JSON.parse(t) as { hookSpecificOutput: { hookEventName: string; additionalContext?: string } }).hookSpecificOutput.additionalContext;
};

describe('conflict warnings (5.06)', () => {
  it('two sessions in two worktrees of one repo: both flagged once, the editor is told, then quiet', async () => {
    const w = await world(false);
    const s1 = await start(w, 'alpha', w.main);
    const s2 = await start(w, 'beta', w.wt);
    expect(s1.planetKey).toBe(s2.planetKey);
    expect(s1.cwd).not.toBe(s2.cwd);

    const first = await editHook(w, s1, path.join(w.main, 'src', 'db.ts'));
    expect(first.status).toBe(200);
    expect(contextOf(first)).toBeUndefined();
    expect(w.ui.of(s1.strategosId).flags.conflicts).toEqual([]);

    const second = await editHook(w, s2, path.join(w.wt, 'src', 'db.ts'));
    expect(second.status).toBe(200);
    expect(second.headers['content-type']).toMatch(/json/);
    expect(contextOf(second)).toMatch(/^Note from Strategos: alpha also edited src\/db\.ts in the last \d+ min; check before overwriting\.$/);
    await w.ui.until(() => w.ui.of(s1.strategosId).flags.conflicts.length === 1 && w.ui.of(s2.strategosId).flags.conflicts.length === 1, 5000, 'flags on both');
    expect(w.ui.of(s1.strategosId).flags.conflicts[0]).toMatchObject({ file: 'src/db.ts', other: 'beta' });
    expect(w.ui.of(s2.strategosId).flags.conflicts[0]).toMatchObject({ file: 'src/db.ts', other: 'alpha' });

    // warn once per change: beta edits again, nothing new from alpha
    expect(contextOf(await editHook(w, s2, path.join(w.wt, 'src', 'db.ts')))).toBeUndefined();
    // other files and other tools are quiet
    expect(contextOf(await editHook(w, s2, path.join(w.wt, 'src', 'other.ts')))).toBeUndefined();
    expect(contextOf(await post(w, s2, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b1', tool_response: {} }))).toBeUndefined();
    // alpha changes it again: it is told about beta
    expect(contextOf(await editHook(w, s1, path.join(w.main, 'src', 'db.ts')))).toMatch(/beta also edited src\/db\.ts/);
    await w.ui.waitStatus(s1.strategosId, ['working', 'done', 'seen']); // the reducer saw the PostToolUse hooks as before
  }, T);

  it('same folder: flagged, no note from Strategos (the session-tracker mod covers it); a subagent edit does get the note', async () => {
    const w = await world(false);
    const s1 = await start(w, 'alpha', w.main);
    const s3 = await start(w, 'gamma', w.main);
    await editHook(w, s1, path.join(w.main, 'a.ts'));
    const same = await editHook(w, s3, path.join(w.main, 'a.ts'));
    expect(contextOf(same)).toBeUndefined();
    await w.ui.until(() => w.ui.of(s3.strategosId).flags.conflicts.length === 1, 5000, 'flag without a note');

    await editHook(w, s1, path.join(w.main, 'b.ts'));
    const viaSub = await editHook(w, s3, path.join(w.main, 'b.ts'), { agent_id: 'agent-fake1', agent_type: 'general-purpose' });
    expect(contextOf(viaSub)).toMatch(/alpha also edited b\.ts/);
  }, T);

  it('contract files: the initiative’s other sessions are marked, and told with their next tool result', async () => {
    const w = await world(true);
    const s1 = await start(w, 'api', w.main, { initiativeId: 'I1' });
    const s2 = await start(w, 'web', w.wt, { initiativeId: 'I1' });

    const edit = await editHook(w, s1, path.join(w.main, 'api', 'spec.yaml'));
    expect(contextOf(edit)).toBeUndefined();
    await w.ui.until(() => w.ui.of(s2.strategosId).flags.contractChanged.includes('api/spec.yaml'), 5000, 'contractChanged on the other session');
    expect(w.ui.of(s1.strategosId).flags.contractChanged).toEqual([]);

    const next = await post(w, s2, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'r1', tool_response: {} });
    expect(contextOf(next)).toBe('Note from Strategos: api changed the contract file api/spec.yaml (conflict-repo) of initiative "Checkout"; check that your work still matches it.');
    const again = await post(w, s2, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'r2', tool_response: {} });
    expect(contextOf(again)).toBeUndefined();
  }, T);
});
