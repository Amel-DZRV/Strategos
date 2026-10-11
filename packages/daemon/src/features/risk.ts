// Risk classifier (task 4.03) and the batch-approval gate (decision D20).
//
//   classifyRisk(tool, input, ctx)  -> RiskClass[]  highest first: delete > outside_repo > network > run > write > read
//   isBatchApprovable(tool, input, ctx)             D20, exactly: Read/Edit/Write with a path inside the worktree and nothing else
//   approveLowRisk(...)                             the `perm.approveLowRisk` command: approve what isBatchApprovable allows
//
// Honesty note: a Bash command's risk cannot be classified reliably from its text (that is why D20 never lets the batch
// approve Bash). The Bash half of this file is a conservative TAG for the UI, not a safety proof: it sees through quotes,
// wrappers (sudo, env, bash -c, cmd /c, powershell -Command ...) and the common spellings, and it says `run` for what it
// cannot read. Only `isBatchApprovable` makes a decision, and it never looks at Bash at all.
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { Decision, RiskClass, SessionRecord } from '@strategos/shared';
import type { PendingRegistry, Result } from '../hooks/pending.ts';

export interface RiskCtx {
  /** The session's worktree (or its repository folder when it has none). */
  worktree: string;
  /** `--add-dir` folders: reads and writes there are not `outside_repo` (they are still never batch-approvable). */
  addDirs: string[];
  /** Tests: pretend to be another OS. Default process.platform. */
  platform?: NodeJS.Platform;
  /** Tests: the user's home folder. Default os.homedir(). */
  home?: string;
  /** Tests: resolve symbolic links. Default fs.realpathSync.native on the deepest existing parent, only for the host OS. */
  realpath?: (p: string) => string;
}

const ORDER: readonly RiskClass[] = ['delete', 'outside_repo', 'network', 'run', 'write', 'read'];
const sortRisk = (s: ReadonlySet<RiskClass>): RiskClass[] => ORDER.filter((r) => s.has(r));

type PathApi = typeof nodePath.posix;
const api = (plat: NodeJS.Platform): PathApi => (plat === 'win32' ? nodePath.win32 : nodePath.posix);

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Resolve `p` against `base`, then follow symbolic links of the deepest part that exists. */
function canonical(p: string, base: string, ctx: RiskCtx): string {
  const plat = ctx.platform ?? process.platform;
  const P = api(plat);
  const lexical = P.resolve(base, p);
  const rp = ctx.realpath ?? (plat === process.platform ? (x: string): string => realpathSync.native(x) : undefined);
  if (rp === undefined) return lexical;
  let cur = lexical;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = rp(cur);
      return tail.length === 0 ? real : P.join(real, ...tail.reverse());
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return lexical;
      tail.push(P.basename(cur));
      cur = parent;
    }
  }
  return lexical;
}

/** `p` is `root` or below it. win32 compares case-insensitively (path.win32.relative does). */
function isInside(root: string, p: string, plat: NodeJS.Platform): boolean {
  const P = api(plat);
  const rel = P.relative(root, p);
  return rel === '' || (!P.isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel));
}

function insideAny(p: string, ctx: RiskCtx): boolean {
  const plat = ctx.platform ?? process.platform;
  const roots = [ctx.worktree, ...ctx.addDirs].filter((r) => r !== '');
  return roots.some((r) => isInside(canonical(r, r, ctx), p, plat));
}

