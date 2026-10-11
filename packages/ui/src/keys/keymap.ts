// Keymap as a per-platform table, not two code paths (plan section 7). When an xterm pane has focus every key goes to
// Claude except the chord that leaves the terminal.

export type Platform = 'win' | 'mac';

export interface Chord {
  key: string; // compared lower-cased
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export const KEYMAP: Record<Platform, { leaveTerminal: Chord; palette: Chord }> = {
  win: { leaveTerminal: { key: 'm', ctrl: true, alt: true }, palette: { key: 'k', ctrl: true } },
  mac: { leaveTerminal: { key: 'm', meta: true, shift: true }, palette: { key: 'k', meta: true } },
};

export function detectPlatform(nav: Pick<Navigator, 'platform' | 'userAgent'> = navigator): Platform {
  return /mac|iphone|ipad/i.test(nav.platform || nav.userAgent) ? 'mac' : 'win';
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

export function matches(e: KeyLike, c: Chord): boolean {
  return e.key.toLowerCase() === c.key
    && e.ctrlKey === !!c.ctrl && e.altKey === !!c.alt && e.shiftKey === !!c.shift && e.metaKey === !!c.meta;
}

export function isLeaveTerminal(e: KeyLike, platform: Platform = detectPlatform()): boolean {
  return matches(e, KEYMAP[platform].leaveTerminal);
}

export function leaveTerminalLabel(platform: Platform = detectPlatform()): string {
  return platform === 'mac' ? 'Cmd+Shift+M' : 'Ctrl+Alt+M';
}
