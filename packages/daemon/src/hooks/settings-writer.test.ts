import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsError } from '../safe-fs.ts';
import { makeTestEnv, type TestEnv } from '../store/testing.ts';
import { writeText } from '../testing/tmp-fs.ts';
import {
  buildRunSettings, HOLD_TIMEOUT_SEC, removeRunSettings, runSettingsPath, sweepRunDir, writeRunSettings, type RunSettingsOptions,
} from './settings-writer.ts';

const opts = (over: Partial<RunSettingsOptions> = {}): RunSettingsOptions => ({
  strategosId: 'sid-1', port: 51234, nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  tapPath: 'C:\\Users\\me\\.strategos\\tap.mjs', relayPath: 'C:\\dev\\strategos\\tools\\hook-relay.mjs', ...over,
});

type Entry = { matcher?: string; hooks: { type: string; url?: string; command?: string; timeout?: number; headers?: Record<string, string>; allowedEnvVars?: string[] }[] };
const hooksOf = (s: Record<string, unknown>) => s['hooks'] as Record<string, Entry[]>;

describe('buildRunSettings', () => {
  it('has every event, http hooks to /hook/<id>/<Event> with the token header from the env var', () => {
    const hooks = hooksOf(buildRunSettings(opts()));
    expect(Object.keys(hooks).sort()).toEqual([
      'CwdChanged', 'Notification', 'PermissionRequest', 'PostCompact', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse',
      'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ]);
    for (const [event, entries] of Object.entries(hooks)) {
      if (event === 'SessionStart') continue;
      const hook = entries[0]!.hooks[0]!;
      expect(hook).toMatchObject({ type: 'http', url: `http://127.0.0.1:51234/hook/sid-1/${event}`, headers: { 'X-Strategos-Token': '$STRATEGOS_HOOK_TOKEN' }, allowedEnvVars: ['STRATEGOS_HOOK_TOKEN'] });
    }
  });

  it('SessionStart is a command hook through the relay (it never arrives over http)', () => {
    const e = hooksOf(buildRunSettings(opts()))['SessionStart']!;
    expect(e).toHaveLength(1);
    expect(e[0]!.hooks[0]).toMatchObject({ type: 'command', timeout: 5 });
    expect(e[0]!.hooks[0]!.command).toBe('"C:/Program Files/nodejs/node.exe" "C:/dev/strategos/tools/hook-relay.mjs" sid-1 SessionStart 51234');
  });

  it('has exactly ONE PreToolUse hook ("*", timeout 86400): the AskUserQuestion matcher would be de-duplicated anyway', () => {
    const pre = hooksOf(buildRunSettings(opts()))['PreToolUse']!;
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ matcher: '*' });
    expect(pre[0]!.hooks).toHaveLength(1);
    expect(pre[0]!.hooks[0]!.timeout).toBe(HOLD_TIMEOUT_SEC);
    expect(hooksOf(buildRunSettings(opts()))['PermissionRequest']![0]!.hooks[0]!.timeout).toBe(86400);
  });

  it('SessionEnd has a 3 s timeout; the other events keep the default', () => {
    const hooks = hooksOf(buildRunSettings(opts()));
    expect(hooks['SessionEnd']![0]!.hooks[0]!.timeout).toBe(3);
    expect(hooks['Stop']![0]!.hooks[0]!.timeout).toBeUndefined();
  });

  it('the statusLine command quotes the node path (it has a space), uses forward slashes and no secret', () => {
    const s = buildRunSettings(opts());
    expect(s['statusLine']).toEqual({ type: 'command', command: '"C:/Program Files/nodejs/node.exe" "C:/Users/me/.strategos/tap.mjs" sid-1 51234' });
  });

  it('always injects disableAgentView and the deny rules; extras are appended', () => {
    const s = buildRunSettings(opts({ extraDeny: ['Bash(rm *)'] }));
    expect(s['disableAgentView']).toBe(true);
    expect(s['permissions']).toEqual({ deny: ['Read(~/.strategos/**)', 'Edit(~/.strategos/**)', 'Bash(rm *)'] });
  });

  it('disableAgentView can be turned off (config) but is the default', () => {
    expect(buildRunSettings(opts({ disableAgentView: false }))['disableAgentView']).toBe(false);
  });

  it('trackerOff injects enabledPlugins for the session-tracker; otherwise the key is absent', () => {
    expect(buildRunSettings(opts({ trackerOff: true }))['enabledPlugins']).toEqual({ 'session-tracker@claude-mods': false });
    expect(buildRunSettings(opts())).not.toHaveProperty('enabledPlugins');
  });

  it('statusLine:false leaves the statusLine out', () => {
    expect(buildRunSettings(opts({ statusLine: false }))).not.toHaveProperty('statusLine');
  });

  it('never contains a token value, only the variable name', () => {
    const text = JSON.stringify(buildRunSettings(opts()));
    expect(text).not.toMatch(/tok-|secret/i);
    expect(text).toContain('$STRATEGOS_HOOK_TOKEN');
  });

  it('refuses ids and ports that could break out of the command line or URL', () => {
    expect(() => buildRunSettings(opts({ strategosId: 'a b' }))).toThrow();
    expect(() => buildRunSettings(opts({ strategosId: 'x"; rm' }))).toThrow();
    expect(() => buildRunSettings(opts({ strategosId: '../x' }))).toThrow();
    expect(() => buildRunSettings(opts({ port: 0 }))).toThrow();
    expect(() => buildRunSettings(opts({ nodePath: 'C:\\a"b\\node.exe' }))).toThrow();
  });

  it('macOS-style paths pass through unchanged', () => {
    const s = buildRunSettings(opts({ nodePath: '/usr/local/bin/node', tapPath: '/Users/me/.strategos/tap.mjs' }));
    expect((s['statusLine'] as { command: string }).command).toBe('"/usr/local/bin/node" "/Users/me/.strategos/tap.mjs" sid-1 51234');
  });
});

