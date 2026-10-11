// D20 for the renderer: may a toast (or any one-click surface) show an "Approve" button for this tool call?
//
// The daemon's `isBatchApprovable` (daemon/src/features/risk.ts) is the authority. It needs node:path and realpath, so
// it cannot run in a browser page. This is a small PURE copy of the same rules with the same test table
// (d20.test.ts): only Read, Edit and Write; the file path inside the session's worktree; no dot file or dot folder
// (.git, .claude, .github, .env ...) in the part of the path below the worktree; no Windows spelling tricks.
// What it cannot do is follow symbolic links, so it is deliberately only a gate for SHOWING the button. The daemon repeats
// the full test (with links) when the decision arrives with `via: 'toast'`.
//
// The caller passes the tool's file path. For Read/Edit/Write the daemon's `inputSummary` IS the file path (receiver.ts
// rawSummary), and a cut summary (D21) must never reach this function: use `toastActions`.
import type { Pending } from './types.ts';

export type D20Platform = 'win32' | 'posix';

interface Parsed {
  /** '' for posix, 'c:' (lower case) for a drive, null when the path is not absolute. */
  drive: string | null;
  rooted: boolean;
  parts: string[];
}

function parse(p: string, plat: D20Platform): Parsed {
  let rest = p;
  let drive: string | null = null;
  if (plat === 'win32') {
    const m = /^([A-Za-z]):/.exec(rest);
    if (m) {
      drive = m[1]!.toLowerCase() + ':';
      rest = rest.slice(2);
    }
    rest = rest.replace(/\\/g, '/');
  }
  const rooted = rest.startsWith('/');
  return { drive, rooted, parts: rest.split('/').filter((s) => s !== '' && s !== '.') };
}

/** Resolve `.` and `..` lexically. null when `..` climbs above the root. */
function collapse(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

function badSegment(seg: string, plat: D20Platform): boolean {
  if (seg === '' || seg === '.') return false;
  if (seg.startsWith('.')) return true; // also '..' and every dotfile / dot folder
  if (plat === 'win32') {
    if (/[:*?"<>|]/.test(seg)) return true;
    if (/[. ]$/.test(seg)) return true;
    if (/~\d/.test(seg)) return true;
    if (WINDOWS_DEVICE.test(seg)) return true;
  }
  return false;
}

/** Same answer as the daemon's `isBatchApprovable` for these inputs, except that it cannot see symbolic links. */
export function isToastApprovablePath(tool: string, file: unknown, worktree: string, plat: D20Platform): boolean {
  if (tool !== 'Read' && tool !== 'Edit' && tool !== 'Write') return false;
  if (typeof file !== 'string' || file === '' || file.length > 1024 || file.includes('\0')) return false;
  if (worktree === '' || worktree.includes('\0')) return false;
  if (/^[{[]/.test(file)) return false; // a JSON summary, not a path (the tool had no file_path)
  if (plat === 'win32' && /^[\\/]{2}/.test(file)) return false; // UNC and device paths
  if (/^~(?:[\\/]|$)/.test(file)) return false;
  const root = parse(worktree, plat);
  if (!root.rooted && root.drive === null) return false; // the worktree must be absolute
  if (plat === 'win32' && /^[\\/]{2}/.test(worktree)) return false;
  const rootParts = collapse(root.parts);
  if (rootParts === null) return false;
  const f = parse(file, plat);
  let target: string[] | null;
  if (f.drive !== null || f.rooted) {
    if (plat === 'win32' && (f.drive ?? root.drive) !== root.drive) return false;
    target = collapse(f.parts);
  } else {
    target = collapse([...rootParts, ...f.parts]);
  }
  if (target === null) return false;
  const eq = (a: string, b: string): boolean => (plat === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (target.length < rootParts.length || !rootParts.every((s, i) => eq(s, target[i]!))) return false;
  return !target.slice(rootParts.length).some((s) => badSegment(s, plat));
}

export interface ToastCtx {
  /** The session's worktree, or its folder when it has none. */
  worktree: string;
  platform: D20Platform;
}

/** The buttons a toast may carry for this held request. Approve only when D20 holds and the input was not cut (D21). */
export function toastActions(p: Pick<Pending, 'kind' | 'held' | 'toolName' | 'inputSummary' | 'inputTruncated'> | undefined, ctx: ToastCtx): ('approve' | 'deny' | 'open')[] {
  if (p === undefined || p.kind !== 'permission' || !p.held) return ['open'];
  const approve = !p.inputTruncated && isToastApprovablePath(p.toolName, p.inputSummary, ctx.worktree, ctx.platform);
  return approve ? ['approve', 'deny', 'open'] : ['deny', 'open'];
}
