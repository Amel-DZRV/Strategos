// The per-spawn `--settings` file (plan section 5 "Injected settings", with the spike corrections of batch 1 and 2).
//
// Facts this file encodes ([ran] = spike/REPORT.md):
//   - SessionStart never arrives over type:"http" (S1), so it is a type:"command" hook running tools/hook-relay.mjs.
//   - Claude de-duplicates hooks that share a URL, and the longest timeout wins (S9), so there is ONE PreToolUse "*" hook
//     with timeout 86400. The daemon decides by tool_name: AskUserQuestion is held, everything else is answered fast.
//   - The statusLine command runs under Git Bash on Windows. The node path has a space ("C:/Program Files/nodejs/node.exe"),
//     so it is quoted, and every path uses forward slashes (S5).
//   - `disableAgentView: true` is always injected (S18) and so are the deny rules for the Strategos home.
//   - The file holds no secret: the token is `$STRATEGOS_HOOK_TOKEN` (allowedEnvVars) and the relay and tap read it from env.
//   - The file is fixed for the process's life (V11), so the port must be stable (D14).
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { SafeFs } from '../safe-fs.ts';

/** The hook timeout of held events, seconds. The registry auto-releases `releaseMarginSec` before this (D13). */
export const HOLD_TIMEOUT_SEC = 86_400;
export const TOKEN_ENV = 'STRATEGOS_HOOK_TOKEN';
export const TOKEN_HEADER = 'X-Strategos-Token';
export const TRACKER_PLUGIN = 'session-tracker@claude-mods';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface RunSettingsOptions {
  strategosId: string;
  port: number;
  /** Absolute path of the node binary that runs the tap and the relay (process.execPath at spawn time). */
  nodePath: string;
  /** Absolute path of statusline/tap.mjs. */
  tapPath: string;
  /** Absolute path of tools/hook-relay.mjs (SessionStart command hook). */
  relayPath: string;
  disableAgentView?: boolean;
  /** Extra permission deny rules appended to the built-in ones. */
  extraDeny?: readonly string[];
  /** conflicts.disableTrackerInStrategos: switch the session-tracker plugin off for this session (D9). */
  trackerOff?: boolean;
  /** Inject the status-line tap. Default true; false for statusLine.mode "off". */
  statusLine?: boolean;
  /** How the Strategos home is spelled in deny rules. Default "~/.strategos". */
  homeForRules?: string;
}

/** Forward slashes, no `\\?\` prefix: Git Bash eats backslashes (V9). */
export function forwardSlashes(p: string): string {
  const stripped = p.startsWith('\\\\?\\') ? p.slice(4) : p;
  return stripped.replace(/\\/g, '/');
}

function quote(p: string): string {
  if (p.includes('"')) throw new Error(`settings-writer: refusing a path with a double quote: ${p}`);
  return `"${forwardSlashes(p)}"`;
}

/** `"<node>" "<tap>" <id> <port>`. The port is not a secret; the token comes from env. */
export function statusLineCommand(o: Pick<RunSettingsOptions, 'nodePath' | 'tapPath' | 'strategosId' | 'port'>): string {
  return `${quote(o.nodePath)} ${quote(o.tapPath)} ${o.strategosId} ${o.port}`;
}

export function relayCommand(o: Pick<RunSettingsOptions, 'nodePath' | 'relayPath' | 'strategosId' | 'port'>, event: string): string {
  return `${quote(o.nodePath)} ${quote(o.relayPath)} ${o.strategosId} ${event} ${o.port}`;
}

type Json = Record<string, unknown>;

