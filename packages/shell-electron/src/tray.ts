// Tray icon, taskbar badge and dock badge (task 7.02). The page pushes the needs-you count whenever it changes
// (shell.setBadge); the badge is that same number, so it equals the strip count.
import { Menu, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import { encodePng, renderBadge, renderTrayIcon } from './icon.ts';
import { tooltipFor } from './window-state.ts';

const image = (size: number, rgba: Uint8Array, scaleFactor = 1): Electron.NativeImage =>
  nativeImage.createFromBuffer(Buffer.from(encodePng({ width: size, height: size, rgba })), { scaleFactor });

export interface TrayHandlers {
  /** Left click on the tray icon: bring the window forward and select the session that has waited longest. */
  onActivate(): void;
  onShow(): void;
  onQuit(): void;
}

export interface TrayController {
  setCount(n: number): void;
  reapply(): void;
  destroy(): void;
}

export function createTray(getWindow: () => BrowserWindow | null, h: TrayHandlers): TrayController {
  // 32 px bitmap at scale factor 2 = a sharp 16 px icon on high-DPI screens and a clean downscale elsewhere.
  const iconFor = (n: number): Electron.NativeImage => image(32, renderTrayIcon(32, n).rgba, 2);
  const tray = new Tray(iconFor(0));
  tray.setToolTip(tooltipFor(0));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Strategos', click: () => { h.onShow(); } },
    { type: 'separator' },
    { label: 'Quit (sessions keep running)', click: () => { h.onQuit(); } },
  ]));
  tray.on('click', () => { h.onActivate(); });

  let last = -1;
  return {
    /** The overlay belongs to a window: apply it again after the window was made anew. */
    reapply() {
      const c = Math.max(0, last);
      last = -1;
      this.setCount(c);
    },
    setCount(n) {
      const count = Math.max(0, Math.floor(n));
      if (count === last) return;
      last = count;
      tray.setToolTip(tooltipFor(count));
      tray.setImage(iconFor(count));
      const win = getWindow();
      if (process.platform === 'win32') {
        // Taskbar overlay: a small red disc with the number; cleared when nothing needs you.
        win?.setOverlayIcon(count > 0 ? image(16, renderBadge(count, 16).rgba) : null, count > 0 ? tooltipFor(count) : '');
      } else if (process.platform === 'darwin') {
        app.dock?.setBadge(count > 0 ? String(count) : '');
      } else {
        app.setBadgeCount(count);
      }
    },
    destroy() { tray.destroy(); },
  };
}
