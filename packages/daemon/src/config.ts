// config.json (plan section 5, D14, D19). Two objects:
//   machine  : things that belong to this computer (repos, claudePath, port, worktreeRoot, nodePath, bind host)
//   portable : things you may copy to your other computer (guards, thresholds, notifications, keymap, ...)
// Hand-written validator (no zod): every problem is reported with its path, none of them throws.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isGuardRule, type GuardRule, type NotificationPrefs } from '@strategos/shared';
import { starterGuards } from './features/guards.ts';
import type { SafeFs } from './safe-fs.ts';

export const PORT_MIN = 49152;
export const PORT_MAX = 65535;
export const LOOPBACK_HOST = '127.0.0.1';

export interface MachineConfig {
  repos: string[];
  claudePath?: string;
  /** Chosen once and kept (D14): run settings files embed the URL. */
  port: number;
  /** Where Strategos creates worktrees. A relative path is relative to the repo (D17). */
  worktreeRoot: string;
  nodePath?: string;
  /** Always 127.0.0.1. Anything else is refused (section 10: no LAN mode). */
  host: typeof LOOPBACK_HOST;
}

export interface Thresholds {
  ctxWarnPct: number;
  ctxFullPct: number;
  escalateMinutes: number[];
  stuckRepeatCount: number;
  stuckFailureCount: number;
  stuckQuietMinutes: number;
  /** Held requests are released this long before the hook timeout (D13). */
  releaseMarginSec: number;
}

export interface PortableConfig {
  env: { keep: string[]; set: Record<string, string> };
  guards: GuardRule[];
  notifications: NotificationPrefs;
  thresholds: Thresholds;
  testCommandPatterns: string[];
  conflicts: { windowMinutes: number; disableTrackerInStrategos: boolean };
  statusLine: { mode: 'chain' | 'replace' | 'off' };
  keymap: Record<string, string>;
}

export interface Config {
  schema: 1;
  machine: MachineConfig;
  portable: PortableConfig;
}

export function strategosHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const o = env['STRATEGOS_HOME'];
  return o !== undefined && o !== '' ? path.resolve(o) : path.join(home, '.strategos');
}

export function randomPort(rand: (min: number, max: number) => number = (a, b) => randomInt(a, b)): number {
  return rand(PORT_MIN, PORT_MAX + 1);
}

export function defaultPortable(): PortableConfig {
  return {
    env: { keep: [], set: {} },
    guards: starterGuards(), // task 4.04: seeded; an empty list in config.json is read as "use the starter rules" (disable a rule with enabled:false)
    notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true },
    thresholds: {
      ctxWarnPct: 70, ctxFullPct: 85, escalateMinutes: [5, 15], stuckRepeatCount: 3, stuckFailureCount: 5, stuckQuietMinutes: 10, releaseMarginSec: 30,
    },
    testCommandPatterns: ['\\b(npm|pnpm|yarn)\\s+(run\\s+)?test\\b', '\\bvitest\\b', '\\bjest\\b', '\\bpytest\\b', '\\bgo\\s+test\\b', '\\bcargo\\s+test\\b'],
    conflicts: { windowMinutes: 30, disableTrackerInStrategos: false },
    statusLine: { mode: 'chain' },
    keymap: {},
  };
}

export function defaultConfig(port: number = randomPort()): Config {
  return {
    schema: 1,
    machine: { repos: [], port, worktreeRoot: path.join('.claude', 'worktrees'), host: LOOPBACK_HOST },
    portable: defaultPortable(),
  };
}

export type ValidateResult = { ok: true; config: Config; portAssigned: boolean } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + '...' : s;
};

/**
 * Validate a parsed config.json. Missing fields get defaults; wrong types and bad values are errors.
 * A missing `machine.port` is not an error: a new one is picked (portAssigned = true) so the caller can save it.
 */
