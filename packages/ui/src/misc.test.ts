import { describe, expect, it, vi } from 'vitest';
import { fmtWait, money, startOfLocalDay, waitingMs } from './format.ts';
import { detectPlatform, isLeaveTerminal, leaveTerminalLabel } from './keys/keymap.ts';
import { createBrowserShellBridge, titleFor } from './shell-bridge.ts';
import { makeSession } from './test/fixtures.ts';
import { computeCounts, waitingToday } from './topbar/TopBar.tsx';

describe('format', () => {
  it('formats waiting time', () => {
    expect(fmtWait(0)).toBe('0s');
    expect(fmtWait(45_000)).toBe('45s');
    expect(fmtWait(14 * 60_000 + 59_000)).toBe('14m');
    expect(fmtWait(65 * 60_000)).toBe('1h 05m');
    expect(fmtWait(-5)).toBe('0s');
  });
  it('formats cost as an estimate', () => {
    expect(money(3.416)).toBe('≈$3.42');
  });
  it('waits from waitingSince, else statusSince', () => {
    expect(waitingMs(makeSession({ strategosId: 'a', waitingSince: 100, statusSince: 50 }), 1100)).toBe(1000);
    expect(waitingMs(makeSession({ strategosId: 'a', statusSince: 50 }), 1050)).toBe(1000);
  });
  it('finds the start of the local day', () => {
    const t = new Date(2026, 9, 11, 15, 30).getTime();
    expect(new Date(startOfLocalDay(t)).getHours()).toBe(0);
    expect(startOfLocalDay(t)).toBeLessThanOrEqual(t);
  });
});

describe('keymap', () => {
  const e = (o: Partial<KeyboardEvent>) => ({ key: 'm', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  it('Windows leaves the terminal with Ctrl+Alt+M only', () => {
    expect(isLeaveTerminal(e({ ctrlKey: true, altKey: true }), 'win')).toBe(true);
    expect(isLeaveTerminal(e({ ctrlKey: true }), 'win')).toBe(false);
    expect(isLeaveTerminal(e({ metaKey: true, shiftKey: true, key: 'M' }), 'win')).toBe(false);
    expect(leaveTerminalLabel('win')).toBe('Ctrl+Alt+M');
  });
  it('macOS leaves the terminal with Cmd+Shift+M only', () => {
    expect(isLeaveTerminal(e({ metaKey: true, shiftKey: true, key: 'M' }), 'mac')).toBe(true);
    expect(isLeaveTerminal(e({ ctrlKey: true, altKey: true }), 'mac')).toBe(false);
    expect(leaveTerminalLabel('mac')).toBe('Cmd+Shift+M');
  });
  it('detects the platform', () => {
    expect(detectPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32', userAgent: '' })).toBe('win');
  });
});

describe('top bar counts (2.08)', () => {
  const now = 10_000_000;
  const list = [
    makeSession({ strategosId: 'p', status: 'permission', waitingSince: now - 14 * 60_000 }),
    makeSession({ strategosId: 'q', status: 'question', waitingSince: now - 4 * 60_000 }),
    makeSession({ strategosId: 'w', status: 'working' }),
    makeSession({ strategosId: 'd', status: 'done', doneAt: 5, statusSince: now - 60_000 }),
    makeSession({ strategosId: 's', status: 'done', doneAt: 5, seenAt: 6 }),
    makeSession({ strategosId: 'x', status: 'stopped' }),
    makeSession({ strategosId: 'z', status: 'permission', archived: true, waitingSince: 1 }),
  ];
  it('counts what needs you, the waiting-now total and the oldest', () => {
    const c = computeCounts(list, now);
    expect(c.needs).toBe(3); // p, q, and the unseen done
    expect(c.working).toBe(1);
    expect(c.done).toBe(1); // the seen one
    expect(c.stopped).toBe(1);
    expect(c.waitingNowMs).toBe(14 * 60_000 + 4 * 60_000 + 60_000);
    expect(c.oldestMs).toBe(14 * 60_000);
  });
  it('shows waiting today from the daemon digest, a dash without one', () => {
    expect(waitingToday(37 * 60_000)).toBe('37m');
    expect(waitingToday(undefined)).toBe('–');
  });
});

describe('browser shell bridge', () => {
  it('sets the title badge', () => {
    expect(titleFor(0)).toBe('Strategos');
    expect(titleFor(3)).toBe('(3) Strategos');
    const bridge = createBrowserShellBridge();
    bridge.setBadge(2);
    expect(document.title).toBe('(2) Strategos');
    bridge.setBadge(0);
    expect(document.title).toBe('Strategos');
    expect(bridge.kind).toBe('browser');
  });

  it('opens only web links, with noopener', () => {
    const open = vi.fn();
    const bridge = createBrowserShellBridge({ open, focus: vi.fn(), document } as unknown as Window);
    bridge.openExternal('https://example.com/x');
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    bridge.openExternal('javascript:alert(1)');
    bridge.openExternal('file:///C:/secret');
    expect(open).toHaveBeenCalledOnce();
  });

  it('notifies through the Web Notification API only when permission was granted', () => {
    const ctor = vi.fn(function (this: { onclick?: () => void }) { this.onclick = undefined; });
    const win = (permission: string) => ({ Notification: Object.assign(ctor, { permission }), focus: vi.fn(), document }) as unknown as Window;
    const n = { kind: 'permission' as const, strategosId: 'a', title: 'Needs you', body: 'Bash: ls', requestId: 'r' };
    createBrowserShellBridge(win('denied')).notify(n);
    expect(ctor).not.toHaveBeenCalled();
    createBrowserShellBridge(win('granted')).notify(n);
    expect(ctor).toHaveBeenCalledWith('Needs you', { body: 'Bash: ls', tag: 'r' });
  });

  it('onNotificationAction is a no-op', () => {
    expect(() => createBrowserShellBridge().onNotificationAction(() => undefined)).not.toThrow();
  });
});
