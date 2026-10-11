// The Strategos desktop shell (milestone M7). It shows the UI the daemon serves, nothing more: window, tray, badge,
// toasts and a global hotkey. All logic and all state stay in the daemon (D2), which runs under the system Node (D7).
//
// Pairing in Electron (plan section 10, "In Electron the token goes over IPC instead"): this process asks the daemon's
// /control/pair route for a one-time code with the secret in ~/.strategos/cli.secret and hands it to the page over IPC
// when the page asks (preload: strategosShell.getPairCode). The page loads from http://127.0.0.1:<port>/ with no code in
// the address, so the code is in no URL, no history and no file. The page redeems it at /api/pair and gets the usual
// HttpOnly cookie, kept in Electron's own profile folder.
import { app, BrowserWindow, Menu, Notification, dialog, globalShortcut, ipcMain, nativeImage, screen, session, shell as electronShell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SHELL_IPC } from '@strategos/shared';
import { DaemonUnavailable, ensureDaemon, homeDir, pairCode, realDiscovery } from './daemon-launch.ts';
import { findLiveDaemon, type DaemonInfo } from './discovery.ts';
import { encodePng, renderAppIcon } from './icon.ts';
import { daemonOrigin, isDaemonUrl, isExternalAllowed, isPermissionAllowed, isRequestAllowed, isTrustedSender } from './nav-guard.ts';
import { isNotification } from './toast-spec.ts';
import { createToasts } from './toasts.ts';
import { createTray, type TrayController } from './tray.ts';
import { parseSaved, restoreBounds, MIN_SIZE } from './window-state.ts';

declare const __dirname: string; // CommonJS bundle (esbuild)

const args = process.argv.slice(1);
const smoke = args.includes('--smoke');
const argValue = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes('=') ? args[i]!.slice(args[i]!.indexOf('=') + 1) : args[i + 1];
};

/** The security settings of the window. The smoke run reports them and checks their effect from inside the page. */
const WEB_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
} as const;
const HOTKEY = 'CommandOrControl+Alt+S';
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const daemonEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'app', 'packages', 'daemon', 'src', 'main.mjs')
  : (process.env['STRATEGOS_DAEMON_ENTRY'] ?? path.join(repoRoot, 'packages', 'daemon', 'src', 'main.ts'));

let origin = '';
let win: BrowserWindow | null = null;
let tray: TrayController | null = null;
let quitting = false;
let lastCount = 0;

app.setName('Strategos');
if (process.platform === 'win32') app.setAppUserModelId('com.strategos.app');
// A smoke run must not touch the real profile (cookie, window state), nor collide with a running instance.
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), 'strategos-shell-smoke'));

const appIcon = (): Electron.NativeImage => nativeImage.createFromBuffer(Buffer.from(encodePng(renderAppIcon(256))));

// ---------------------------------------------------------------------------
// window state
// ---------------------------------------------------------------------------

const stateFile = (): string => path.join(app.getPath('userData'), 'window-state.json');

function loadState(): ReturnType<typeof parseSaved> {
  try {
    return parseSaved(JSON.parse(readFileSync(stateFile(), 'utf8')));
  } catch {
    return null;
  }
}

function saveState(w: BrowserWindow): void {
  try {
    const b = w.isMaximized() || w.isMinimized() ? w.getNormalBounds() : w.getBounds();
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: w.isMaximized() }));
  } catch {
    // losing the window position is harmless
  }
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function showWindow(): void {
  if (win === null || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function pageUrlOk(url: string): boolean {
  return origin !== '' && isDaemonUrl(url, origin);
}

function handOff(url: string): void {
  if (isExternalAllowed(url)) void electronShell.openExternal(url);
}

/** Navigation rules for every web contents this app ever creates. */
function guard(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    handOff(url);
    return { action: 'deny' };
  });
  const block = (e: { preventDefault(): void }, url: string): void => {
    if (pageUrlOk(url)) return; // loadURL from this file does not fire these events, so only the page itself is judged here
    e.preventDefault();
    handOff(url);
  };
  contents.on('will-navigate', (e, url) => { block(e, url); });
  contents.on('will-redirect', (e, url) => { block(e, url); });
  contents.on('will-frame-navigate', (e) => { block(e, e.url); });
  contents.on('will-attach-webview', (e) => { e.preventDefault(); });
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl || wc.getURL(), origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin, origin));
  ses.setDevicePermissionHandler(() => false);
  // No remote content: the page may only talk to the daemon.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: !isRequestAllowed(details.url, origin) });
  });
}