describe('writeRunSettings / sweepRunDir', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await makeTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('writes <home>/run/<id>.settings.json through safe-fs, valid JSON, no temp file left', async () => {
    const file = await writeRunSettings(env.fs, env.home, opts());
    expect(file).toBe(path.join(env.home, 'run', 'sid-1.settings.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(buildRunSettings(opts()))));
    expect(readdirSync(path.join(env.home, 'run'))).toEqual(['sid-1.settings.json']);
  });

  it('overwrites an existing file (resume regenerates it)', async () => {
    await writeRunSettings(env.fs, env.home, opts());
    await writeRunSettings(env.fs, env.home, opts({ port: 40000 }));
    expect(readFileSync(runSettingsPath(env.home, 'sid-1'), 'utf8')).toContain('127.0.0.1:40000');
  });

  it('refuses to write when the home is inside the Claude config dir', async () => {
    const bad = path.join(env.claudeDir, 'strategos');
    await expect(writeRunSettings(env.fs, bad, opts())).rejects.toBeInstanceOf(SafeFsError);
  });

  it('removeRunSettings deletes one file and tolerates a missing one', async () => {
    await writeRunSettings(env.fs, env.home, opts());
    await removeRunSettings(env.fs, env.home, 'sid-1');
    await removeRunSettings(env.fs, env.home, 'sid-1');
    expect(readdirSync(path.join(env.home, 'run'))).toEqual([]);
  });

  it('sweepRunDir deletes stale files and temp leftovers, keeps live ones and strangers', async () => {
    const run = path.join(env.home, 'run');
    for (const n of ['live-1.settings.json', 'dead-1.settings.json', 'dead-2.settings.json.123.4.tmp', 'live-1.settings.json.9.9.tmp', 'notes.txt']) writeText(path.join(run, n), '{}');
    const removed = await sweepRunDir(env.fs, env.home, ['live-1']);
    expect(removed.sort()).toEqual(['dead-1.settings.json', 'dead-2.settings.json.123.4.tmp', 'live-1.settings.json.9.9.tmp']);
    expect(readdirSync(run).sort()).toEqual(['live-1.settings.json', 'notes.txt']);
  });

  it('sweepRunDir on a missing run dir is a no-op', async () => {
    expect(await sweepRunDir(env.fs, env.home, [])).toEqual([]);
  });
});
