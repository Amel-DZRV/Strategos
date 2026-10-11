# Strategos: product document

*One screen that shows every Claude Code session you are running, tells you which one needs you, and lets you act on it.*

Status: Draft v2, 11 Oct 2026 · Owner: Amel · Platform: Windows 10 and macOS, Windows first in order · Licence: MIT

This replaces the first product document ([docs/history/product-brief-v1-macos.md](history/product-brief-v1-macos.md)), which described a macOS app with a Total War style parchment map and voice lines. Since then the owner chose a different look, platform and scope. The first document is kept for history.

**How to read this.** This document says *what* Strategos is and *why*. The technical write-up ([strategos-technical-writeup.md](strategos-technical-writeup.md)) says *how it could be built*, and the implementation plan ([strategos-implementation-plan.md](strategos-implementation-plan.md)) says *exactly how it will be built*, step by step. Where they disagree, the plan wins, then the write-up, then this document.

Words used throughout: a **session** is one running Claude Code conversation. A **repo** (repository) is a project folder tracked by git. A **worktree** is an extra working copy of a repo on its own branch, so two sessions can edit the same repo without colliding. A **pull request** (PR) is a proposal on GitHub to merge your changes.

---

## 1. Problem

Working with several Claude Code sessions at once means many terminal windows and tabs. The thing you need most, "which session needs me right now?", is buried, and you find out by cycling through tabs. A session that is waiting on you costs time every minute it waits, and you can't see how long.

