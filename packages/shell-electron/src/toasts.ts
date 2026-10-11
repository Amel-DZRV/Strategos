// Native desktop notifications with Approve / Deny / Open buttons (task 7.03).
//
// Windows and macOS both support `actions` on Electron's Notification. A press is sent to the page, which sends
// perm.decide with via 'toast'; the daemon checks D20/D21 again on the full input. A notification whose process was gone
// when it was pressed (cold start) arrives through Notification.handleActivation: the request it belonged to is
// not known any more, so the only safe reaction is to bring the window forward.
import { Notification } from 'electron';
import type { UiNotification } from '@strategos/shared';
import { buildToast, type ToastAction } from './toast-spec.ts';

export interface ToastHandlers {
  onAction(a: { requestId: string; action: ToastAction }): void;
  onClick(strategosId: string): void;
}

export interface Toasts {
  show(n: UiNotification): void;
  /** Drop the toast of an answered request. */
  dismiss(requestId: string): void;
}

export function createToasts(h: ToastHandlers, o: { icon?: Electron.NativeImage; silent?: () => boolean }): Toasts {
  // A Notification that is garbage collected loses its events, so live ones are kept here until closed.
  const live = new Map<string, Electron.Notification>();

  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation(() => { /* cold start or lost object: the caller shows the window */ });
  }

  return {
    show(n) {
      if (!Notification.isSupported()) return;
      const spec = buildToast(n);
      live.get(spec.id)?.close();
      const note = new Notification({
        id: spec.id,
        title: spec.title,
        body: spec.body,
        silent: o.silent?.() ?? false,
        ...(o.icon === undefined ? {} : { icon: o.icon }),
        ...(spec.actions.length > 0 ? { actions: spec.actions.map((a) => ({ type: 'button' as const, text: a.text })) } : {}),
        ...(process.platform === 'win32' && spec.sticky ? { timeoutType: 'never' as const } : {}),
      });
      live.set(spec.id, note);
      const forget = (): void => { if (live.get(spec.id) === note) live.delete(spec.id); };
      note.on('click', () => { h.onClick(spec.strategosId); forget(); });
      note.on('action', (_e, index) => {
        const a = spec.actions[index];
        if (a === undefined) return;
        if (a.action === 'open' || spec.requestId === undefined) h.onClick(spec.strategosId);
        else h.onAction({ requestId: spec.requestId, action: a.action });
        forget();
      });
      note.on('close', forget);
      note.show();
    },
    dismiss(requestId) {
      live.get(requestId)?.close();
      live.delete(requestId);
    },
  };
}
