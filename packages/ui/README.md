# @strategos/ui

Preact + `@preact/signals` + Vite. The UI holds no authoritative state: it mirrors what the daemon sends over one
WebSocket (protocol v1, plan section 5) and sends commands back. M2 scope: session rows (look A), the drawer with a
real xterm terminal, and approving or denying held requests.

## Run it against the mock daemon

The real daemon does not yet implement session commands, so `scripts/mock-daemon.ts` speaks the protocol with fake
sessions (two permissions, one of them with a truncated input, a question, working, done and stopped sessions).

```
npm run mock -w @strategos/ui        # fake daemon on http://127.0.0.1:47800  (MOCK_PORT to change)
npm run dev  -w @strategos/ui        # Vite on http://127.0.0.1:5173, proxies /api and /ws to the mock
```

Open `http://127.0.0.1:5173/#pair=anything`. The mock accepts any code and sets a cookie. Stop and restart the mock to
watch the UI reconnect without a reload. The mock does not check Origin.

## Run it against the real daemon

Vite proxies `/api` and `/ws` (see `vite.config.ts`) so the page stays same-origin and the pairing cookie works.

1. Start the daemon with `STRATEGOS_DEV_ORIGIN=http://127.0.0.1:5173` (the daemon allows exactly one extra Origin).
2. `STRATEGOS_DEV_TARGET=http://127.0.0.1:<daemon port> npm run dev -w @strategos/ui`
3. Open the pairing URL the daemon prints, but with the Vite host: `http://127.0.0.1:5173/#pair=<code>`.
   (Codes live 60 s and work once; the UI strips the fragment from the address bar before using it.)

In production the daemon serves `dist/` (`npm run build -w @strategos/ui`) itself; the CSP there is
`default-src 'self'`, so the UI uses system fonts only and no external resources.

## Layout

```
src/state/connection.ts   pairing, WebSocket, backoff reconnect, seq-gap resync, command/ack (injectable for tests)
src/state/store.ts        signals: sessions, planets, initiatives, usage, prefs, connection; applies snapshot/deltas
src/state/commands.ts     send()/fire()/onChannel() on top of a swappable Transport
src/state/ui.ts           per-tab view state (selection, drawer, dialogs, error banner)
src/rows/                 look A rows and the needs-you strip
src/drawer/               Drawer, TerminalPane (xterm), PendingCard, pending-actions (approve/deny/always/answer/release)
src/topbar/TopBar.tsx     counts, waiting now / today, connection state
src/dialogs/              New session, confirm stop
src/keys/                 keymap.ts (per-platform table), global-keys.ts (a d A x n j k c Esc)
src/shell-bridge.ts       browser ShellBridge (Web Notification, title + favicon badge, openExternal)
scripts/mock-daemon.ts    the fake daemon
```

## Keys

`a` approve, `d` deny (focuses the optional message box), `A` always allow (only when the daemon offered a
suggestion), `x` mark seen, `n` next session that needs you, `j`/`k` or arrows move the selection, `c` new session,
`Esc` closes the drawer. Inside a terminal every key goes to Claude except `Ctrl+Alt+M` (Windows) or `Cmd+Shift+M`
(macOS), which leaves the terminal. `Tab` is left to the browser on purpose.

## Daemon requests (what the UI relies on, and what it invented)

Used from the frozen protocol: `session.start`, `session.stop`, `session.resume`, `session.seen`, `perm.decide`,
`perm.release`, `question.answer`, `pty.subscribe`, `pty.unsubscribe`, `pty.input`, `pty.resize`, `pty.focus`,
`digest.get` (for "waiting today"), `resync`; events `hello`, `snapshot`, `session.upsert`, `session.removed`, `usage`,
`resources`, `pty.replay`, `pty.data`, `digest`, `ack`.

Invented, not in `protocol.ts`:

- **`pending.full`** command `{ c: 'pending.full', strategosId, requestId }` (D21). The daemon should reply with a
  channel event `{ t: 'pending.full', strategosId, requestId, input: string }` (the full tool input, from memory) and
  then ack. Until the daemon supports it the real hub answers "unknown command", the UI shows the error, and Approve
  and Always stay blocked for a truncated request (Deny, Answer in terminal and release still work). That is the safe
  failure.
- The New session dialog takes the repo from a text box (plus a datalist of repos existing sessions use and a few
  recently typed ones in `localStorage`). A daemon-provided repo list (for example in the snapshot) would replace it.