export function validateConfig(raw: unknown, pickPort: () => number = randomPort): ValidateResult {
  const errors: string[] = [];
  const err = (p: string, msg: string) => errors.push(`${p}: ${msg}`);
  if (!isObj(raw)) return { ok: false, errors: ['config.json: the top level must be a JSON object'] };
  if (raw['schema'] !== undefined && raw['schema'] !== 1) err('schema', `must be 1 (got ${show(raw['schema'])})`);

  const def = defaultConfig(0);
  const sect = (name: 'machine' | 'portable'): Record<string, unknown> => {
    const v = raw[name];
    if (v === undefined) return {};
    if (!isObj(v)) {
      err(name, `must be an object (got ${show(v)})`);
      return {};
    }
    return v;
  };
  const strList = (o: Record<string, unknown>, key: string, p: string, fallback: string[]): string[] => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      err(`${p}.${key}`, `must be an array of strings (got ${show(v)})`);
      return fallback;
    }
    return v as string[];
  };
  const optStr = (o: Record<string, unknown>, key: string, p: string): string | undefined => {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '') {
      err(`${p}.${key}`, `must be a non-empty string (got ${show(v)})`);
      return undefined;
    }
    return v;
  };
  const bool = (o: Record<string, unknown>, key: string, p: string, fallback: boolean): boolean => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') {
      err(`${p}.${key}`, `must be true or false (got ${show(v)})`);
      return fallback;
    }
    return v;
  };
  const num = (o: Record<string, unknown>, key: string, p: string, fallback: number, min: number, max: number): number => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      err(`${p}.${key}`, `must be a number between ${min} and ${max} (got ${show(v)})`);
      return fallback;
    }
    return v;
  };

  // --- machine ---
  const m = sect('machine');
  let portAssigned = false;
  let port: number;
  if (m['port'] === undefined) {
    port = pickPort();
    portAssigned = true;
  } else if (typeof m['port'] !== 'number' || !Number.isInteger(m['port']) || m['port'] < PORT_MIN || m['port'] > PORT_MAX) {
    err('machine.port', `must be a whole number from ${PORT_MIN} to ${PORT_MAX} (got ${show(m['port'])})`);
    port = def.machine.port;
  } else {
    port = m['port'];
  }
  if (m['host'] !== undefined && m['host'] !== LOOPBACK_HOST) {
    err('machine.host', `Strategos only listens on ${LOOPBACK_HOST}; ${show(m['host'])} is refused (there is no LAN mode)`);
  }
  const repos = strList(m, 'repos', 'machine', []);
  const claudePath = optStr(m, 'claudePath', 'machine');
  const nodePath = optStr(m, 'nodePath', 'machine');
  const worktreeRoot = optStr(m, 'worktreeRoot', 'machine') ?? def.machine.worktreeRoot;
  const machine: MachineConfig = {
    repos, port, worktreeRoot, host: LOOPBACK_HOST,
    ...(claudePath === undefined ? {} : { claudePath }),
    ...(nodePath === undefined ? {} : { nodePath }),
  };

  // --- portable ---
  const p = sect('portable');
  const dp = def.portable;

  let envKeep = dp.env.keep;
  let envSet = dp.env.set;
  if (p['env'] !== undefined) {
    if (!isObj(p['env'])) err('portable.env', `must be an object (got ${show(p['env'])})`);
    else {
      envKeep = strList(p['env'], 'keep', 'portable.env', dp.env.keep);
      const s = p['env']['set'];
      if (s !== undefined) {
        if (isObj(s) && Object.values(s).every((v) => typeof v === 'string')) envSet = s as Record<string, string>;
        else err('portable.env.set', `must be an object of strings (got ${show(s)})`);
      }
    }
  }

  let guards = dp.guards;
  if (p['guards'] !== undefined) {
    if (!Array.isArray(p['guards'])) err('portable.guards', `must be an array (got ${show(p['guards'])})`);
    else {
      const seen = new Set<string>();
      p['guards'].forEach((g, i) => {
        if (!isGuardRule(g)) {
          err(`portable.guards[${i}]`, 'must be {id, description, tool, pattern (a valid regular expression), enabled, field?}');
        } else if (seen.has(g.id)) err(`portable.guards[${i}].id`, `duplicate id ${show(g.id)}`);
        else seen.add(g.id);
      });
      guards = p['guards'].length === 0 ? dp.guards : (p['guards'] as GuardRule[]);
    }
  }

  let notifications = dp.notifications;
  if (p['notifications'] !== undefined) {
    if (!isObj(p['notifications'])) err('portable.notifications', `must be an object (got ${show(p['notifications'])})`);
    else {
      const n = p['notifications'];
      notifications = {
        enabled: bool(n, 'enabled', 'portable.notifications', dp.notifications.enabled),
        sound: bool(n, 'sound', 'portable.notifications', dp.notifications.sound),
        onPermission: bool(n, 'onPermission', 'portable.notifications', dp.notifications.onPermission),
        onQuestion: bool(n, 'onQuestion', 'portable.notifications', dp.notifications.onQuestion),
        onErrored: bool(n, 'onErrored', 'portable.notifications', dp.notifications.onErrored),
        onDone: bool(n, 'onDone', 'portable.notifications', dp.notifications.onDone),
        escalate: bool(n, 'escalate', 'portable.notifications', dp.notifications.escalate),
      };
    }
  }

  let thresholds = dp.thresholds;
  if (p['thresholds'] !== undefined) {
    if (!isObj(p['thresholds'])) err('portable.thresholds', `must be an object (got ${show(p['thresholds'])})`);
    else {
      const t = p['thresholds'];
      const T = 'portable.thresholds';
      let escalate = dp.thresholds.escalateMinutes;
      const e = t['escalateMinutes'];
      if (e !== undefined) {
        if (Array.isArray(e) && e.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) escalate = e as number[];
        else err(`${T}.escalateMinutes`, `must be an array of positive numbers (got ${show(e)})`);
      }
      thresholds = {
        ctxWarnPct: num(t, 'ctxWarnPct', T, dp.thresholds.ctxWarnPct, 1, 100),
        ctxFullPct: num(t, 'ctxFullPct', T, dp.thresholds.ctxFullPct, 1, 100),
        escalateMinutes: escalate,
        stuckRepeatCount: num(t, 'stuckRepeatCount', T, dp.thresholds.stuckRepeatCount, 2, 100),
        stuckFailureCount: num(t, 'stuckFailureCount', T, dp.thresholds.stuckFailureCount, 2, 100),
        stuckQuietMinutes: num(t, 'stuckQuietMinutes', T, dp.thresholds.stuckQuietMinutes, 1, 1440),
        releaseMarginSec: num(t, 'releaseMarginSec', T, dp.thresholds.releaseMarginSec, 1, 600),
      };
      if (thresholds.ctxWarnPct >= thresholds.ctxFullPct) err(`${T}.ctxWarnPct`, 'must be lower than ctxFullPct');
    }
  }

  const testCommandPatterns = strList(p, 'testCommandPatterns', 'portable', dp.testCommandPatterns);
  testCommandPatterns.forEach((pat, i) => {
    try {
      new RegExp(pat);
    } catch {
      err(`portable.testCommandPatterns[${i}]`, `${show(pat)} is not a valid regular expression`);
    }
  });

  let conflicts = dp.conflicts;
  if (p['conflicts'] !== undefined) {
    if (!isObj(p['conflicts'])) err('portable.conflicts', `must be an object (got ${show(p['conflicts'])})`);
    else {
      conflicts = {
        windowMinutes: num(p['conflicts'], 'windowMinutes', 'portable.conflicts', dp.conflicts.windowMinutes, 1, 1440),
        disableTrackerInStrategos: bool(p['conflicts'], 'disableTrackerInStrategos', 'portable.conflicts', false),
      };
    }
  }

  let statusLine = dp.statusLine;
  if (p['statusLine'] !== undefined) {
    const mode = isObj(p['statusLine']) ? p['statusLine']['mode'] : undefined;
    if (mode === 'chain' || mode === 'replace' || mode === 'off') statusLine = { mode };
    else err('portable.statusLine.mode', `must be "chain", "replace" or "off" (got ${show(mode)})`);
  }

  let keymap = dp.keymap;
  if (p['keymap'] !== undefined) {
    if (isObj(p['keymap']) && Object.values(p['keymap']).every((v) => typeof v === 'string')) keymap = p['keymap'] as Record<string, string>;
    else err('portable.keymap', `must be an object of strings (got ${show(p['keymap'])})`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    portAssigned,
    config: {
      schema: 1,
      machine,
      portable: { env: { keep: envKeep, set: envSet }, guards, notifications, thresholds, testCommandPatterns, conflicts, statusLine, keymap },
    },
  };
}

