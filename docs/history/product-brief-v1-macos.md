# Strategos — Product Document

*A campaign map for commanding parallel Claude Code agents across git worktrees.*

Status: Draft v1 · Owner: Amel · Platform: macOS (iPhone later) · License: open source later (keep everything config-driven, nothing employer-specific)

---

## 1. Problem

Working with many AI agents in parallel means many worktrees, many sessions and many terminal tabs. The information you need most, which agent needs me right now, is buried: you find out by cycling through tabs. Existing tools (Conductor, Claude Squad, c9s and similar) all use the same model, a sidebar list of workspaces with tabs inside. That scales poorly past a handful of agents and gives no at-a-glance picture of the whole operation.

## 2. Vision

Strategos is a Total War–style campaign map of your work. Repositories are regions, worktrees are settlements, Claude sessions are squads stationed in them. You see everything at once, the map tells you where attention is needed (visually and by voice), and you can talk to any squad, approve its requests, review its work and open a PR without leaving the map.

Underneath it is real, interactive Claude Code. Skills, `CLAUDE.md`, MCP servers, slash commands and subscription billing behave exactly as they do in a terminal. Strategos adds a command layer; it does not replace the agent.

## 3. Principles

1. **Never leave the map.** Every routine action (read, reply, approve, review, PR) happens in an overlay on top of the live map.
2. **Attention is the product.** Visuals and sound exist to route your attention to the squad that needs it. Decoration that doesn't serve that is secondary.
3. **Real Claude Code, untouched.** Squads are ordinary interactive `claude` processes. Anything that works in a terminal works in Strategos, and a raw terminal is always one keypress away.
4. **Fail open, never block.** If Strategos (or its daemon) is down, every Claude session behaves exactly as if Strategos didn't exist. Hooks never hang and never auto-approve.
5. **Spatial memory over data-driven layout.** Settlements stay where you put them. Position is yours; state is shown through visuals.
6. **Destructive actions need confirmation.** Deleting worktrees or branches, killing squads and discarding changes always ask.

## 4. Scope

**In scope (v1):** macOS app, local daemon, Claude Code only, worktree lifecycle management, native chat, permission approvals, diff review and PR creation, RTS-style voice lines and sounds.

**Later:** sub-agents as soldiers, zoom levels, control groups, minimap, iPhone client, open-source release.

**Non-goals:** other agent CLIs (Codex etc.), cloud or multi-machine sync, team/multi-user features, replacing a full git client, reimplementing the Claude Code agent loop.

## 5. Concepts and vocabulary

| Map term | Real thing | Notes |
|---|---|---|
| **Campaign** | Everything Strategos manages | One per machine |
| **Region** | A git repository | Has a heraldic color and a "faction voice" |
| **Capital** | The repo's main checkout | Always present, drawn as a keep |
| **Settlement** | A git worktree | Created, adopted, archived or razed |
| **Squad** | One Claude Code session | 1:1 with a Claude `session_id` |
| **Soldier** | The main agent or a sub-agent inside a session | Later phase |
| **Orders** | Messages you send to a squad | |
| **Petition** | A permission request from a squad | Answered with Grant / Deny |
| **Spoils** | A finished squad's diff, ready for review | |
| **Chronicle** | History of archived settlements and past squads | |

## 6. Users and use cases

Primary user: a senior engineer running 3–10 agents in parallel across several repos, fully delegating work to agents and acting as reviewer and commander.

Core use cases:

1. **Glance.** "Which of my eight agents need me?" One look at the map, or press Tab.
2. **Dispatch.** "Start a new task on a fresh branch in repo X." Right-click the region, found a settlement, raise a squad, give first orders.
3. **Converse.** Read a squad's progress and reply, without leaving the map.
4. **Grant.** Approve or deny a permission request from an alert, in seconds.
5. **Collect spoils.** Review a finished squad's diff, send it back with notes or open a PR.
6. **Clean up.** Archive settlements whose work is merged; see stale ones fading into fog.

## 7. Experience

### 7.1 The map

A parchment campaign map: aged paper texture, ink-drawn region borders, muted heraldic colors per repository, serif display typography. Each region contains its capital (main checkout) and settlements (worktrees), connected to the capital by an ink road.

Settlement anatomy:
- Name (worktree name) and branch label on a small scroll
- State indicators: uncommitted changes (ink blot), ahead/behind base (small numerals on the road), open PR (wax seal), stale (fog)
- One banner per squad stationed there, in the region's color, with a status glyph

