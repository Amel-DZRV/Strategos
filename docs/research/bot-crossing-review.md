# Bot Crossing review, for Strategos

Status: advisor pass, 11 Oct 2026. Source: `Station-Sciences/bot-crossing` (MIT, copyright 2026 Jarren Rocks), fetched read-only through `gh api` into the scratchpad. Nothing from the repo was installed, run or invoked. Its `.claude/skills` files were read as data only.

Claim tags used below: **[code]** = read in the repo's source, **[docs]** = read in the repo's README, DECISIONS or skill files, **[inferred]** = my reasoning, not shown by code or a run. Section 8 lists what I did not read.

---

## 1. Verdict

**Adapt a few small pieces. Ignore the rest.** Bot Crossing is a read-only observer. It scans every Claude Code session on disk and paints a 3D colony, and it cannot approve, reply, start, stop or host anything. About 90% of the repo is three.js rendering, audio and asset tooling, and none of that applies to a 2D SVG Map. What *does* apply is small, cheap and valuable:

- the transcript-reading helpers (safe head and tail reads, title rules, "whose turn is it");
- the sticky layout rules (a place never moves because something *else* changed);
- the localhost-server hardening, which Strategos should copy and then tighten;
- above all, the list of traps it hit on real machines.

Its biggest lesson for Strategos is negative. Without hooks, a transcript cannot tell "waiting for permission" from "running a tool", so Bot Crossing shows a blocked session as busy. That confirms the plan's hook-first design. It also exposes three things the plan has not covered: session-id churn (`/clear`), user interrupts, and a "seen" state for finished sessions.

## 2. How it works

### 2.1 From disk to pixels

| Step | What happens | Where |
|---|---|---|
| 1 | The browser polls `GET /api/threads` every **15 s**. It also polls on window `focus`, when the tab becomes visible, 1.8 s after "Open" and 6 s after "New" | `src/main.js` [code] |
| 2 | The server asks each detected harness adapter for its threads. An adapter that throws is skipped, so the rest still show | `server/scan.mjs` [code] |
| 3 | The Claude adapter merges two stores. One is the desktop app's per-thread JSON records. The other is the CLI's `~/.claude/projects/<enc-cwd>/<id>.jsonl` transcripts. It then probes `~/.claude/sessions/<pid>.json` for live pids | `server/harnesses/claude-code.mjs` [code] |
| 4 | Project names are disambiguated (`1/foo`, `2/foo`), the list is sorted by recency, and colony-only archives are applied | `scan.mjs`, `api.mjs` [code] |
| 5 | The page flattens subagents into "errand" threads. It applies "viewed" timestamps, marks first-seen ids, and calls `colony.setThreads()` | `main.js`, `errands.js` [code] |
| 6 | `statusFor()` maps each thread to one behaviour. The plot allocator places repos, and the renderer animates bots, badges and sound | `colony.js`, `plots.js` [code] |

The thread shape is: `id` (prefixed `claude-code:<uuid>`), title, preview, project, projectPath, worktree, cwd, gitBranch, model, effort, createdAt, lastActivityAt, lastFocusedAt, running, unread, hasError, archived, sizeBytes, canOpen, subagents, and an opaque `ref` the browser hands back on actions [docs: harnesses/README].

### 2.2 How it decides running, waiting, error and done

There are no hooks, so status is inferred [code, `scanThreads`]:

- **Live:** a `~/.claude/sessions/*.json` record exists *and* `process.kill(pid, 0)` succeeds. The file's own `status` field is ignored.
- **Fresh:** the transcript's mtime (or the desktop record's stamp, whichever is later) is under **30 min** old.
- **Waiting on you** (`awaitingReply`): read the last 64 KB of the transcript and walk back to the last `user` or `assistant` record. A `user` record (prompt, tool result) means the model speaks next, so it is *not* waiting. An `assistant` record with no `tool_use` (and `stop_reason` ≠ `tool_use`) means the turn was handed back, so it is waiting.
- **running** = live AND fresh AND not waiting. **unread** = the desktop record moved after `lastFocusedAt`, or it is waiting.
- **Error:** only from the desktop record's `error` field. A CLI-only thread can never show as errored.
- **Precedence** (`statusFor`, first match wins): error → working → PR merged → waiting → dormant (>3 days) → idle. Only waiting, error, working and merged get a badge [code].

