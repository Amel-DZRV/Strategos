// Runs in the page's isolated world (sandbox on, contextIsolation on, no Node). It exposes ONE object,
// window.strategosShell, made of fixed functions: the page can call them, but cannot reach ipcRenderer itself.
// Main re-checks every message (sender frame, shape, limits); nothing here is trusted by it.
import { contextBridge, ipcRenderer } from 'electron';
import { SHELL_IPC, type ShellNotificationAction, type StrategosShellApi } from '@strategos/shared';

const api: StrategosShellApi = {
  kind: 'electron',
  platform: process.platform,
  getPairCode: () => ipcRenderer.invoke(SHELL_IPC.getPairCode) as Promise<string | null>,
  notify: (n) => { ipcRenderer.send(SHELL_IPC.notify, n); },
  setBadge: (count) => { ipcRenderer.send(SHELL_IPC.setBadge, count); },
  focusWindow: () => { ipcRenderer.send(SHELL_IPC.focusWindow); },
  openExternal: (url) => { ipcRenderer.send(SHELL_IPC.openExternal, url); },
  onNotificationAction: (cb) => {
    ipcRenderer.on(SHELL_IPC.notificationAction, (_e, a: ShellNotificationAction) => { cb(a); });
  },
  onNotificationClick: (cb) => {
    ipcRenderer.on(SHELL_IPC.notificationClick, (_e, strategosId: string) => { cb(strategosId); });
  },
  onSelectOldestBlocked: (cb) => {
    ipcRenderer.on(SHELL_IPC.selectOldestBlocked, () => { cb(); });
  },
};

contextBridge.exposeInMainWorld('strategosShell', api);
