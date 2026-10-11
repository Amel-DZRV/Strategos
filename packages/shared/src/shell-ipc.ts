// The contract between the Electron shell (main + preload) and the UI page: what `window.strategosShell` offers and the
// IPC channel names behind it. Types and constants only, so both sides compile against one definition.
import type { UiNotification } from './types.ts';

export const SHELL_IPC = {
  /** invoke: the renderer asks main for a fresh one-time pairing code (null when it cannot get one). */
  getPairCode: 'strategos:get-pair-code',
  notify: 'strategos:notify',
  setBadge: 'strategos:set-badge',
  focusWindow: 'strategos:focus-window',
  openExternal: 'strategos:open-external',
  /** main -> renderer */
  notificationAction: 'strategos:notification-action',
  notificationClick: 'strategos:notification-click',
  /** main -> renderer: the tray icon was clicked; select the oldest blocked session. */
  selectOldestBlocked: 'strategos:select-oldest-blocked',
} as const;

export type ShellNotificationAction = { requestId: string; action: 'approve' | 'deny' | 'open' };

export interface StrategosShellApi {
  readonly kind: 'electron';
  /** process.platform of the shell. */
  readonly platform: string;
  /** A fresh one-time pairing code for this window, or null. Never on disk, never in the URL. */
  getPairCode(): Promise<string | null>;
  notify(n: UiNotification): void;
  setBadge(count: number): void;
  focusWindow(): void;
  openExternal(url: string): void;
  onNotificationAction(cb: (a: ShellNotificationAction) => void): void;
  onNotificationClick(cb: (strategosId: string) => void): void;
  onSelectOldestBlocked(cb: () => void): void;
}
