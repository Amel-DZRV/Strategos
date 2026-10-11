// Shared data contracts. Source: docs/strategos-implementation-plan.md §5 (+ §4.1, §6).
// No Node or DOM imports allowed in this package.

export type Status =
  | 'starting' | 'trust_pending' | 'working' | 'permission' | 'question' | 'done' | 'seen'
  | 'interrupted' | 'errored' | 'stopped' | 'parked' | 'open_elsewhere';
export type StatusSource = 'hook' | 'pty' | 'transcript' | 'reconciler' | 'user' | 'daemon';
export type RiskClass = 'read' | 'write' | 'run' | 'network' | 'delete' | 'outside_repo';

export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface Pending {
  requestId: string;
  kind: 'permission' | 'question';
  held: boolean; // held=false: answer only in terminal
  toolName: string;
  toolUseId?: string;
  agentId?: string; // asked by a subagent
  inputSummary: string; // <= 400 chars: command, file path or first question
  inputTruncated: boolean; // true -> Approve opens the full card first (D21); full input kept in memory only
  risk: RiskClass[]; // highest first
  suggestions?: unknown[]; // permission_suggestions, passed back verbatim as updatedPermissions
  questions?: PendingQuestion[];
  since: number;
  expiresAt?: number; // daemon auto-release time
}

export interface SubagentInfo {
  agentId: string;
  type?: string;
  running: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface SessionRecord {
  schema: 1;
  strategosId: string;
  name: string;
  displayName: string;
  claudeSessionIds: string[];
  currentSessionId: string;
  transcriptPath?: string;
  transcriptOffset: number;
  repoRoot: string;
  planetKey: string; // canonical(git common dir); repoRoot = its main checkout
  cwd: string;
  branch?: string;
  worktree?: { path: string; branch: string; base: string; createdByStrategos: boolean };
  launch: { model?: string; permissionMode?: string; addDirs: string[]; extraArgs: string[]; firstPrompt?: string };
  status: Status;
  statusSource: StatusSource;
  statusSince: number;
  waitingSince?: number;
  pending?: Pending;
  doneAt?: number;
  seenAt?: number;
  interruptPendingAt?: number;
  now?: { tool: string; summary: string; since: number; agentId?: string };
  last?: string;
  lastIsQuestion?: boolean; // first ~160 chars of last_assistant_message
  initiativeId?: string;
  parentId?: string; // the mission's lead session, if any
  ringSlot: number;
  ringSlotByGroup: Record<string, number>; // sticky; key = planetKey or initiativeId
  ctx?: { pct: number | null; tokens?: number; window?: number; at: number; source: 'statusline' | 'transcript' };
  cost: { lineageUsd: number; byClaudeSession: Record<string, number> };
  model?: string;
  effort?: string;
  permissionMode?: string;
  cache?: { warm: boolean | null; ttl?: '5m' | '1h'; expiresAt?: number; lastCallAt?: number; source: 'statusline' | 'transcript' };
  git?: { branch?: string; ahead?: number; behind?: number; dirty?: boolean; diffStat?: { files: number; add: number; del: number }; at: number };
  pr?: { number: number; url: string; state: 'DRAFT' | 'OPEN' | 'MERGED' | 'CLOSED'; review?: string; ci: 'pass' | 'fail' | 'pending' | 'none'; at: number };
  resource?: { pid: number; procStart: string; treeWorkingSetMb: number; treePrivateMb: number; cpuPct: number; at: number };
  flags: {
    stuck?: { reason: 'repeat' | 'failures' | 'ctx_no_progress' | 'quiet'; since: number };
    conflicts: { file: string; other: string; at: number }[];
    contractChanged: string[];
    guardDenials: number;
    /** M8 (8.06, V14): a stopped session whose transcript was last written about 28 days ago or more (Claude keeps transcripts 30 days by default): resume may say 'No conversation found'. */
    mayNotResume?: boolean;
    lastTest?: { command: string; ok: boolean | null; at: number };
  };
  subagents: SubagentInfo[];
  pty?: { pid: number; cols: number; rows: number; dirtyInput: boolean };
  exitCode?: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  lastHookAt?: number; // last hook event: drives the 10 s quiet gate (rule 2) and drift (rule 7)
  driftLoggedAt?: number; // last drift log, so a lasting disagreement is logged once per 5 min
  /** M8 (8.04): the session had a Claude process when the daemon last stopped (clean or not): 'Resume all' brings it back. Set at daemon.restart, cleared on resume or an explicit stop. */
  wasLiveAtStop?: boolean;
  archived: boolean;
  view: 'term' | 'chat' | 'review';
}

export interface Initiative {
  id: string;
  name: string;
  colour: string;
  createdAt: number;
  contractFiles: { planetKey: string; relPath: string }[];
  archived: boolean;
}

/** Rate-limit readings. `resetsAt` is epoch MILLISECONDS (Claude sends seconds; the status-line ingest converts). */
export interface Usage {
  fiveHour?: { pct: number; resetsAt: number };
  sevenDay?: { pct: number; resetsAt: number };
  burnPctPerHour?: number;
  etaFull?: number;
  at: number;
}

export interface PlanetInfo {
  planetKey: string;
  label: string;
  colour: string;
  cell: { col: number; row: number };
  pinned: boolean;
  folded: boolean;
}

export type ChatItem =
  | { k: 'user'; id: string; text: string; at: number }
  | { k: 'assistant'; id: string; md: string; at: number }
  | { k: 'tool'; id: string; tool: string; summary: string; result?: string; ok?: boolean; diff?: string; agentId?: string; at?: number }
  | { k: 'subagent'; id: string; agentId: string; brief: string; items: ChatItem[] }
  | { k: 'compact'; id: string; at: number }
  | { k: 'interrupted'; id: string; at: number }
  /** Where the conversation changed identity: /clear, resume, fork ('unknown': the transcripts changed and no marker was recorded, e.g. after a daemon restart). */
  | { k: 'marker'; id: string; marker: 'clear' | 'resume' | 'fork' | 'unknown'; at: number };

// ---------------------------------------------------------------------------
// Types §5 references but does not spell out (design choices, see task 1.02 report)
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  onPermission: boolean;
  onQuestion: boolean;
  onErrored: boolean;
  onDone: boolean;
  escalate: boolean; // reminders at 5 and 15 min
}

