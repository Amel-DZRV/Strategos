// Wire protocol between daemon and UI. Source: docs/strategos-implementation-plan.md §5.
import type {
  AllowedSlash, ChatItem, DigestData, GuardRule, Initiative, PlanetInfo, ReviewData, RiskClass, SessionRecord,
  UiPrefs, Usage,
} from './types.ts';

export const PROTOCOL = 1;

export type DaemonEvent =
  | { t: 'hello'; protocol: 1; daemonVersion: string; claudeVersion: string; testedRange: string; inRange: boolean }
  | { t: 'snapshot'; seq: number; sessions: SessionRecord[]; planets: PlanetInfo[]; initiatives: Initiative[]; usage?: Usage; prefs: UiPrefs; repos?: string[] }
  | { t: 'session.upsert'; seq: number; session: SessionRecord }
  | { t: 'session.removed'; seq: number; strategosId: string }
  | { t: 'planets'; seq: number; planets: PlanetInfo[] }
  | { t: 'initiatives'; seq: number; initiatives: Initiative[] }
  | { t: 'usage'; seq: number; usage: Usage }
  | { t: 'resources'; seq: number; totalMb: number; cpuPct: number }
  | { t: 'notify'; seq: number; kind: 'permission' | 'question' | 'errored' | 'done' | 'escalate'; strategosId: string; title: string; body: string; risk?: RiskClass[]; requestId?: string }
  | { t: 'suggestion'; seq: number; id: string; kind: 'initiative' | 'park'; text: string; strategosIds: string[] }
  | { t: 'pty.data'; strategosId: string; data: string }
  | { t: 'pty.replay'; strategosId: string; data: string }
  | { t: 'chat.items'; strategosId: string; from: number; items: ChatItem[]; reset: boolean }
  | { t: 'review'; strategosId: string; review: ReviewData }
  | { t: 'digest'; since: number; digest: DigestData }
  /** M6: answer to `worktree.exclude`: is `.claude/worktrees/` in the repo's .git/info/exclude? Channel event: the asking connection only. */
  | { t: 'worktree.exclude'; repoPath: string; excluded: boolean }
  /** M6 (R14): `gh` is missing or not logged in. Broadcast when it changes; also `prefs.ghNeedsLogin` in the snapshot. */
  | { t: 'gh.status'; seq: number; needsLogin: boolean; message?: string }
  /** Answer to `pending.full` (D21): the whole tool input of a held request. Channel event: goes to the asking connection only. */
  | { t: 'pending.full'; strategosId: string; requestId: string; event: 'PermissionRequest' | 'PreToolUse'; toolName: string; input: Record<string, unknown> }
  | { t: 'ack'; id: string; ok: boolean; error?: string };

export type UiCommand = { id: string } & (
  | { c: 'session.start'; repoPath: string; worktree?: { name: string; branch: string; base: string; addExclude?: boolean }; firstPrompt?: string; name?: string; initiativeId?: string; model?: string; permissionMode?: string }
  | { c: 'session.stop' | 'session.park' | 'session.resume' | 'session.forget' | 'session.seen'; strategosId: string }
  | { c: 'session.archive'; strategosId: string; on: boolean }
  | { c: 'session.resumeAll' }
  | { c: 'resync' }
  | { c: 'pty.subscribe'; strategosId: string; cols: number; rows: number }
  | { c: 'pty.unsubscribe'; strategosId: string }
  | { c: 'pty.input'; strategosId: string; data: string }
  | { c: 'pty.resize'; strategosId: string; cols: number; rows: number }
  | { c: 'pty.focus'; strategosId: string } // triggers auto-release (D13)
  | { c: 'perm.decide'; strategosId: string; requestId: string; decision: 'allow' | 'deny' | 'always'; message?: string; suggestionIndex?: number; via?: string } // via: audit label, default 'drawer'
  | { c: 'perm.release'; strategosId: string; requestId: string }
  | { c: 'pending.full'; strategosId: string; requestId: string } // D21: answered with a `pending.full` event
  /** Approve what D20 allows. initiativeId '*' = every session (until initiatives exist). requestIds: only these (the list the person confirmed). */
  | { c: 'perm.approveLowRisk'; initiativeId: string; requestIds?: string[] }
  /** The UI tells the daemon which session it is showing (null: none), so no notification is raised for it. Per connection. */
  | { c: 'view.focus'; strategosId: string | null }
  | { c: 'question.answer'; strategosId: string; requestId: string; answers: Record<string, string>; via?: string }
  | { c: 'reply.send'; strategosId: string; text: string }
  | { c: 'slash.send'; strategosId: string; cmd: AllowedSlash }
  | { c: 'chat.subscribe'; strategosId: string; from: number }
  | { c: 'review.get'; strategosId: string }
  | { c: 'review.sendBack'; strategosId: string; text: string }
  | { c: 'pr.create'; strategosId: string; title: string; body: string; draft: boolean }
  | { c: 'worktree.remove'; strategosId: string; deleteBranch: boolean; confirmText?: string }
  /** add=false: report whether `.claude/worktrees/` is excluded in this repo (answered with a `worktree.exclude` event); add=true: add it (only after the person agreed). */
  | { c: 'worktree.exclude'; repoPath: string; add: boolean }
  | { c: 'initiative.upsert'; initiative: Initiative }
  | { c: 'initiative.assign'; strategosId: string; initiativeId: string | null }
  | { c: 'mission.start'; initiativeId: string; sessions: { repoPath: string; branch: string; firstPrompt: string }[] }
  | { c: 'suggestion.respond'; id: string; accept: boolean }
  | { c: 'layout.setPlanetCell'; planetKey: string; col: number; row: number }
  | { c: 'prefs.set'; prefs: Partial<UiPrefs> }
  | { c: 'guards.set'; rules: GuardRule[] }
  | { c: 'digest.get'; since?: number }
  | { c: 'activity'; idleMs: number }
);

