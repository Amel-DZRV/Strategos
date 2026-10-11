# Strategos desktop shell (Electron, milestone M7)

A thin window around the UI the daemon serves: tray icon, taskbar badge, native toasts with buttons, a global hotkey.
It holds no logic and no state (decision D2). The daemon runs under your own Node.js, not inside Electron (D7).

## Run it

```
npm run app            # builds the UI once, bundles the shell, starts Electron on this checkout
npm run app:smoke      # same, loads the window, checks pairing and security, saves docs/screenshots/m7-electron.png, exits
```

If no daemon is running, the shell starts one (`node packages/daemon/src/main.ts`, detached, like `strategos start`).
Closing the window hides it to the tray; "Quit" in the tray menu ends only the shell, sessions keep running.
Hotkey: `Ctrl+Alt+S` (`Cmd+Alt+S` on macOS) shows the window.

## Pairing in Electron

1. `daemon-launch.ts` reads `~/.strategos/daemon.json` (port) and `cli.secret`, and proves the daemon is alive with
   `POST /control/status`. Otherwise it starts it.
2. The window loads `http://127.0.0.1:<port>/` with no code in the address.
3. The page calls `window.strategosShell.getPairCode()` (preload, IPC). Main answers only the top frame of the daemon origin,
   fetches a fresh one-time code from `POST /control/pair` (the same route `strategos open` uses) and returns just the code.
4. The page posts it to `/api/pair` and gets the usual HttpOnly cookie, kept in Electron's own profile folder
   (`%APPDATA%/Strategos`). A cookie from an earlier run is reused, so a restart spends no code.
The code is never in a URL, a log or a file. In a plain browser the `#pair=` fragment path is unchanged.

## Security settings

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, no webview, no application menu
(Windows/Linux). Navigation guard (`src/nav-guard.ts`): the window may only be on the daemon origin; links and
`window.open` to anything else go to the system browser only if they are plain `http(s)` without credentials. All network
requests other than the daemon (http, the `/ws` socket, `data:`, `blob:`) are cancelled. Permission requests are denied
except `notifications` from the daemon origin. IPC messages are accepted only from the main frame of the daemon origin and
are shape-checked. Window size and position live in Electron's userData, never in `~/.claude`.

## Toast buttons (7.03)

The UI decides the buttons with the shared rule `toastActions` (`packages/shared/src/d20.ts`): Approve only for
`Read`/`Edit`/`Write` inside the worktree, never Bash, never a dotfile or `.git`/`.claude`/`.github` path, and never when the
input was cut at 400 characters (D21); otherwise Deny and Open. The toast body is the path. A button press goes back to the
page, which sends `perm.decide` with `via: 'toast'`. The daemon repeats D20/D21 on the full input (with symbolic links)
for every decision that arrives with `via: 'toast'`, so a wrong button cannot approve anything (`toastAllowRefusal`).

## ELECTRON_RUN_AS_NODE test (decision for 7.05)

Run on this machine, 11 Oct 2026: `ELECTRON_RUN_AS_NODE=1 electron.exe packages/daemon/src/main.ts` with Electron 44.7.0
(Node 24.21.0, ABI 149) starts the daemon (types stripped, listens on 127.0.0.1) and node-pty's N-API prebuilds load.
So it would work for the daemon itself. It is still not the default, because (a) the hook relay and status-line tap run as
`"<node path>" script.mjs` commands inside Claude sessions and would need `ELECTRON_RUN_AS_NODE` in every child's environment,
and (b) Claude would then see the Electron binary as "node". The daemon therefore runs under system Node (found on `PATH`,
then the Windows registry, then Program Files). Not tested: starting a real Claude session through an Electron-hosted daemon.

## Packaging (7.05)

```
npm run dist:win       # release/Strategos-<version>-win-x64.exe (NSIS, unsigned)   ~107 MB, about 45 s
npm run dist:mac       # dmg, unsigned (run on the Mac; not tried here)
node packages/shell-electron/scripts/dist.ts --win --dir    # unpacked app only, faster
```

The installer holds the shell plus `resources/app/`: the daemon bundled by esbuild into one file, the built UI, `tap.mjs`,
`hook-relay.mjs` and node-pty with its prebuilt binaries, laid out like the repo so the daemon's own relative paths work
unchanged. It does not contain Node: the owner needs Node.js 24 or newer installed. Windows SmartScreen will warn about the
unsigned installer. The unpacked app was run on this machine (`--smoke`): it started the bundled daemon, paired and loaded
the UI. The NSIS installer itself was built but not installed.