function outsideRepo(p: string, ctx: RiskCtx, base: string = ctx.worktree): boolean {
  return !insideAny(canonical(p, base, ctx), ctx);
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

interface Segment {
  words: string[];
  /** The segment redirects output to a file. */
  redirects: string[];
}

/**
 * Split a command line into segments (at ; & | newline and (){} `) and words, removing quotes the way a shell does
 * ("r""m" is the word rm). Backslashes stay, because on Windows they are path separators. Unterminated quotes run to the end.
 */
function tokenise(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let cur = '';
  let has = false;
  let pendingRedirect = false;
  const endWord = (): void => {
    if (!has) return;
    if (pendingRedirect) redirects.push(cur);
    else words.push(cur);
    pendingRedirect = false;
    cur = '';
    has = false;
  };
  const endSeg = (): void => {
    endWord();
    pendingRedirect = false;
    if (words.length > 0 || redirects.length > 0) segs.push({ words, redirects });
    words = [];
    redirects = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd.charAt(i);
    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, i + 1);
      const end = close === -1 ? cmd.length : close;
      cur += cmd.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (ch === '^' && cmd.charAt(i + 1) !== '') { // cmd.exe escape: r^m is rm
      cur += cmd.charAt(i + 1);
      has = true;
      i += 2;
      continue;
    }
    if (ch === '$' && cmd.charAt(i + 1) === '(') { endSeg(); i += 2; continue; }
    if (';&|\n\r(){}`'.includes(ch)) {
      // `2>&1` and `&>` are redirections, not separators
      if (ch === '&' && (cur.endsWith('>') || cmd.charAt(i + 1) === '>')) { cur += ch; has = true; i++; continue; }
      endSeg();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }
    if (ch === '>') {
      // [n]> file, >> file, >| file. A leading fd digit belongs to the operator.
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false; } else endWord();
      i++;
      if (cmd.charAt(i) === '>' || cmd.charAt(i) === '|') i++;
      if (cmd.charAt(i) === '&') { // 2>&1 : not a file
        i++;
        while (i < cmd.length && /[\w-]/.test(cmd.charAt(i))) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  endSeg();
  return segs;
}

const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'xargs', 'start', 'call',
  'setsid', 'stdbuf', 'chronic', 'then', 'do', 'else', 'if', 'while', 'until', '!', 'wsl', 'busybox',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php']);

const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'rimraf', 'remove-item', 'ri', 'srm', 'trash', 'trash-put']);
const NETWORK_CMDS = new Set([
  'curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'bitsadmin', 'certutil',
  'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'tftp', 'gh', 'aria2c', 'http', 'https', 'httpie',
  'test-netconnection', 'invoke-sqlcmd',
]);
const GIT_NET = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'remote-update', 'send-email']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx']);
const PKG_NET = new Set(['install', 'i', 'add', 'ci', 'publish', 'login', 'adduser', 'update', 'upgrade', 'unpublish', 'deprecate', 'dist-tag', 'view', 'info', 'search', 'audit', 'outdated', 'create', 'dlx', 'x']);

/** Commands whose arguments are text, not files; cmd.exe-style commands whose /x words are switches, not paths. */
const NO_PATH_ARGS = new Set(['echo', 'printf', 'write-host', 'write-output', 'cmd']);
const WIN_CMDS = new Set(['del', 'erase', 'rd', 'rmdir', 'dir', 'copy', 'xcopy', 'move', 'md', 'mkdir', 'type', 'attrib', 'robocopy', 'findstr', 'where', 'tasklist', 'taskkill', 'start', 'ren', 'rename']);

const baseName = (w: string, plat: NodeJS.Platform): string => {
  let n = w.replace(/^\\+/, '').replace(/\^/g, '');
  n = api(plat === 'win32' ? 'win32' : 'linux').basename(n.replace(/\\/g, '/'));
  n = n.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  return n;
};

function isAssignment(w: string): boolean {
  return /^[A-Za-z_]\w*\+?=/.test(w);
}

const HOME_VARS = /^(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|\$\{?USERPROFILE\}?|\$env:HOME)(?=$|[\\/])/i;
const CWD_VARS = /^(?:\$PWD|\$\{PWD\}|%CD%|\$\(pwd\)|\.)(?=$|[\\/])/i;

