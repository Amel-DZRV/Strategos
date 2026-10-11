import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { PlatformWriter } from '../types.ts';

export const STARTUP_FILE = 'Strategos.cmd';

export function startupDir(env: Record<string, string | undefined> = process.env): string {
  const appData = env['APPDATA'];
  if (!appData) throw new Error('APPDATA is not set');
  return win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** Contents of the Startup-folder launcher. Every part is quoted; the node path contains a space on a default install. */
export function buildStartupCmd(command: string[]): string {
  if (command.length === 0) throw new Error('empty autostart command');
  for (const part of command) if (/["%\r\n\0]/.test(part)) throw new Error(`unsafe character in autostart command: ${part}`);
  const [exe, ...rest] = command;
  return ['@echo off', `start "" /min "${exe}" ${rest.map((a) => `"${a}"`).join(' ')}`, ''].join('\r\n');
}

export function createAutostart(o: { writer?: PlatformWriter; command: () => string[]; dir?: string }): { get(): Promise<boolean>; set(on: boolean): Promise<void> } {
  const file = (): string => win32.join(o.dir ?? startupDir(), STARTUP_FILE);
  return {
    async get() { try { return statSync(file()).isFile(); } catch { return false; } },
    async set(on) {
      if (!o.writer) throw new Error('autostart writer is not wired (safe-fs not injected)');
      if (on) await o.writer.writeFile(file(), buildStartupCmd(o.command()));
      else await o.writer.remove(file());
    },
  };
}