export function formatConfigErrors(file: string, errors: string[]): string {
  return `config.json is not valid (${file}):\n${errors.map((e) => `  - ${e}`).join('\n')}\nFix the file by hand or delete it to start from the defaults. A copy of the last good one may be in config.json.bak.`;
}

export type LoadConfigResult =
  | { ok: true; config: Config; created: boolean; path: string }
  | { ok: false; errors: string[]; path: string; message: string };

export function configPath(home: string): string {
  return path.join(home, 'config.json');
}

/**
 * Read config.json. First run (no file): write the defaults including a freshly chosen port. A file without a port
 * gets one chosen and saved. A broken file is reported, never overwritten.
 */
export async function loadConfig(o: { fs: SafeFs; home: string; pickPort?: () => number }): Promise<LoadConfigResult> {
  const file = configPath(o.home);
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      const errors = [`cannot read the file: ${(e as Error).message}`];
      return { ok: false, errors, path: file, message: formatConfigErrors(file, errors) };
    }
  }
  if (text === null) {
    const config = defaultConfig(o.pickPort?.() ?? randomPort());
    await o.fs.mkdirp(o.home);
    await writeConfig(o.fs, o.home, config, false);
    return { ok: true, config, created: true, path: file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    const errors = [`not valid JSON: ${(e as Error).message}`];
    return { ok: false, errors, path: file, message: formatConfigErrors(file, errors) };
  }
  const v = validateConfig(parsed, o.pickPort);
  if (!v.ok) return { ok: false, errors: v.errors, path: file, message: formatConfigErrors(file, v.errors) };
  if (v.portAssigned) await writeConfig(o.fs, o.home, v.config, true);
  return { ok: true, config: v.config, created: false, path: file };
}

async function writeConfig(sfs: SafeFs, home: string, config: Config, keepBak: boolean): Promise<void> {
  const file = configPath(home);
  if (keepBak) await sfs.copyFile(file, file + '.bak').catch(() => undefined);
  await sfs.writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
}

/** Save after an explicit user action in the UI. Validates first; the previous file is kept as config.json.bak. */
export async function saveConfig(o: { fs: SafeFs; home: string }, config: unknown): Promise<LoadConfigResult> {
  const file = configPath(o.home);
  const v = validateConfig(config);
  if (!v.ok) return { ok: false, errors: v.errors, path: file, message: formatConfigErrors(file, v.errors) };
  await o.fs.mkdirp(o.home);
  await writeConfig(o.fs, o.home, v.config, true);
  return { ok: true, config: v.config, created: false, path: file };
}