function pathLikeOutside(word: string, ctx: RiskCtx): boolean {
  const plat = ctx.platform ?? process.platform;
  let w = word;
  const eq = w.match(/^--?[\w-]+=(.+)$/s); // --output=/etc/x
  if (eq?.[1] !== undefined) w = eq[1];
  else if (w.startsWith('-')) return false;
  if (w === '' || w.includes('://') || /^[\w.+-]+@[\w.-]+:/.test(w)) return false; // URLs and git@host:repo are `network`, not paths
  if (/^(?:\/dev\/(?:null|stdin|stdout|stderr|tty)|nul|con)$/i.test(w)) return false;
  const home = ctx.home ?? os.homedir();
  if (HOME_VARS.test(w)) {
    const rest = w.replace(HOME_VARS, '');
    return outsideRepo(api(plat).join(home, rest), ctx);
  }
  if (CWD_VARS.test(w)) return outsideRepo(w.replace(CWD_VARS, '.'), ctx);
  if (/^(?:\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%|\$env:\w+)[\\/]/.test(w)) return true; // some other variable as a base: unknown, so outside
  if (plat === 'win32') {
    if (/^\/[A-Za-z?]{1,2}$/.test(w)) return false; // cmd switches: /s /q /c /?
    const msys = w.match(/^\/([A-Za-z])(?:\/(.*))?$/s);
    if (msys?.[1] !== undefined) w = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`;
  }
  const absolute = api(plat).isAbsolute(w) || /^[\\/]/.test(w) || /^[A-Za-z]:/.test(w);
  if (absolute) return outsideRepo(w, ctx);
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(w)) return outsideRepo(w, ctx);
  return false;
}

function gitSub(words: string[]): { sub: string; rest: string[] } | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? '';
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return { sub: w.toLowerCase(), rest: words.slice(i + 1) };
  }
  return undefined;
}

function analyseSegment(seg: Segment, ctx: RiskCtx, into: Set<RiskClass>, depth: number): void {
  const plat = ctx.platform ?? process.platform;
  let words = seg.words;
  // leading VAR=value, then wrappers
  for (let guard = 0; guard < 12 && words.length > 0; guard++) {
    const w = words[0] ?? '';
    if (isAssignment(w)) { words = words.slice(1); continue; }
    const n = baseName(w, plat);
    if (WRAPPERS.has(n)) {
      let k = 1;
      while (k < words.length) {
        const a = words[k] ?? '';
        if (a.startsWith('-') || /^\d+[smhd]?$/.test(a) || isAssignment(a)) k++;
        else break;
      }
      words = words.slice(k);
      continue;
    }
    break;
  }
  const first = words[0];
  if (first === undefined) { for (const r of seg.redirects) noteRedirect(r, ctx, into); return; }
  const cmd = baseName(first, plat);
  const args = words.slice(1);
  const lowerArgs = args.map((a) => a.toLowerCase());

  if (SHELLS.has(cmd) || cmd === 'eval') {
    // run the quoted string as a command line of its own
    const idx = cmd === 'eval' ? 0 : lowerArgs.findIndex((a) => ['/c', '/k', '-command'].includes(a) || /^-[a-z]*c$/.test(a));
    if (cmd === 'eval') {
      if (depth < 3) classifyBashInto(args.join(' '), ctx, into, depth + 1);
    } else if (idx >= 0 && depth < 3) {
      classifyBashInto(args.slice(idx + 1).join(' '), ctx, into, depth + 1);
    } else if (lowerArgs.some((a) => a.startsWith('-enc'))) {
      // -EncodedCommand: unreadable, stays `run`
    }
  }
  if (INTERPRETERS.has(cmd)) {
    const script = args.join(' ');
    if (/\b(?:urllib|requests\.|http\.client|socket|fetch\s*\(|axios|XMLHttpRequest|Invoke-WebRequest|curl|wget)\b|https?:\/\//i.test(script)) into.add('network');
    if (/\b(?:rmtree|os\.remove|os\.unlink|unlinkSync|rmSync|fs\.rm|rimraf|Remove-Item|shutil\.move)\b|\brm\s+-/i.test(script)) into.add('delete');
  }

  if (DELETE_CMDS.has(cmd)) into.add('delete');
  if (NETWORK_CMDS.has(cmd)) into.add('network');
  if (cmd === 'docker' || cmd === 'podman' || cmd === 'kubectl') {
    const sub = lowerArgs.find((a) => !a.startsWith('-'));
    if (sub !== undefined && ['pull', 'push', 'login', 'run', 'build', 'apply', 'exec', 'cp'].includes(sub)) into.add('network');
    if (sub !== undefined && ['rm', 'rmi', 'prune', 'delete', 'kill'].includes(sub)) into.add('delete');
    if (lowerArgs.includes('prune')) into.add('delete');
  }
  if (PKG.has(cmd)) {
    const sub = lowerArgs.find((a) => !a.startsWith('-'));
    if (cmd === 'npx' || cmd === 'pnpx' || (sub !== undefined && PKG_NET.has(sub))) into.add('network');
    if (sub === 'uninstall' || sub === 'remove' || sub === 'rm' || sub === 'prune') into.add('delete');
  }
  if (['pip', 'pip3', 'pipx', 'cargo', 'go', 'gem', 'composer', 'nuget', 'dotnet', 'brew', 'apt', 'apt-get', 'winget', 'choco', 'scoop'].includes(cmd)) {
    const sub = lowerArgs.find((a) => !a.startsWith('-'));
    if (sub !== undefined && ['install', 'download', 'add', 'publish', 'get', 'fetch', 'update', 'upgrade', 'restore', 'push', 'login'].includes(sub)) into.add('network');
    if (sub === 'uninstall' || sub === 'remove') into.add('delete');
  }
  if (cmd === 'find' && (lowerArgs.includes('-delete') || lowerArgs.some((a, i) => a === '-exec' && DELETE_CMDS.has(baseName(args[i + 1] ?? '', plat))))) into.add('delete');
  if (cmd === 'git') {
    const g = gitSub(words);
    if (g !== undefined) {
      const rest = g.rest.map((a) => a.toLowerCase());
      if (GIT_NET.has(g.sub)) into.add('network');
      if (g.sub === 'remote' && rest.some((a) => ['update', 'add', 'set-url'].includes(a))) into.add('network');
      if (g.sub === 'clean') into.add('delete');
      if (g.sub === 'reset' && rest.includes('--hard')) into.add('delete');
      if (g.sub === 'branch' && (rest.includes('--delete') || g.rest.includes('-D'))) into.add('delete');
      if (g.sub === 'stash' && rest.some((a) => a === 'drop' || a === 'clear')) into.add('delete');
      if (g.sub === 'push' && (rest.includes('--delete') || rest.includes('-d') || rest.some((a) => a.startsWith(':')))) into.add('delete');
      if ((g.sub === 'checkout' || g.sub === 'restore') && rest.some((a) => a === '.' || a === '--')) into.add('delete'); // throws away uncommitted work
      if (g.sub === 'worktree' && rest.includes('remove')) into.add('delete');
    }
  }
  if (cmd === 'sed' && lowerArgs.some((a) => /^-[a-z]*i/.test(a) && !a.startsWith('--'))) into.add('write');
  if (['tee', 'cp', 'mv', 'move', 'copy', 'xcopy', 'robocopy', 'touch', 'mkdir', 'md', 'ln', 'set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item', 'rename-item', 'chmod', 'chown', 'truncate', 'install'].includes(cmd)) into.add('write');

  // any path-looking argument outside the repository (the command word itself is not an argument)
  if (!NO_PATH_ARGS.has(cmd)) {
    const switches = WIN_CMDS.has(cmd);
    for (const a of args) {
      if (switches && /^\/[A-Za-z?]{1,2}$/.test(a)) continue;
      if (pathLikeOutside(a, ctx)) { into.add('outside_repo'); break; }
    }
  }
  for (const r of seg.redirects) noteRedirect(r, ctx, into);
}

function noteRedirect(target: string, ctx: RiskCtx, into: Set<RiskClass>): void {
  if (/^(?:\/dev\/null|nul|&\d?)$/i.test(target)) return;
  into.add('write');
  if (pathLikeOutside(target, ctx)) into.add('outside_repo');
}

function classifyBashInto(cmd: string, ctx: RiskCtx, into: Set<RiskClass>, depth: number): void {
  for (const seg of tokenise(cmd)) analyseSegment(seg, ctx, into, depth);
}

function classifyBash(command: string, ctx: RiskCtx): RiskClass[] {
  const out = new Set<RiskClass>(['run']);
  try {
    classifyBashInto(command.slice(0, 20_000), ctx, out, 0);
  } catch {
    // an unreadable command stays `run`
  }
  return sortRisk(out);
}

// ---------------------------------------------------------------------------
// classifyRisk
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function classifyRisk(tool: string, input: unknown, ctx: RiskCtx): RiskClass[] {
  const i: Record<string, unknown> = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out = new Set<RiskClass>();
  const pathsOf = (...keys: string[]): string[] => keys.flatMap((k) => { const v = str(i[k]); return v === undefined ? [] : [v]; });
  switch (tool) {
    case 'Bash': case 'PowerShell': case 'BashOutput': case 'KillShell': case 'KillBash':
      return classifyBash(str(i['command']) ?? '', ctx);
    case 'Read': case 'Glob': case 'Grep': case 'LS': case 'NotebookRead': {
      out.add('read');
      const paths = pathsOf('file_path', 'path', 'notebook_path');
      const pat = str(i['pattern']);
      if (tool === 'Glob' && pat !== undefined && /^(?:[\\/]|[A-Za-z]:|~)/.test(pat)) paths.push(pat.replace(/[*?[{].*$/s, '') || pat);
      if (paths.some((p) => outsideRepo(p.replace(/^~(?=[\\/]|$)/, ctx.home ?? os.homedir()), ctx))) out.add('outside_repo');
      return sortRisk(out);
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      out.add('write');
      const paths = pathsOf('file_path', 'notebook_path', 'path');
      if (paths.some((p) => outsideRepo(p.replace(/^~(?=[\\/]|$)/, ctx.home ?? os.homedir()), ctx))) out.add('outside_repo');
      return sortRisk(out);
    }
    case 'WebFetch': case 'WebSearch':
      return ['network'];
    default:
      if (tool.startsWith('mcp__')) return ['network', 'run'];
      return ['run']; // Task/Agent, TodoWrite, anything new: unknown means `run`
  }
}

// ---------------------------------------------------------------------------
// D20: what a batch (or a toast) may approve
// ---------------------------------------------------------------------------

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/** A path segment that D20 refuses: a dotfile or dot folder (.git, .claude, .github, .env ...) or a Windows spelling trick. */
function badSegment(seg: string, plat: NodeJS.Platform): boolean {
  if (seg === '' || seg === '.') return false;
  if (seg.startsWith('.')) return true; // also '..' and every dotfile / dotdir
  if (plat === 'win32') {
    if (/[:*?"<>|]/.test(seg)) return true; // alternate data streams (.git::$INDEX_ALLOCATION), wildcards
    if (/[. ]$/.test(seg)) return true; // Windows drops trailing dots and spaces: ".git." is ".git"
    if (/~\d/.test(seg)) return true; // 8.3 short names: GIT~1
    if (WINDOWS_DEVICE.test(seg)) return true;
  }
  return false;
}

/**
 * D20, exactly: only `Read`, `Edit` and `Write` calls whose file path is inside the session's worktree; never Bash; never a
 * path with a dotfile or dot folder in it (.git/, .claude/, .github/, .env ...). Also never a symbolic link that leads out.
 * The test is made on the full tool input, so the caller must pass the FULL input (D21), never the 400-character summary.
 */
export function isBatchApprovable(tool: string, input: unknown, ctx: RiskCtx): boolean {
  if (tool !== 'Read' && tool !== 'Edit' && tool !== 'Write') return false;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const file = (input as Record<string, unknown>)['file_path'];
  if (typeof file !== 'string' || file === '' || file.length > 1024 || file.includes('\0')) return false;
  if (ctx.worktree === '') return false;
  try {
    const plat = ctx.platform ?? process.platform;
    const P = api(plat);
    const risk = classifyRisk(tool, input, { ...ctx, addDirs: [] }); // addDirs do not count: the worktree only
    if (risk.length !== 1 || risk[0] !== (tool === 'Write' || tool === 'Edit' ? 'write' : 'read')) return false;
    const root = canonical(ctx.worktree, ctx.worktree, ctx);
    const lexRoot = P.resolve(ctx.worktree);
    const lexical = P.resolve(ctx.worktree, file);
    const real = canonical(file, ctx.worktree, ctx);
    if (!isInside(lexRoot, lexical, plat) || !isInside(root, real, plat)) return false;
    for (const [base, target] of [[lexRoot, lexical], [root, real]] as const) {
      const rel = P.relative(base, target);
      if (rel.split(/[\\/]/).some((s) => badSegment(s, plat))) return false;
    }
    return true;
  } catch {
    return false; // fail closed: anything odd is not batch-approvable
  }
}

// ---------------------------------------------------------------------------
// perm.approveLowRisk
// ---------------------------------------------------------------------------

export interface LowRiskDeps {
  list(): SessionRecord[];
  registry: Pick<PendingRegistry, 'getFull'>;
  decide(sid: string, requestId: string, d: Decision, meta: { connId?: string; via?: string }): Result;
}

export function riskCtxOf(s: SessionRecord): RiskCtx {
  return { worktree: s.worktree?.path ?? s.cwd, addDirs: s.launch.addDirs };
}

export interface LowRiskResult {
  approved: { sid: string; requestId: string }[];
  /** Held requests that were looked at and left for a human. */
  skipped: number;
}

/**
 * Approve every pending permission request of the sessions of `initiativeId` that D20 allows. `'*'` means every session
 * (initiatives are not implemented yet). A request with a cut summary (D21) is never approved: the full input is tested,
 * and a truncated one is left alone. `only` restricts the batch to the requests the person saw in the confirmation list.
 * The audit line says `via: lowRiskBatch`.
 */
export function approveLowRisk(d: LowRiskDeps, initiativeId: string, o: { connId?: string; only?: readonly string[] } = {}): LowRiskResult {
  const result: LowRiskResult = { approved: [], skipped: 0 };
  for (const s of d.list()) {
    if (initiativeId !== '*' && s.initiativeId !== initiativeId) continue;
    const p = s.pending;
    if (p === undefined || !p.held || p.kind !== 'permission') continue;
    if (o.only !== undefined && !o.only.includes(p.requestId)) continue;
    const full = d.registry.getFull(s.strategosId, p.requestId);
    if (p.inputTruncated || full === undefined || full.event !== 'PermissionRequest' || full.toolName !== p.toolName
      || !isBatchApprovable(p.toolName, full.toolInput, riskCtxOf(s))) {
      result.skipped++;
      continue;
    }
    const r = d.decide(s.strategosId, p.requestId, { kind: 'allow', via: 'lowRiskBatch' }, { ...(o.connId === undefined ? {} : { connId: o.connId }), via: 'lowRiskBatch' });
    if (r.ok) result.approved.push({ sid: s.strategosId, requestId: p.requestId });
    else result.skipped++;
  }
  return result;
}
