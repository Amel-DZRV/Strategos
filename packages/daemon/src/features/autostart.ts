// Autostart opt-in (task 8.04). The platform layer writes the Startup entry (Windows Startup-folder .cmd, macOS LaunchAgent);
// this file decides WHICH command it launches, because that differs by how the daemon itself was started:
//
//   packaged app   the Electron shell tells the daemon its own launch command in STRATEGOS_AUTOSTART_CMD, a JSON array
//                  `[exe, ...args]` with an absolute exe, e.g. ["C:\\Program Files\\Strategos\\Strategos.exe"]. The shell then
//                  starts the daemon itself (daemon-launch.ts), so autostart opens the app, not a bare daemon.
//   from source    the system Node (config.machine.nodePath, else this process' own node) running packages/daemon/src/cli.ts
//                  `start`, which starts main.ts detached. Only when that file exists and this is not an Electron process.
//   otherwise      no command: autostart cannot be turned on, and the reason says why. It is never enabled without a command.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '../platform/index.ts';
import type { WsHub } from '../server/ws-hub.ts';

export const AUTOSTART_ENV = 'STRATEGOS_AUTOSTART_CMD';

export type AutostartCommand = { ok: true; command: string[]; source: 'env' | 'source' } | { ok: false; reason: string };

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  /** Absolute path of cli.ts next to this daemon, when the daemon runs from source. */
  cliPath?: string;
  nodePath: string;
  isElectron?: boolean;
  exists?: (p: string) => boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLI_PATH = path.resolve(here, '..', 'cli.ts');

/** Parse STRATEGOS_AUTOSTART_CMD. A bad value is an error, not a silent fallback: the shell meant something. */
export function parseAutostartEnv(raw: string): string[] | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: `${AUTOSTART_ENV} is not valid JSON (expected an array like ["C:\\\\path\\\\app.exe", "--arg"])` };
  }
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x !== '')) return { error: `${AUTOSTART_ENV} must be a non-empty JSON array of strings` };
  const list = v as string[];
  const exe = list[0]!;
  if (!path.win32.isAbsolute(exe) && !path.posix.isAbsolute(exe)) return { error: `${AUTOSTART_ENV}: the first entry must be an absolute path` };
  return list;
}

export function resolveAutostartCommand(deps: ResolveDeps): AutostartCommand {
  const raw = deps.env[AUTOSTART_ENV];
  if (raw !== undefined && raw !== '') {
    const parsed = parseAutostartEnv(raw);
    return 'error' in parsed ? { ok: false, reason: parsed.error } : { ok: true, command: parsed, source: 'env' };
  }
  const exists = deps.exists ?? existsSync;
  const cli = deps.cliPath ?? DEFAULT_CLI_PATH;
  if (deps.isElectron === true) return { ok: false, reason: 'The daemon runs inside Electron and was not told its launch command (set STRATEGOS_AUTOSTART_CMD).' };
  if (!exists(cli)) return { ok: false, reason: 'This daemon does not know how to start itself (no source checkout and no STRATEGOS_AUTOSTART_CMD).' };
  if (!path.isAbsolute(deps.nodePath)) return { ok: false, reason: 'The Node.js path is not absolute.' };
  return { ok: true, command: [deps.nodePath, cli, 'start'], source: 'source' };
}

export interface AutostartDeps {
  hub: Pick<WsHub, 'registerCommand'>;
  platform: Pick<Platform, 'autostart'>;
  command: AutostartCommand;
  /** Called with the new state after every get/set, so the next snapshot carries prefs.autostart. */
  onState: (s: { on: boolean; available: boolean }) => void;
  onError?: (what: string, err: unknown) => void;
}

export interface AutostartControl {
  state(): Promise<{ on: boolean; available: boolean }>;
}

export function registerAutostartCommands(deps: AutostartDeps): AutostartControl {
  const available = deps.command.ok;
  const read = async (): Promise<boolean> => {
    try {
      return await deps.platform.autostart.get();
    } catch (err) {
      deps.onError?.('autostart.get', err);
      return false;
    }
  };
  const event = (on: boolean) => ({
    t: 'autostart' as const, on, available,
    ...(deps.command.ok ? { command: deps.command.command } : { reason: deps.command.reason }),
  });
  deps.hub.registerCommand('autostart.get', async (_c, ctx) => {
    const on = await read();
    deps.onState({ on, available });
    ctx.send(event(on));
  });
  deps.hub.registerCommand('autostart.set', async (c, ctx) => {
    if (c.on && !deps.command.ok) return { ok: false, error: deps.command.reason };
    try {
      await deps.platform.autostart.set(c.on);
    } catch (err) {
      return { ok: false, error: `Could not ${c.on ? 'enable' : 'disable'} autostart: ${err instanceof Error ? err.message : String(err)}` };
    }
    const on = await read();
    deps.onState({ on, available });
    ctx.send(event(on));
    if (on !== c.on) return { ok: false, error: 'The Startup entry did not change.' };
  });
  return { state: async () => ({ on: await read(), available }) };
}
