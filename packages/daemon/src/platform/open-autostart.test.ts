import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkTmp, rmTree, writeText } from '../../../../tools/tmp-fs.ts';
import { assertHttpUrl, chromeAppArgs } from './common/open.ts';
import { findChrome, openAppWindow as winOpenApp, parseRegDefault } from './win32/open.ts';
import { findChrome as macFindChrome, openAppWindow as macOpenApp } from './darwin/open.ts';
import { buildStartupCmd, createAutostart as winAutostart, startupDir, STARTUP_FILE } from './win32/autostart.ts';
import { buildPlist, createAutostart as macAutostart, launchAgentPath } from './darwin/autostart.ts';
import type { PlatformWriter } from './types.ts';

describe('open helpers (pure)', () => {
  it('chromeAppArgs gives one --app= argument and keeps the pairing fragment', () => {
    expect(chromeAppArgs('http://127.0.0.1:47800/#pair=abc')).toEqual(['--app=http://127.0.0.1:47800/#pair=abc']);
  });
  it('refuses non-http URLs', () => {
    expect(() => assertHttpUrl('file:///C:/x')).toThrow();
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow();
    expect(() => assertHttpUrl('nonsense')).toThrow();
  });
  it('parseRegDefault reads reg.exe output', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n\r\n';
    expect(parseRegDefault(out)).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(parseRegDefault('ERROR: nope')).toBeNull();
  });
});

describe('win32 Chrome lookup', () => {
  it('falls back to the standard folders when the registry has nothing usable, never PATH', async () => {
    const want = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const p = await findChrome({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: 'C:\\evil' }, (x) => x === want || x === 'C:\\evil\\chrome.exe');
    expect(p).toBe(want);
  });
  it('openAppWindow spawns <chrome> --app=<url>', async () => {
    const calls: [string, string[]][] = [];
    await winOpenApp('http://127.0.0.1:1/#pair=x', (e, a) => calls.push([e, a]), async () => 'C:\\Chrome\\chrome.exe');
    expect(calls).toEqual([['C:\\Chrome\\chrome.exe', ['--app=http://127.0.0.1:1/#pair=x']]]);
  });
  it('reports a clear error when Chrome is missing', async () => {
    await expect(winOpenApp('http://127.0.0.1:1/', () => undefined, async () => null)).rejects.toThrow(/Chrome/);
  });
  it.runIf(process.platform === 'win32')('this machine: finds chrome.exe at an absolute path (or none installed)', async () => {
    const p = await findChrome();
    expect(p === null || /\\chrome\.exe$/i.test(p)).toBe(true);
  }, 20_000);
});

describe('darwin Chrome lookup (pure)', () => {
  it('uses the app bundle path in /Applications, then ~/Applications', () => {
    const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(macFindChrome((p) => p === sys, '/Users/u')).toBe(sys);
    const home = '/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(macFindChrome((p) => p === home, '/Users/u')).toBe(home);
    expect(macFindChrome(() => false, '/Users/u')).toBeNull();
  });
  it('openAppWindow spawns the full path', async () => {
    const calls: [string, string[]][] = [];
    await macOpenApp('http://127.0.0.1:1/', (e, a) => calls.push([e, a]), () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(calls[0]).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--app=http://127.0.0.1:1/']]);
  });
});

describe('autostart', () => {
  let dir: string;
  const writer: PlatformWriter = {
    async writeFile(p, c) { writeText(p, c); },
    async remove(p) { rmTree(p); },
  };
  beforeEach(() => { dir = mkTmp('auto-'); });
  afterEach(() => rmTree(dir));
  const cmd = () => ['C:/Program Files/nodejs/node.exe', 'C:/dev/strategos/packages/daemon/src/main.ts', 'start'];

  it('win32: Startup-folder .cmd quotes every part (node.exe lives under a path with a space)', async () => {
    const a = winAutostart({ writer, command: cmd, dir });
    expect(await a.get()).toBe(false);
    await a.set(true);
    expect(await a.get()).toBe(true);
    const text = buildStartupCmd(cmd());
    expect(text).toContain('start "" /min "C:/Program Files/nodejs/node.exe" "C:/dev/strategos/packages/daemon/src/main.ts" "start"');
    expect(text.includes('\r\n')).toBe(true);
    await a.set(false);
    expect(await a.get()).toBe(false);
    await a.set(false); // idempotent
  });
  it('win32: unsafe characters are rejected, missing writer throws, location is the Startup folder', async () => {
    expect(() => buildStartupCmd(['a"b'])).toThrow();
    expect(() => buildStartupCmd(['%PATH%'])).toThrow();
    await expect(winAutostart({ command: cmd, dir }).set(true)).rejects.toThrow(/writer/);
    expect(startupDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
    expect(STARTUP_FILE).toBe('Strategos.cmd');
  });
  it('darwin: LaunchAgent plist with RunAtLoad and escaped arguments', async () => {
    const file = join(dir, 'com.strategos.daemon.plist');
    const a = macAutostart({ writer, command: () => ['/usr/local/bin/node', '/Users/u/a&b/main.ts', 'start'], file });
    expect(await a.get()).toBe(false);
    await a.set(true);
    expect(await a.get()).toBe(true);
    const plist = buildPlist(['/usr/local/bin/node', '/Users/u/a&b/main.ts', 'start']);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<string>/Users/u/a&amp;b/main.ts</string>');
    expect(launchAgentPath('/Users/u')).toBe('/Users/u/Library/LaunchAgents/com.strategos.daemon.plist');
    await a.set(false);
    expect(await a.get()).toBe(false);
  });
});