Squad banner states:

| State | Meaning | Visual | Sound |
|---|---|---|---|
| Mustering | Session starting | Banner rising | — |
| Marching | Agent working | Banner waving; activity line on hover | — |
| Petitioning | Waiting for permission | Pulsing red wax seal | "Awaiting your command" |
| Awaiting orders | Finished a turn, needs input | Banner still, horn icon | "Objective complete" / "Ready" |
| Spoils ready | Done, has unreviewed diff | Chest icon | — (announced on completion) |
| Fallen | Process died unexpectedly | Torn banner | "We've lost a squad" |
| Disbanded | Session ended normally | Banner removed | — |

Layout: new settlements are auto-placed inside their region near the capital; you can drag them anywhere and positions persist. Regions can be resized and moved. Pan with trackpad or drag, zoom with pinch.

Fog of war: settlements with no squad activity for a configurable period (default 7 days) gradually fade into fog, a gentle nudge to archive them.

### 7.2 Attention loop

- **Tab** jumps to the next squad that needs you, in priority order: Petitioning → Fallen → Awaiting orders → Spoils ready. Shift-Tab goes backwards.
- **Event feed** in the bottom-left corner: a scrolling chronicle of recent events ("rooblocks / filter-fix: objective complete"). Click an entry to jump there.
- **Voice lines** announce important events (see 7.6).
- **macOS notifications** for petitions and completions when the app is not frontmost.
- **Dock badge** shows the number of squads needing attention.

### 7.3 Chat drawer

Click a squad (or press Enter on a selected one) and a drawer slides in from the right, taking about 40% of the width. The map stays visible and live; the selected squad stays highlighted and centered.

Contents:
- Header: squad name, settlement, branch, state, context/token usage, buttons for raw terminal, review and disband
- Conversation rendered natively from the transcript: your orders, assistant text (Markdown), tool calls as collapsed cards (name, target file or command, result summary; expandable), inline diffs for edits, sub-agent runs as nested collapsed threads
- Live activity line while the agent works ("Editing StorePageHeader.swift…")
- Pending petition shown inline as a card with Grant / Deny
- Order input at the bottom: multiline, ⌘Enter to send, slash commands pass through untouched

Visual treatment: parchment frame, but the conversation itself uses clean, readable system typography. Readability beats theme inside the drawer.

Updates arrive per message rather than per token, since the drawer reads the session transcript; the activity line covers the time in between.

### 7.4 Command bar

⌘K opens a command bar over the map, targeting the selected squad by default. It supports sending a quick order, jumping to a squad or settlement by name, and running actions ("found settlement in pedregal", "archive filter-fix"). This is the fastest way to give a one-line order without opening the drawer.

### 7.5 Worktree lifecycle

Strategos fully owns the worktree lifecycle, and also adopts existing worktrees so current setups appear on first launch.

- **Found settlement:** pick a region, branch name (new from a base branch, or an existing branch), and optional first orders. Strategos runs `git worktree add` at the configured path, runs the region's setup hooks (for example dependency install or project generation), then optionally raises a squad.
- **Adopt:** worktrees discovered via `git worktree list` that Strategos didn't create appear as adopted settlements with full functionality.
- **Archive:** disband squads, check for uncommitted or unpushed work (warn with details), `git worktree remove`, keep the branch. The settlement moves to the chronicle.
- **Raze:** archive plus delete the branch. Requires typed confirmation if the branch isn't merged.

### 7.6 Voice and sound

Full RTS-style audio, designed not to become annoying:

- Event categories with several line variants each: squad raised ("Ready for orders"), petition ("Awaiting your command, Strategos"), objective complete, squad fallen, PR opened ("The banner is raised")
- Each region can have its own faction voice, so you can tell which repo is calling without looking
- Throttling: a priority queue, at most one line every few seconds, no repeats of the same line back-to-back, and no line for the squad you're currently focused on
- Ambient sound (distant camp, quill) at low volume, off by default
- Global mute hotkey; per-category toggles; Do Not Disturb respected
- Voice assets must be original (recorded or generated with properly licensed TTS), never taken from games; the system speech synthesizer is a fallback

### 7.7 Review and PR (Spoils)

