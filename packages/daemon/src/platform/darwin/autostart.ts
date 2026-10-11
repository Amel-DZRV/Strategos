import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { PlatformWriter } from '../types.ts';

export const LAUNCH_AGENT_LABEL = 'com.strategos.daemon';

export function launchAgentPath(home: string = homedir()): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildPlist(command: string[]): string {
  if (command.length === 0) throw new Error('empty autostart command');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map((c) => `    <string>${esc(c)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function createAutostart(o: { writer?: PlatformWriter; command: () => string[]; file?: string }): { get(): Promise<boolean>; set(on: boolean): Promise<void> } {
  const file = (): string => o.file ?? launchAgentPath();
  return {
    async get() { try { return statSync(file()).isFile(); } catch { return false; } },
    async set(on) {
      if (!o.writer) throw new Error('autostart writer is not wired (safe-fs not injected)');
      if (on) await o.writer.writeFile(file(), buildPlist(o.command()));
      else await o.writer.remove(file());
    },
  };
}