export type UiCommandKind = UiCommand['c'];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Events that carry a `seq` (everything the UI must apply in order and can resync on a gap). */
export type SeqEvent = Extract<DaemonEvent, { seq: number }>;

export function isSeqEvent(x: unknown): x is SeqEvent {
  return isRecord(x) && typeof x['t'] === 'string' && typeof x['seq'] === 'number' && Number.isFinite(x['seq']);
}

export function isDaemonEvent(x: unknown): x is DaemonEvent {
  return isRecord(x) && typeof x['t'] === 'string' && DAEMON_EVENT_TYPES.has(x['t']);
}

const DAEMON_EVENT_TYPES: ReadonlySet<string> = new Set([
  'hello', 'snapshot', 'session.upsert', 'session.removed', 'planets', 'initiatives', 'usage', 'resources', 'notify',
  'suggestion', 'pty.data', 'pty.replay', 'chat.items', 'review', 'digest', 'worktree.exclude', 'gh.status', 'pending.full', 'ack',
]);

// ---------------------------------------------------------------------------
// parseUiCommand: hand-written validator, no dependencies
// ---------------------------------------------------------------------------

export type UiCommandError = { error: string; id?: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmpty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isPosInt = (x: unknown): x is number => isInt(x) && x > 0;
const optStr = (x: unknown): boolean => x === undefined || isStr(x);
const SLASH_RE = /^(\/compact|\/handoff-now|\/keepwarm (60m|90m|2h))$/;

export function isAllowedSlash(x: unknown): x is AllowedSlash {
  return isStr(x) && SLASH_RE.test(x);
}

function isStringRecord(x: unknown): x is Record<string, string> {
  return isRecord(x) && Object.values(x).every(isStr);
}

export function isGuardRule(x: unknown): x is GuardRule {
  if (!isRecord(x)) return false;
  if (!isNonEmpty(x['id']) || !isStr(x['description']) || !isNonEmpty(x['tool']) || !isStr(x['pattern']) || !isBool(x['enabled'])) return false;
  if (!optStr(x['field'])) return false;
  try {
    new RegExp(x['pattern'] as string);
  } catch {
    return false;
  }
  return true;
}

export function isInitiative(x: unknown): x is Initiative {
  if (!isRecord(x)) return false;
  if (!isNonEmpty(x['id']) || !isStr(x['name']) || !isStr(x['colour']) || !isNum(x['createdAt']) || !isBool(x['archived'])) return false;
  const cf = x['contractFiles'];
  return Array.isArray(cf) && cf.every((f) => isRecord(f) && isStr(f['planetKey']) && isStr(f['relPath']));
}

type Check = (c: Record<string, unknown>) => string | null;
const need = (field: string, ok: (v: unknown) => boolean, what: string): Check => (c) =>
  ok(c[field]) ? null : `${field} must be ${what}`;
const sid = need('strategosId', isNonEmpty, 'a non-empty string');
const rid = need('requestId', isNonEmpty, 'a non-empty string');
const dims = (c: Record<string, unknown>) =>
  isPosInt(c['cols']) && isPosInt(c['rows']) && (c['cols'] as number) <= 1000 && (c['rows'] as number) <= 1000 ? null : 'cols and rows must be positive integers';
const optional = (field: string, ok: (v: unknown) => boolean, what: string): Check => (c) =>
  c[field] === undefined || ok(c[field]) ? null : `${field} must be ${what} when present`;

const SPECS: Record<UiCommandKind, Check[]> = {
  'session.start': [
    need('repoPath', isNonEmpty, 'a non-empty string'),
    optional('firstPrompt', isStr, 'a string'), optional('name', isStr, 'a string'),
    optional('initiativeId', isStr, 'a string'), optional('model', isStr, 'a string'), optional('permissionMode', isStr, 'a string'),
    optional('worktree', (v) => isRecord(v) && isNonEmpty(v['name']) && isNonEmpty(v['branch']) && isNonEmpty(v['base']), '{name, branch, base}'),
  ],
  'session.stop': [sid], 'session.park': [sid], 'session.resume': [sid], 'session.forget': [sid], 'session.seen': [sid],
  'session.archive': [sid, need('on', isBool, 'a boolean')],
  'session.resumeAll': [],
  'resync': [],
  'pty.subscribe': [sid, dims],
  'pty.unsubscribe': [sid],
  'pty.input': [sid, need('data', isStr, 'a string')],
  'pty.resize': [sid, dims],
  'pty.focus': [sid],
  'perm.decide': [
    sid, rid,
    need('decision', (v) => v === 'allow' || v === 'deny' || v === 'always', "'allow' | 'deny' | 'always'"),
    optional('message', isStr, 'a string'),
    optional('suggestionIndex', (v) => isInt(v) && (v as number) >= 0, 'a non-negative integer'),
    optional('via', isStr, 'a string'),
  ],
  'perm.release': [sid, rid],
  'pending.full': [sid, rid],
  'perm.approveLowRisk': [need('initiativeId', isNonEmpty, 'a non-empty string'), optional('requestIds', (v) => Array.isArray(v) && v.every(isNonEmpty), 'an array of non-empty strings')],
  'view.focus': [need('strategosId', (v) => v === null || isNonEmpty(v), 'a string or null')],
  'question.answer': [sid, rid, need('answers', isStringRecord, 'a string-to-string record'), optional('via', isStr, 'a string')],
  'reply.send': [sid, need('text', isStr, 'a string')],
  'slash.send': [sid, need('cmd', isAllowedSlash, 'one of /compact, /handoff-now, /keepwarm 60m|90m|2h')],
  'chat.subscribe': [sid, need('from', (v) => isInt(v) && (v as number) >= 0, 'a non-negative integer')],
  'review.get': [sid],
  'review.sendBack': [sid, need('text', isStr, 'a string')],
  'pr.create': [sid, need('title', isStr, 'a string'), need('body', isStr, 'a string'), need('draft', isBool, 'a boolean')],
  'worktree.exclude': [need('repoPath', isNonEmpty, 'a non-empty string'), need('add', isBool, 'a boolean')],
  'worktree.remove': [sid, need('deleteBranch', isBool, 'a boolean'), optional('confirmText', isStr, 'a string')],
  'initiative.upsert': [need('initiative', isInitiative, 'a valid Initiative')],
  'initiative.assign': [sid, need('initiativeId', (v) => v === null || isNonEmpty(v), 'a string or null')],
  'mission.start': [
    need('initiativeId', isNonEmpty, 'a non-empty string'),
    need('sessions', (v) => Array.isArray(v) && v.length > 0 && v.every((s) => isRecord(s) && isNonEmpty(s['repoPath']) && isStr(s['branch']) && isStr(s['firstPrompt'])), 'a non-empty array of {repoPath, branch, firstPrompt}'),
  ],
  'suggestion.respond': [need('id', isNonEmpty, 'a non-empty string'), need('accept', isBool, 'a boolean')],
  'layout.setPlanetCell': [need('planetKey', isNonEmpty, 'a non-empty string'), need('col', isInt, 'an integer'), need('row', isInt, 'an integer')],
  'prefs.set': [need('prefs', isRecord, 'an object')],
  'guards.set': [need('rules', (v) => Array.isArray(v) && v.every(isGuardRule), 'an array of valid GuardRules')],
  'digest.get': [optional('since', isNum, 'a number')],
  'activity': [need('idleMs', (v) => isNum(v) && (v as number) >= 0, 'a non-negative number')],
};

/** Validate an untrusted message from a UI socket. Never throws. Returns the same object, typed, or `{ error }`. */
export function parseUiCommand(x: unknown): UiCommand | UiCommandError {
  if (!isRecord(x)) return { error: 'command must be a JSON object' };
  const id = isNonEmpty(x['id']) ? x['id'] : undefined;
  const fail = (error: string): UiCommandError => (id === undefined ? { error } : { error, id });
  if (id === undefined) return fail('id must be a non-empty string');
  const c = x['c'];
  if (!isStr(c) || !Object.hasOwn(SPECS, c)) return fail('unknown command');
  for (const check of SPECS[c as UiCommandKind]) {
    const err = check(x);
    if (err !== null) return fail(`${c}: ${err}`);
  }
  return x as unknown as UiCommand;
}