export interface UiPrefs {
  groupBy: 'repo' | 'initiative';
  reducedMotion?: boolean; // undefined = follow the OS setting
  notifications: NotificationPrefs;
  keymap: Record<string, string>; // action id -> key chord override
  /** Set by the daemon in the snapshot only (never persisted): the installed Claude Code is outside the tested range (task 1.16). */
  claudeVersionOutOfRange?: boolean;
  /** Set by the daemon in the snapshot only (M6, R14): `gh` is missing or not logged in. */
  ghNeedsLogin?: boolean;
  /** M8 (8.03): publish a 'while you were away' digest when the person comes back after more than 10 minutes. Default on; false opts out. */
  awayDigest?: boolean;
  /** Set by the daemon in the snapshot only (M8, 8.04): a Startup entry for the daemon exists. */
  autostart?: boolean;
  /** Set by the daemon in the snapshot only (M8, 8.04): the daemon knows the command that would start it (autostart.set {on:true} can work). */
  autostartAvailable?: boolean;
  /** Set by the daemon in the snapshot only: state.json was corrupt and was restored or started empty. */
  stateBanner?: string;
  /** Set by the daemon in the snapshot only (task 5.05): owner mods found read-only in the Claude config dir. */
  mods?: { autoHandoff: boolean };
}

export interface GuardRule {
  id: string;
  description: string;
  tool: string; // tool name or '*'
  pattern: string; // regex source
  field?: string; // key inside tool_input to test; absent = JSON of the whole input
  enabled: boolean;
}

export interface ReviewFile {
  path: string;
  add: number;
  del: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'other';
}
export interface ReviewData {
  files: ReviewFile[];
  diff: string;
  base: string;
  head: string;
  stat: { files: number; add: number; del: number };
}

/** One session in the digest. The fields after finalStatus are additive (M8, 8.03) and always present from an M8 daemon. */
export interface DigestSession {
  strategosId: string;
  displayName: string;
  planetKey: string;
  summary?: string;
  /** Turns that finished in the window (status -> done). */
  turns: number;
  /** Cost added in the window, list-price estimate (lineage: survives /clear and resume). */
  costUsd: number;
  decisions: { allowed: number; denied: number };
  prs: { number: number; url: string }[];
  finalStatus: Status;
  initiativeId?: string;
  /** Needs-you time in the window (permission, question, errored, trust, interrupted AND done-unseen), as in 'waiting today'. */
  waitingMs?: number;
  /** The part of waitingMs where work was blocked (everything except done). */
  blockedMs?: number;
  /** Guard denials (auto-denied tool calls) in the window. */
  guardDenials?: number;
  errors?: number;
}