export function buildRunSettings(o: RunSettingsOptions): Json {
  if (!ID_RE.test(o.strategosId)) throw new Error(`settings-writer: bad strategosId ${JSON.stringify(o.strategosId)}`);
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65_535) throw new Error(`settings-writer: bad port ${String(o.port)}`);
  const base = `http://127.0.0.1:${o.port}/hook/${o.strategosId}`;
  const http = (event: string, timeout?: number): Json => ({
    type: 'http',
    url: `${base}/${event}`,
    headers: { [TOKEN_HEADER]: `$${TOKEN_ENV}` },
    allowedEnvVars: [TOKEN_ENV],
    ...(timeout === undefined ? {} : { timeout }),
  });
  const plain = (event: string, timeout?: number): Json[] => [{ hooks: [http(event, timeout)] }];
  const star = (event: string, timeout?: number): Json[] => [{ matcher: '*', hooks: [http(event, timeout)] }];

  const hooks: Record<string, Json[]> = {
    // [ran] SessionStart over http never arrives: a command hook runs the relay, which POSTs it to the same URL scheme.
    SessionStart: [{ hooks: [{ type: 'command', command: relayCommand(o, 'SessionStart'), timeout: 5 }] }],
    SessionEnd: plain('SessionEnd', 3),
    UserPromptSubmit: plain('UserPromptSubmit'),
    // One hook for every tool: AskUserQuestion is held, guards answer the rest fast. The long timeout applies to all of them.
    PreToolUse: star('PreToolUse', HOLD_TIMEOUT_SEC),
    PermissionRequest: star('PermissionRequest', HOLD_TIMEOUT_SEC),
    PostToolUse: star('PostToolUse'),
    PostToolUseFailure: star('PostToolUseFailure'),
    Notification: plain('Notification'),
    Stop: plain('Stop'),
    StopFailure: plain('StopFailure'),
    SubagentStart: plain('SubagentStart'),
    SubagentStop: plain('SubagentStop'),
    PreCompact: plain('PreCompact'),
    PostCompact: plain('PostCompact'),
    CwdChanged: plain('CwdChanged'),
  };

  const home = o.homeForRules ?? '~/.strategos';
  const deny = [`Read(${home}/**)`, `Edit(${home}/**)`, ...(o.extraDeny ?? [])];

  return {
    hooks,
    ...(o.statusLine === false ? {} : { statusLine: { type: 'command', command: statusLineCommand(o) } }),
    // [ran, S18] without this one ArrowLeft moves the conversation into a background process.
    disableAgentView: o.disableAgentView ?? true,
    permissions: { deny },
    ...(o.trackerOff === true ? { enabledPlugins: { [TRACKER_PLUGIN]: false } } : {}),
  };
}

export function runDir(home: string): string {
  return path.join(home, 'run');
}

export function runSettingsPath(home: string, strategosId: string): string {
  if (!ID_RE.test(strategosId)) throw new Error(`settings-writer: bad strategosId ${JSON.stringify(strategosId)}`);
  return path.join(runDir(home), `${strategosId}.settings.json`);
}

/** Write `<home>/run/<id>.settings.json` through safe-fs. Returns the path. */
export async function writeRunSettings(safeFs: SafeFs, home: string, o: RunSettingsOptions): Promise<string> {
  const file = runSettingsPath(home, o.strategosId);
  await safeFs.mkdirp(runDir(home), { allow: [home] });
  await safeFs.writeFileAtomic(file, JSON.stringify(buildRunSettings(o), null, 2) + '\n', { allow: [home] });
  return file;
}

export async function removeRunSettings(safeFs: SafeFs, home: string, strategosId: string): Promise<void> {
  await safeFs.rm(runSettingsPath(home, strategosId), { allow: [home], force: true });
}

/** Delete every `run/*.settings.json` (and stray temp files) whose owner is not in `liveIds`. Returns the removed file names. */
export async function sweepRunDir(safeFs: SafeFs, home: string, liveIds: Iterable<string>): Promise<string[]> {
  const live = new Set(liveIds);
  let names: string[];
  try {
    names = readdirSync(runDir(home));
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = /^([A-Za-z0-9_-]{1,128})\.settings\.json(\..*\.tmp)?$/.exec(name);
    if (m === null) continue; // not ours: leave it alone
    if (live.has(m[1]!) && m[2] === undefined) continue;
    await safeFs.rm(path.join(runDir(home), name), { allow: [home], force: true });
    removed.push(name);
  }
  return removed;
}
