// Notifications (2.09). The daemon decides when (transition-only, rate limited, escalations, never for the session
// being looked at); the UI only shows what a `notify` event says: an in-page toast, and a desktop notification through
// the shell bridge when the owner has allowed it. A snapshot or resync never reaches here, so a reload is silent.
import { signal } from '@preact/signals';
import { toastActions, type SessionRecord, type UiNotification } from '@strategos/shared';
import { useEffect } from 'preact/hooks';
import { statusInfo } from '../format.ts';
import { shell } from '../shell-bridge.ts';
import { send } from '../state/commands.ts';
import { store, type NotifyEvent } from '../state/store.ts';
import { errorNotice, openDrawer } from '../state/ui.ts';

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
  const actions = actionsFor(ev);
  if (actions) n.actions = actions;
  if (store.prefs.value.notifications.enabled) shell.notify(n);
}

/**
 * Buttons for a desktop notification (Electron only; a browser notification has none). Approve only when D20 holds and the
 * input was not cut (D21); the daemon checks both again when the decision arrives with via 'toast'.
 */
function actionsFor(ev: NotifyEvent): UiNotification['actions'] | undefined {
  if (shell.kind !== 'electron' || ev.requestId === undefined) return undefined;
  const s = store.sessions.value.get(ev.strategosId);
  if (s?.pending?.requestId !== ev.requestId) return undefined;
  return toastActions(s.pending, { worktree: s.worktree?.path ?? s.cwd, platform: shell.platform === 'win32' ? 'win32' : 'posix' });
}

function sessionOfRequest(requestId: string): SessionRecord | undefined {
  for (const s of store.sessions.value.values()) if (s.pending?.requestId === requestId) return s;
  return undefined;
}

/** A button on a desktop notification was pressed (Approve / Deny / Open). Decisions carry via 'toast' for the audit log. */
export function handleNotificationAction(a: { requestId: string; action: 'approve' | 'deny' | 'open' }): void {
  const s = sessionOfRequest(a.requestId);
  if (s === undefined) return; // already answered somewhere else
  if (a.action === 'open') { showSession(s.strategosId); return; }
  const cmd = { c: 'perm.decide' as const, strategosId: s.strategosId, requestId: a.requestId, decision: a.action === 'approve' ? 'allow' as const : 'deny' as const, via: 'toast' };
  send(cmd).catch((e: unknown) => {
    errorNotice.value = `Could not ${a.action} from the notification: ${e instanceof Error ? e.message : String(e)}. Open the session and decide there.`;
    showSession(s.strategosId);
  });
}

/** Tray icon click: show the session that has waited longest for you. */
export function showOldestBlocked(): void {
  shell.focusWindow();
  const waiting = store.needsYou.value.filter((s) => s.status === 'permission' || s.status === 'question');
  const oldest = [...(waiting.length > 0 ? waiting : store.needsYou.value)].sort((a, b) => (a.waitingSince ?? a.statusSince) - (b.waitingSince ?? b.statusSince))[0];
  if (oldest !== undefined) openDrawer(oldest.strategosId);
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
    shell.onNotificationAction(handleNotificationAction);
    shell.onSelectOldestBlocked?.(showOldestBlocked);
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
