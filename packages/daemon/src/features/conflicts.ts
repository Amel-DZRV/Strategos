// Conflict warnings (plan task 5.06, decision D9, spike S17).
//
// Two sessions that change the same file within a window (default 30 min) are a clash. The key is
// (planetKey, repo-relative path): the path is relative to the session's own working tree, so two worktrees of one repo
// meet on the same file. The source is the PostToolUse hook of Edit / Write / MultiEdit / NotebookEdit, subagents
// included (the hook carries `agent_id`).
//
// What happens on a clash, once per change (it fires again only when the OTHER side has edited since the last warning):
//   - the human side: both sessions get `flags.conflicts += {file, other, at}` and a session.upsert (the manager applies
//     the warnings this module returns)
//   - the Claude side (D9): the session-tracker mod already tells Claude when two sessions in the SAME folder clash, but
//     it scopes to one folder and skips subagents. So Strategos adds the note only for what the mod misses: different
//     folders (worktrees), subagent edits on either side, and, if the owner switched the mod off for Strategos sessions
//     (`conflicts.disableTrackerInStrategos`), every clash. The note rides back on the PostToolUse response as
//     `additionalContext` (the hook receiver does that).
//   - contract files: an edit to a file listed in an initiative's `contractFiles` marks the initiative's OTHER sessions
//     (`flags.contractChanged += relPath`) and queues a note for each, delivered with their next PostToolUse response.
//
// Pure bookkeeping with injected lookups: no I/O except looking for the `.git` entry to find a working-tree root.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Initiative, SessionRecord } from '@strategos/shared';

export type Conflict = SessionRecord['flags']['conflicts'][number];

export interface TrackedSession {
  strategosId: string;
  name: string;
  planetKey: string;
  cwd: string;
  worktree?: { path: string };
  initiativeId?: string;
  archived?: boolean;
}

export interface ConflictDeps {
  session(sid: string): TrackedSession | undefined;
  /** Every session (for the other sessions of an initiative). */
  sessions(): TrackedSession[];
  initiatives(): Initiative[];
  now(): number;
  /** Default 30 min. */
  windowMs?: number;
  /** The owner switched session-tracker off for Strategos sessions: every clash gets the note. */
  trackerOff?: () => boolean;
  /** Label of a planet for notes. Default: the last folder of the key. */
  planetLabel?: (planetKey: string) => string;
}

export interface EditEvent {
  sid: string;
  tool: string;
  toolInput: Record<string, unknown> | undefined;
  /** Set when a subagent made the edit. */
  agentId?: string;
}

export interface EditOutcome {
  /** Flags to set: the session and the conflict. */
  warnings: { sid: string; conflict: Conflict }[];
  /** Contract files changed: mark these sessions' `flags.contractChanged`. */
  contract: { sid: string; relPath: string }[];
  /** Text for the editing session's PostToolUse `additionalContext` (D9). */
  note?: string;
}

export interface ConflictTracker {
  onEdit(e: EditEvent): EditOutcome;
  /** Notes queued for this session (contract changes by others); returns and clears them. */
  takeNotes(sid: string): string[];
  /** Drop everything remembered about a session. */
  forget(sid: string): void;
  /** Forget edits and warnings older than the window. */
  sweep(): void;
}

export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WINDOW_MS = 30 * 60_000;
const PER_FILE_MAX = 40;
const NOTES_MAX = 5;
const FLAGS_MAX = 20;

/** The path an edit tool changed, as the tool named it. */
export function editedPath(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!EDIT_TOOLS.includes(tool) || input === undefined) return undefined;
  const p = tool === 'NotebookEdit' ? (input['notebook_path'] ?? input['file_path']) : input['file_path'];
  return typeof p === 'string' && p !== '' ? p : undefined;
}

const caseFold = process.platform !== 'linux';
const fold = (s: string): string => (caseFold ? s.toLowerCase() : s);
const slashes = (s: string): string => s.replace(/\\/g, '/');

const rootCache = new Map<string, string>();
/** The working tree of a folder: the nearest parent with a `.git` entry (a folder, or the file a linked worktree has). */
function treeRootOf(cwd: string): string {
  const hit = rootCache.get(cwd);
  if (hit !== undefined) return hit;
  let dir = path.resolve(cwd);
  let found = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(path.join(dir, '.git'))) {
      found = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      found = path.resolve(cwd);
      break;
    }
    dir = up;
  }
  rootCache.set(cwd, found);
  return found;
}

export function treeRoot(s: TrackedSession): string {
  return s.worktree?.path ?? treeRootOf(s.cwd);
}

/** repo-relative path with forward slashes, or undefined when the file is outside the session's working tree. */
export function relInTree(s: TrackedSession, file: string): string | undefined {
  const root = treeRoot(s);
  const abs = path.isAbsolute(file) ? file : path.resolve(s.cwd, file);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return slashes(rel);
}

/** Add (or refresh) a conflict in a flags list: one entry per (file, other). */
export function addConflict(list: readonly Conflict[], c: Conflict): Conflict[] {
  const rest = list.filter((x) => !(x.file === c.file && x.other === c.other));
  return [...rest, c].slice(-FLAGS_MAX);
}