Tools for this exist (Claude Squad, Conductor, and Claude Code's own Agent View). They mostly show a list of sessions. A list works for a handful and gives no overall picture of what is happening across your repos. Agent View lists sessions and can take replies, but it doesn't let you approve a permission request from one overview, review diffs, or open PRs in the same place. Strategos accepts that overlap. If Claude Code later offers an official way to approve requests from outside, Strategos will use it.

## 2. Vision

Strategos replaces your Claude window with a **Map**. Repos are planets. Each session is a marker orbiting its planet. Colour and symbol say what the session is doing, a ring shows how full its context is, and a pulse means it is waiting on you. A "Needs you" strip along the top lists every blocked session, oldest first.

You can see everything at once, and you can act without leaving the Map: approve or deny a permission request, answer a question, reply, start or stop a session, review its diff and open a PR.

Underneath is the real Claude Code. Your slash commands, your mods, your settings and your subscription login behave exactly as they do in a terminal. Strategos adds a layer above the agent. It doesn't replace it.

![The Map](../design/screenshots/01-map-permission-terminal.png)

*Sample data from the prototype. The sessions and costs are made up.*

## 3. Principles

1. **See everything first.** The main screen answers "what is happening, and what needs me?" in one look.
2. **Attention is the product.** Colour, motion and notifications exist to send you to the session that needs you. Anything that doesn't serve that is secondary.
3. **Real Claude Code, untouched.** Every session is an ordinary interactive `claude`. Anything that works in a terminal works in Strategos, and the real terminal is one keypress away. Strategos never edits Claude Code's own files or your global settings.
4. **Nothing approves itself.** Only your click approves a permission request. The one automatic action allowed is a guard that **denies**, and guards are a safety net, not a security boundary.
5. **Fail open, never block.** If Strategos is down, every session behaves as if Strategos didn't exist: the normal permission dialog appears in the terminal.
6. **Be honest about what it knows.** A status that comes from a signal Claude Code sent is shown as certain. A status guessed from reading a log is labelled as inferred, and a guess never clears a pending permission request.
7. **Positions are yours.** Planets and markers stay where they are, so your eye learns the Map. Position doesn't change when a status changes. Urgency is shown by the strip and the markers' look, not by moving things.
8. **Destructive actions ask first.** Deleting a worktree or branch, stopping a session and discarding changes always ask.
9. **Mouse and keyboard equally.** Everything works with either.
10. **Plain words.** The look is a strategy-game Map, but the words are ordinary: session, permission request, repo.

## 4. Scope

**In v1:**
- Windows 10 and macOS; Claude Code only. The Windows PC is the daily machine and goes first in order. The Mac is a committed target: the same code runs on both, and the platform-specific parts are written for both from the start.
- Sessions started from Strategos, held by a program that runs in the background, so closing the window doesn't stop them.
- The Map, the Needs-you strip, and a drawer with a Terminal tab, a Chat tab and a Review tab.
- Approve, deny, reply, answer questions, start, stop, park and resume sessions, in a repo or a new worktree.
- Diff review and draft PRs through the GitHub command-line tool.
- The chosen extra features (section 7), and grouping sessions by initiative.

**Not in v1:**
- Sessions started elsewhere, such as the Claude desktop app or a plain terminal window. Nothing is read from the desktop app's data.
- Other tools such as Codex.
- Phone or network access of any kind.
- Voice lines and sound, apart from one optional attention chime.
- Textured planets, zoom levels, a minimap and control groups.
- Automatic grouping of sessions. Grouping is never guessed.
- Any action that spends tokens or approves something without your click.

**Later:** a phone client with proper pairing and security, zoom levels, control groups, and an open-source release.

**Non-goals:** replacing a full git client, reimplementing Claude Code's agent loop, team or multi-user features, syncing sessions across machines (the Map shows the sessions of the machine it runs on; guard rules and preferences live in a portable part of the config you can copy by hand).

## 5. Vocabulary

| Word | Meaning |
|---|---|
| **Map** | The main screen |
| **Planet** | A repo. Colour comes from a stable hash of its name and can be overridden |
| **Marker** | One session, drawn on its planet's ring |
| **Needs-you strip** | The row above the Map listing every blocked session, oldest first |
| **Drawer** | The panel on the right for the selected session: Terminal, Chat, Review |
| **Permission request** | Claude asks to run a command or edit a file and waits for your answer |
| **Question** | Claude asks you something and waits |
| **Initiative** | A name and colour you give to sessions that belong to one piece of work, even across repos |
| **Park** | Stop a session's process but keep it resumable |

## 6. Users and use cases

**The user:** a developer running 3 to 10 Claude Code sessions in parallel across several repos, delegating most work to the agents and acting as reviewer.

1. **Glance.** "Which of my eight sessions need me?" One look at the Map, or press `n` or Tab.
2. **Approve.** A permission request appears. Read the command, the risk label and the diff, and click Approve or Deny in seconds, without opening the session.
3. **Converse.** Read a session's progress as a chat and reply, or drop into its real terminal.
4. **Dispatch.** Start a session in a repo, or on a new branch in a new worktree, with a first prompt.
5. **Review.** A finished session joins the review inbox. Read the diff, send it back with notes, or open a draft PR.
6. **Work across repos.** Group the backend, iOS and Android sessions of one feature into an initiative. Hover to see the connected sessions, and see one status for the whole piece of work.
7. **Come back.** After time away, a short digest says what finished, what blocked and for how long, and what it cost.
8. **Clean up.** Archive worktrees whose work is merged, and let stale planets fold away.

## 7. Experience

### 7.1 The Map

Each marker shows:

| Element | Meaning |
|---|---|
| Ring colour and glyph | Status: ◆ needs permission, ? has a question, ● working, ✓ done, ○ stopped, ✕ errored. The glyph means status never depends on colour alone |
| Outer arc | Context used. Amber from 70%, red from 85% |
| Pulse | Waiting on you. It speeds up after 5 and 15 minutes. With reduced motion set, a thicker ring replaces it |
| Label | Name, context percentage, approximate cost |
| Small badges | Waiting time, risk, git branch state, PR and test status, warnings |

Layout rules:
- Planets sit in fixed cells on a grid (2×2 up to 4 planets, 3×3 up to 9) and you can drag them. A new planet takes the free cell nearest the centre and never pushes the others.
- Each session keeps the same slot on its planet's ring for life. Up to 8 per ring, then a second ring.
- Above about 12 sessions, working and done markers on a crowded planet collapse into a count ("+5 working"). Markers that need you are never collapsed. Above about 24 sessions, a list view shows the same data.
- Planets whose sessions are all stopped and old fold away, but never all of them.

### 7.2 Statuses

| Status | Meaning |
|---|---|
| Starting | The session is launching |
| Working | Claude is running or thinking |
| Needs permission | A permission request is waiting on you |
| Has a question | Claude asked you something |
| Done | Claude finished its turn. It stays in the strip until you mark it seen |
| Seen | You looked at a finished session, so it leaves the strip until it does something new |
| Interrupted | You pressed Esc or Ctrl+C. Not an error, and not done |
| Errored | The process died unexpectedly, or Claude Code reported a failure |
| Stopped | Ended normally. Resumable |
| Parked | You stopped it to free memory. Resumable |
| Trust pending | Claude Code is asking whether to trust this folder, so its signals are not flowing yet |
| Open elsewhere | The same session is also open in another program |

### 7.3 Attention

- **Needs-you strip:** one chip per blocked session, oldest first, with Approve and Deny on permission chips. It scrolls sideways and is never cut off.
- **Waiting time as a number:** each blocked marker shows "waiting 14 min", and the top bar shows the total waiting now and today.
- **Notifications you can act on:** an alert when a session starts needing you. At first it opens Strategos on that session. In the desktop version (with Electron) it has Approve and Deny buttons. Notifications fire only when a session *starts* needing you, never for sessions already waiting when Strategos opens, and at most one every 2.5 seconds. If a session stays blocked, the alert repeats after a set time. Approve from a notification follows the same rule as 'approve all low-risk': file reads and edits inside the session's folder only, with the path shown; anything else opens the request.
- **Tray icon with a blocked-count badge:** the taskbar shows how many sessions need you. Before the desktop version, the browser tab title shows "(3) Strategos".
- **`n`** jumps to the next session that needs you, and **Tab** cycles through them.

### 7.4 The drawer

Click a marker, or press Enter on a selected one. The Map stays visible and live.

- **Terminal:** the real Claude Code interface, so slash commands, dialogs and your mods work. When the terminal has focus, every key goes to Claude Code except one chord that returns you to the Map.
- **Chat:** the same live session drawn as a conversation: your messages, Claude's replies, tool calls as collapsed cards, edits as diffs, sub-agent work as nested threads, and any pending request as an inline card with Approve and Deny. Updates arrive per message rather than word by word, with a live activity line in between.
- **Reply box:** types into the session's terminal. It is enabled only when the session is done, seen, interrupted, or has a question you can answer there, and it refuses to send while you have half-typed something in the terminal, so it never clobbers a prompt.
- **Review:** the diff, the commit list and the PR.
- Switching between Terminal and Chat is instant. It is one session read two ways, so nothing restarts.

### 7.5 Permission requests

- Every request shows the tool, the command or diff, and a risk label: read, write, run, network, delete, or outside the repo. The label is a hint, never a guarantee.
- **Approve**, **Deny** (with an optional message to Claude), **Always allow** (when Claude Code offers a rule) and **Answer in terminal** (hands the request back to the normal dialog).
- **You approve what you saw.** If a command is too long to show in full on a chip or a notification, the Approve button opens the full request first.
- 'Approve all low-risk' applies to the selected initiative only, and only to file reads and edits inside the session's own folder. It never approves a shell command, and never a file under `.git`, `.claude`, `.github` or a dotfile, because those change what runs next.
- Questions Claude asks you appear with their options, and you can answer from the Map.
- **Auto-deny guards:** one editable list of patterns that are always refused, such as force-push, `rm -rf`, reading `.env` files or writing outside the repo. Every denial is logged. Guards only deny. They can be bypassed by a rewritten command, so they are a safety net.
- **Audit log:** every approval and denial you make is recorded with the time.
- If Strategos is down or a request takes too long, the normal dialog appears in the terminal. Strategos never approves on its own.

### 7.6 Initiatives

- An initiative groups sessions that belong to one piece of work, across repos.
- **Hover** a marker and everything not connected to it dims. **Lines** are drawn only for the hovered or selected initiative, to avoid clutter. A **Group by: repo | initiative** toggle regroups the whole Map.
- You create one by tagging a session when you start it, by starting a **mission** (several linked sessions at once), or by accepting a suggestion when branch names match across repos. Strategos never guesses.
- An initiative shows one rolled-up status ("2 of 3 need you"), a summed cost, and a group action to stop them together.
- Sub-agents always appear linked to their parent session.

### 7.7 Usage, cost and context

- **Usage gauge:** the 5-hour and 7-day limits that actually throttle you, with a burn rate and a projected time to the limit. Near a threshold, Strategos *suggests* parking the lowest-priority sessions. It never does it for you.
- **Cost** is shown as approximate ("≈ $3.42"), because on a subscription it is the list-price equivalent, not your bill. It is summed across a session's life even when `/clear` resets Claude's own counter.
- **Context-full actions:** at 70% and 85% the drawer offers Compact (types `/compact`) or Hand off (uses your auto-handoff mod). Offered only when the session is idle.
- **Cache warmth:** a small timer showing whether the session's prompt cache is still warm, read from Claude Code's own report. When it is cold, the next message costs more. A button sends your `/keepwarm` command.
- **Stuck and loop detection:** a warning badge when a session repeats the same failing step, runs a long time without a tool call, or sits at over 90% context with no progress. It only suggests.

### 7.8 Review, git and CI

- **Review inbox:** finished sessions queue with files changed, diff size, a one-line summary, the last test command and its result (only if the session ran one, otherwise "not run"), and a Create PR button.
- **Send back with notes** sends your notes to the session as a message.
- **Create PR:** a draft PR through the GitHub command-line tool, with title and body filled from the session's summary and editable first. For an initiative, the PRs are linked and carry a suggested merge order.
- **Git and CI on the marker:** branch, ahead/behind, uncommitted changes, PR state, and a red or green dot for the automatic tests that GitHub runs (CI).

### 7.9 Starting, stopping and worktrees

- **Start in a repo:** pick a repo and type a first prompt.
- **Start in a new worktree:** Strategos creates the worktree and branch itself, runs the repo's optional setup commands, then starts the session there, so it knows the base branch for review and PRs.
- **Stop, park, resume:** stopping asks first. Parking stops the process and keeps the session resumable. Resuming re-applies Strategos's settings. Claude Code deletes transcripts after 30 days by default, so a session stopped for about four weeks is marked "may not be resumable".
- **Trust:** Claude Code asks you to trust a folder before its signals flow. A brand-new worktree can trigger that question, so Strategos shows it as "needs you: trust this folder".
- **Archive:** checks for uncommitted or unpushed work, warns with details, removes the worktree and keeps the branch.
- **Surviving a restart:** closing the window leaves sessions running. After a crash or reboot, sessions show as stopped and resumable, with a "resume everything that was open" button and an option to start Strategos at login. Restarting or upgrading the Strategos background program stops every session (they are resumable, but the next message costs more because Claude's prompt cache is cold). Strategos warns before it does this.

### 7.10 Conflict warnings

Modelled on your session-tracker mod: if another session edited the same file in the last 30 minutes, after this one last touched it, you get a warning on both markers, and Claude is told to re-read the file and keep the other session's changes. It warns once per change.

Strategos goes further than the mod: it compares every Strategos session, including worktrees of one repo, and it tracks sub-agent edits. For work across repos, you list **contract files** per initiative, such as the file that describes the backend's interface to the apps. A change to one flags the other repos' sessions.

### 7.11 Away digest and resource view

- **While you were away:** on return, a short summary of what finished, what blocked and for how long, what it cost and what was auto-denied.
- **Resource view:** memory and processor use per session and in total. A Claude Code session takes roughly 0.6 to 0.8 GB, so ten use about 7 GB. It sits next to the Park action.

### 7.12 Keyboard

| Key | Action |
|---|---|
| `n` / `Tab` | Next session that needs you (`Shift`: previous) |
| Arrows or `h j k l` | Move the selection between markers |
| `Enter` | Open the drawer |
| `Esc` | Close the drawer or palette |
| `a` / `d` | Approve / deny the selected request (`d` opens an optional message) |
| `A` | Always allow (only when Claude Code offers a rule) |
| `1`–`9` | Pick an answer option |
| `r` | Reply |
| `t` | Switch the drawer between Terminal and Chat |
| `v` | Review tab |
| `c` | New session (repo or worktree) |
| `s` / `p` | Stop / park (with confirmation) |
| `x` | Mark seen |
| `g` | Group by repo / initiative |
| `i` | Assign an initiative |
| `Ctrl+K` (Windows) / `Cmd+K` (Mac) | Command palette: jump to a session, run any action, change grouping |
| `Ctrl+Alt+M` (Windows) / `Cmd+Shift+M` (Mac) | Leave the terminal and return to the Map |
| `?` | Key help |

## 8. How it works, briefly

- A **background program** (the daemon) starts each session as an ordinary `claude` inside a pseudo-terminal, which is what makes a program believe it is in a real terminal window. Closing the Strategos window doesn't stop the sessions.
- Status and permission requests arrive through **hooks**: small signals Claude Code sends when something happens. Strategos hands them to each session at start-up with `claude --settings`, so your own settings files are never edited. Context, cost and rate limits come from Claude Code's **status line**.
- The **interface** is a web page (the Map drawn in SVG, terminals drawn with xterm.js) that talks to the daemon over a local connection. In v1 it opens in a Chrome app window. Later it is wrapped in Electron for a tray icon, notification buttons and a global hotkey. The shell can be swapped without touching the daemon.
- The chat view reads the same live session's log file plus the hooks, so there is no process switch.
- Estimated effort, from the plan: about 14 weeks for one person working in sequence for Windows and Mac, or 9 to 11 weeks with three helper lanes. Approving requests from one screen is possible after milestone M2 (about 6 weeks); the full Map after M4.
- The parts that differ between Windows and macOS (finding `claude`, starting and stopping processes, opening windows, start at login) live in one small module with a version for each system, written together from the start. Everything else is shared.

## 9. Configuration

`~/.strategos/config.json` (the folder is `%USERPROFILE%\.strategos` on Windows and `~/.strategos` on the Mac) has two parts: a machine part (repo paths, the path to `claude`, the port) and a portable part (guard rules, thresholds, notification preferences, key overrides) that you can copy between machines by hand:
- repos, display names, planet colours, base branches, worktree location (default `<repo>/.claude/worktrees/<name>`) and setup commands;
- the path to your `claude` program and any extra arguments;
- the price table and notification preferences;
- the guard rules and the contract-file lists;
- an environment rule: Strategos removes `ANTHROPIC_API_KEY` and a few Claude Code variables from each session's environment by default, so sessions use your subscription login and don't inherit settings from the program that launched Strategos.

## 10. Privacy and safety

- The daemon listens on `127.0.0.1` only. No remote access in v1. No telemetry.
- Requests from a browser must come from Strategos's own window, with an exact match on its address, and carry a secret that proves it. Hook routes refuse anything that looks like it came from a web page.
- Hook secrets are never stored in the settings files or the repo.
- Hooks fail open. A permission hook that can't reach the daemon gives no decision, and the normal dialog appears. Nothing is approved on a timeout.
- Strategos never writes to `~/.claude`. It never runs a Claude program bundled inside another app, and it never uses `claude://` links to open Strategos sessions, because that copies the session into the desktop app.
- A session can read its own signal token, so it could send Strategos a made-up status about itself. That can only change what the Map shows. It can never approve a request or unblock one that is waiting on you.
- Everything read from logs, other people's repos and web pages is treated as data, not instructions.

## 11. Success criteria (personal)

- Terminal tab-switching for agent work drops to near zero.
- A permission request in a session you aren't viewing is noticed and answered in under 5 seconds, without opening its terminal.
- For status fed by Claude Code's own signals, status is correct within 1 second of reality across 30 minutes of mixed work with 6 sessions in 3 repos. Guessed statuses (marked 'probably') may lag by up to 10 seconds.
- Running 8 or more sessions across 3 repos feels calm rather than chaotic.
- Closing the Strategos window and reopening it loses nothing. After a crash, every session is resumable with its history.
- Stale worktrees get archived instead of piling up.
- After time away, the digest answers "what happened?" without reading any session.

## 12. Later phases

- **Phone client:** read the Map and answer permission requests from anywhere. It needs real pairing and encryption first, because approving a request means running code on your machine.
- **Zoom levels, control groups and a minimap.**
- **Open-source release:** installer, documentation and contribution guide. Never ship the Agent SDK together with a claude.ai login. Strategos launches your own installed `claude`, which avoids the problem.
- **Voice and sound,** if you ever want them.

## 13. Open questions

These are settled by milestone M0, the roughly five-day experiment in the plan, before any product code is written:

- **Does the terminal library install and run without build tools** on both machines (check S0)? This is the very first thing to try.
- **Can Strategos answer a permission request itself** while Claude's own dialog waits (check S2), and is there a maximum time a request can be held? This is the core of "act from the overview".
- **Does Claude Code's fullscreen interface draw correctly** in Strategos's terminal on Windows 10's built-in terminal layer, with your mods (check S3)?
- **Does the status line** accept settings passed with `--settings` and chain to yours (check S5)?
- **Do hooks keep reaching Strategos** after `/clear`, `/resume` and plan-mode context clears (checks S11 and S14)?
- **Do new worktrees trigger the trust question** (check S10)?
- **Can a notification carry Approve and Deny buttons** on Windows 10 before Electron (check S15)?
- **Does turning off Agent View** stop a session being pulled out of Strategos by the left arrow or `/bg` (check S18)?

The plan's section 13 lists eight further decisions for you, each with a recommended default.
