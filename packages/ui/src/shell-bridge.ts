// The only shell-specific surface in the UI (plan section 4.1). This is the browser implementation; the Electron
// shell (M7) provides another with kind 'electron'.
import type { UiNotification } from '@strategos/shared';

export interface ShellBridge {
  notify(n: UiNotification): void;
  setBadge(count: number): void;
  focusWindow(): void;
  openExternal(url: string): void;
  onNotificationAction(cb: (a: { requestId: string; action: 'approve' | 'deny' | 'open' }) => void): void;
  /** The owner clicked a desktop notification: the window is already focused, show this session. */
  onNotificationClick(cb: (strategosId: string) => void): void;
  /** 'unsupported' where there is no Notification API. 'default' = not asked yet. */
  notificationPermission(): NotificationPermission | 'unsupported';
  /** Ask the browser for permission. Call it from a click, never on load. */
  requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'>;
  kind: 'browser' | 'electron';
}

const BASE_TITLE = 'Strategos';

export function titleFor(count: number): string {
  return count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

/** A 32px favicon: a dark rounded square with a red dot (and the count) when something needs you. */
function faviconHref(count: number, doc: Document): string | null {
  if (/jsdom/i.test(doc.defaultView?.navigator.userAgent ?? '')) return null; // no canvas there
  const canvas = doc.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const g = canvas.getContext?.('2d') ?? null;
  if (g === null) return null;
  g.fillStyle = '#0f1424';
  g.beginPath();
  g.roundRect(2, 2, 28, 28, 7);
  g.fill();
  g.fillStyle = '#e8ecf2';
  g.font = '600 18px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('S', 16, 17);
  if (count > 0) {
    g.fillStyle = '#ff6a5a';
    g.beginPath();
    g.arc(23, 9, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0e16';
    g.font = '700 11px sans-serif';
    g.fillText(count > 9 ? '9+' : String(count), 23, 10);
  }
  return canvas.toDataURL('image/png');
}

export function createBrowserShellBridge(win: Window = window): ShellBridge {
  const doc = win.document;
  const NotificationApi = () => (win as unknown as { Notification?: typeof Notification }).Notification;
  const clickListeners = new Set<(strategosId: string) => void>();
  return {
    kind: 'browser',
    notificationPermission() {
      const N = NotificationApi();
      return N ? N.permission : 'unsupported';
    },
    async requestNotificationPermission() {
      const N = NotificationApi();
      if (!N) return 'unsupported';
      try {
        return await N.requestPermission();
      } catch {
        return N.permission;
      }
    },
    onNotificationClick(cb) { clickListeners.add(cb); },
    notify(n) {
      const N = NotificationApi();
      if (!N || N.permission !== 'granted') return;
      try {
        const note = new N(n.title, { body: n.body, tag: n.requestId ?? n.strategosId });
        note.onclick = () => {
          win.focus();
          note.close();
          for (const cb of clickListeners) cb(n.strategosId);
        };
      } catch {
        // some environments throw on construction; the in-page UI still shows the item
      }
    },
    setBadge(count) {
      doc.title = titleFor(count);
      const href = faviconHref(count, doc);
      if (href === null) return;
      let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = doc.createElement('link');
        link.rel = 'icon';
        doc.head.appendChild(link);
      }
      link.type = 'image/png';
      link.href = href;
    },
    focusWindow() { win.focus(); },
    openExternal(url) {
      // Only web links; noopener keeps the opened page from reaching this window.
      if (!/^https?:\/\//i.test(url)) return;
      win.open(url, '_blank', 'noopener,noreferrer');
    },
    onNotificationAction() {
      // Web Notifications have no action buttons here; toasts with buttons come with the Electron shell (M7).
    },
  };
}

export const shell: ShellBridge = createBrowserShellBridge();
