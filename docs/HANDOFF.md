# Strategos build: handoff

Written 11 Oct 2026 at the end of the first build day. Read this first tomorrow.

## In one paragraph

Strategos was built from `docs/strategos-implementation-plan.md` by one coordinator (Claude Opus) handing jobs to helper agents (Claude Sonnet), each in its own git worktree, then reviewing and merging their work. Milestones **M0 to M7 are done** and merged on branch **`build/m0-m1`** (pushed to GitHub, not merged into `main`). **M8 is about one third done**, on branch **`build/m8-daemon`** (pushed, not merged). **M9 (macOS)** needs the MacBook. All 1,747 automatic tests passed twice in a row on a quiet machine before the push.

## Where things are

| What | Where |
|---|---|
| Finished work, M0–M7 | branch `build/m0-m1` (GitHub: Amel-DZRV/Strategos, private) |
| Unfinished M8 work | branch `build/m8-daemon`: one finished commit (8.01 stuck detection, 8.02 resource sampler) and one **WIP** commit (8.03 digest, 8.04 autostart/resume-all, 8.06 retention). The WIP compiles; its tests were **not** run. |
| Spike results (M0) | `spike/REPORT.md` (results S0–S19, go/no-go, "Manual checks for the owner") |
| Plan changes from the spike | "Edit 3" at the top of `docs/strategos-implementation-plan.md` |
| M1 acceptance notes | `docs/acceptance/M1.md` |
| Screenshots of the UI (mock data) | `docs/screenshots/` (`m3-map-*`, `m5-*`, `m6-*`, `m4-palette`, `m7-electron`) |
| Recorded Claude Code samples | `fixtures/claude/2.1.292/` (redacted) |
| Practice repo for real-Claude tests | `C:\dev\strategos-sandbox` (deny rules for rm/del/Remove-Item/git push) |

## How to run it

```bash
npm install
npm run check
npm run strategos -- start
npm run strategos -- status
npm run strategos -- open
npm run app
npm run strategos -- stop
```

