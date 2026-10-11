# Strategos: implementation plan

Status: plan, 11 Oct 2026. Written by the Opus advisor pass. Nothing has been built or installed.
Inputs: `strategos-technical-writeup.md` (the write-up), `bot-crossing-review.md` (the review), `strategos-looks.html` look B (the prototype), `Strategos_PRODUCT.md` (the product doc), the session-tracker and auto-handoff READMEs, the official Claude Code docs, and the Bot Crossing source read as data.

**Claim tags.** **[docs]** read in official docs on 11 Oct 2026 (URL in §2 or §14). **[code]** read in source code (Bot Crossing or node-pty typings). **[ran]** ran on this machine today. **[inf]** my inference, not yet shown. Anything marked [inf] that matters has a spike check (S1–S18).

**Words used throughout.**
- **Daemon:** `strategosd`, a background Node program that owns the sessions.
- **pty:** a pseudo-terminal, the thing a terminal program believes is a real terminal window. On Windows it is ConPTY.
- **Hook:** a callback Claude Code makes at a lifecycle point, here as an HTTP POST to the daemon.
- **Held hook:** the daemon keeps that HTTP request open until you decide.
- **Transcript:** the session's `.jsonl` file under `~/.claude/projects`.
- **Planet:** a repo on the Map. **Token:** a session on a planet's ring.
- **hd:** half a working day. Every task is sized in hd.

## Contents
1. What we are building
2. Verification pass
3. Decisions
4. Repository layout and module boundaries
5. Data contracts
6. Status state machine
7. The Map
8. Milestones, tasks, first 10 days, traceability, effort
9. Test strategy
10. Security and safety
11. Parallel work plan
12. Risk register
13. Open questions and the "start tomorrow" checklist
14. Appendix: Bot Crossing port list; docs pages used

---

## 1. What we are building

1. Strategos is a Windows desktop tool that replaces the Claude window for your own Claude Code work.
2. It starts every session itself: an ordinary interactive `claude` in a pty owned by a background daemon. Closing the window does not stop the sessions.
3. Only sessions started from Strategos appear. Nothing is read from the desktop app's store.
4. The main screen is the Map (look B). Repos are planets. Sessions are tokens on sticky ring slots. A "Needs you" strip runs across the top.
5. Each token shows status (glyph and colour), context fill (arc), cost, waiting time, risk, git/PR/CI, and warnings.
6. Clicking a token opens a drawer with three tabs. **Terminal** is the real Claude Code TUI in xterm.js. **Chat** is the same live session drawn as cards. **Review** shows the diff and the PR.
7. You can approve or deny permissions, answer questions, reply, start, stop, park and resume sessions, create worktrees, review diffs and open draft PRs, by mouse or keyboard.
8. Hooks and a status-line tap are injected per process with `--settings`. Strategos never edits `~/.claude`.
9. v1 runs as a browser app window (Edge `--app`). From M7 it runs in an Electron shell with a tray icon, native toasts and a global hotkey. The shell is swappable.
10. Windows 10 first. The macOS port (M9) only touches the platform module and packaging.

**Not in v1:**
- Sessions not started by Strategos ("external squads" in the product doc).
- Desktop-app sessions, and Codex or any other harness.
- Phone or LAN access, or any remote port.
- Voice lines and sound, beyond one optional attention chime.
- Procedural planet textures (`strategos-planets.js`). v1 uses SVG gradients.
- Zoom levels, minimap and control groups.
- Headless chat sessions (stream-json), and resume-switching between modes.
- Option E (the first-party supervisor) as the host. It is evaluated in the spike only.
- Tauri or a native shell.
- Automatic grouping by initiative, which is never auto-guessed.
- Any automatic action that spends tokens or approves something without your click. The one exception is the auto-deny guards, which only deny.

---

## 2. Verification pass

I checked every claim the earlier documents marked assumed, recalled or inferred against the docs and this machine. Contradictions and corrections come first.