What this cannot see [inferred from the logic above]:

- A session blocked on a **permission dialog** ends in an assistant `tool_use`, so it reads as *working*.
- An **Esc interrupt** leaves a final `user` record (the "interrupted" marker), so it reads as *working* until the 30-min window runs out.
- A **freshly started session** with no transcript yet reads as *working* (live, fresh, no file to test).

### 2.3 Stale, crashed and ghost sessions

- **Pid registry files outlive their process**, so every pid is probed before it counts. There is no pid-reuse check (no `procStart` comparison) [code].
- **Liveness alone is not activity.** The desktop app pre-warms idle threads, and real data showed warm processes 16 h to 3 days idle. Hence the 30-min freshness gate [code comment].
- **Subagents:** only walked for live parents; abandoned after 10 min without a write; finished once their own transcript hands the turn back [code + tests].
- **Ghost records:** "a record with no transcript, no title, no live process, older than 10 min" is dropped [code].
- **Departures:** anything missing from a scan walks back to the ship. There is no explicit "crashed" state [code].

### 2.4 Polling and caching

- **No server-side result cache.** Every request re-walks all project folders and stats every transcript.
- **Head metadata** (192 KB head read) is cached per session against mtime. Subagent briefs (64 KB head) use the same cache, pruned per pass.
- **The 64 KB tail read** happens on every poll, for each live-and-fresh thread.
- **Desktop data dir** (MSIX or not) is resolved once at import.
- **Harness detection** runs on every scan.
- **One poll at a time:** a `polling` flag drops overlapping polls, and polls are parked while a plot is being dragged [code].

### 2.5 The sticky layout, in plain words

Repos are blobs of hex cells; threads are buildings in slots inside a blob (`allocateCells` in `src/world/plots.js`, slot code in `colony.js`) [code]:

1. **Last layout is an input.** A repo that needs the same number of cells keeps exactly those cells.
2. **A growing repo** keeps its cells and claims free neighbours, hugging its own root first and then the map centre.
3. **A shrinking repo** gives back the cells it claimed most recently. Growing then shrinking restores the original shape.
4. **Hysteresis:** a cell is only handed back once the repo is 3 threads past the boundary. This stops flapping when one thread is archived and another started.
5. **A brand-new repo** takes the innermost free cell in spiral order. Existing repos grow first, so a newcomer cannot steal their growth cell.
6. **If a repo's root cell is taken**, it is re-seeded rather than quietly re-rooted. **If the whole map ends up in disconnected islands**, it is laid out afresh, as the lesser evil.
7. **Memory** holds up to 80 repos (least recently seen evicted). Hidden or dormant repos are refreshed so they come back to their old ground. Layout is persisted to `data/colony.json` and is user-draggable.
8. **Slots inside a repo:** the first assignment goes oldest-thread-first. After that a thread keeps its slot for life, and freed slots are reused lowest-first. The code comment records the bug this fixed: numbering by list position made one archive shift every sibling.

### 2.6 Actions and local state

- **Open:**
  - deep link `claude://claude.ai/epitaxy/local_<id>` (navigates the desktop app);
  - fallback `claude://resume?session=<id>` (imports, which forks — see §3);
  - or `claude --resume <id>` in a new terminal;
  - or, on Windows, front the terminal window already hosting the live pid.
- **New:** `claude://code/new?folder=`, or bare `claude` in a terminal.
- **Archive, Hide repo, Viewed:** colony-only.

The only file it writes is `data/colony.json` [code, docs]. The browser owns that file and PUTs it whole, with optimistic concurrency (409 plus a three-way merge on the client) [code].

## 3. What it learned the hard way

"Hits Strategos?" assumes the current plan: own sessions only, hooks, node-pty.

