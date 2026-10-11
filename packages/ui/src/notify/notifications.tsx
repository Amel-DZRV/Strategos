// Notifications (2.09). The daemon decides when (transition-only, rate limited, escalations, never for the session
// being looked at); the UI only shows what a `notify` event says: an in-page toast, and a desktop notification through
// the shell bridge when the owner has allowed it. A snapshot or resync never reaches here, so a reload is silent.
import { signal } from '@preact/signals';
import type { UiNotification } from '@strategos/shared';
import { useEffect } from 'preact/hooks';
import { statusInfo } from '../format.ts';
import { shell } from '../shell-bridge.ts';
import { store, type NotifyEvent } from '../state/store.ts';
import { openDrawer } from '../state/ui.ts';

export interface Toast { key: number; strategosId: string; kind: NotifyEvent['kind']; title: string; body: string }

export const toasts = signal<readonly Toast[]>([]);
export const permission = signal<NotificationPermission | 'unsupported'>(shell.notificationPermission());

let nextKey = 1;
const TOAST_MS = 9000;
const MAX_TOASTS = 4;

export function dismissToast(key: number): void {
  toasts.value = toasts.value.filter((t) => t.key !== key);
}

export function clearToasts(): void { toasts.value = []; }

export function handleNotify(ev: NotifyEvent): void {
  const key = nextKey++;
  toasts.value = [...toasts.value, { key, strategosId: ev.strategosId, kind: ev.kind, title: ev.title, body: ev.body }].slice(-MAX_TOASTS);
  setTimeout(() => dismissToast(key), TOAST_MS);
  const n: UiNotification = { kind: ev.kind, strategosId: ev.strategosId, title: ev.title, body: ev.body };
  if (ev.risk) n.risk = ev.risk;
  if (ev.requestId) n.requestId = ev.requestId;
  if (store.prefs.value.notifications.enabled) shell.notify(n);
}

/** Show the session a notification or toast was about. */
export function showSession(strategosId: string): void {
  shell.focusWindow();
  if (store.sessions.value.has(strategosId)) openDrawer(strategosId);
}

export async function enableNotifications(): Promise<void> {
  permission.value = await shell.requestNotificationPermission();
}

/** Wire the daemon's notify events to toasts and the shell, and desktop-notification clicks to the session. */
export function useNotifications(): void {
  useEffect(() => {
    shell.onNotificationClick(showSession);
    return store.onNotify(handleNotify);
  }, []);
}

const KIND_COLOUR: Record<NotifyEvent['kind'], string> = {
  permission: statusInfo('permission').colour, question: statusInfo('question').colour, errored: statusInfo('errored').colour,
  done: statusInfo('done').colour, escalate: statusInfo('permission').colour,
};

export function Toasts() {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div class="toasts" role="region" aria-label="Notifications">
      {list.map((t) => (
        <button
          key={t.key} type="button" class="toast" style={`--stc:${KIND_COLOUR[t.kind]}`}
          onClick={() => { dismissToast(t.key); showSession(t.strategosId); }}
        >
          <b>{t.title}</b>
          <span>{t.body}</span>
        </button>
      ))}
    </div>
  );
}

/** "Enable notifications": shown only while the browser has not been asked, and only on a click does it ask. */
export function EnableNotifications() {
  if (permission.value !== 'default' || !store.prefs.value.notifications.enabled) return null;
  return <button type="button" class="quiet" title="Enable desktop notifications for sessions that need you" aria-label="Enable notifications" onClick={() => void enableNotifications()}>Notifications</button>;
}