/** The conflicts still inside the window. Returns the same array when nothing expired. */
export function pruneConflicts(list: readonly Conflict[], now: number, windowMs = WINDOW_MS): readonly Conflict[] {
  const kept = list.filter((c) => now - c.at < windowMs);
  return kept.length === list.length ? list : kept;
}

interface Edit {
  sid: string;
  at: number;
  sub: boolean;
  root: string;
}

const minutesAgo = (now: number, at: number): number => Math.max(1, Math.round((now - at) / 60_000));

export function createConflictTracker(deps: ConflictDeps): ConflictTracker {
  const windowMs = deps.windowMs ?? WINDOW_MS;
  const edits = new Map<string, Edit[]>(); // key -> edits inside the window, oldest first
  const warned = new Map<string, number>(); // pair key -> time of the last warning
  const notes = new Map<string, string[]>();
  const label = deps.planetLabel ?? ((k: string): string => path.basename(k.replace(/[\\/]\.git[\\/]?$/i, '')) || k);

  function contractInitiatives(planetKey: string, rel: string): Initiative[] {
    return deps.initiatives().filter((i) => !i.archived && i.contractFiles.some((f) => f.planetKey === planetKey && fold(slashes(f.relPath)) === fold(rel)));
  }

  function queueNote(sid: string, text: string): void {
    const list = notes.get(sid) ?? [];
    if (!list.includes(text)) list.push(text);
    notes.set(sid, list.slice(-NOTES_MAX));
  }

  return {
    onEdit(e) {
      const out: EditOutcome = { warnings: [], contract: [] };
      const file = editedPath(e.tool, e.toolInput);
      const me = deps.session(e.sid);
      if (file === undefined || me === undefined) return out;
      const rel = relInTree(me, file);
      if (rel === undefined) return out;
      const at = deps.now();
      const key = `${me.planetKey}\u0000${fold(rel)}`;
      const mine: Edit = { sid: me.strategosId, at, sub: e.agentId !== undefined && e.agentId !== '', root: fold(treeRoot(me)) };

      // ---- same-file clashes -----------------------------------------------------------
      const history = (edits.get(key) ?? []).filter((x) => at - x.at < windowMs);
      const latestOther = new Map<string, Edit>();
      const others: Edit[] = [];
      for (const x of history) if (x.sid !== me.strategosId) latestOther.set(x.sid, x); // later entries overwrite earlier ones
      others.push(...latestOther.values());
      edits.set(key, [...history, mine].slice(-PER_FILE_MAX));

      const noteFor: { name: string; at: number }[] = [];
      for (const o of others) {
        const other = deps.session(o.sid);
        if (other === undefined) continue;
        const pair = `${key}\u0000${[me.strategosId, o.sid].sort().join('\u0000')}`;
        const last = warned.get(pair);
        if (last !== undefined && o.at <= last && at - last < windowMs) continue; // already told, nothing new from the other side
        warned.set(pair, at);
        out.warnings.push({ sid: me.strategosId, conflict: { file: rel, other: other.name, at } });
        out.warnings.push({ sid: other.strategosId, conflict: { file: rel, other: me.name, at } });
        // D9: the mod covers the same folder and main-agent edits; everything else needs our note
        const modBlind = (deps.trackerOff?.() ?? false) || mine.root !== o.root || mine.sub || o.sub;
        if (modBlind) noteFor.push({ name: other.name, at: o.at });
      }
      if (noteFor.length > 0) {
        const names = noteFor.map((n) => n.name);
        const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
        const mins = minutesAgo(at, Math.max(...noteFor.map((n) => n.at)));
        out.note = `Note from Strategos: ${who} also edited ${rel} in the last ${mins} min; check before overwriting.`;
      }

      // ---- contract files --------------------------------------------------------------
      for (const ini of contractInitiatives(me.planetKey, rel)) {
        if (me.initiativeId !== ini.id) continue;
        for (const s of deps.sessions()) {
          if (s.initiativeId !== ini.id || s.strategosId === me.strategosId || s.archived === true) continue;
          out.contract.push({ sid: s.strategosId, relPath: rel });
          queueNote(s.strategosId, `Note from Strategos: ${me.name} changed the contract file ${rel} (${label(me.planetKey)}) of initiative "${ini.name}"; check that your work still matches it.`);
        }
      }
      return out;
    },

    takeNotes(sid) {
      const list = notes.get(sid) ?? [];
      notes.delete(sid);
      return list;
    },

    forget(sid) {
      notes.delete(sid);
      for (const [k, list] of edits) {
        const kept = list.filter((x) => x.sid !== sid);
        if (kept.length === 0) edits.delete(k);
        else edits.set(k, kept);
      }
      for (const k of [...warned.keys()]) if (k.split('\u0000').includes(sid)) warned.delete(k);
    },

    sweep() {
      const t = deps.now();
      for (const [k, list] of edits) {
        const kept = list.filter((x) => t - x.at < windowMs);
        if (kept.length === 0) edits.delete(k);
        else if (kept.length !== list.length) edits.set(k, kept);
      }
      for (const [k, at] of warned) if (t - at >= windowMs) warned.delete(k);
    },
  };
}