function errorPage(message: string): string {
  const esc = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Strategos</title><body style="background:#0b0e16;color:#e8ecf2;font:15px system-ui;padding:48px;max-width:640px"><h2>Strategos</h2><p>${esc}</p><p style="color:#8a93a6">Looking for the service again every few seconds.</p>`)}`;
}

let recovering = false;
/** The page could not load (the service stopped or moved to another port): show a note and wait for it to come back. */
function recover(w: BrowserWindow, why: string): void {
  if (recovering || quitting) return;
  recovering = true;
  void w.loadURL(errorPage(`The Strategos service is not answering (${why}). Your Claude sessions are not affected by this window. Run "npm run strategos -- start", or start Strategos again.`));
  const timer = setInterval(() => {
    if (w.isDestroyed() || quitting) { clearInterval(timer); return; }
    void findLiveDaemon(homeDir(), realDiscovery).then((info) => {
      if (info === null || w.isDestroyed()) return;
      clearInterval(timer);
      origin = daemonOrigin(info.port);
      recovering = false;
      void w.loadURL(`${origin}/`);
    });
  }, 2500);
}

function createWindow(): BrowserWindow {
  const { bounds, maximized } = restoreBounds(loadState(), screen.getAllDisplays().map((d) => d.workArea));
  const w = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Strategos',
    backgroundColor: '#0b0e16',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), ...WEB_PREFS },
  });
  if (maximized) w.maximize();
  w.once('ready-to-show', () => { w.show(); });
  w.on('page-title-updated', (e, title) => { // "(2) Strategos" from the UI is fine; keep it
    e.preventDefault();
    w.setTitle(title);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (): void => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed()) saveState(w); }, 600); };
  w.on('resize', later);
  w.on('move', later);
  w.on('close', (e) => {
    if (!w.isDestroyed()) saveState(w);
    if (!quitting && !smoke && tray !== null) { // closing hides to the tray; the hotkey and toasts keep working
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => { if (win === w) win = null; });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !url.startsWith('data:')) recover(w, desc);
  });
  w.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') recover(w, d.reason); });
  return w;
}

// ---------------------------------------------------------------------------
// IPC (every handler checks who is asking and what they sent)
// ---------------------------------------------------------------------------

const trusted = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
  isTrustedSender(e.senderFrame?.url, e.senderFrame !== null && e.senderFrame === e.sender.mainFrame, origin);

function registerIpc(): void {
  const toasts = createToasts({
    onAction: (a) => { win?.webContents.send(SHELL_IPC.notificationAction, a); },
    onClick: (strategosId) => {
      showWindow();
      win?.webContents.send(SHELL_IPC.notificationClick, strategosId);
    },
  }, { icon: appIcon() });

  ipcMain.handle(SHELL_IPC.getPairCode, async (e): Promise<string | null> => {
    if (!trusted(e)) return null;
    const home = homeDir();
    const info = await findLiveDaemon(home, realDiscovery);
    if (info === null || daemonOrigin(info.port) !== origin) return null;
    return pairCode(home, info);
  });
  ipcMain.on(SHELL_IPC.notify, (e, n: unknown) => {
    if (!trusted(e) || !isNotification(n)) return;
    toasts.show(n);
  });
  ipcMain.on(SHELL_IPC.setBadge, (e, count: unknown) => {
    if (!trusted(e) || typeof count !== 'number' || !Number.isFinite(count) || count < 0 || count > 99999) return;
    lastCount = Math.floor(count);
    tray?.setCount(lastCount);
  });
  ipcMain.on(SHELL_IPC.focusWindow, (e) => { if (trusted(e)) showWindow(); });
  ipcMain.on(SHELL_IPC.openExternal, (e, url: unknown) => {
    if (!trusted(e) || typeof url !== 'string' || url.length > 2048) return;
    handOff(url);
  });
}

