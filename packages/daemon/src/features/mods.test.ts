import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeTmpDir, removeDir, writeText } from '../testing/tmp-fs.ts';
import { createModsProbe, detectMods } from './mods.ts';

let dir: string;
beforeEach(() => { dir = makeTmpDir(); });
afterEach(() => removeDir(dir));
const settings = (enabledPlugins: object): void => writeText(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins }));
const installed = (...names: string[]): void => writeText(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: Object.fromEntries(names.map((n) => [n, []])) }));

describe('detectMods', () => {
  it('is absent in an empty config dir', () => {
    expect(detectMods(dir)).toEqual({ autoHandoff: false });
    expect(detectMods(join(dir, 'missing'))).toEqual({ autoHandoff: false });
  });
  it('is present when enabledPlugins switches it on', () => {
    settings({ 'auto-handoff@amel-mods': true, 'other@x': false });
    expect(detectMods(dir)).toEqual({ autoHandoff: true });
  });
  it('is absent when enabledPlugins switches it off, even though it is installed', () => {
    settings({ 'auto-handoff@amel-mods': false });
    installed('auto-handoff@amel-mods');
    expect(detectMods(dir)).toEqual({ autoHandoff: false });
  });
  it('is present when installed and not mentioned in settings', () => {
    settings({ 'other@x': true });
    installed('auto-handoff@amel-mods');
    expect(detectMods(dir)).toEqual({ autoHandoff: true });
  });
  it('does not match look-alike names, and survives broken files', () => {
    settings({ 'my-auto-handoff@x': true, 'auto-handoffs@x': true });
    expect(detectMods(dir)).toEqual({ autoHandoff: false });
    writeText(join(dir, 'settings.json'), '{not json');
    writeText(join(dir, 'plugins', 'installed_plugins.json'), '[]');
    expect(detectMods(dir)).toEqual({ autoHandoff: false });
  });
  it('the probe caches for its ttl', () => {
    let t = 0;
    const probe = createModsProbe(dir, 1000, () => t);
    expect(probe().autoHandoff).toBe(false);
    settings({ 'auto-handoff@a': true });
    expect(probe().autoHandoff).toBe(false);
    t = 1500;
    expect(probe().autoHandoff).toBe(true);
  });
});