export interface DigestBlocked {
  strategosId: string;
  displayName: string;
  /** What it waited on: permission, question, errored, trust_pending or interrupted. */
  status: string;
  from: number;
  /** Absent while still blocked. */
  to?: number;
  /** Clipped to the window. */
  ms: number;
}

/** Sessions of one initiative (initiativeId null: not in one). Present only for groups that have a session in the digest. */
export interface DigestGroup {
  initiativeId: string | null;
  name: string;
  colour?: string;
  strategosIds: string[];
  costUsd: number;
  finished: number;
  blockedMs: number;
  errors: number;
  guardDenials: number;
}

export interface DigestData {
  since: number;
  until: number;
  sessions: DigestSession[];
  totals: {
    costUsd: number;
    waitingMs: number;
    decisions: number;
    guardDenials: number;
    /** Additive (M8): */
    blockedMs?: number;
    errors?: number;
    prs?: number;
    finished?: number;
  };
  /** Additive (M8, 8.03): sessions whose turn finished in the window, newest first. */
  finished?: { strategosId: string; displayName: string; at: number; turns: number }[];
  /** Blocked intervals that overlap the window (open ones included), longest first. */
  blocked?: DigestBlocked[];
  errors?: { strategosId: string; displayName: string; at: number; message: string }[];
  /** Pull requests that appeared for a session in the window. */
  prsOpened?: { strategosId: string; displayName: string; number: number; url: string; at: number }[];
  /** Grouped by initiative, the order the UI should list them in. */
  groups?: DigestGroup[];
}

export interface PrCreate { cwd: string; title: string; body: string; draft: boolean; base?: string; head?: string }
export interface PrInfo {
  number: number;
  url: string;
  state: 'DRAFT' | 'OPEN' | 'MERGED' | 'CLOSED';
  review?: string;
  ci: 'pass' | 'fail' | 'pending' | 'none';
}

export interface GitStatus {
  branch?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  diffStat?: { files: number; add: number; del: number };
}
export interface DiffData { base: string; head: string; files: ReviewFile[]; diff: string; truncated: boolean }

export interface StartOptions {
  repoPath: string;
  worktree?: { name: string; branch: string; base: string };
  firstPrompt?: string;
  name?: string;
  initiativeId?: string;
  parentId?: string;
  model?: string;
  permissionMode?: string;
  addDirs?: string[];
  extraArgs?: string[];
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'not_live' | 'dirty_input' | 'busy' | 'not_allowed' | 'pty_error'; message?: string };

export type AllowedSlash = '/compact' | '/handoff-now' | `/keepwarm ${'60m' | '90m' | '2h'}`;

export interface UiNotification {
  kind: 'permission' | 'question' | 'errored' | 'done' | 'escalate';
  strategosId: string;
  title: string;
  body: string;
  risk?: RiskClass[];
  requestId?: string;
  actions?: ('approve' | 'deny' | 'open')[];
}

export interface ProcSample {
  pid: number;
  ppid: number;
  workingSetMb: number;
  privateMb: number;
  cpuPct: number;
  startTime?: string;
}

// ---------------------------------------------------------------------------
// State machine vocabulary (§6): reduce(s, e, now) -> { next, effects }
// ---------------------------------------------------------------------------

/** What the user decided on a pending request. */
export type Decision =
  | { kind: 'allow'; via?: string }
  | { kind: 'deny'; message?: string; via?: string }
  | { kind: 'always'; suggestionIndex?: number; via?: string }
  | { kind: 'answers'; answers: Record<string, string>; via?: string };

/** One reconciler reading about one session (sessions/<pid>.json or `claude agents --json`). */
export interface Observation {
  strategosId?: string; // set when the reconciler could map it to one of our records
  claudeSessionId: string;
  pid: number;
  procStart?: string;
  alive: boolean;
  ownedByUs: boolean; // pid equals our pty's pid
  status?: 'busy' | 'idle' | 'waiting';
  waitingFor?: string; // e.g. "permission prompt", "dialog open"
  statusUpdatedAt?: number;
  parkedJobId?: string; // sessions/<pid>.json of our pty names a background job: Agent View moved the conversation (S18)
  source: 'sessions_dir' | 'agents_cli';
}