| # | Trap | What Bot Crossing does | Hits Strategos? |
|---|---|---|---|
| 1 | **MSIX/Store install** redirects the desktop app's `%APPDATA%\Claude` to `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`; the classic path does not exist [code] | Globs `Packages\Claude_*`, picks whichever has `claude-code-sessions` | **No.** Strategos never reads the desktop store. Yes only if you add "import desktop sessions" later |
| 2 | macOS ships under `Claude` *and* `Claude-3p`; an empty leftover dir looks like "no app" [code] | Picks the dir that holds records | No (same reason). Note for the Mac port if desktop data is ever read |
| 3 | **Drive-letter case**: `C:\…` and `c:\…` both appear for one checkout; project-dir encoding keeps whatever case was given [code, tests] | Canonicalises (lower drive, strips `\\?\` but not `\\?\UNC\`) before comparing | **Yes.** Planet keys from hook `cwd`, git output (forward slashes) and your own spawn paths will disagree. Canonicalise once |
| 4 | Same folder name, two checkouts (`ws1/foo`, `ws2/foo`) [code] | Grows the label leftward only where names collide | **Yes**, for planet labels. Key planets by canonical git common dir, not name |
| 5 | **Desktop pre-warms idle sessions**: a live process can mean days idle [code comment] | 30-min activity gate | Partly. `claude agents --json` and `sessions/*.json` will list these; filter to your own ids (the plan does). A pre-warm of a Strategos session opened once in the desktop app will trip your single-writer guard. That is correct, but say "open in desktop app", not "error" |
| 6 | **Resume twins**: resuming a thread already open in the app writes a second, untitled desktop record [code] | Merges by CLI id, keeps the titled one canonical, keeps both ids so archive covers the ghost | No for the store. The lesson applies to Strategos's own table: one Strategos record must be able to own several Claude session ids (see §5, gap 1) |
| 7 | **`claude://resume` imports**: it creates a second, untitled session and rewrites the `.jsonl` [docs, code] | Used only when nothing can be navigated to | **Yes, if you add "Open in Claude app".** Never offer it for a running Strategos session, and warn on stopped ones |
| 8 | **Ghost sessions**: empty desktop records, deleted-in-app threads whose transcript remains (`deleted_<cliId>` marker) [code, tests] | Drops empty records; reports deleted ones as archived | Mostly no. But Strategos needs its own archive/forget, or stopped sessions pile up forever |
| 9 | **Half-written JSONL**: partial last line, malformed lines; briefs up to 17 KB; transcripts up to ~12 MB [code] | `readHead` drops trailing partial line, `readTail` drops leading partial line, `jsonLines` skips bad lines; reads bounded chunks | **Yes.** The chat-view tailer must keep a byte offset, hold an unterminated last line until its newline arrives, decode UTF-8 across chunk edges, and reset if the file shrinks |
| 10 | Desktop record `lastActivityAt` lags (written on focus) [code] | Uses max(record, transcript mtime) | No (no desktop store) |
| 11 | **"Unread" never clears** if you answered elsewhere [code, README] | `viewedAt` timestamp: hides the hand until the thread moves again | **Yes.** "Done" sessions need a seen/acknowledge state or the Needs-you strip fills up (gap 4) |
| 12 | **Interrupt ≠ error**: Esc or a user abort must not show red [tests for Codex/OpenCode] | Codex: `turn_aborted` is not an error; OpenCode filters "aborted/denied" text | **Yes**, and it is worse for you: Strategos must notice the interrupt at all (gap 2) |
| 13 | **Windows window fronting**: `SetForegroundWindow` is refused for background processes [code] | PowerShell walks the parent chain to the first windowed ancestor, restores it if minimised, sends a fake Alt key, then fronts it; skips the desktop app and `explorer`; 8 s budget | Partly: notification click → bring Strategos forward (browser-window phase), and the "external terminal" fallback if S3 fails. Electron has its own focus rules |
| 14 | **Windows URL opening**: `explorer.exe <url>` drops query strings; `cmd /c start` expands `%xx` escapes [code comment] | `rundll32 url.dll,FileProtocolHandler <url>` | **Yes**, before Electron (open a PR URL, reveal a folder). In Electron use `shell.openExternal` |
| 15 | **Opening a terminal on Windows**: `wt.exe -d <cwd> …`, else `cmd /c start "" cmd.exe /k …` [code] | As stated | Only for the external-terminal fallback |
| 16 | **Finding `claude` on Windows**: `findExecutable` ignores `PATHEXT`, so it can find the extensionless npm sh shim or miss `claude.exe`. The Windows test is skipped (`posixOnly`) [code; failure is inferred] | (likely broken) | **Yes.** The plan's ClaudeLocator must use PATHEXT and prefer the real `.exe`. Run its tests on Windows |
| 17 | **Never run binaries from another app's bundle** (a revoked cert made macOS trash two apps) [docs] | Only `PATH` or user-home binaries | Yes on the Mac port: do not use the desktop app's bundled `claude`. On Windows that bundled 2.1.295 copy is equally off-limits |
| 18 | **Writing to the harness's records does not stick**: the app serves an in-memory copy and rewrites the record [docs] | Stopped writing entirely | **Yes, as a rule:** never edit `~/.claude` files to "fix" a title or state. Already your stance; keep it a test |
| 19 | **Two tabs, one state file**: a shared `.tmp` raced on rename (ENOENT → lost save); a save before the first read wiped 50 archives to 11 [code] | Serialised write queue, unique temp names, 409 + three-way merge, "refuse to save before read" | **Yes.** `state.json` writes need a queue and unique temp names. With the daemon as sole writer the merge is unnecessary, but the "never write before load" guard is not |
| 20 | **CSRF and DNS rebinding** on a localhost server that can launch things [code] | Host allow-list + Origin check; POST without Origin refused | **Yes**, and Bot Crossing's version is too loose for you (gap 6) |
| 21 | **LAN serving** exposes titles, prompts and paths with no password [docs] | Opt-in env var, documented risk | Do not offer this. Approve is code execution |
| 22 | `CLAUDE_CONFIG_DIR` moves `~/.claude` [code] | Honoured | **Yes.** The plan hard-codes `%USERPROFILE%\.claude`, and the env scrubber must not drop this variable |
| 23 | **Notification spam**: a reload, or many arrivals at once [code] | Chime only on transition into waiting; never on first roster; ≤ 1 per 2.5 s | **Yes**, copy as is |
| 24 | **Docs drift inside the repo**: README still describes `isArchived` writes and `/api/archive`; the skill's adapter reference still lists `setArchived`/`appStartedAt` that DECISIONS removed [docs] | — | Lesson only: trust code over prose, theirs and ours |

## 4. Reuse map

Licence: all code is MIT. Keep the copyright and permission notice in a `THIRD_PARTY_NOTICES` file for anything ported. The name "Bot Crossing" is reserved: do not use it in Strategos's name or UI. Crew character designs created after 16 Sep 2026 are reserved; earlier designs stay under their original licence. Strategos uses none of them anyway. Bundled art (KayKit, Kenney) is CC0 and irrelevant to an SVG Map.

| File | Verdict | What to take | Effort |
|---|---|---|---|
| `server/lib/fsutil.mjs` | **Port** (→ TS) | `readHead`, `readTail`, `jsonLines`, `num`. Rewrite `findExecutable` with PATHEXT | 1–2 h |
| `server/harnesses/claude-code.mjs` | **Port parts** | `firstText`, `cleanPrompt`, `readTranscriptMeta` (title order custom > ai > summary > first prompt), `awaitingReply` (add interrupt and system-record handling), `subagentTask`, the mtime cache pattern. Skip the desktop store, deep links and the worktree regex (use git) | 0.5 day |
| `server/scan.mjs` | **Port** `disambiguateProjects` + `canonical` | Planet labels and path keys | 2 h |
| `server/api.mjs` | **Adapt** | Serialised `writeState` with unique temp files; `readJsonBody` with size limit; `resolveFolder` checks. Rewrite `isLocalRequest` stricter (gap 6). Skip `present`/opening | 0.5 day |
| `server/lib/windows.mjs` | **Adapt (optional)** | Front a window by pid, for the browser-window phase and external-terminal fallback | 2 h |
| `server/lib/win-terminal.mjs` | **Adapt (fallback only)** | `wt.exe`/`cmd /k` launch | 1 h |
| `server/lib/terminal.mjs`, `xdg.mjs` | Skip | Linux only | — |
| `server/harnesses/codex.mjs`, `opencode.mjs` etc. | Skip | Read only to compare: Codex and OpenCode have explicit turn-lifecycle records; Claude transcripts do not | — |
| `src/world/plots.js` (`allocateCells`, `growBlob`) | **Rewrite the idea** | Sticky planet placement on a grid (§2.5). Hex maths not needed | 0.5 day |
| `src/game/colony.js` | **Port two snippets** | Sticky ring slots (`slotOf`) and the single `statusFor` precedence function | 2 h |
| `src/main.js` | **Port two snippets** | `chimeForNewWaiting` (notification policy); poll on focus/visibility | 1 h |
| `src/game/merge-state.js`, `api.js` | Skip (copy only if the UI writes whole state) | Daemon is sole writer. Keep the "refuse to save before read" idea | — |
| `src/game/errands.js` | Idea only | Subagents as children of a session, never "needs you" | — |
| `src/game/hidden-projects.js` | Copy as is (if "hide repo" wanted) | Tiny pure helpers | 15 min |
| `src/ui/hud.js` | Idea only | `escapeHtml`; setters that compare against the last value written; keep scroll position across poll repaints | — |
| `test/harness.test.mjs`, `scan.test.mjs`, `state.test.mjs` | **Port the method** | Fake `CLAUDE_CONFIG_DIR` fixtures; a "file listing unchanged after scan" read-only assertion; path canonicalisation cases | 0.5 day |
| Everything 3D, audio, assets, tools | Skip | — | — |

Total useful port: about **3 days**, mostly in Phases 1–3.

## 5. Gaps in the Strategos plan this exposes (ranked)

**1. Session identity is not stable for life (missing).** The plan sets id = `--session-id` and keys hook URLs on it (§3.1, §4.1).

- From hooks documentation I recall, `SessionStart` carries `source` = startup | resume | clear | compact. `/clear`, and likely "clear context" flows from plan mode, start a **new** `session_id` and a new transcript inside the same process [inferred; spike it].
- `/resume` typed inside the TUI can switch the process to a different session entirely.
- Bot Crossing's need to merge twins and keep `desktopSessionIds[]` is the same problem from the outside.

**Fix:** give the Strategos record its own id. Keep `claudeSessionIds[]` (lineage) plus `currentSessionId`, updated from every hook's `session_id`, and point the chat view at the current `transcript_path`. Key hook URLs by the Strategos id, not the Claude id.

**2. User interrupts are invisible to the state machine (missing).** Esc stops a turn, and Bot Crossing shows exactly the symptom: an interrupted session reads as working.

- The hooks docs (as I recall them) say `Stop` does not fire on a user interrupt [inferred; spike it]. The plan's `working → done` transition relies on `Stop`, so after Esc the token stays "working".
- **Fix:** treat Esc or Ctrl+C typed into the xterm as an "interrupt pending" signal; confirm from the transcript's interrupted marker or `sessions/<pid>.json` `status`; label the result "Interrupted" (not errored, not done).

**3. Hook-free inference is needed as a fallback (optimistic).** The plan's fallback for missed hooks is `claude agents --json`. But hooks will be silent in at least three cases:

- before workspace trust is accepted (the plan's own §3.9);
- across a daemon restart mid-turn;
- if http hooks misbehave.

Port `awaitingReply` plus interrupt detection as a transcript reconciler, and label inferred states as such. Remember its blind spot: a permission wait looks like working, so it must never *clear* a pending permission.

**4. No "seen" state (missing).** The Needs-you priority includes `done`, but nothing removes a done session from the strip except new work. Add `seenAt`: opening the drawer, or an explicit "Seen" key, sets it, and new activity re-arms it. This is the same as Bot Crossing's `viewedAt`. Without it the strip fills with done sessions within an hour.

**5. Map token placement contradicts itself (wrong).** §5 says tokens are "ordered by needs-you rank" *and* "never move while their status changes". The prototype's `mapSvg()` uses `order()` (status rank), so tokens *do* jump on every status change, and planets sit at fixed grid positions by repo *index*.

- Bot Crossing found both bugs in production: one archive shifted every sibling, and one new repo reshuffled the map.
- **Fix:** sticky ring slots assigned at first sight. Planet cells keyed by canonical repo path, placed nearest-free-to-centre, never reflowed by others. Needs-you ordering lives only in the strip.

**6. Local server security is under-specified (optimistic).** Bot Crossing compares Origin by *hostname only*, so any other localhost page (an untrusted dev server on `:3000`) passes. For Strategos, where Approve means running code, use:

- exact Origin incl. port;
- exact `Host` (`127.0.0.1:<port>`);
- the token on *every* HTTP request and WS upgrade, not only the first WS message;
- hook routes reject any request that *carries* an `Origin` (hooks never send one; browsers always do);
- a body-size cap sized for big `tool_input` (a Write of a large file);
- the `--settings` file (with hook secrets) written under `~/.strategos` with user-only ACL, never passed inline on the command line, where same-user processes can read it.

**7. The reconciler's cost is unmeasured (optimistic).** Running `claude agents --json` every 5–10 s spawns a native Claude binary each time on Windows [inferred cost; measure it in the spike].

- `~/.claude/sessions/<pid>.json` already carries `status`, and Bot Crossing reads that folder cheaply.
- Use the folder (with a pid + `procStart` check) every 2–5 s, and the CLI on startup, every ~60 s, and on disagreement.

**8. `CLAUDE_CONFIG_DIR` and binary location are missing.**

- `Paths` must honour `CLAUDE_CONFIG_DIR`, and the env scrubber (§3.1) must keep it.
- `ClaudeLocator` must apply `PATHEXT`, and must never use the desktop app's bundled binary.

**9. Retention is missing.** Strategos's session table only grows. Needed:

- Archive and forget for Strategos sessions.
- Auto-fold planets whose sessions are all stopped and older than N days. Never fold everything; Bot Crossing's rule.
- A definition of "recent" (§5 "live or recent session" is undefined).

**10. Atomic writes are only half specified.** §3.7 says temp + rename. Add unique temp names, a single serialised writer, and "never write state before it has been loaded".

**11. Transcript facts to state in §3.3 (partly already right).**

- The transcript **can** give: title (custom/ai/summary/first prompt), cwd, gitBranch, whose turn it is, subagent briefs, usage.
- It **cannot** give: permission waits, errors for CLI sessions, interrupts (except as a user-record marker), process liveness, cost, or context-window size.
- Subagent transcripts can open with a fork reference and no brief, and briefs can exceed 8 KB.

**12. Already solved by the plan (Bot Crossing confirms the choice):**

- hooks for permission vs working;
- grouping by `git rev-parse --git-common-dir` (Bot Crossing's `.claude/worktrees` regex misses any worktree elsewhere);
- owning identity at spawn (no twin-merging);
- the daemon as sole state writer;
- not reading the desktop store;
- polling a transcript's size every 500 ms rather than trusting `fs.watch` on Windows. Bot Crossing just re-stats everything every 15 s.

## 6. What Strategos does that Bot Crossing cannot

| Capability | Bot Crossing | Strategos |
|---|---|---|
| Tell "needs permission" from "working" | No (both look like working) | Yes (PermissionRequest hook) |
| Approve / deny / always-allow in place | No | Yes |
| Reply without leaving the overview | No | Yes (pty paste) |
| Start, stop, park, resume | Hands off to the app or a terminal | Owns the process |
| Embedded real terminal | No | Yes (xterm.js + ConPTY) |
| Context fill, cost, 5-hour limit | No (transcript size as a "progress" proxy) | Yes (status line + usage) |
| Errors for CLI sessions | Never | StopFailure, exit code |
| Worktree creation, diff review, draft PR | Shows the branch name; `prState` only from the desktop app | Yes |
| Latency | 15 s poll | Push, under 1 s |
| Identity | Reconstructed by merging stores | Known at spawn |

What Bot Crossing has that Strategos deliberately lacks: all harnesses and all sessions on the machine (including desktop and Codex); phone/LAN viewing; ambient 3D and sound. None of that is a reason to change the plan. The one cheap extra worth adopting is a single "needs you" chime with its transition-only rule.

## 7. Recommended changes to the Strategos plan

**Phase 0 (spike), add four checks:**

| # | Check | Pass |
|---|---|---|
| S11 | Identity churn | `/clear`, in-TUI `/resume` and plan-mode "clear context" each send SessionStart with a new `session_id` to the same hook URL. Record the `source` values; confirm the transcript path changes |
| S12 | Interrupt | Esc mid-tool: confirm whether Stop or StopFailure fires; record the transcript's final record and `sessions/<pid>.json` `status` |
| S13 | Reconciler cost | Time and memory of one `claude agents --json` call on this machine, against reading `~/.claude/sessions/*.json` |
| S14 | Resume identity | `claude --resume <id>` (no `--fork-session`) keeps the same id and appends to the same `.jsonl` |

**Data model (§4.1):**

- add `strategosId`, `claudeSessionIds[]`, `currentSessionId`, `seenAt`, `archived`, `ringSlot`, `planetKey` (canonical common-dir path), `displayName` (disambiguated);
- add `statusSource` (hook | transcript | reconciler) so inferred states can be shown as such;
- add a `transcriptOffset` per current session.

**State machine (§4.2):**

- add `interrupted` (from pty Esc/Ctrl+C plus confirmation) and `done → seen`;
- the transcript reconciler may move working → done/interrupted, but never clears `permission`.

**Map (§5):**

- replace "ordered by needs-you rank" with sticky slots;
- persist planet cells by `planetKey`;
- place new planets at the free cell nearest the centre;
- give the 2×2 → 3×3 growth hysteresis (do not shrink the grid until two planets below the threshold);
- fold dormant planets.

**IPC (§3.6):** apply gap 6 in full.

**Persistence (§3.7):** single writer queue, unique temp names, no write before load, archive and retention.

**Platform (§6):** `CLAUDE_CONFIG_DIR`; PATHEXT; `rundll32 url.dll,FileProtocolHandler` for URLs before Electron; window-fronting helper for notification clicks; run the platform tests on Windows (Bot Crossing's are `posixOnly`).

**Phase 1:**

- port the fsutil, transcript-meta and `awaitingReply` helpers;
- build fixture tests with a fake `CLAUDE_CONFIG_DIR` and a "`~/.claude` listing unchanged" assertion for every parser.

**Phase 2:**

- notification rule: transition-only, none at startup, ≤ 1 per 2.5 s;
- re-poll and reconcile on window focus and visibility.

**Risks (§8):**

- add "session-id churn" and "interrupt invisibility" as risks 3 and 4;
- add "never use `claude://resume` deep links for Strategos sessions (forks the transcript)" under risk 7.

## 8. Verified vs assumed

| Claim | Status |
|---|---|
| Status inference rules, 30-min/10-min windows, pid probe, no procStart | Read in code (`claude-code.mjs`) |
| MSIX path, Claude-3p, deleted markers, resume twins, ghost filter | Read in code + tests |
| Drive-letter and `\\?\` canonicalisation, name disambiguation | Read in code + tests (`scan.mjs`, `scan.test.mjs`) |
| 15 s poll, focus/visibility re-poll, chime rule, viewedAt, first-seen | Read in code (`main.js`) |
| Sticky layout algorithm and slot stickiness | Read in code (`plots.js` `allocateCells`, `colony.js`) |
| Host/Origin checks compare hostname only; LAN IPs always allowed | Read in code (`api.mjs`) |
| Write queue, unique temp, 409 merge, refuse-before-read | Read in code + `state.test.mjs` names |
| Window fronting and terminal launch on Windows | Read in code (`windows.mjs`, `win-terminal.mjs`) |
| `explorer.exe` drops query strings; `cmd start` expands escapes; pre-warm durations; 17 KB briefs; 12 MB transcripts | Read in code comments (their measurements, not mine) |
| Revoked-cert incident; LAN risk; `isArchived` history | Read in docs (DECISIONS, README) |
| Licence, reserved name and post-16-Sep-2026 character designs, CC0 art | Read in docs (LICENSE, TRADEMARKS, README) |
| Permission waits, Esc interrupts and fresh sessions read as "working" | Inferred from code logic, not run |
| `findExecutable` broken on Windows | Inferred (no PATHEXT; Windows test skipped) |
| `/clear` makes a new session id; Stop not fired on interrupt | Inferred from my recall of Claude Code hook docs; not verified this pass → S11, S12 |
| `claude agents --json` is expensive to poll | Inferred → S13 |

**Not read:** `codex.mjs` and `opencode.mjs` beyond their status logic; `cursor`, `antigravity`, `hermes`, `kilocode` adapters; `xdg.mjs`; most of `terminal.mjs`; `test/open.test.mjs` bodies; `plot-move.js`; `plots.js` outside the allocator; all of `src/agents`, `src/world` (except the allocator), `src/core`, `src/audio`; `tools/`; `design/`; skill references `rendering-traps.md` and `asset-pipeline.md`; README apart from the open, archive, security and licence sections; CONTRIBUTING.