- `npm run check`: typecheck, all tests, lint. About 3.5 minutes. Do not run two of these at once: the process-heavy tests (vitest project `proc`) time out when the machine is shared.
- `strategos start` / `stop` / `status` / `open`: the background daemon. `open` opens Chrome as an app window, already paired.
- `npm run app`: the Electron desktop app (starts the daemon if needed).
- `npm run dist:win`: builds an unsigned installer into `packages/shell-electron/release/` (about 107 MB; needs Node 24 on the target machine; SmartScreen will warn).
- UI with fake data (no Claude needed): see `packages/ui/README.md` (mock daemon + Vite on http://127.0.0.1:5173/#pair=mock).

## What each milestone delivered

- **M0 spike:** checks S0–S19 run on Windows. GO, conditional on the owner's manual S3. Key findings changed the plan (Edit 3): SessionStart only arrives via a command-hook relay; the account defaults to auto mode, so Strategos always passes `--permission-mode default`; `disableAgentView: true` is required (← moves a session to the background otherwise); answering Yes in the TUI does not close a held hook, Esc does, so held requests are released on later evidence; the status-line tap runs at about 200 ms against a 300 ms budget.
- **M1 daemon:** stores, config (stable port), local server with pairing/Origin/Host guards, hook receiver and held requests, status-line tap, state machine (100% branch coverage), transcript tailer, reconciler, platform code for Windows and macOS, pty host, fake-claude, session manager, CLI, version guard. Real-Claude demo passed.
- **M2/M3 UI:** connection and pairing, terminal pane (xterm), drawer, pending card, then **the Map as the home screen** (look B), polished against `design/screenshots/`. The session list is only a secondary "List" view.
- **M4:** risk classes, auto-deny guards (deny only; known bypasses listed in `guards.test.ts`), "approve all low-risk" (D20/D21), usage burn rate, notification policy, Ctrl+K palette.
- **M5:** chat view from the transcript, reply box, Compact / Hand off / Keepwarm, conflict warnings with notes to Claude, cache warmth.
- **M6:** git status polling, safe worktrees (typed branch name to lose work), review tab with diff, draft PR create and polling, test-result detection, initiatives, missions.
- **M7:** Electron shell: IPC pairing, tray + badge, toasts (Approve only per D20, re-checked by the daemon), Ctrl+Alt+S, NSIS build.
- **Stability:** process-heavy tests isolated in a `proc` vitest project, deterministic waits, 8.3 short-path canonicalisation, `.gitattributes` (LF).

## Next steps, in order

1. **Owner manual checks** (only you can do these):
   - S3 and S15 in `spike/REPORT.md` → "Manual checks for the owner".
   - Try `npm run app`: tray icon and badge, Ctrl+Alt+S, a toast with Approve/Deny (never exercised by hand yet).
   - Turn off Claude Code's auto-updater for the build period (plan V26; your own setting, set by hand).
2. **Finish M8 daemon** on `build/m8-daemon`: review the WIP commit, finish 8.03 (digest incl. "waiting today" surviving restarts, "while you were away"), 8.04 (resume all, autostart opt-in incl. the packaged-app command), 8.06 (retention, `mayNotResume` warning), then 8.05 (`tools/record-session.ts` + `npm run contract`; build and dry-run against fake-claude, don't spend real tokens without asking). Run `npm run check` twice, merge into `build/m0-m1`.
3. **M8 UI:** stuck badge, resource panel with Park, digest dialog, settings page with guard-rule editor (8.08), list view toggle above 24 sessions, transcript-age warning.
4. **8.07 soak** (20 fake + a few real sessions for hours; daemon < 200 MB, UI < 300 MB) and **8.09 security pass** (walk plan §10 line by line).
5. **M9 on the MacBook:** clone, `npm install`, run `npm run check` (4 macOS-only tests are skipped on Windows and have never run), forkpty smoke test, `npm run dist:mac`, M2/M4 acceptance.
6. Decide when to open a pull request from `build/m0-m1` into `main`.

## Known issues and loose ends

- **Not verified on real Claude:** answering AskUserQuestion on the second (PermissionRequest) path; `claude agents --json` output shape; the `ai-title` transcript record; `projectDirName` for paths over 200 characters; Windows toast cold-start (`handleActivation`) format.
- **"Always allow":** on Claude 2.1.292, suggestion 0 was `addDirectories` for the session, so "Always" does not create a lasting rule.
- **Small gaps:**
  - the review event drops the diff `truncated` flag;
  - the chat tab re-subscribes from item 0 on every open;
  - the `perm.approveLowRisk` ack has no count;
  - `flags.contractChanged` has no repo key and is never cleared;
  - worktree setup commands are a TODO;
  - the PR merge-order bundle (6.06) is not built;
  - the packaged app's autostart command is wrong (being fixed in 8.04 WIP).
- **Design deviations, owner to confirm:**
  - the drawer footer shows the command, risk chip, "Always allow" and "Answer in terminal";
  - the reply box is disabled while a question is held;
  - ring slots fill top, bottom, right, left, then diagonals (`SLOT_ANGLE_ORDER` in `map/layout.ts`);
  - `Tab` is not used for "next needing you" (keeps keyboard navigation working);
  - only the JetBrains Mono font is bundled.
- **Housekeeping:**
  - git has no user identity configured on this PC; commits used `-c user.name=Amel-DZRV -c user.email=…`. You may want to set it with `git config --global`.
  - Agent worktrees remain under `C:\dev\Strategos\.claude\worktrees\` (ignored by git). Remove them when no longer needed (`git worktree list`, `git worktree remove <path>`).
  - Stray folders to delete by hand: `C:\dev\Strategos-tmp` and `C:\dev\Strategos\spike\devstrategos-sandbox`.
  - The sandbox repo has untracked `probe.txt`, `probe.md` and a `.claude/handoffs/` note.
- **Safety record:** `~/.claude/settings.json` had the same SHA-256 before and after every real-Claude run. Nothing in the build writes to `~/.claude` (enforced by `safe-fs`).

## How the build was run (to continue the same way)

- The owner asked for a multi-agent build: Opus coordinates and reviews; Sonnet/Haiku agents edit, read and build.
- Each agent gets a self-contained prompt: plan sections to read, files it owns, the rules from `CLAUDE.md`, and "done when".
- Agents work in their own worktree and branch; the coordinator merges with `--no-ff` and runs `npm run check` after every merge.
- Only one full test run at a time on this machine.
- Never push or merge into `main` without the owner's OK.