// ---------------------------------------------------------------------------
// smoke test: `electron . --smoke --smoke-shot <png> --smoke-out <json>`
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runSmoke(w: BrowserWindow): Promise<void> {
  const shot = argValue('--smoke-shot');
  const out = argValue('--smoke-out');
  const wc = w.webContents;
  const probe = `(() => ({
    url: location.href, hash: location.hash, title: document.title,
    ui: !!document.querySelector('.app'), shellKind: window.strategosShell ? window.strategosShell.kind : null,
    hasRequire: typeof require !== 'undefined', hasProcess: typeof process !== 'undefined',
    text: document.body ? document.body.innerText.slice(0, 400) : ''
  }))()`;
  let state: Record<string, unknown>;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      state = (await wc.executeJavaScript(probe)) as Record<string, unknown>;
      if (state['ui'] === true) break;
    } catch {
      // the page is still loading
    }
    await sleep(300);
  }
  await sleep(2500); // let the pairing, the WebSocket and the first snapshot settle
  state = (await wc.executeJavaScript(probe)) as Record<string, unknown>;
  const apiStatus = (await wc.executeJavaScript(`fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.status)`)) as number;
  const result = {
    ok: state['ui'] === true && apiStatus !== 401 && state['hasRequire'] === false && state['hasProcess'] === false && state['shellKind'] === 'electron' && !String(state['hash']).includes('pair='),
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    origin, apiSessionStatus: apiStatus, state,
    webPreferences: WEB_PREFS,
    notificationsSupported: Notification.isSupported(), hotkeyRegistered: globalShortcut.isRegistered(HOTKEY),
  };
  if (shot !== undefined) {
    const img = await wc.capturePage();
    mkdirSync(path.dirname(path.resolve(shot)), { recursive: true });
    writeFileSync(path.resolve(shot), img.toPNG());
  }
  const text = JSON.stringify(result, null, 2);
  if (out !== undefined) writeFileSync(path.resolve(out), text);
  try { console.log(text); } catch { /* a packaged GUI app may have no console */ }
  quitting = true;
  app.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  let info: DaemonInfo;
  try {
    info = await ensureDaemon(homeDir(), { entry: daemonEntry });
  } catch (err) {
    const msg = err instanceof DaemonUnavailable ? err.message : `Strategos could not start: ${err instanceof Error ? err.message : String(err)}`;
    if (smoke) { console.error(msg); app.exit(2); return; }
    dialog.showErrorBox('Strategos', msg);
    app.exit(1);
    return;
  }
  origin = daemonOrigin(info.port);
  hardenSession();
  registerIpc();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  win = createWindow();
  if (!smoke) {
    try {
      tray = createTray(() => win, {
        onActivate: () => {
          showWindow();
          win?.webContents.send(SHELL_IPC.selectOldestBlocked);
        },
        onShow: showWindow,
        onQuit: () => { quitting = true; app.quit(); },
      });
      tray.setCount(lastCount);
    } catch (err) {
      console.error('tray unavailable:', err);
    }
    if (!globalShortcut.register(HOTKEY, showWindow)) console.error(`hotkey ${HOTKEY} is taken by another program`);
  } else {
    globalShortcut.register(HOTKEY, showWindow);
  }
  win.webContents.once('did-finish-load', () => { if (smoke && win !== null) runSmoke(win).catch((err: unknown) => { console.error(err); app.exit(3); }); });
  await win.loadURL(`${origin}/`).catch(() => undefined); // did-fail-load takes over
}

app.on('web-contents-created', (_e, contents) => { guard(contents); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* the tray keeps the app alive; Quit is in its menu */ if (smoke || tray === null) app.quit(); });
app.on('activate', showWindow);

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // another Strategos window is running: it gets focus below
} else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(start);
}