| # | Claim (where) | Status | Source | Effect on plan |
|---|---|---|---|---|
| C1 | AskUserQuestion is answered by allowing a **PermissionRequest** with `updatedInput` (write-up S9) | **Contradicted.** The docs answer it through **PreToolUse**: return `allow` plus `updatedInput` that echoes `questions` and adds `answers`. "Returning `allow` alone is not sufficient" | [hooks](https://code.claude.com/docs/en/hooks) | Hold the PreToolUse hook (matcher `AskUserQuestion`) instead. S9 is rewritten |
| C2 | The cache TTL can't be read; infer it from the transcript (write-up S16; auto-handoff README) | **Contradicted.** The status-line JSON has `prompt_cache.warm`, `ttl` ("5m"/"1h"), `expires_at` and `recache_tokens_if_cold` (v2.1.251+) | [statusline](https://code.claude.com/docs/en/statusline) | The cache indicator reads the status line. The transcript `ephemeral_1h/5m_input_tokens` [ran] is the fallback |
| C3 | A session's cost is one cumulative number (write-up §4.1) | **Corrected.** `cost.total_cost_usd` "Resets to $0 when `/clear` starts a new session" | statusline | Store cost per Claude session id and sum over the lineage |
| C4 | `effort` is a string hook field (write-up §4.1) | **Corrected.** It is an object `{level}`, present only in tool-use-context events | hooks | Type is `effort?: {level: string}` |
| C5 | "Interactive sessions appear in `claude agents --json`" (write-up §9) | **Docs contradict each other.** One section says the JSON covers "every live session" (`kind` = interactive/background); Agent View says interactive sessions "don't appear until you background them". The write-up saw them locally | [agent-view](https://code.claude.com/docs/en/agent-view) | The reconciler must not depend on it. Primary source is `~/.claude/sessions/<pid>.json` (has `status`, `statusUpdatedAt` [ran]). Re-check in S13 |
| V1 | `Stop` does not fire on a user interrupt (review gap 2) | **Confirmed.** "Does not run if the stoppage occurred due to a user interrupt." Cancelling a tool fires no PostToolUseFailure; `PostToolUseFailure.is_interrupt` exists for aborts | hooks | `interrupted` state, fed by pty keystrokes plus transcript markers (§6) |
| V2 | Transcripts mark interrupts | **Confirmed locally.** `[Request interrupted by user]` (3×) and `[Request interrupted by user for tool use]` (5×) | [ran] grep of `~/.claude/projects` | Transcript confirmation of `interrupted` |
| V3 | `/clear` starts a new session id (review gap 1) | **Confirmed in substance.** `/clear` saves the previous session; SessionEnd `reason: clear` and SessionStart `source: clear` exist; cost resets "when `/clear` starts a new session". The new id value is still to be watched | [sessions](https://code.claude.com/docs/en/sessions), hooks, statusline | Lineage (`claudeSessionIds[]`). Your auto-handoff mod runs `/clear`, so this happens routinely. S11 |
| V4 | In-TUI `/resume` and `/branch` switch the process to another session | **Confirmed.** SessionEnd `reason: resume`; `/branch` "switches the running Claude Code process to write to" a copy with its own id; SessionStart has `source: fork` | sessions, hooks | Lineage handles both. Two records on one Claude id → `open_elsewhere` |
| V5 | PostToolUse can return added context to the model | **Confirmed.** `hookSpecificOutput.additionalContext`, placed "next to the tool result". Subagent tool calls fire the same hooks. `agent_id` identifies the subagent | hooks | Conflict notes to Claude are feasible. S17 checks delivery |
| V6 | PermissionRequest hold: does the TUI dialog show while it is held, and is there a maximum timeout? | **Unknown.** Docs give default timeouts (600 s for http) and no maximum. Notification `permission_prompt` fires after "about six seconds" of waiting in terminal sessions | hooks | S2 settles it. The daemon always releases with "no decision" before its own configured timeout |
| V7 | http hook header auth | **Confirmed.** `headers` support `$VAR` interpolation for variables listed in `allowedEnvVars`. Non-2xx and connection failure are "non-blocking" | hooks | Per-session token in a child env var, sent as a header. The settings file holds no secret |
| V8 | `statusLine` can come from `--settings` | **Confirmed in docs, not yet run.** `--settings` "can set any key your user settings file can set" and sits above project and user files | [settings](https://code.claude.com/docs/en/settings) | The injected tap overrides your status line, so it must chain (S5) |
| V9 | Status line on Windows | **New.** Runs through Git Bash when installed, else PowerShell. Backslashes are eaten, so paths need forward slashes. 300 ms debounce; a new trigger cancels an in-flight run | statusline | Tap command uses forward slashes and must finish in under 300 ms |
| V10 | Hooks and status line wait for workspace trust | **Confirmed.** Hooks "from every settings file" and the status line are held back until trust is accepted (interactive). Trust can extend from a parent directory | hooks, statusline | `trust_pending` state. S10 tests worktrees inside the repo (trust may extend) and outside it |
| V11 | Edits to the `--settings` file reach a running session | **Not covered.** The reload covers "user, project, local, and managed" files only | settings | Treat `run/<id>.settings.json` as fixed for the process's life. The daemon **port must be stable** across restarts |
| V12 | Agent View can pull a session out of its terminal | **New risk.** `←` on an empty prompt, or `/bg`, moves the conversation to a background process; "the original terminal is freed". `disableAgentView` / `CLAUDE_CODE_DISABLE_AGENT_VIEW` turn it off | agent-view | Inject `"disableAgentView": true` by default. New check S18 |
| V13 | `--resume <id>` keeps the id; `--settings` survives resume | **Partly confirmed.** `--fork-session` creates a new id (so plain resume keeps it). `--settings`, `--plugin-dir` and `--add-dir` are **not** restored: "pass them again" | [cli-reference](https://code.claude.com/docs/en/cli-reference), sessions | The resume path regenerates the settings file and re-passes every launch flag. S14 |
| V14 | Transcripts are kept indefinitely | **Contradicted.** 30-day retention by default (`cleanupPeriodDays`). The entry format "is internal… changes between versions" | sessions | Retention rule: a stopped session older than about 28 days shows "may not be resumable". Contract tests per version (§9) |
| V15 | Windows toast actions | **Confirmed for Electron.** `actions` and the `'action'` event are listed for macOS **and Windows**; `Notification.handleActivation` covers cold start. Unknown for browser notifications from the 127.0.0.1 page | [electron](https://www.electronjs.org/docs/latest/api/notification) | Toast buttons in M7. The browser phase uses click-to-open (S15) |
| V16 | node-pty bundled `conpty.dll` option | **Confirmed.** `useConptyDll` "(EXPERIMENTAL)". ConPTY is the default on build ≥18309; this machine is 19045 | [code] node-pty 1.1.0 typings; [ran] `ver` | S3 fallback order stands |
| V17 | `--session-id` accepts any id | **Confirmed with a rule:** "must be a valid UUID" | cli-reference | `crypto.randomUUID()` |
| V18 | Finding `claude` on Windows | **Trap confirmed.** `where claude` lists the extensionless sh shim first, then `claude.cmd`; PATHEXT starts `.COM;.EXE;.BAT;.CMD` | [ran] | ClaudeLocator uses PATHEXT and resolves `claude.cmd` to the real `claude.exe` |
| V19 | Daemon can run TypeScript without a build | **Confirmed.** Node 24.21 ran a `.ts` file with types stripped | [ran] | Dev runs `node src/main.ts`; `tsc --noEmit` checks types; esbuild only for packaging |
| V20 | PreToolUse `defer` can park a tool call | **Not usable.** "Only in non-interactive mode with the `-p` flag" | hooks | Not used |
| V21 | `PermissionDenied` hook helps detect user denials | **No.** "Only fires in auto mode" | hooks | Not used |
| V22 | Hook input fields | **Confirmed:** `permission_mode`, `agent_id`, `agent_type`, `transcript_path`, `cwd`. SessionEnd reasons: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`. Notification types include `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input` | hooks | Typed in `shared/hooks.ts` as tolerant (optional) fields |
| V23 | SessionEnd has a short budget | **Confirmed.** 1.5 s by default, raised up to 60 s by a per-hook `timeout` | hooks | SessionEnd hook `timeout: 3`; never relied on alone (pty exit is the backstop) |
| V24 | `CLAUDE_CODE_SIMPLE` is bare mode | **Confirmed** (`--bare` "Sets CLAUDE_CODE_SIMPLE") | cli-reference | The env scrubber must drop it; the write-up saw it inherited from the desktop app |

Still unknown after this pass, so spike-only: hold behaviour and maximum timeout (S2); ConPTY fidelity (S3); whether hooks keep reaching the same URL after `/clear` (S11, [inf] yes, because `--settings` is per process); whether `disableAgentView` from `--settings` blocks `←` and `/bg` (S18); how a failing Bash exit code is reported (S17); whether `Read(...)` deny rules for `~/.strategos` parse on Windows (S1).

---

## 3. Decisions

### 3.1 Lock now

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | v1 shell | **Browser app window** (`msedge --app=http://127.0.0.1:PORT/`) through M6. **Electron** in M7. Tauri stays possible later | Fastest to iterate and needs no packaging. Electron is the only shell with tray, toasts with buttons, global hotkey and no new toolchain (Rust/MSVC absent [write-up, verified]). The UI talks to the daemon only over WebSocket plus a 6-method `ShellBridge`, so Tauri or a native shell later reimplements only the bridge |
| D2 | Must stay shell-independent | Daemon (all logic, all state, all processes), protocol, UI app. Shell-specific: notifications with buttons, tray/badge, global hotkey, window focus, opening external URLs, autostart | Same list is the `ShellBridge` (§4) plus `platform/` |
| D3 | Repo layout | **One git repo, npm workspaces**: `C:\dev\strategos` with `packages/{shared,daemon,ui,shell-electron}`, `tools/`, `fixtures/`, `spike/` | npm 11 has workspaces; no pnpm/turbo to install. One repo keeps protocol changes atomic |
| D4 | UI framework | **Preact 10 + @preact/signals + Vite**, SVG written as JSX | The prototype re-renders with `innerHTML`, which would destroy xterm instances, focus and scroll. Keyed diffing fixes that. Signals map 1:1 to daemon deltas, so only the changed token re-renders. About 4 KB. JSX is what sub-agents write most reliably. Solid is equally fast but less familiar; React adds weight for nothing here |
| D5 | State sync | **WebSocket, JSON, protocol v1**: `hello` → full `snapshot` (with `seq`) → ordered deltas (`session.upsert` carries the whole record). Commands carry an `id` and get an `ack`. A gap in `seq` → the client asks for a snapshot. pty bytes and chat items go on per-subscription channels outside `seq` | Whole-record upserts are about 2 KB each, simple and idempotent. No patch library |
| D6 | Test runner | **Vitest** for unit, contract and integration. **Playwright with `channel: 'msedge'`** for end-to-end, using the installed Edge (no browser download) | One runner for TS; Playwright only drives the UI |
| D7 | Daemon runtime | System Node 24, TS with types stripped (`erasableSyntaxOnly`: no enums, no namespaces). esbuild bundle only for packaging (M7). The daemon is **not** run inside Electron in v1 | Removes the Electron/node-pty rebuild question (write-up §9 "assumed") until M7 |
| D8 | Chat view | **Keep it on the same pty** (write-up §3.4): a second renderer over transcript plus hooks. Replies go in as bracketed paste | Confirmed constraints: two writers interleave, and `--settings` is not restored on resume. A process switch would cost a restart and a cache miss |
| D9 | session-tracker coexistence | **Keep the mod installed.** Strategos shows its own human-side warning for every clash. It adds the "tell Claude" note **only** where the mod can't: different folders (worktrees), cross-repo contract files, and subagent edits. Per-session escape hatch: `conflicts.disableTrackerInStrategos: true` injects `enabledPlugins: {"session-tracker@claude-mods": false}` through `--settings` | The mod scopes to "the same folder" and skips subagents. Strategos worktrees are separate folders, so duplicates are rare. `enabledPlugins` is a user-settings key, so `--settings` can set it [docs; S1 confirms] |
| D10 | Identity | `strategosId` (uuid, never sent to Claude) keys everything: hook URL `/hook/<strategosId>/<event>`, state, layout. Claude ids live in `claudeSessionIds[]` | V3, V4 |
| D11 | Hook transport | `type: "http"` hooks; header `X-Strategos-Token: $STRATEGOS_HOOK_TOKEN` with `allowedEnvVars`. Fallback is one command hook (`tools/hook-relay.mjs`) if S1 fails for http | V7 |
| D12 | Agent View inside Strategos sessions | Inject `"disableAgentView": true` (configurable) | V12, S18 |
| D13 | Held requests | Hold PermissionRequest and PreToolUse(AskUserQuestion). **Auto-release** ("no decision") when you focus that session's terminal pane, click "Answer in terminal", or 30 s before the hook timeout | One rule covers both views and a possible timeout cap |
| D14 | Port | Choose a random free port once (49152–65535) and keep it in `config.json`. If it is taken at start, exit with a clear error | Run settings files embed the URL and aren't reloaded (V11) |
| D15 | Storage | JSON and JSONL under `%USERPROFILE%\.strategos` (override `STRATEGOS_HOME`). No SQLite in v1 | Small data. Revisit if events exceed 50 MB/month |
| D16 | Git and GitHub | Shell out to `git` and `gh` with argument arrays, never a shell string | Both installed and authenticated |
| D17 | Worktree location | `<repo>/.claude/worktrees/<name>` by default (same as `claude -w`). Add `.claude/worktrees/` to `.git/info/exclude` after asking once per repo | Trust may extend from the repo folder (V10); S10 confirms |

### 3.2 Can wait

| Decision | Decide when | Input needed |
|---|---|---|
| Electron vs Tauri for the packaged shell | Start of M7 | M4 dogfood notes; whether Rust is acceptable then |
| Option E (supervisor host) instead of own ptys | M8 review | S8 result; Agent View churn since then |
| List view (look A) toggle | M8 (7.4 below) | Real session counts after a month |
| Sound or voice | After v1 | — |
| Mac signing and notarisation | M9, only if shared | — |
| SQLite for the event log | If `events-*.jsonl` exceed 50 MB/month | Measured size |
| Publishing or open-sourcing | After v1 | Licence scan; the Agent SDK login rule doesn't apply (we launch your own `claude`) |

---

## 4. Repository layout and module boundaries

```
C:\dev\strategos\
  package.json  tsconfig.base.json  vitest.workspace.ts  LICENSE  THIRD_PARTY_NOTICES.md
  spike\                  M0 only: hostpty.ts, hooklog.ts, mksettings.ts, tap.mjs, agents-cost.ts, page\index.html, REPORT.md
  packages\shared\src\    types.ts  protocol.ts  hooks.ts  status-rank.ts
  packages\daemon\src\
    main.ts  cli.ts  config.ts  safe-fs.ts
    store\       state-store.ts  event-log.ts  audit-log.ts
    server\      http.ts  guards.ts  pairing.ts  ws-hub.ts  static.ts
    hooks\       settings-writer.ts  receiver.ts  pending.ts
    statusline\  tap.mjs  ingest.ts
    sessions\    manager.ts  state-machine.ts  identity.ts  launch.ts
    pty\         pty-host.ts  input.ts
    transcript\  fsutil.ts  tailer.ts  parse.ts  chat-items.ts
    reconciler\  reconciler.ts  sessions-dir.ts  agents-cli.ts
    git\         git.ts  gh.ts  worktrees.ts  review.ts  pr-poller.ts
    features\    risk.ts  guards.ts  stuck.ts  conflicts.ts  usage.ts  digest.ts  initiatives.ts  resources.ts
    notify\      policy.ts
    platform\    index.ts  win32\{paths,locator,process,sampler,open,autostart}.ts  darwin\ (M9)
  packages\ui\
    index.html  vite.config.ts
    src\ main.tsx  app.tsx  shell-bridge.ts
         state\{connection,store}.ts
         map\{MapView,Planet,Token,NeedsStrip,InitiativeLines,layout}.tsx|ts
         drawer\{Drawer,TerminalPane,ChatPane,ReviewPane,PendingCard}.tsx
         topbar\TopBar.tsx  palette\CommandPalette.tsx  dialogs\{NewSession,RemoveWorktree,Digest}.tsx
         keys\keymap.ts  styles\tokens.css
  packages\shell-electron\  (M7) main.ts  preload.ts  tray.ts  toasts.ts  daemon-launch.ts
  tools\   fake-claude.ts  fake-claude-home.ts  record-session.ts  snapshot-claude-dir.ts  hook-relay.mjs
  fixtures\claude\<cc-version>\{hooks,transcripts,statusline}\...
  docs\acceptance\M1.md ... M9.md
```

| Module | Responsibility | Must never | Source |
|---|---|---|---|
| `shared` | Types, protocol, status ranking. No runtime deps | Import Node or DOM APIs | new; ranking idea from Bot Crossing `statusFor` |
| `daemon/config` | Load and validate `config.json`; defaults; stable port | Write config without your action in the UI | new |
| `daemon/safe-fs` | The only write path for the daemon. Refuses any path under the Claude config dir | Be bypassed (lint rule: no `fs.write*` outside this file) | new |
| `store/*` | Single-writer `state.json`, `events-*.jsonl`, `audit.jsonl` | Write before load; reuse a temp name; store full tool inputs or file contents in events | Bot Crossing `api.mjs` `writeState` (adapt) |
| `server/*` | HTTP, WebSocket, pairing, guards, static UI | Bind anything but 127.0.0.1; accept a hook request that has an `Origin` | Bot Crossing `isLocalRequest`, `readJsonBody` (rewrite stricter) |
| `hooks/settings-writer` | Write `run/<id>.settings.json` per spawn | Put a secret in the file; write into a repo or `~/.claude` | new |
| `hooks/receiver`, `pending` | Parse hook bodies, feed the state machine, hold and resolve requests | Approve anything without a UI command; leave a request held past its expiry | new |
| `statusline/*` | `tap.mjs` (no deps, under 300 ms): POST stdin to the daemon, run your own status line, print its output. `ingest.ts` normalises | Block longer than 250 ms on the daemon (fire and forget) | new |
| `sessions/*` | Spawn, stop, park, resume, forget; the pure reducer; lineage | Spawn without the single-writer check; let inferred sources clear a pending request | new; Bot Crossing `slotOf` for ring slots |
| `pty/*` | node-pty wrapper, scrollback ring buffer, input tracking (`dirtyInput`, interrupt keys), bracketed paste | Write to a pty you haven't asked for, except the documented sends (reply, slash, release) | new |
| `transcript/*` | Tail with byte offset, hold partial lines, decode UTF-8 across chunks, reset on shrink, 500 ms poll while active; parse meta, chat items, `awaitingReply`, interrupt markers | Read whole files on every poll; write to transcripts | Bot Crossing `fsutil.mjs`, `firstText`, `cleanPrompt`, `readTranscriptMeta`, `awaitingReply` (port + extend) |
| `reconciler/*` | Read `sessions/<pid>.json` every 3 s; `claude agents --json` at start, every 60 s and on disagreement; transcript inference; `open_elsewhere` | Override hook state younger than 10 s; clear `permission` or `question` | new; Bot Crossing live-pid probe idea |
| `git/*` | Status, diff, worktree create/remove, review data, `gh` PR create and poll | Delete a branch or a dirty worktree without the typed confirmation | new |
| `features/*` | Risk, guards, stuck, conflicts, usage, digest, initiatives, resources. Each is a pure function over events plus a small store | Act on its own, except guards (deny only) | new |
| `notify/policy` | Transition-only, none at startup, at most 1 per 2.5 s, escalation at 5 and 15 min | Fire for the session you are looking at | Bot Crossing `chimeForNewWaiting` (port) |
| `platform/*` | Paths (`CLAUDE_CONFIG_DIR`, canonicalisation), Claude locator, process liveness, tree kill and sampling, URL and folder opener, autostart | Use a binary from another app's bundle; drop `CLAUDE_CONFIG_DIR` | Bot Crossing `scan.mjs` `canonical`, `windows.mjs` (fronting), `api.mjs` opener (adapt) |
| `ui/*` | Map, drawer, palette, dialogs, keyboard, shell bridge | Hold authoritative state; write files; talk to anything but the daemon | prototype look B; Bot Crossing `hud.js` escape and "set only if changed" ideas |
| `shell-electron` | Window, tray, badge, toasts, hotkey; launches or connects to the daemon | Contain business logic | new |
| `tools/fake-claude` | A stand-in `claude` that reads `--settings`, posts scripted hooks, writes a scripted transcript, prints TUI-like output | Run real tools | new |

### 4.1 Public interfaces

```ts
// platform/index.ts
export interface Platform {
  paths: { strategosHome(): string; claudeConfigDir(): string; canonical(p: string): string; projectDirName(cwd: string): string };
  locateClaude(cfg: { claudePath?: string }): Promise<{ exe: string; version: string } | { error: string }>;
  proc: { isAlive(pid: number, startTime?: string): Promise<boolean>; startTime(pid: number): Promise<string | null>;
          killTree(pid: number): Promise<void>; sample(): AsyncIterable<ProcSample[]> };   // every 5 s, persistent sampler
  openExternal(urlOrPath: string): Promise<void>;     // win32: rundll32 url.dll,FileProtocolHandler
  openAppWindow(url: string): Promise<void>;          // win32: msedge --app=<url>
  autostart: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
}
// sessions/manager.ts
export interface SessionManager {
  start(o: StartOptions): Promise<SessionRecord>; stop(id: string): Promise<void>; park(id: string): Promise<void>;
  resume(id: string): Promise<void>; forget(id: string): Promise<void>; archive(id: string, on: boolean): Promise<void>;
  sendReply(id: string, text: string): Promise<SendResult>; sendSlash(id: string, cmd: AllowedSlash): Promise<SendResult>;
  get(id: string): SessionRecord | undefined; list(): SessionRecord[]; onChange(cb: (s: SessionRecord) => void): () => void;
}
// sessions/state-machine.ts — pure, fully unit-tested
export function reduce(s: SessionRecord, e: MachineInput, now: number): { next: SessionRecord; effects: Effect[] };
// hooks/pending.ts
export interface PendingRegistry {
  hold(sid: string, p: Pending, res: HookResponder): void;
  decide(sid: string, requestId: string, d: Decision): Result;   // allow | deny | always | answers
  release(sid: string, requestId: string, why: 'terminal-focus' | 'user' | 'expiry' | 'shutdown'): Result;
  onClosed(sid: string, requestId: string): void;                // client closed the connection: answered in the TUI
}
// pty/pty-host.ts
export interface PtyHost {
  spawn(o: { exe: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }): PtyHandle;
}
export interface PtyHandle { pid: number; write(d: string, origin: 'user' | 'strategos'): void; resize(c: number, r: number): void;
  kill(): void; onData(cb: (d: string) => void): () => void; onExit(cb: (code: number) => void): void; scrollback(): string; dirtyInput: boolean }
// transcript/tailer.ts
export interface Tailer { follow(path: string, fromOffset: number, cb: (recs: unknown[], offset: number) => void): () => void }
// reconciler/reconciler.ts
export interface Reconciler { tick(): Promise<Observation[]>; onDemand(sid: string): Promise<Observation | null> }
// git/*.ts
export interface Git { status(cwd: string): Promise<GitStatus>; commonDir(cwd: string): Promise<string>; diffVsBase(cwd: string, base: string): Promise<DiffData>;
  worktreeAdd(repo: string, path: string, branch: string, base: string): Promise<void>; worktreeRemoveSafe(path: string, o: { deleteBranch: boolean }): Promise<void> }
export interface Gh { prCreate(o: PrCreate): Promise<{ number: number; url: string }>; prView(cwd: string, branch: string): Promise<PrInfo | null> }
// features
export function classifyRisk(tool: string, input: unknown, ctx: { worktree: string; addDirs: string[] }): RiskClass[];
export function checkGuards(rules: GuardRule[], ev: PreToolUseInput, ctx: GuardCtx): { deny: false } | { deny: true; ruleId: string; reason: string };
// ui/shell-bridge.ts — the only shell-specific surface in the UI
export interface ShellBridge { notify(n: UiNotification): void; setBadge(count: number): void; focusWindow(): void;
  openExternal(url: string): void; onNotificationAction(cb: (a: { requestId: string; action: 'approve' | 'deny' | 'open' }) => void): void; kind: 'browser' | 'electron' }
```

---

## 5. Data contracts

```ts
// shared/types.ts
export type Status = 'starting' | 'trust_pending' | 'working' | 'permission' | 'question' | 'done' | 'seen'
  | 'interrupted' | 'errored' | 'stopped' | 'parked' | 'open_elsewhere';
export type StatusSource = 'hook' | 'pty' | 'transcript' | 'reconciler' | 'user';
export type RiskClass = 'read' | 'write' | 'run' | 'network' | 'delete' | 'outside_repo';
export interface Pending {
  requestId: string; kind: 'permission' | 'question'; held: boolean;  // held=false: answer only in terminal
  toolName: string; toolUseId?: string; agentId?: string;             // agentId: asked by a subagent
  inputSummary: string;                 // ≤ 400 chars: command, file path or first question
  risk: RiskClass[];                    // highest first
  suggestions?: unknown[];              // permission_suggestions, passed back verbatim as updatedPermissions
  questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
  since: number; expiresAt?: number;    // daemon auto-release time
}
export interface SubagentInfo { agentId: string; type?: string; running: boolean; startedAt: number; endedAt?: number }
export interface SessionRecord {
  schema: 1; strategosId: string; name: string; displayName: string;
  claudeSessionIds: string[]; currentSessionId: string; transcriptPath?: string; transcriptOffset: number;
  repoRoot: string; planetKey: string;  // planetKey = canonical(git common dir); repoRoot = its main checkout
  cwd: string; branch?: string;
  worktree?: { path: string; branch: string; base: string; createdByStrategos: boolean };
  launch: { model?: string; permissionMode?: string; addDirs: string[]; extraArgs: string[]; firstPrompt?: string };
  status: Status; statusSource: StatusSource; statusSince: number;
  waitingSince?: number; pending?: Pending; doneAt?: number; seenAt?: number; interruptPendingAt?: number;
  now?: { tool: string; summary: string; since: number; agentId?: string };
  last?: string; lastIsQuestion?: boolean;            // first ~160 chars of last_assistant_message
  initiativeId?: string; parentId?: string;           // parentId: the mission's lead session, if any
  ringSlot: number; ringSlotByGroup: Record<string, number>;  // sticky; key = planetKey or initiativeId
  ctx?: { pct: number | null; tokens?: number; window?: number; at: number; source: 'statusline' | 'transcript' };
  cost: { lineageUsd: number; byClaudeSession: Record<string, number> };   // list-price estimate, shown as "≈ $"
  model?: string; effort?: string; permissionMode?: string;
  cache?: { warm: boolean | null; ttl?: '5m' | '1h'; expiresAt?: number; lastCallAt?: number; source: 'statusline' | 'transcript' };
  git?: { branch?: string; ahead?: number; behind?: number; dirty?: boolean; diffStat?: { files: number; add: number; del: number }; at: number };
  pr?: { number: number; url: string; state: 'DRAFT' | 'OPEN' | 'MERGED' | 'CLOSED'; review?: string; ci: 'pass' | 'fail' | 'pending' | 'none'; at: number };
  resource?: { pid: number; procStart: string; treeWorkingSetMb: number; treePrivateMb: number; cpuPct: number; at: number };
  flags: { stuck?: { reason: 'repeat' | 'failures' | 'ctx_no_progress' | 'quiet'; since: number };
           conflicts: { file: string; other: string; at: number }[]; contractChanged: string[];
           guardDenials: number; lastTest?: { command: string; ok: boolean | null; at: number } };
  subagents: SubagentInfo[];
  pty?: { pid: number; cols: number; rows: number; dirtyInput: boolean }; exitCode?: number;
  createdAt: number; updatedAt: number; lastActivityAt: number; archived: boolean; view: 'term' | 'chat' | 'review';
}
export interface Initiative { id: string; name: string; colour: string; createdAt: number;
  contractFiles: { planetKey: string; relPath: string }[]; archived: boolean }
export interface Usage { fiveHour?: { pct: number; resetsAt: number }; sevenDay?: { pct: number; resetsAt: number };
  burnPctPerHour?: number; etaFull?: number; at: number }
export interface PlanetInfo { planetKey: string; label: string; colour: string; cell: { col: number; row: number }; pinned: boolean; folded: boolean }
export type ChatItem =
  | { k: 'user'; id: string; text: string; at: number } | { k: 'assistant'; id: string; md: string; at: number }
  | { k: 'tool'; id: string; tool: string; summary: string; result?: string; ok?: boolean; diff?: string; agentId?: string }
  | { k: 'subagent'; id: string; agentId: string; brief: string; items: ChatItem[] }
  | { k: 'compact'; id: string; at: number } | { k: 'interrupted'; id: string; at: number };
// shared/protocol.ts  (PROTOCOL = 1)
export type DaemonEvent =
  | { t: 'hello'; protocol: 1; daemonVersion: string; claudeVersion: string; testedRange: string; inRange: boolean }
  | { t: 'snapshot'; seq: number; sessions: SessionRecord[]; planets: PlanetInfo[]; initiatives: Initiative[]; usage?: Usage; prefs: UiPrefs }
  | { t: 'session.upsert'; seq: number; session: SessionRecord } | { t: 'session.removed'; seq: number; strategosId: string }
  | { t: 'planets'; seq: number; planets: PlanetInfo[] } | { t: 'initiatives'; seq: number; initiatives: Initiative[] }
  | { t: 'usage'; seq: number; usage: Usage } | { t: 'resources'; seq: number; totalMb: number; cpuPct: number }
  | { t: 'notify'; seq: number; kind: 'permission' | 'question' | 'errored' | 'done' | 'escalate'; strategosId: string; title: string; body: string; risk?: RiskClass[]; requestId?: string }
  | { t: 'suggestion'; seq: number; id: string; kind: 'initiative' | 'park'; text: string; strategosIds: string[] }
  | { t: 'pty.data'; strategosId: string; data: string } | { t: 'pty.replay'; strategosId: string; data: string }
  | { t: 'chat.items'; strategosId: string; from: number; items: ChatItem[]; reset: boolean }
  | { t: 'review'; strategosId: string; review: ReviewData } | { t: 'digest'; since: number; digest: DigestData }
  | { t: 'ack'; id: string; ok: boolean; error?: string };
export type UiCommand = { id: string } & (
  | { c: 'session.start'; repoPath: string; worktree?: { name: string; branch: string; base: string }; firstPrompt?: string; name?: string; initiativeId?: string; model?: string; permissionMode?: string }
  | { c: 'session.stop' | 'session.park' | 'session.resume' | 'session.forget' | 'session.seen'; strategosId: string }
  | { c: 'session.archive'; strategosId: string; on: boolean } | { c: 'session.resumeAll' }
  | { c: 'pty.subscribe'; strategosId: string; cols: number; rows: number } | { c: 'pty.unsubscribe'; strategosId: string }
  | { c: 'pty.input'; strategosId: string; data: string } | { c: 'pty.resize'; strategosId: string; cols: number; rows: number }
  | { c: 'pty.focus'; strategosId: string }                                      // triggers auto-release (D13)
  | { c: 'perm.decide'; strategosId: string; requestId: string; decision: 'allow' | 'deny' | 'always'; message?: string; suggestionIndex?: number }
  | { c: 'perm.release'; strategosId: string; requestId: string } | { c: 'perm.approveLowRisk'; initiativeId: string }
  | { c: 'question.answer'; strategosId: string; requestId: string; answers: Record<string, string> }
  | { c: 'reply.send'; strategosId: string; text: string } | { c: 'slash.send'; strategosId: string; cmd: '/compact' | '/handoff-now' | `/keepwarm ${'60m' | '90m' | '2h'}` }
  | { c: 'chat.subscribe'; strategosId: string; from: number } | { c: 'review.get'; strategosId: string } | { c: 'review.sendBack'; strategosId: string; text: string }
  | { c: 'pr.create'; strategosId: string; title: string; body: string; draft: boolean }
  | { c: 'worktree.remove'; strategosId: string; deleteBranch: boolean; confirmText?: string }
  | { c: 'initiative.upsert'; initiative: Initiative } | { c: 'initiative.assign'; strategosId: string; initiativeId: string | null }
  | { c: 'mission.start'; initiativeId: string; sessions: { repoPath: string; branch: string; firstPrompt: string }[] }
  | { c: 'suggestion.respond'; id: string; accept: boolean }
  | { c: 'layout.setPlanetCell'; planetKey: string; col: number; row: number } | { c: 'prefs.set'; prefs: Partial<UiPrefs> }
  | { c: 'guards.set'; rules: GuardRule[] } | { c: 'digest.get'; since?: number } | { c: 'activity'; idleMs: number });
```

**On-disk files** (all under `~/.strategos`, owned by the daemon; the UI never writes files):

| File | Content | Write rule |
|---|---|---|
| `daemon.lock` | `{pid, procStart}` | Created exclusively at start. A live holder means a second daemon exits. A stale holder (dead pid or other start time) is replaced |
| `daemon.json` | `{pid, port, startedAt, version}`. **No token** | Rewritten at start |
| `config.json` | Repos, `claudePath?`, `port`, `worktreeRoot`, `env.keep[]`, `env.set{}`, guards, notification prefs, thresholds, `testCommandPatterns[]`, `conflicts.*`, `statusLine.mode` | Written only on an explicit UI save; validated; previous copy kept as `config.json.bak` |
| `state.json` | `{schema, writtenAt, daemonVersion, sessions[] (no pty/resource; pending saved with held:false), initiatives[], layout:{planetCells, groupCells}, prefs, dismissedSuggestions[]}` | **Single serialised writer queue; unique temp name `state.json.<pid>.<seq>.tmp` then rename; no write until load finished (a flag set after a successful parse or an explicit "start empty"); debounce 500 ms; flush on exit; keep `state.json.bak` hourly. A parse failure renames the file to `state.json.corrupt-<ts>`, loads the `.bak`, and shows a banner** |
| `events-YYYY-MM-DD.jsonl` | `{ts, sid?, type, data}`; types `status`, `hook` (event name, tool, summary only), `decision`, `guard`, `cost`, `usage`, `notify`, `error`, `activity` | Append only, one writer. Roll at 20 MB. **Retention 30 days.** Never full tool inputs or file contents |
| `audit.jsonl` | Every allow, deny, always, release, answer and guard deny: `{ts, sid, claudeSessionId, requestId, tool, inputSummary, risk, decision, via: 'map'\|'strip'\|'drawer'\|'toast'\|'palette'\|'guard'\|'lowRiskBatch', connId}` | Append only. **Retention 180 days** |
| `run/<strategosId>.settings.json` | Hooks, statusLine, `disableAgentView`, deny rules (§10) | Written before spawn and fixed for the process's life. Deleted on exit. `run/` is swept at start (files with no live owner) |
| `logs/daemon-YYYY-MM-DD.log` | Diagnostics | 7-day retention |

**Injected settings (v1):** `SessionStart`, `SessionEnd` (timeout 3), `UserPromptSubmit`, `PreToolUse` `*` (timeout 5; guards answer here), `PreToolUse` `AskUserQuestion` (timeout 86400, held), `PermissionRequest` `*` (timeout 86400, held), `PostToolUse` `*`, `PostToolUseFailure` `*`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `CwdChanged`. All are `type: "http"` with URL `http://127.0.0.1:<port>/hook/<strategosId>/<Event>`, `headers: {"X-Strategos-Token": "$STRATEGOS_HOOK_TOKEN"}` and `allowedEnvVars: ["STRATEGOS_HOOK_TOKEN"]`. Also `statusLine: {type: "command", command: "<node>/node.exe <home>/tap.mjs <strategosId>"}` with forward slashes, plus `"disableAgentView": true`.

---

## 6. Status state machine

Sources: **H** hook, **P** pty (exit, keystrokes typed through Strategos), **T** transcript inference, **R** reconciler (`sessions/<pid>.json`, `claude agents --json`), **U** your command.

| Status | Meaning | Entered by (source) | Left by |
|---|---|---|---|
| `starting` | Spawned, no hook yet | U start/resume | Any H; `trust_pending`; exit |
| `trust_pending` | Trust dialog is up, so hooks are silent (V10) | P: pty text matches the trust dialog; R: `waitingFor: "dialog open"` within 20 s of spawn with no hook | Any H (usually SessionStart) |
| `working` | Model or tool running | H: UserPromptSubmit, PreToolUse (not AUQ), PostToolUse, SubagentStart, PreCompact. T/R (inferred): user or tool_result last, or `status: busy` | See below |
| `permission` | Tool needs your OK | **H only**: PermissionRequest (`held: true`). R `waitingFor: "permission prompt"` with no hook → `permission` with `held: false` ("answer in terminal"), statusSource=reconciler | Decision sent; hold released and then PostToolUse/PreToolUse(next); hook connection closed (answered in TUI); Stop; StopFailure; exit |
| `question` | AskUserQuestion or elicitation | H: PreToolUse(AskUserQuestion) (held), Notification `elicitation_dialog` (held: false) | Answer sent; PostToolUse(AUQ); UserPromptSubmit; exit |
| `done` | Turn handed back to you | H: Stop. T: `awaitingReply` true. R: `status: idle` (both inferred) | UserPromptSubmit → working; U seen → `seen` |
| `seen` | Done and you've looked | U: drawer opened ≥ 1.5 s, `x` key, or "Seen" button (`seenAt ≥ doneAt`) | Any new activity → working (re-arms) |
| `interrupted` | You pressed Esc or Ctrl+C mid-turn | P: Esc or Ctrl+C typed while working or permission sets `interruptPendingAt`; confirmed by T marker `[Request interrupted by user`, or H PostToolUseFailure `is_interrupt`, or R idle within 5 s. Unconfirmed after 10 s → flag dropped | UserPromptSubmit → working; U seen |
| `errored` | Turn failed or the process died | H: StopFailure (`error`). P: exit ≠ 0 without SessionEnd while not stopping | U resume → `starting` |
| `stopped` | Ended normally; resumable | P: exit after U stop, or after SessionEnd `prompt_input_exit`/`other`. Daemon restart: every non-live record | U resume |
| `parked` | Stopped by you to free memory; resumable | U park (same mechanics as stop) | U resume |
| `open_elsewhere` | Another live process owns a Claude id in this lineage | R: `sessions/*.json` or agents shows our current id with a pid that isn't our pty's | R: that process is gone → `stopped` |

**Rules**
1. **Inferred sources never clear a pending request.** T and R may not move a session out of `permission` or `question` while `pending` is set. Only H, U, P (exit) or the hold connection closing may.
2. **Hooks beat inference.** T/R transitions apply only after 10 s with no hook event, and set `statusSource` to `transcript` or `reconciler`. The UI draws those tokens with a dashed ring and the word "probably".
3. **Subagents.** Events with `agent_id` update `subagents` and `now` and never change top-level status, **except** PermissionRequest and AskUserQuestion, which block the session like the main agent's (`pending.agentId` set).
4. **Lineage.** SessionStart with a new `session_id`: push onto `claudeSessionIds`, set `currentSessionId` and `transcriptPath`, reset `transcriptOffset`, and add a `compact`/`clear` marker in chat. `source: clear|resume|fork` → `done` (fresh prompt); `compact` → no change.
5. **Needs-you priority**, for the strip and Tab order: permission > question > errored > trust_pending > interrupted > done (unseen). Within a tier, the oldest `waitingSince` comes first. `waitingSince` is set on entering any of these and cleared on leaving.
6. **`lastIsQuestion`.** A Stop whose last message ends in "?" keeps status `done` and adds a "?" badge. It no longer creates a fake `question` state (the write-up's heuristic is dropped).
7. Every transition is appended to `events-*.jsonl` with its source. A disagreement between H and R older than 30 s is logged as `drift`.

---

## 7. The Map

**From the prototype to components.** `mapSvg()` becomes `MapView.tsx` with `<Planet>` and `<Token>` children. The prototype's two layout bugs are removed (review gap 5):
- It places planets by repo index (`cx[i]`). v1 uses sticky cells keyed by `planetKey`.
- It orders tokens by `order()` (status rank) and divides the ring by the count. v1 uses sticky slots at fixed angles.

**`map/layout.ts` (pure, unit-tested):**
- **Grid.** Square cells, 380×240 viewBox units each (the prototype's spacing). Capacity is 2×2, then 3×3, then 4×4. It grows when planets exceed capacity. It shrinks only when the count is at or below the smaller capacity minus 2, for 3 consecutive snapshots (hysteresis).
- **Planet cells.** Stored in `state.layout.planetCells[planetKey]`. A new planet takes the free cell nearest the centre (spiral order). A planet never moves because another changed. Dragging sets `pinned: true`. A cell you remember stays reserved 30 days after its planet folds (memory of at most 80 planets, least recently seen evicted, as Bot Crossing does).
- **Ring slots.** Assigned at first sight, lowest free index, then kept for life (`ringSlot`; per group in `ringSlotByGroup`). Slot k sits on ring ⌊k/8⌋ (radius 80 + 28·ring) at angle −90° + (k mod 8)·45°. Fixed angles mean a token never moves when a sibling arrives or leaves. Freed slots are reused lowest-first.
- **Folding.** A planet whose sessions are all stopped, parked or archived and older than 7 days folds into a small "dormant" dot in its cell. At least one planet is always shown.

**What each element reads:**

| Element | Reads | Notes |
|---|---|---|
| Planet disc and label | `PlanetInfo.label` (disambiguated as `1/foo` `2/foo` with Bot Crossing's rule), `colour` (hash of `planetKey`, config override) | Label split on `-` as in the prototype |
| Token ring and glyph | `status` → ◆ permission, ? question, ● working, ✓ done, · seen (dimmed ✓), ⏸ interrupted, ✕ errored, ○ stopped, z parked, ⇱ open elsewhere, ⚑ trust | Glyph and colour, never colour alone. Dashed ring if `statusSource` is transcript or reconciler |
| Outer arc | `ctx.pct` | Amber ≥70, red ≥85. Hollow if null |
| Pulse | needs-you statuses; speed from `waitingSince` (normal; faster at 5 min; fastest at 15 min) | `prefers-reduced-motion`: no pulse, no drift; a 4.5 px ring plus the waiting text instead |
| Waiting number | `now - waitingSince` → "14m" under the token | Feature "waiting time as a number" |
| Risk chip | `pending.risk[0]` as a 1-word label on permission tokens (READ, WRITE, RUN, NET, DEL, OUTSIDE) | Colour by risk |
| Label lines | `displayName` (≤ 20 chars) and `ctx% · ≈$lineageUsd` | As in the prototype |
| Small marks around the token | 2 o'clock: CI dot (`pr.ci`); 4 o'clock: PR glyph (`pr.state`); 8 o'clock: ⚠ conflict or contract; 10 o'clock: ! stuck; 12 o'clock: cache arc (warm → amber under 5 min → grey cold) | Hover card shows branch, ahead/behind, dirty, last message, memory |
| Subagents | `subagents.filter(running).length` as up to 3 dots inside the ring | Never separate tokens |
| Needs-you strip | Records in a needs-you status, sorted by rule 5 in §6 | Inline Approve/Deny with risk chip and command. Never truncated; scrolls horizontally |
| Top bar | Counts, waiting now/today, 5-hour and 7-day gauge with ETA, total memory, digest button | |

**Initiatives.**
- **Hover-dim.** Hovering a token, or an initiative chip in the top bar, sets `focusInitiative`. Everything outside it drops to 25% opacity.
- **Lines.** `InitiativeLines` draws straight lines between the tokens of the hovered or selected initiative only, in its colour, under the tokens.
- **Group-by toggle.** "Group by: Repo | Initiative" (key `g`) re-keys the same layout engine on `initiativeId`. Sessions with none go to an "Unassigned" system. Cells and slots for groups are stored separately, so switching back restores repo positions exactly.

**Crowding.**
- A planet with more than 8 non-needs-you sessions collapses its quiet tokens into a "+5" badge (click or Enter expands that planet for 30 s). Needs-you tokens are never collapsed.
- From 10 planets the grid is 4×4 and the viewBox scales. The list view toggle comes in M8.

**Keyboard.** All keys are also reachable with the mouse. The prototype's keys are kept.

| Key | Action | Key | Action |
|---|---|---|---|
| `n`, `Tab` | Next session needing you (`Shift`: previous) | Arrows / `h j k l` | Move selection spatially (nearest token in that direction) |
| `Enter` | Open the drawer | `Esc` | Close the drawer or palette; back to the map |
| `a` / `d` | Approve / deny the selected request (`d` opens an optional message) | `A` | Always allow (only when suggestions exist) |
| `1`–`9` | Pick an answer option while a question is selected | `r` | Reply box |
| `t` | Drawer: terminal ↔ chat | `v` | Review tab |
| `c` | New session | `s` / `p` | Stop / park (with confirmation) |
| `x` | Mark seen | `g` | Group by repo ↔ initiative |
| `i` | Assign an initiative | `Ctrl+K` | Command palette |
| `Ctrl+Alt+M` | Leave a focused terminal and go back to the map | `?` | Key help |

When an xterm pane has focus, every key goes to Claude except `Ctrl+Alt+M`. Focusing a terminal sends `pty.focus`, which auto-releases any held request of that session so the real dialog appears (D13).

**Accessibility.**
- Tokens are focusable `role="button"`. The `aria-label` reads name, status, waiting time and context.
- A polite live region announces new needs-you items.
- Contrast follows the prototype's token colours.

---

## 8. Milestones

Each task row gives: id | what | hd | depends | files | how to test | done when. "Accept" means the milestone's manual acceptance script in `docs/acceptance/Mx.md`.

### M0 Spike (9 hd). Goal: kill the biggest unknowns before writing product code.

Setup:
1. `C:\dev\strategos\spike` with `npm i node-pty@1.1.0 ws @xterm/xterm @xterm/addon-fit`.
2. A scratch repo, `C:\dev\strategos-sandbox`, created by `spike/mkrepo.ts` (`git init`, one README, one commit, `.claude/settings.local.json` with deny rules `Bash(rm *)`, `Bash(del *)`, `Bash(Remove-Item *)`, `Bash(git push *)`).
3. Permission tests only ask Claude to run `echo strategos-probe > probe.txt` or to write `probe.md`.
4. Never use `--dangerously-skip-permissions`.

Scripts:
- `spike/hostpty.ts` spawns the resolved `claude.exe` in node-pty with `--session-id`, `--settings`, `--name`. It serves `page/index.html` (xterm plus fit) over a WebSocket on 127.0.0.1:47800 and logs exit codes. Flags: `--conpty-dll`, `--resume <id>`, `--no-agentview`.
- `spike/hooklog.ts` is an HTTP server on 127.0.0.1:47801. It writes every body to `spike/out/<ts>-<event>.json` and logs headers. PermissionRequest and PreToolUse(AskUserQuestion) are held. Stdin commands: `allow`, `deny <msg>`, `always <i>`, `answer <json>`, `none` (empty 200), `drop` (close the socket). It logs `req.on('close')` for held requests.
- `spike/mksettings.ts` writes the §5 settings file for one run. `spike/tap.mjs` is the status tap; it chains to a test status line.
- `spike/agents-cost.ts` times 10× `claude agents --json` against reading `sessions/*.json`, and the persistent PowerShell sampler.
- `spike/hash-claude-dir.ts` records SHA-256 of `settings.json` and a listing of top-level `~/.claude` before and after.

**Checks, in the order that kills the biggest risk first:**

| Order | # | Check | Pass | Fail → |
|---|---|---|---|---|
| 1 | S1 | `--settings` injects http hooks with the header token | Every listed event arrives with our `session_id` and `X-Strategos-Token` set; your own plugins still load (clawd-pet band visible, auto-handoff bar visible); `~/.claude/settings.json` hash unchanged; the deny rule `Read(~/.strategos/**)` is accepted (no Settings Warning) | Try the token in the URL path; then a command hook (`hook-relay.mjs`); then `--plugin-dir` with hooks. All fail → **no-go**, re-plan |
| 2 | S2 | Hold a PermissionRequest | Held 15 min with timeout 86400, then each of allow, deny with a message, always (one suggestion → rule applied), `none` (the TUI dialog appears) behaves as documented. Record: is the TUI dialog visible **while held**? If answered in the TUI while held, does our request get `close`? | Run **S2b**: with the hook immediately empty, can `1`/`Enter`/`Esc` typed into the pty answer the dialog reliably 10/10? Yes → GO, degraded (approve by keystrokes). No → approvals become "open terminal" only |
| 3 | S3 | ConPTY renders your TUI | 10 min of real use side by side with a normal console: no garbled redraws; resize; mouse; Shift+Enter; paste; Ctrl+C; `/` picker; permission dialog; clawd-pet band | Retry with `--conpty-dll`; then `"tui"` classic via `--settings`; then the external-window mode (§12, R2). All fail → run S8 as the alternative host |
| 4 | S9 | Answer AskUserQuestion from outside | Held PreToolUse(AUQ) + `allow` + `updatedInput` {questions, answers} continues the turn with that answer; `none` shows the TUI question | Questions are "answer in terminal" only |
| 5 | S11 | Identity churn | `/clear`, in-TUI `/resume`, `/branch`, plan-mode "clear context" and `/handoff-now` (auto-handoff) each produce SessionEnd + SessionStart **to the same hook URL** with the new `session_id` and `transcript_path`; the status line reports the new id and reset cost | If hooks stop after a switch → lineage from the reconciler (sessions file) plus a watcher on the project dir |
| 6 | S12 | Interrupts | Esc mid-text, Esc mid-tool, Esc at the permission dialog, Ctrl+C: record which hooks fire (expect no Stop), the final transcript record, and `sessions/<pid>.json` status within 5 s | If no confirmation exists → mark interrupted from keystrokes alone, labelled "probably" |
| 7 | S18 | Agent View escape | With `disableAgentView: true` via `--settings`: `←` on an empty prompt and `/bg` do **not** move the session. Without it: record what the pty shows | Can't disable → detect `open_elsewhere` and show "moved to background; open with `claude attach`" |
| 8 | S5 | Status line through `--settings` | The tap receives `context_window.used_percentage`, `context_window_size`, `cost.total_cost_usd`, `rate_limits.*`, `prompt_cache.*`, `session_id`; runs in under 300 ms under Git Bash; the chained status line prints. Note whether plain-talk's status display is affected | Transcript ctx% plus a price table; usage gauge cut (no other `rate_limits` source) |
| 9 | S4 | Reply through the pty | Bracketed paste of 3 lines + `\r` = one UserPromptSubmit with the exact text; `/compact` sent the same way runs the command; record what Ctrl+U does in the prompt | Reply only from the terminal; slash actions become "copy command" |
| 10 | S10 | Trust in new worktrees | Record whether a worktree under `<repo>/.claude/worktrees/x` and one under `C:\dev\x-wt` prompt for trust; the pty text pattern and `sessions/<pid>.json` during the prompt | Show a "Trust this folder" step in the new-session flow |
| 11 | S16 | Cache TTL | `prompt_cache.ttl/expires_at/warm` present and consistent with transcript `ephemeral_*` fields; one idle session crosses expiry | Show "age since last call" only |
| 12 | S17 | Added context after a tool | PostToolUse `additionalContext` is visible to the model (ask it to quote the note) for a main and a subagent call. Also record which hook fires for a Bash command exiting 3 | No "tell Claude" notes; warn the human only. Test results come from the transcript |
| 13 | S14 | Resume identity | `claude --resume <id> --settings <new file>` keeps the id, appends to the same `.jsonl`, and hooks fire again | Resume uses lineage + the new id |
| 14 | S13 | Reconciler and sampler cost | Median time and peak memory of `claude agents --json`; `sessions/*.json` read time; sampler CPU. Does the sessions file ever show `waiting`? | Pick intervals from measurements |
| 15 | S6 | Chat from the transcript tail | Cards for user, assistant, tool, Edit diff, subagent and compaction render within 1 s of the line being written; fixtures saved | Narrow the card set |
| 16 | S15 | Toast actions | A Web Notification from the 127.0.0.1 page (Edge app window) with a click handler focuses the window; note whether action buttons work through a service worker | Click-to-open in the browser phase; buttons wait for Electron (V15) |
| 17 | S8 | Option E (timebox 2 h) | `claude --bg --settings X` starts; hooks fire; `claude attach` renders in node-pty | Record only |
| 18 | S7 | Cross-mode resume (timebox 1 h) | Record only | Already out of scope |

**Go/no-go:** GO to M1 if S1 passes, S3 passes in any variant, and S2 or S2b passes. S11 and S12 must be *understood* (results recorded), not necessarily favourable. Every other failure has a cut listed above. The output is `spike/REPORT.md` plus `fixtures/claude/2.1.292/**` (redacted: home path → `~`, tool inputs over 2 KB cut).

**M0 tasks:** M0.1 scaffold and sandbox (1). M0.2 hostpty + page (2). M0.3 hooklog + mksettings + tap (2). M0.4 run S1–S18, fixtures, report (4). Done when REPORT.md has a result row per check and the go/no-go table is filled.

### M1 Daemon (29 hd). Goal: a headless daemon that runs real sessions with correct status, persistence and security, testable without Claude.

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 1.01 | Monorepo scaffold, `npm run check` (tsc strict + vitest + eslint no-restricted-imports) | 1 | M0 | root `package.json`, `tsconfig.base.json` | CI script runs | `npm run check` green on an empty repo |
| 1.02 | Shared types and protocol from §5; status ranking | 1 | 1.01 | `shared/src/*` | type tests | Reviewed and frozen at gate G1 |
| 1.03 | Platform win32: paths (`CLAUDE_CONFIG_DIR`, canonical drive case, `\\?\`), locator (PATHEXT, `claude.cmd` → exe, bundle denylist), process (alive + start time, `taskkill /T /F`), opener, persistent sampler | 2 | 1.02 | `platform/**` | unit: locator temp dirs; canonical table; kill-tree of a 3-level tree | Tests pass **on Windows** (none skipped) |
| 1.04 | Stores: state (queue, unique temp, no write before load, `.bak`, corrupt handling), event log (roll, retention), audit log; `safe-fs` refusing the Claude config dir | 2 | 1.02 | `store/**`, `safe-fs.ts` | unit: 50 concurrent writes, kill mid-write, write-before-load refused | No lost write in 1000-iteration fuzz |
| 1.05 | Config: schema, defaults, stable port | 1 | 1.02 | `config.ts` | unit | Invalid config → a clear error, not a crash |
| 1.06 | Server: http, guards (§10), pairing, WS hub (hello, snapshot, seq deltas, acks, resync), static UI | 3 | 1.04, 1.05 | `server/**` | unit + integration with `ws` client; guard matrix test | Every row of the §10 guard table has a test |
| 1.07 | Hooks: settings writer, receiver for each event, pending registry (hold, decide, release, expiry, close) | 3 | 1.06 | `hooks/**` | contract tests over M0 fixtures; fake-claude hold/close tests | All fixture events parse; a held request resolves in all 5 ways |
| 1.08 | State machine reducer and lineage, per §6 | 3 | 1.02 | `sessions/state-machine.ts`, `identity.ts` | table-driven tests, one per row and rule in §6 | 100% branch coverage on the reducer |
| 1.09 | pty host: spawn with scrubbed env, 2 MB scrollback ring, resize, input origin, `dirtyInput`, Esc/Ctrl+C detection, bracketed paste helper | 2 | 1.03 | `pty/**` | integration with fake-claude and `cmd.exe` | Scrollback replays the same bytes; exit codes correct |
| 1.10 | Session manager: start (`git rev-parse --git-common-dir` → `planetKey`), stop (Ctrl+C ×2, `/exit`, 5 s, tree kill), park, resume (single-writer check, regenerated settings), forget, archive; restart recovery | 3 | 1.07–1.09 | `sessions/manager.ts`, `launch.ts` | e2e with fake-claude | Kill the daemon → restart → sessions show `stopped`, resumable |
| 1.11 | Transcript: fsutil port, tailer, meta, `awaitingReply` + interrupt markers | 2 | 1.02 | `transcript/**` | partial lines, UTF-8 split, shrink, 12 MB file | Tail latency ≤ 600 ms; never parses a partial line |
| 1.12 | Status-line ingest and the final `tap.mjs` (chain, timeout 250 ms) | 1 | 1.06 | `statusline/**` | unit; timed run under Git Bash | Under 300 ms p95 |
| 1.13 | Reconciler: sessions dir (3 s), agents CLI (60 s and on demand), transcript inference, `open_elsewhere`, drift log | 2 | 1.08, 1.11 | `reconciler/**` | fake `CLAUDE_CONFIG_DIR` fixtures | Inferred states labelled; never clears a pending request (test) |
| 1.14 | `tools/fake-claude.ts`, `fake-claude-home.ts`, `snapshot-claude-dir.ts` | 2 | 1.02 | `tools/**` | self-tests | Scripts for: plain turn, permission, question, subagent, `/clear`, interrupt, crash |
| 1.15 | `main.ts` and `cli.ts`: lock, detached start, `strategos start\|stop\|status\|open` | 1 | 1.06, 1.10 | `main.ts`, `cli.ts` | manual | `strategos open` launches the app window, already paired |

**Demo:** with fake-claude, start 3 sessions and walk one through permission → allow → done over a WS client script. Then start one real `claude` session and watch statuses in `strategos status --watch`.
**Exit:** all tests green; the M0 fixtures replay; the listing of `CLAUDE_CONFIG_DIR` is unchanged in every integration test.
**Cut if late:** the agents-CLI half of 1.13 (keep the sessions dir); hourly `.bak`.

### M2 Terminals (11 hd). Goal: use real sessions in the browser window.

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 2.01 | UI scaffold: Vite, Preact, signals, `tokens.css` from the prototype, connection (pairing, WS, resync), `ShellBridge` browser impl | 2 | 1.06 | `ui/src/{main,app,shell-bridge}.ts*`, `state/*` | vitest store tests | Reconnects after a daemon restart without a reload |
| 2.02 | Session rows (look A) as a temporary home; New session dialog (repo from config, first prompt, name); stop and resume buttons | 2 | 2.01 | `dialogs/NewSession.tsx`, `app.tsx` | Playwright with fake-claude | Start/stop/resume from the UI |
| 2.03 | TerminalPane: xterm + fit + web-links, subscribe and replay, input, resize, `Ctrl+Alt+M`, `pty.focus` | 3 | 2.01, 1.09 | `drawer/TerminalPane.tsx` | Playwright: type, resize, replay | Real Claude usable for 30 min with no glitches beyond S3 notes |
| 2.04 | Drawer shell: header (status, ctx, ≈$, repo/branch, last), tabs Terminal/Chat/Review (Chat and Review placeholders) | 1 | 2.01 | `drawer/Drawer.tsx` | component test | Header updates live |
| 2.05 | App window: `strategos open`, pairing on launch, title badge "(n) Strategos" | 1 | 1.15 | `platform/win32/open.ts`, `ui/state/connection.ts` | manual | One command opens a paired window |
| 2.06 | Acceptance soak and fixes | 2 | all | — | Accept M2 | Below |

**Demo / Accept M2:**
1. Start 6 real sessions across 3 repos.
2. Status is right within 1 s for 30 minutes of mixed work.
3. Closing the window leaves the sessions running, and reopening restores them.
4. Killing the daemon leaves them resumable with history.

**Cut if late:** web-links addon; the look A rows' extra columns.

### M3 Map (13 hd). Goal: look B from live data.

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 3.01 | `layout.ts`: grid, sticky cells, spiral, hysteresis, pin, fold memory, ring slots, group keys | 3 | 1.02 | `map/layout.ts` | property tests: adding or removing any session or planet never moves another | 0 moves across 10 000 random edits |
| 3.02 | `MapView`, `Planet`, `Token` from `mapSvg()`: arcs, glyphs, pulse, labels, marks, dashed inferred ring, selection | 3 | 3.01, 2.01 | `map/*.tsx` | SVG snapshot per status | Matches the prototype visually (screenshot review) |
| 3.03 | NeedsStrip with waiting time and inline buttons (wired in M4) | 1 | 3.02 | `map/NeedsStrip.tsx` | component | Order follows §6 rule 5 |
| 3.04 | Keymap, spatial navigation, focus management, aria, live region | 2 | 3.02 | `keys/keymap.ts` | Playwright keyboard-only run | Every §7 key works; no focus traps |
| 3.05 | Crowding (+N badge, grid growth), reduced motion | 1 | 3.02 | `map/*` | Playwright with 30 fake sessions; `prefers-reduced-motion` emulation | No overlap at 30 sessions |
| 3.06 | Initiative visuals: hover-dim, lines, group-by toggle | 2 | 3.01 | `map/InitiativeLines.tsx` | Playwright | Lines only for the hovered or selected initiative |
| 3.07 | Planet drag + `layout.setPlanetCell` | 1 | 3.02 | `map/Planet.tsx`, `server/ws-hub.ts` | Playwright | Position survives a restart |

**Demo:** 8 sessions on 4 planets. Start a 9th: nothing moves. Stop one: nothing moves. Hover an initiative: dim and lines.
**Cut if late:** drag (3.07); the fold memory beyond the current session.

### M4 Attention (18 hd). Goal: the daily driver. Notice and act in seconds.

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 4.01 | Approve/Deny/Always end to end from strip, token, drawer, keys; audit log | 2 | 1.07, 3.03 | `PendingCard.tsx`, `hooks/pending.ts` | fake-claude e2e; real check in a sandbox | Under 5 s from request to approval without opening a terminal |
| 4.02 | Questions: held AUQ, option buttons and `1`–`9`, "Answer in terminal" | 2 | 4.01, S9 | same | fake-claude e2e | Answer reaches the model (real check) |
| 4.03 | Risk classifier + tags on token/card/strip; "Approve all low-risk" per initiative (read and write-in-repo only, with a confirmation listing each) | 2 | 4.01 | `features/risk.ts` | table test of 60 commands | No `delete`/`network`/`outside_repo` case approved by the batch (test) |
| 4.04 | Auto-deny guards: starter rules in PreToolUse; logged; read-only list in settings | 2 | 1.07 | `features/guards.ts` | fake payloads incl. obfuscations; labelled honestly | Starter rules deny in under 20 ms; each denial is visible on the token |
| 4.05 | Notifications: in-page toast, Web Notification, policy (transition-only, none at startup, ≤ 1 per 2.5 s, escalate at 5/15 min, never for the open session), favicon + title badge | 2 | 3.03 | `notify/policy.ts`, `shell-bridge.ts` | unit for policy; manual | A reload produces no notification (test) |
| 4.06 | Waiting numbers on tokens and chips; top bar "waiting now / today" | 1 | 3.02 | `topbar/TopBar.tsx` | unit | Matches `events` replay |
| 4.07 | Seen state (drawer ≥ 1.5 s, `x`), interrupted display | 1 | 1.08 | UI + reducer | e2e | The strip empties after you look |
| 4.08 | Usage gauge: 5-hour and 7-day, burn rate (slope over 30 min), ETA, park suggestion at 85% (never automatic) | 2 | 1.12 | `features/usage.ts`, `TopBar.tsx` | unit on synthetic samples | ETA within 10% on a synthetic line |
| 4.09 | Command palette over a shared action registry | 2 | 3.04 | `palette/CommandPalette.tsx`, `keys/keymap.ts` | Playwright | Every key action is also a palette command |
| 4.10 | Initiatives: create, tag at start, assign, suggestion from matching branch names (accept/dismiss; dismissals remembered) | 2 | 3.06 | `features/initiatives.ts`, dialogs | unit for matching | A suggestion never applies itself (test) |

**Demo / Accept M4:**
1. A permission in a session you aren't viewing shows strip + pulse + notification, and is approved in under 5 s.
2. With the daemon stopped, the same request shows the normal TUI dialog.
3. A guard denies `git push --force` (fake payload) and the token shows it.

**Gate G4:** dogfood for 3 working days before M5. Log annoyances in `docs/dogfood.md`.
**Cut if late:** "approve all low-risk"; the burn-rate ETA (keep the gauge).

### M5 Chat view and in-session helpers (14 hd)

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 5.01 | Transcript → `ChatItem`: user, assistant, tools paired by `tool_use_id`, Edit/Write diffs, subagent threads from `subagents/agent-*.jsonl`, compaction, interrupt markers | 3 | 1.11 | `transcript/chat-items.ts` | golden tests over fixtures | All M0 fixtures produce stable goldens |
| 5.02 | ChatPane: markdown-it (HTML off), collapsed tool cards, virtual list, keep scroll | 3 | 5.01, 2.04 | `drawer/ChatPane.tsx` | Playwright with a 5 000-item transcript | 60 fps scroll; new items within 1 s |
| 5.03 | Activity line and inline pending cards (reuse 4.01/4.02) | 1 | 5.02 | same | e2e | Pending shows in both views |
| 5.04 | Reply box: allowed only in `done`, `seen`, `interrupted` or unheld `question`; refused when `dirtyInput` (you have half-typed in the terminal); `t` toggle | 2 | 1.09, S4 | `ChatPane.tsx`, `pty/input.ts` | e2e with fake-claude | Never interleaves with half-typed input (test) |
| 5.05 | Context-full actions at 70%/85%, offered only when done: Compact (`/compact`), Hand off (`/handoff-now`, shown if the auto-handoff mod is present), Keepwarm 60m/90m/2h (the mod prints its own cost warning) | 1 | 5.04 | `drawer/*` | e2e | Buttons hidden mid-turn |
| 5.06 | Conflict warnings: file key = (`planetKey`, repo-relative path); 30-min window; warn once per change; subagents included; note to Claude via PostToolUse `additionalContext` per D9; contract-file changes mark the initiative's other sessions | 3 | 1.07, S17 | `features/conflicts.ts` | unit sequences; e2e two fake sessions in two worktrees | Matches the mod's rules plus cross-worktree and contract cases |
| 5.07 | Cache-warmth mark from `prompt_cache` (transcript fallback); Keepwarm button only when idle | 1 | 1.12, S16 | `Token.tsx`, `features/usage.ts` | unit | Turns amber under 5 min |

**Accept M5:**
1. Follow and answer a full real session in chat view only.
2. Toggling to the terminal and back loses nothing.
3. Two sessions editing the same file in two worktrees both show ⚠, and Claude acknowledges the note.

**Cut if late:** the virtual list (cap at the last 500 items); Keepwarm button.

### M6 Worktrees, review, PRs, missions (16 hd)

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 6.01 | Git module: status v2 (ahead/behind/dirty), merge-base diff stat, log; poll every 15 s for active worktrees | 2 | 1.10 | `git/git.ts` | temp-repo tests | Correct on detached HEAD and a new branch |
| 6.02 | Worktree create (dialog, setup commands, trust step from S10, `.git/info/exclude` once with consent) and safe remove (porcelain, unpushed, typed branch confirmation) | 3 | 6.01 | `git/worktrees.ts`, `dialogs/RemoveWorktree.tsx` | temp repos incl. dirty and unpushed | Dirty or unpushed work can't be removed without the typed confirmation |
| 6.03 | Review tab: diff2html, file list, "Send back with notes", "Ask to commit" | 3 | 6.01, 5.04 | `git/review.ts`, `drawer/ReviewPane.tsx` | Playwright | Notes arrive as one user turn |
| 6.04 | Review inbox: finished-with-changes queue, files, stat, last test command and its result (only if seen; otherwise "not run"), one-line summary | 2 | 6.03, S17 | `features/*`, UI | unit on test detection | Never shows "passing" without an observed run (test) |
| 6.05 | PR create (`gh pr create --draft`, editable title/body from the last summary); PR and CI poll every 60 s with backoff; marks on the token | 3 | 6.01 | `git/gh.ts`, `git/pr-poller.ts` | gh calls stubbed; one real PR on a sandbox repo | CI dot updates; backs off on HTTP 403/429 |
| 6.06 | Missions: start several linked sessions at once; contract-files editor; PR bundle with suggested merge order (contract owners first) and cross-links | 3 | 4.10, 6.05 | `features/initiatives.ts`, dialogs | e2e with fake sessions | Bundle lists every PR with links |

**Accept M6:** start in a new worktree → work → review → send back → PR → merge on GitHub → remove the worktree, all without leaving Strategos.
**Cut if late:** missions (6.06) move to M8; the merge-order suggestion.

### M7 Electron shell (8 hd)

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 7.01 | Shell: single instance, launch or connect to the daemon, load the UI, preload bridge (token via IPC, never on disk) | 2 | M6 | `shell-electron/{main,preload,daemon-launch}.ts` | manual + Playwright Electron | The browser phase still works unchanged |
| 7.02 | Tray icon, taskbar overlay badge, click → oldest blocked session | 1 | 7.01 | `tray.ts` | manual | Badge equals the strip count |
| 7.03 | Native toasts with Approve/Deny/Open (`actions`, `handleActivation`); Approve shown only for `read` and in-repo `write`; others get "Open" | 2 | 7.01, 4.05 | `toasts.ts` | manual on Win10 | Toast approve is logged with `via: toast` |
| 7.04 | Global hotkey (default `Ctrl+Alt+S`), window state | 1 | 7.01 | `main.ts` | manual | — |
| 7.05 | Packaging: esbuild daemon bundle, electron-builder NSIS unsigned; daemon runs under `ELECTRON_RUN_AS_NODE` or system Node (decide from a 1-hour test; node-pty is N-API) | 2 | 7.01 | build config | install on a clean user profile | Installs and runs without the dev tree |

**Cut if late:** packaging (run from source); global hotkey.

### M8 Remaining features and hardening (14 hd)

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 8.01 | Stuck/loop detection: same tool+input hash ×3; 3 failures in a row; ctx ≥ 90% with no Edit/Write in 10 calls; working ≥ 20 min with no tool start for 5 min (excluding a running Bash). Badge only | 2 | 1.07 | `features/stuck.ts` | sequences from fixtures | False positives under 1 per day in dogfood |
| 8.02 | Resource view: per-session process tree memory/CPU, total in the top bar, panel with Park | 2 | 1.03 | `features/resources.ts`, UI | sampler test | Within 10% of Task Manager |
| 8.03 | "While you were away" digest: idle > 10 min (UI `activity`); finished, blocked + durations, cost delta, auto-denied, errors; grouped by initiative | 2 | 1.04 | `features/digest.ts`, `dialogs/Digest.tsx` | replay tests | Matches a hand-made replay |
| 8.04 | Resume all after a reboot; autostart opt-in (Startup-folder shortcut, after your confirmation) | 1 | 1.10 | `platform/win32/autostart.ts` | manual reboot | One click restores the open set |
| 8.05 | Version guard (tested range) + `npm run contract` + `tools/record-session.ts` | 2 | 1.14 | `tools/*`, `main.ts` | run against 2.1.292 | Out-of-range version → banner, not a crash |
| 8.06 | Retention: archive/forget, fold planets, transcript age warning (V14), log rotation | 1 | 3.01 | store + UI | unit | — |
| 8.07 | Soak and performance: 20 sessions (fake) + 6 real for 4 h; list view toggle above 24 sessions | 2 | all | — | measured | Daemon < 200 MB RSS; UI < 300 MB; no event backlog |
| 8.08 | Guard rules editor and settings page | 1 | 4.04 | UI | e2e | — |
| 8.09 | Security pass: walk §10 line by line; fuzz the guards and the hook routes | 1 | all | — | checklist | Every §10 item has a test or a written exception |

**Cut if late:** list view; guard editor (edit `config.json` by hand).

### M9 macOS port (7 hd)

| id | What | hd | Dep | Files | Test | Done when |
|---|---|---|---|---|---|---|
| 9.01 | `platform/darwin`: paths, locator (`~/.local/bin/claude`, npm; never inside an `.app`), `ps`-based process ops, `open`, LaunchAgent autostart | 2 | M8 | `platform/darwin/**` | the unit suite on macOS | All platform tests pass on both OSes |
| 9.02 | Fix path and case issues; forkpty smoke test | 2 | 9.01 | various | full suite on macOS | Green |
| 9.03 | Electron dmg, `Cmd` keymap, dock badge, notifications | 2 | 9.01 | shell | manual | — |
| 9.04 | Mac acceptance (M2 + M4 scripts) | 1 | 9.03 | — | Accept M9 | — |

### 8.1 First 10 working days

| Day | Work | End-of-day output |
|---|---|---|
| 1 | M0.1 scaffold + sandbox; M0.2 hostpty starts; run **S1** basic (one event arrives) | Hook bodies on disk |
| 2 | Finish M0.2/M0.3; **S1** full; **S3** 10-minute side-by-side session | S1, S3 rows in REPORT.md |
| 3 | **S2** (+S2b if needed), **S9**, **S11**, **S12**, **S18** | The riskiest five answered |
| 4 | **S5, S4, S10, S16, S17, S14, S13, S6, S15**; S8/S7 if time; go/no-go meeting with yourself | REPORT.md + fixtures; gate **G0** |
| 5 | 1.01 scaffold; 1.02 types/protocol from §5 adjusted to findings; fixtures moved in | Gate **G1**: contracts frozen |
| 6 | 1.03 platform (lead); lanes start: A 1.04 store, B 1.11 transcript, C 1.14 fake-claude | Three PRs open |
| 7 | 1.05 config; A 1.06 server; B 1.07 hooks; C 1.09 pty | Guard tests green |
| 8 | 1.08 reducer (lead); A finishes 1.06; B 1.12 tap; C 1.10 manager starts | Reducer table tests green |
| 9 | C 1.10; B 1.13 reconciler; A 2.01 UI scaffold | Fake e2e: start → permission → allow |
| 10 | 1.15 CLI; integration with one real session; review gate **G2** | `strategos status --watch` shows a real session |

### 8.2 Traceability

| Feature | Milestone | Tasks | Gating check |
|---|---|---|---|
| Actionable notifications | M4, M7 | 4.05, 7.03 | S2, S15 (V15 for Electron) |
| Waiting time as a number | M3, M4 | 3.03, 4.06 | — |
| "While you were away" digest | M8 | 8.03 | — |
| Shared usage and rate limits | M4 | 4.08 | S5 |
| Stuck/loop detection | M8 | 8.01 | S12 (so interrupts aren't read as stuck) |
| Cache-warmth indicator | M5 | 5.07 | S16 (C2) |
| Context-full actions | M5 | 5.05 | S4 |
| Risk-tagged permission requests | M4 | 4.03 | S2 |
| Auto-deny guards | M4, M8 | 4.04, 8.08 | S1 |
| Review inbox | M6 | 6.03, 6.04 | S17 (test-result detection) |
| Git and CI on the marker | M6 | 6.01, 6.05 | — |
| Conflict warnings across repos | M5, M6 | 5.06, 6.06 | S17 |
| Surviving a restart | M1, M8 | 1.10, 1.15, 8.04 | S3 (children die with the daemon), S14 |
| Resource view | M8 | 8.02 | S13 (sampler cost) |
| Tray icon with blocked-count badge | M2, M4, M7 | 2.05, 4.05, 7.02 | — |
| Command palette | M4 | 4.09 | — |
| Initiative grouping (hover-dim, lines, toggle, tagging, missions, suggestions) | M3, M4, M6 | 3.06, 4.10, 6.06 | — |

### 8.3 Effort

| Milestone | M0 | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 | M9 | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hd | 9 | 29 | 11 | 13 | 18 | 14 | 16 | 8 | 14 | 7 | **139 hd ≈ 70 dev-days** |

- **One developer working serially with Claude:** 14 weeks of task time. With 15% for review and rework, the range is **13–16 weeks** to Windows + Mac v1, or **12–15 weeks** for Windows only (M0–M8).
- **With 3 sub-agent lanes from day 6 (§11):** calendar time is about **9–11 weeks**, because review gates and the single shared contract stay serial.
- **Daily use** starts at the end of M4: 80 hd, about **6 weeks** in lanes or 8 weeks serially.

**Against the earlier 7–9 weeks (9.5–11.5 with the features):**
- *Optimistic* there, because it had no budget for:
  - session lineage, interrupts, seen state and the transcript reconciler (review gaps 1–4);
  - pairing-based security;
  - the fake-claude harness and contract fixtures that make Claude Code churn survivable;
  - 18 spike checks instead of 10;
  - Windows-specific process sampling;
  - missions and contract files.
- *Pessimistic* in three places:
  - Node's built-in TypeScript and Preact remove build plumbing;
  - about 2 days of Bot Crossing ports;
  - parallel lanes compress calendar time.
- The serial number is the honest one for a single person reviewing everything.

---

## 9. Test strategy

**Fixture recording.**
- M0's `hooklog.ts` saves every raw hook body, status-line JSON and transcript slice under `fixtures/claude/<version>/`.
- From M8, `tools/record-session.ts` re-records them. It runs a scripted real session in `C:\dev\strategos-sandbox` covering: plain turn, Bash permission, Write permission, AskUserQuestion, subagent, `/compact`, `/clear`, Esc interrupt and a failing Bash.
- Recording redacts: home path → `~`, inputs over 2 KB cut, and no file contents beyond the probe files.

**Replay and contract tests (`npm run contract`).**
- Every fixture version directory is fed through the hook parser, the reducer and `chat-items`.
- Outputs are compared with golden files.
- Run this after every Claude Code update (`claude --version` change detected at daemon start → banner "run contract tests").
- A new version that passes gets added to `testedRange`.

**Fake `CLAUDE_CONFIG_DIR` harness** (the idea from Bot Crossing's `harness.test.mjs`).
- `tools/fake-claude-home.ts` builds a temp dir with `projects/<enc>/<id>.jsonl`, `sessions/<pid>.json` and subagent folders.
- Every reconciler and transcript test runs against it.
- Each test asserts `listing(root)` before equals after: the daemon writes nothing there.
- The same guard is enforced at runtime by `safe-fs`, which throws on any write path under the Claude config dir. It has its own unit test.

**Real `~/.claude` assertion.**
- The M0 and acceptance scripts run `tools/snapshot-claude-dir.ts` before and after.
- `settings.json` and `settings.local.json` hashes must be equal.
- Claude itself writes to `~/.claude` (transcripts, the sessions folder), so a whole-folder hash can't isolate Strategos on a real machine. That guarantee comes from `safe-fs` (the daemon's only write path) and from the fake-home tests above.

**Windows-specific tests** (all must run on Windows; nothing skipped as "posixOnly"):
- **Locator:** extensionless shim + `.cmd` + `.exe` combinations; a bundle path refused.
- **Paths:** canonical drive case, `\\?\C:\` and `\\?\UNC\` kept apart, forward vs back slashes, project-dir encoding including the over-200-character hash case [docs].
- **ConPTY:** spawn, resize, exit code, `killTree` of grandchildren. Plus the crash test: start a daemon child, kill it hard, and assert its pty children are gone within 5 s.
- **Status-line tap:** runs under Git Bash and under PowerShell.

**UI tests.**
- Vitest + `@testing-library/preact` for components and `layout.ts` (property tests).
- Playwright `channel: 'msedge'` end-to-end against a daemon with fake-claude: approve from the strip, keyboard-only run, reduced motion, 30-session crowding, initiative hover, palette.

**Testing permission flows safely.**
- Automated tests use fake-claude only. It posts PermissionRequest/PreToolUse payloads with frightening commands (`rm -rf /`, `git push --force`) as **strings**; nothing executes them.
- Real-Claude manual tests use only the sandbox repo:
  - with deny rules for `rm`, `del`, `Remove-Item` and `git push`;
  - with prompts that write probe files;
  - in the default permission mode, never bypass.
- Guards are tested on payloads, not on effects.

**Manual acceptance:** `docs/acceptance/M1.md…M9.md`, one numbered script per milestone (the "Demo / Accept" lines above), signed off in `docs/dogfood.md`.

---

## 10. Security and safety

| Item | Rule |
|---|---|
| Binding | `127.0.0.1:<config.port>` only. Refuse to start if config asks for `0.0.0.0` or a LAN IP. No LAN mode exists |
| Host | Exactly `127.0.0.1:<port>` or `localhost:<port>`; anything else → 421 (stops DNS rebinding) |
| Origin (UI routes) | Exactly `http://127.0.0.1:<port>`, plus in dev the one explicit `STRATEGOS_DEV_ORIGIN` (Vite). Hostname-only matching (Bot Crossing's) is **not** enough: another local dev server on `:3000` would pass |
| Session token | One-time pairing code (32 random bytes) generated when the daemon opens the window. It goes in the URL **fragment** (`#pair=`), so it never reaches logs. The UI POSTs it to `/api/pair` (single use, 60 s life) and receives an HttpOnly, SameSite=Strict cookie. **Every** HTTP request and the WebSocket upgrade require the cookie plus the Origin. In Electron the token goes over IPC instead. `daemon.json` holds no token |
| Hook routes | `/hook/<strategosId>/<Event>` only. **Refuse any request carrying an `Origin` header** (hooks never send one; browsers always do). Require `X-Strategos-Token` equal to that session's token (constant-time compare). Unknown session → 404 with an empty body (= no decision). A hook token can only report events for its own session. It can never decide a request |
| Body caps | Hooks 8 MiB (large Write inputs); status line 256 KiB; UI commands 64 KiB; WS frames 1 MiB. Over the cap → 413 and the connection closed |
| Rate limits | Pairing 5/min; hook routes 200/s per session |
| Secrets | Hook tokens live in memory and in each child's env (`STRATEGOS_HOOK_TOKEN`), never in files or on command lines. `~/.strategos` gets a user-only ACL at creation (`icacls /inheritance:r /grant:r <user>:F`) |
| Same-user honesty | Any process running as you (including Claude's own Bash tool) can read your files and process list. Strategos can't fully stop a session from reading its own env token or poking at `~/.strategos`. Mitigations: decisions require the UI cookie; the injected settings add deny rules `Read(~/.strategos/**)` and `Edit(~/.strategos/**)` (S1 checks the syntax); every decision lands in the audit log with its connection id. This is a **safety net, not a sandbox**, and the UI says so in Settings |
| Auto-deny guards | Labelled in the UI: "Safety net, not a security boundary. Pattern matching on command text can be bypassed; your own `deny` rules remain the real control." Guards only deny, never allow |
| Fail open | Daemon down, timeout or unknown session → no decision → the normal TUI dialog. Strategos never auto-approves. Held requests are released 30 s before their timeout |
| Toast approvals | Only for `read` and in-repo `write`, and the toast shows the command or path |
| Audit log | `audit.jsonl` (§5): every decision, release, answer, batch approve and guard deny, kept 180 days, viewable in the UI |
| No network exposure | No telemetry, no update checks; `gh` and `git` are the only network users, plus Claude itself |
| Other apps' binaries | ClaudeLocator accepts only `config.claudePath`, the npm global `claude.cmd` → `…\@anthropic-ai\claude-code\bin\claude.exe`, or `%USERPROFILE%\.local\bin\claude.exe`. It refuses paths under `Program Files\Claude`, `%LOCALAPPDATA%\AnthropicClaude`, `WindowsApps`, `Packages\Claude_*` and any `.app` bundle. The desktop app's bundled 2.1.295 is never used |
| `~/.claude` | Never written (`safe-fs`). Never use `claude://resume` links (they fork the transcript [review, code]). Never "fix" titles in Claude's files |
| Env scrubbing | Child env drops `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` and `ANTHROPIC_*` (keys outrank `/login`), **keeps** `CLAUDE_CONFIG_DIR`, then applies `config.env.keep` and `env.set` |
| Licence | Ported Bot Crossing code keeps its MIT notice in `THIRD_PARTY_NOTICES.md` (copyright 2026 Jarren Rocks), plus a header comment `Adapted from Station-Sciences/bot-crossing <file> (MIT)` in each ported file. Never use the name "Bot Crossing" or its character designs (post-16 Sep 2026 designs are reserved [review]). Add node-pty, xterm.js, Preact, diff2html and markdown-it notices at packaging |

---

## 11. Parallel work plan

Rules for sub-agents:
- Each lane works in its own git worktree and branch. It merges by PR after `npm run check`.
- `packages/shared` has **one owner** (the lead). A lane needing a contract change opens a small PR to `shared` first.
- Each agent receives: this plan (its sections), the frozen `shared` types, the fixtures, the task rows (with "done when" as the definition of done), and the files it owns. It must not edit other lanes' directories.

| Lane | Owns | Tasks (in order) | Needs as input |
|---|---|---|---|
| Lead | `shared/`, `sessions/state-machine.ts`, reviews | 1.01, 1.02, 1.08, 1.15; gates | REPORT.md |
| A: Server & store | `daemon/src/{store,server,config.ts,safe-fs.ts}` | 1.04, 1.05, 1.06 → 2.05 → 7.01–7.05 | §5 files table, §10 |
| B: Claude adapters | `daemon/src/{hooks,statusline,transcript,reconciler}` | 1.07, 1.11, 1.12, 1.13 → 5.01 → 5.06, 5.07 | Fixtures, §6 |
| C: Process & platform | `daemon/src/{platform,pty,sessions/manager.ts,sessions/launch.ts}`, `tools/` | 1.03, 1.09, 1.14, 1.10 → 8.02, 8.04 → 9.01–9.02 | §4 interfaces, S3/S13 notes |
| D: UI | `packages/ui/` | 2.01–2.04 → 3.01–3.07 → 4.x UI parts → 5.02–5.05 | prototype look B, §7, protocol |
| E: Git & review (from M3) | `daemon/src/git/`, `features/{risk,guards,stuck,usage,digest,initiatives,conflicts}.ts` | 4.03, 4.04, 4.08, 4.10 (daemon parts) → 6.01–6.06 → 8.01, 8.03 | §5, §8 task rows |

**Review gates** (the lead signs each one in `docs/gates.md`):

| Gate | Opens | Checks |
|---|---|---|
| G0 | M1 | REPORT.md complete; go/no-go |
| G1 | Lanes A–C | `shared` frozen; fixture set agreed |
| G2 | UI lanes on real data | Fake-claude e2e green; listing-unchanged tests green |
| G3 | M3 | M2 30-min soak passes |
| G4 | M5 | 3 days of dogfood |
| G5 | M7 | M6 full flow |
| G6 | M8 | Installer works |
| G7 | v1 | §10 checklist; M8 soak |

**No two lanes touch the same file.** The two shared touch points are `ws-hub.ts` command routing (lane A owns it; others send a one-line registration PR) and `TopBar.tsx` (lane D owns it).

---

## 12. Risk register (ranked)

| # | Risk | Early warning | Fallback | Retired in |
|---|---|---|---|---|
| R1 | PermissionRequest can't be held, or a hidden cap kills the hold | S2: dialog never appears, or the hook dies at about 600 s | S2b keystrokes; auto-release before the cap; else "open terminal" approvals | M0 |
| R2 | Windows 10 ConPTY can't render the fullscreen TUI or mods well | S3 garbling; M2 soak glitches | `useConptyDll`; classic TUI; **external-window mode** (`wt`/`cmd /k` per session; the Map still gets hooks; reply via the "open" button); Option E | M0 / M2 |
| R3 | Claude Code churn: transcript format "internal", hooks evolve, Agent View is a research preview | Contract test diff; reducer `drift` logs | Version guard banner; tolerant parsing; hook-only status; fixtures per version | Ongoing; harness in M8 |
| R4 | Session identity churn (`/clear` from auto-handoff, `/resume`, `/branch`) breaks tracking | S11; a token goes stale after a handoff | Lineage; reconciler from the sessions file | M0 / M1 |
| R5 | Agent View moves a session out of our pty (`←`, `/bg`) | S18 | `disableAgentView`; `open_elsewhere` state | M0 |
| R6 | Workspace trust silences hooks and the status line in new worktrees | S10 | `trust_pending` state, detected from pty text | M0 / M6 |
| R7 | Interrupts invisible | S12 | Keystroke flag + transcript markers | M0 / M1 |
| R8 | A session reads its own token or `~/.strategos` and tries to self-approve | Audit log shows decisions without UI input | Cookie-bound decisions; deny rules; honest labelling | M1 / M8 |
| R9 | Status-line override clashes with your or a mod's display | S5 | Chain; `statusLine.mode: "off"` (transcript fallback) | M0 |
| R10 | Reply injection collides with half-typed input | S4; dogfood | `dirtyInput` refusal | M5 |
| R11 | Memory: 0.6–0.8 GB per session [write-up, verified] | Resource view total > 70% of RAM | Park suggestions | M8 |
| R12 | Transcripts deleted after 30 days, so old sessions can't resume | Resume error "No conversation found" | Age warning; archive | M8 |
| R13 | Electron + node-pty or packaging friction | 7.05 one-hour test | Keep the daemon on system Node; ship the browser mode | M7 |
| R14 | `gh` rate limits or auth expiry | 403/429 from the poller | Backoff, cached state, "gh needs login" banner | M6 |
| R15 | Effort overrun | Milestone over by more than 30% | Cut lists per milestone; M8/M9 slip, M4 is protected | Each gate |
| R16 | First-party overlap (Agent View gains an approve API) | Changelog | Adopt it as the transport; keep the Map | Watch |

---

## 13. Open questions and the "start tomorrow" checklist

| # | Question | Recommended default |
|---|---|---|
| Q1 | Repo location and hosting? | `C:\dev\strategos`, private GitHub repo under Amel-DZRV, MIT licence |
| Q2 | Worktrees inside the repo (`.claude/worktrees/<name>`) or beside it? | Inside, if S10 shows trust carries over; otherwise beside it (`C:\dev\<repo>.worktrees\<name>`) |
| Q3 | May Strategos replace your status line inside its own sessions (chaining your original)? | Yes, chained |
| Q4 | Turn off Agent View (`←`, `/bg`) inside Strategos sessions? | Yes |
| Q5 | Keep session-tracker active inside Strategos sessions? | Keep it; Strategos adds only what it can't do (D9) |
| Q6 | Allow Approve straight from a Windows toast? | Only for read and in-repo write, with the command shown |
| Q7 | Start Strategos at login? | Off; opt-in toggle in M8 |
| Q8 | Which repos go in the first `config.json`? | The ones you run sessions in this week; others added from the New session dialog |

**If we start tomorrow:**
- [ ] Answer Q1–Q8 (defaults are fine).
- [ ] Create `C:\dev\strategos` (git init) and `C:\dev\strategos-sandbox` (M0.1).
- [ ] Close any desktop-app session working in the sandbox repo.
- [ ] Note `claude --version` (2.1.292) and do **not** run `claude update` until M0 is done.
- [ ] Record SHA-256 of `~/.claude/settings.json` (`spike/hash-claude-dir.ts`).
- [ ] Day 1: M0.1 and M0.2, then S1. Day 2: S3. Day 3: S2, S9, S11, S12, S18. Day 4: the rest, then the go/no-go decision.
- [ ] Copy §5 into `packages/shared/src` on day 5, adjusted for spike findings, and freeze it (G1).
- [ ] Create `THIRD_PARTY_NOTICES.md` before the first Bot Crossing port.
- [ ] Keep `docs/dogfood.md` open from M2 on.

---

## 14. Appendix

### 14.1 Bot Crossing port list (MIT, read-only source in the scratchpad `botx\`, `botx2\`)

| File | Take | Target | Effort | Licence note |
|---|---|---|---|---|
| `server/lib/fsutil.mjs` | `readHead`, `readTail`, `jsonLines`, `num` [code]. **Rewrite** `findExecutable` (no PATHEXT [code]) | `transcript/fsutil.ts`, `platform/win32/locator.ts` | 2 h | Notice + header |
| `server/harnesses/claude-code.mjs` | `firstText`, `cleanPrompt`, `readTranscriptMeta` (custom > ai > summary > first prompt), `awaitingReply` (+ interrupt markers, system records), mtime-keyed meta cache | `transcript/parse.ts` | 0.5 day | Notice + header |
| `server/scan.mjs` | `canonical` (drive case, `\\?\` but not `\\?\UNC\`), `disambiguateProjects` label growth | `platform/win32/paths.ts`, `map/layout.ts` labels | 2 h | Notice + header |
| `server/api.mjs` | Serialised `writeState` with unique temp names; `readJsonBody` limit; opener via `rundll32 url.dll,FileProtocolHandler`. `isLocalRequest` **rewritten** stricter | `store/state-store.ts`, `server/guards.ts`, `platform/win32/open.ts` | 0.5 day | Notice + header |
| `server/lib/windows.mjs` | Window fronting by pid (browser phase) | `platform/win32/open.ts` | 2 h | Notice + header |
| `server/lib/win-terminal.mjs` | `wt.exe` / `cmd /k` launch, only for the R2 external-window fallback | `platform/win32/terminal.ts` (only if R2 fires) | 1 h | Notice + header |
| `src/world/plots.js` `allocateCells` | The idea only (previous layout as input, newcomers innermost, hysteresis, re-seed if disconnected) on a square grid | `map/layout.ts` | 0.5 day | Idea; no code copied |
| `src/game/colony.js` | Sticky `slotOf` loop; single precedence function | `map/layout.ts`, `shared/status-rank.ts` | 2 h | Notice if copied |
| `src/main.js` | `chimeForNewWaiting` policy; poll on focus/visibility | `notify/policy.ts`, `ui/state/connection.ts` | 1 h | Notice + header |
| `src/game/merge-state.js` | Only "refuse to save before read" | `store/state-store.ts` | — | Idea |
| `src/game/errands.js` | Subagents as children, never needs-you | §6 rule 3 | — | Idea |
| `src/ui/hud.js` | `escapeHtml`; set-only-if-changed; keep scroll across repaints | UI conventions | — | Idea |
| `test/harness.test.mjs`, `scan.test.mjs`, `state.test.mjs` | Fake `CLAUDE_CONFIG_DIR` fixtures, `listing()` read-only assertion, path cases | `tools/fake-claude-home.ts`, tests | 0.5 day | Method; notice if copied |
| Everything 3D, audio, assets, `.claude/skills`, other harnesses | Skip | — | — | Skills read as data only; no instruction in them was followed |

### 14.2 Docs and sources used (fetched 11 Oct 2026)

- https://code.claude.com/docs/en/hooks: events list, PermissionRequest output, http hooks and headers, Stop on interrupt, PreToolUse for AskUserQuestion, workspace trust, SessionEnd budget, defaults.
- https://code.claude.com/docs/en/sessions: `/clear`, `/branch`, resume restores and non-restored flags, two writers, storage, 30-day retention, `CLAUDE_CONFIG_DIR`.
- https://code.claude.com/docs/en/statusline: fields including `prompt_cache` and `rate_limits`, Windows Git Bash, debounce, trust.
- https://code.claude.com/docs/en/settings: `--settings` precedence and scope, list merge, file watching.
- https://code.claude.com/docs/en/cli-reference: `--session-id` UUID, `--settings` 2 MiB, `--fork-session`, `--bare`/`CLAUDE_CODE_SIMPLE`, `agents`, `attach`, `daemon`.
- https://code.claude.com/docs/en/agent-view: `agents --json` fields, `/bg` and `←`, `disableAgentView`, idle reaping, two-writer refusal.
- https://www.electronjs.org/docs/latest/api/notification: Windows `actions`, `toastXml`, `handleActivation`.
- https://unpkg.com/node-pty@1.1.0/typings/node-pty.d.ts: `useConpty`, `useConptyDll` (experimental), `IPty`.
- Local runs: `claude --version` (2.1.292), `node` (24.21.0, runs `.ts`), `git` (2.40.1), `where claude`, `PATHEXT`, `~/.claude/sessions/*.json` fields, transcript grep (interrupt markers, record types, `ephemeral_*` fields). The only writes were a 3-line `.ts` file in the scratchpad and this plan.
