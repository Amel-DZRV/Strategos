// Which of the owner's Claude Code mods are present (task 5.05). Read-only: this only reads the Claude config dir
// (`settings.json` enabledPlugins, `plugins/installed_plugins.json`), never writes to it.
//
// The auto-handoff mod provides `/handoff-now` and the keepwarm warning; Strategos offers those buttons only when it is there.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface Mods {
  autoHandoff: boolean;
}

const NAME = /^auto-handoff(@|$)/;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An explicit enabledPlugins entry decides (false = switched off); without one, being installed counts. */
export function detectMods(claudeDir: string): Mods {
  const enabled = readJson(path.join(claudeDir, 'settings.json'))?.['enabledPlugins'];
  if (typeof enabled === 'object' && enabled !== null) {
    const entries = Object.entries(enabled as Record<string, unknown>).filter(([k]) => NAME.test(k));
    if (entries.length > 0) return { autoHandoff: entries.some(([, v]) => v === true) };
  }
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'))?.['plugins'];
  const has = typeof installed === 'object' && installed !== null && Object.keys(installed).some((k) => NAME.test(k));
  return { autoHandoff: has };
}

/** `detectMods` with a short cache, for the snapshot and for slash.send. */
export function createModsProbe(claudeDir: string, ttlMs = 15_000, now: () => number = Date.now): () => Mods {
  let last: { at: number; mods: Mods } | undefined;
  return () => {
    const t = now();
    if (last === undefined || t - last.at > ttlMs) last = { at: t, mods: detectMods(claudeDir) };
    return last.mods;
  };
}
