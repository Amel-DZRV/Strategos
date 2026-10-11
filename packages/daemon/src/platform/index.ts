// Platform layer (plan section 4.1, task 1.03, decision D18): both implementations exist from M1.
// Pure helpers are exported from the per-OS modules so they can be unit-tested on any OS.
import { fileURLToPath } from 'node:url';
import type { Platform, PlatformOptions } from './types.ts';
import { projectDirName } from './common/project-dir.ts';
import * as winPaths from './win32/paths.ts';
import * as winLocator from './win32/locator.ts';
import * as winProcess from './win32/process.ts';
import { createSampler as winSampler } from './win32/sampler.ts';
import * as winOpen from './win32/open.ts';
import { createAutostart as winAutostart } from './win32/autostart.ts';
import * as macPaths from './darwin/paths.ts';
import * as macLocator from './darwin/locator.ts';
import * as macProcess from './darwin/process.ts';
import { createSampler as macSampler } from './darwin/sampler.ts';
import * as macOpen from './darwin/open.ts';
import { createAutostart as macAutostart } from './darwin/autostart.ts';

export type { Platform, PlatformOptions, PlatformWriter, LocateResult, ProcSample } from './types.ts';
export { projectDirName, projectDirPrefix } from './common/project-dir.ts';
export { bundleRefusal } from './common/bundle.ts';

const defaultCommand = (): string[] => [process.execPath, fileURLToPath(new URL('../main.ts', import.meta.url)), 'start'];

export function createWin32Platform(o: PlatformOptions = {}): Platform {
  return {
    paths: { strategosHome: () => winPaths.strategosHome(), claudeConfigDir: () => winPaths.claudeConfigDir(), canonical: winPaths.canonicalWin32, projectDirName },
    locateClaude: (cfg) => winLocator.locateClaudeWin32(cfg),
    proc: { isAlive: winProcess.isAlive, startTime: winProcess.startTime, killTree: winProcess.killTree, sample: winSampler({ intervalMs: o.sampleIntervalMs }) },
    openExternal: winOpen.openExternal,
    openAppWindow: (url) => winOpen.openAppWindow(url),
    autostart: winAutostart({ writer: o.writer, command: o.autostartCommand ?? defaultCommand }),
  };
}

export function createDarwinPlatform(o: PlatformOptions = {}): Platform {
  return {
    paths: { strategosHome: () => macPaths.strategosHome(), claudeConfigDir: () => macPaths.claudeConfigDir(), canonical: (p) => macPaths.canonicalDarwin(p), projectDirName },
    locateClaude: (cfg) => macLocator.locateClaudeDarwin(cfg),
    proc: { isAlive: macProcess.isAlive, startTime: macProcess.startTime, killTree: macProcess.killTree, sample: macSampler({ intervalMs: o.sampleIntervalMs }) },
    openExternal: macOpen.openExternal,
    openAppWindow: (url) => macOpen.openAppWindow(url),
    autostart: macAutostart({ writer: o.writer, command: o.autostartCommand ?? defaultCommand }),
  };
}

let cached: Platform | undefined;

/** The platform for this process. Pass options on the first call (the daemon passes the safe-fs writer); later calls return the same object. */
export function getPlatform(o?: PlatformOptions): Platform {
  if (o || !cached) {
    if (process.platform === 'win32') cached = createWin32Platform(o);
    else if (process.platform === 'darwin') cached = createDarwinPlatform(o);
    else throw new Error(`unsupported platform: ${process.platform}`);
  }
  return cached;
}
