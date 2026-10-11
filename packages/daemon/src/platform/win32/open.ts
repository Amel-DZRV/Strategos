import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { run } from '../common/exec.ts';
import { chromeAppArgs, spawnDetached, type SpawnDetached } from '../common/open.ts';

const sys = (name: string): string => `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\${name}`;
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

export async function openExternal(urlOrPath: string): Promise<void> {
  if (!urlOrPath || /[\r\n\0]/.test(urlOrPath)) throw new Error('bad target');
  const r = await run(sys('rundll32.exe'), ['url.dll,FileProtocolHandler', urlOrPath], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`rundll32 exited ${r.code}`);
}

/** The `(Default)` value from `reg query ... /ve` output, or null. */
export function parseRegDefault(out: string): string | null {
  const m = /\(Default\)\s+REG_SZ\s+(.+?)\s*$/im.exec(out);
  return m?.[1] ? m[1].replace(/^"|"$/g, '') : null;
}

const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';

/** Chrome's full path: registry App Paths (HKCU then HKLM), then the standard install folders. Never PATH. */
export async function findChrome(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = isFile): Promise<string | null> {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const r = await run(sys('reg.exe'), ['query', `${hive}\\${APP_PATHS}`, '/ve'], { timeoutMs: 5000 });
      const p = r.code === 0 ? parseRegDefault(r.stdout) : null;
      if (p && exists(p)) return p;
    } catch { /* try the next source */ }
  }
  for (const base of [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']]) {
    if (!base) continue;
    const p = win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (exists(p)) return p;
  }
  return null;
}

export async function openAppWindow(url: string, spawnFn: SpawnDetached = spawnDetached, find: () => Promise<string | null> = () => findChrome()): Promise<void> {
  const args = chromeAppArgs(url);
  const chrome = await find();
  if (!chrome) throw new Error('Google Chrome was not found (looked in the registry and the standard install folders)');
  spawnFn(chrome, args);
}