type HookBase = {
  claudeSessionId?: string;
  agentId?: string; // present => event came from a subagent (rule 3)
  agentType?: string;
  cwd?: string;
  permissionMode?: string;
  effort?: string;
  transcriptPath?: string;
  model?: string;
};

/** Hook events after the receiver has normalised them (summaries, risk, request ids). */
export type HookMachineInput = HookBase & (
  | { event: 'SessionStart'; source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | (string & {}) }
  | { event: 'SessionEnd'; reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | (string & {}) }
  | { event: 'UserPromptSubmit' }
  | { event: 'PreToolUse'; tool: string; toolUseId?: string; summary: string; pending?: Pending } // pending set for AskUserQuestion (held)
  | { event: 'PostToolUse'; tool: string; toolUseId?: string; summary?: string; testResult?: { command: string; ok: boolean | null } }
  | { event: 'PostToolUseFailure'; tool: string; toolUseId?: string; summary?: string; isInterrupt: boolean; error?: string; testResult?: { command: string; ok: boolean | null } }
  | { event: 'PermissionRequest'; pending: Pending }
  | { event: 'Notification'; notificationType?: string; message?: string; pending?: Pending } // pending for elicitation_dialog (held:false)
  | { event: 'Stop'; lastMessage?: string }
  | { event: 'StopFailure'; error?: string; lastMessage?: string }
  | { event: 'SubagentStart' }
  | { event: 'SubagentStop' }
  | { event: 'PreCompact' }
  | { event: 'PostCompact' }
  | { event: 'CwdChanged'; newCwd?: string }
);

export type UserMachineCommand =
  | { cmd: 'start' | 'resume' }
  | { cmd: 'stop' | 'park' }
  | { cmd: 'seen' } // drawer open >= 1.5 s, `x`, or the Seen button
  | { cmd: 'decide'; requestId: string; decision: Decision }
  | { cmd: 'release'; requestId: string; why: 'terminal-focus' | 'user' | 'expiry' | 'shutdown' };

/** Everything the pure reducer consumes. Time is always passed separately as `now`. */
export type MachineInput =
  | { k: 'hook'; hook: HookMachineInput }
  | { k: 'hold.closed'; requestId: string } // client closed the hook connection: answered in the TUI
  | { k: 'pty.exit'; code: number | null; after?: 'stop' | 'park' } // `after` set by the manager when we asked for the exit
  | { k: 'pty.trust_dialog' } // pty text matched the trust dialog
  | { k: 'pty.key'; key: 'esc' | 'ctrl_c'; fromStrategos: boolean }
  | { k: 'transcript'; signal: 'working' | 'awaiting_reply' | 'interrupt_marker'; lastIsQuestion?: boolean; at?: number }
  | { k: 'reconciler'; obs: Observation }
  | { k: 'statusline'; ctx?: SessionRecord['ctx']; cost?: { claudeSessionId: string; usd: number }; model?: string; cache?: SessionRecord['cache'] }
  | { k: 'user'; u: UserMachineCommand }
  | { k: 'daemon.restart' } // every non-live record becomes stopped
  | { k: 'guard.denied' } // an auto-deny guard denied a tool call of this session: flags.guardDenials += 1
  | { k: 'tick' }; // time-based rules: interruptPending 10 s, pending expiry, hook-quiet inference window

export type Effect =
  | { e: 'hook.respond'; requestId: string; response: 'allow' | 'deny' | 'always' | 'answers' | 'no_decision'; decision?: Decision } // release the held HTTP request
  | { e: 'spawn'; resume: boolean }
  | { e: 'pty.kill'; park?: boolean }
  | { e: 'notify'; kind: UiNotification['kind']; title: string; body: string; requestId?: string }
  | { e: 'audit'; requestId: string; decision: 'allow' | 'deny' | 'always' | 'answer' | 'release'; via: string }
  | { e: 'chat.marker'; marker: 'clear' | 'compact' | 'resume' | 'fork' | 'interrupted' }
  | { e: 'transcript.follow'; path: string; offset: number }
  | { e: 'log'; type: 'status' | 'drift' | 'error'; data: Record<string, unknown> } // every transition is appended with its source (rule 7)
  | { e: 'persist' };

/** The fixed text of the review pane's "Ask to commit" button (the UI sends it with `reply.send`). */
export const ASK_TO_COMMIT_TEXT = 'Please commit your changes now with a clear commit message, then tell me the branch name and the commit hash.';