When a squad finishes with changes, its settlement shows Spoils ready. The review panel (same drawer, Review tab) shows:
- Changed files, a unified diff against the base branch (committed and uncommitted), and commit list
- **Send back with notes:** your notes are sent as orders to the squad
- **Order commit:** asks the squad to commit uncommitted changes
- **Open PR:** creates a pull request via `gh` (draft by default, title and body pre-filled from the squad's summary, editable before sending)

After a PR is opened the settlement shows a wax seal; PR status (checks, review, merged) is polled via `gh`. A merged PR suggests archiving.

### 7.8 Raw terminal

Every squad runs in a tmux session. The raw terminal (T in the drawer) shows it in an embedded terminal view, for interactive pickers or anything the native view can't do. Squads can also be attached from any terminal with `tmux attach`, and they survive closing the app.

### 7.9 External squads

Claude sessions started by hand in any terminal also report to Strategos through global hooks. They appear on the map (in their worktree's settlement) marked as external. They can be read in the drawer and their petitions answered; sending orders requires Strategos to own the session, so external squads offer "take command", which resumes the session inside Strategos once the external process has ended.

## 8. Architecture overview

```
┌──────────────────────── macOS app (SwiftUI) ──────────────────────┐
│  Map (Canvas)   Chat drawer   Review   Command bar   Audio engine │
└───────────────────────────────▲───────────────────────────────────┘
                                │ WebSocket (localhost, versioned JSON)
┌───────────────────────── strategosd (TypeScript) ─────────────────┐
│ Campaign state · Worktree manager · Squad manager (tmux)          │
│ Hook receiver (unix socket) · Transcript tailer · Git/gh adapters │
│ Event bus · Persistence (~/.strategos)                            │
└──────▲───────────────────────▲──────────────────────▲─────────────┘
       │ hook events            │ JSONL transcripts    │ tmux / git / gh
┌──────┴──────┐        ┌────────┴────────┐    ┌────────┴────────┐
│ strategos-  │        │ ~/.claude/      │    │ claude (in tmux │
│ hook (every │        │ projects/…jsonl │    │ per squad)      │
│ claude sess)│        └─────────────────┘    └─────────────────┘
└─────────────┘
```

Three data channels per squad:
- **Read** — the session's JSONL transcript (path provided in hook payloads) for messages and tool calls
- **Live state** — Claude Code hooks for lifecycle, tool activity, notifications and petitions
- **Write** — tmux (paste buffer plus Enter) for sending orders

The GUI only consumes the daemon's normalized event stream, so the engine can be swapped (for example to the Agent SDK) without touching the app.

## 9. Configuration

`~/.strategos/config.toml`:
- `regions`: repo path, display name, color, voice, base branch, worktree path pattern (default keeps worktrees under the repo's `.claude/worktrees/<name>`), setup commands to run on founding
- `claude.binary`, extra `claude` args
- `audio`: volumes, category toggles, throttle interval
- `fog.days`
- Environment hygiene: the daemon strips `ANTHROPIC_API_KEY` from squad environments by default, so squads use your subscription login rather than silently billing an API key (overridable)

## 10. Privacy and safety

- Daemon binds to localhost and a user-only unix socket; no network exposure until the iPhone phase, which adds explicit pairing and auth
- No telemetry
- Hooks fail open: if the daemon is unreachable, the hook exits immediately with no effect; permission hooks fall back to the normal terminal prompt, never auto-approve
- Installing hooks merges into `~/.claude/settings.json` with a backup and a clean uninstall command

## 11. Success criteria (personal)

- Terminal tab switching for agent work drops to near zero
- A petition is noticed and answered within seconds, without hunting
- Running 8+ squads across 3 repos feels calm rather than chaotic
- Stale worktrees get archived instead of piling up

## 12. Later phases

- **Soldiers:** sub-agents visualized as individual units within a squad
- **Zoom levels:** strategic (regions) → operational (squads and soldiers) → tactical (drawer)
- **Control groups:** ⌘1–9 to bind squads, 1–9 to jump
- **Minimap** when zoomed in
- **iPhone client:** read-only map, answer petitions and send orders from anywhere; connects to the daemon over a private network with pairing
- **Open-source release:** docs, installer, sample voice pack, contribution guide

## 13. Open questions (answered by the M0 spike)

- Which hook event is best for petitions: a dedicated permission-request hook if the installed Claude Code version provides one, otherwise Notification plus a TUI answer via tmux
- Hook timeout behavior when a petition waits minutes for an answer
- Stability of the JSONL transcript format across Claude Code versions, and which fields identify the version
- Whether a session registry under `~/.claude/` is reliable enough to discover sessions with no hook activity yet
- How sub-agent activity appears in hooks and transcripts
