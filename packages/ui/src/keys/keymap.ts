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

// --- Single-key actions (plan section 7 table). One table for both platforms; the handler only reads this. -------------
export type ActionId =
  | 'next' | 'prev' | 'left' | 'right' | 'up' | 'down' | 'open' | 'close' | 'approve' | 'deny' | 'always' | 'option'
  | 'reply' | 'terminal' | 'review' | 'new' | 'stop' | 'park' | 'seen' | 'group' | 'list' | 'help';

export interface KeyAction {
  id: ActionId;
  /** KeyboardEvent.key values that trigger it (case matters: Shift+n arrives as "N"). */
  keys: string[];
  /** Shown in the key help. */
  show: string;
  label: string;
}

export const KEY_ACTIONS: readonly KeyAction[] = [
  { id: 'next', keys: ['n'], show: 'n', label: 'Next session that needs you' },
  { id: 'prev', keys: ['N'], show: 'Shift+N', label: 'Previous session that needs you' },
  { id: 'left', keys: ['ArrowLeft', 'h'], show: '← / h', label: 'Move selection left' },
  { id: 'down', keys: ['ArrowDown', 'j'], show: '↓ / j', label: 'Move selection down' },
  { id: 'up', keys: ['ArrowUp', 'k'], show: '↑ / k', label: 'Move selection up' },
  { id: 'right', keys: ['ArrowRight', 'l'], show: '→ / l', label: 'Move selection right' },
  { id: 'open', keys: ['Enter'], show: 'Enter', label: 'Open the drawer' },
  { id: 'close', keys: ['Escape'], show: 'Esc', label: 'Close the drawer or dialog, back to the map' },
  { id: 'approve', keys: ['a'], show: 'a', label: 'Approve the selected request' },
  { id: 'deny', keys: ['d'], show: 'd', label: 'Deny (opens the optional message)' },
  { id: 'always', keys: ['A'], show: 'Shift+A', label: 'Always allow (when Claude suggested a rule)' },
  { id: 'option', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], show: '1 to 9', label: 'Pick an answer option on a question' },
  { id: 'reply', keys: ['r'], show: 'r', label: 'Reply box' },
  { id: 'terminal', keys: ['t'], show: 't', label: 'Drawer: terminal or chat' },
  { id: 'review', keys: ['v'], show: 'v', label: 'Drawer: review' },
  { id: 'new', keys: ['c'], show: 'c', label: 'New session' },
  { id: 'stop', keys: ['s'], show: 's', label: 'Stop (asks first)' },
  { id: 'park', keys: ['p'], show: 'p', label: 'Park (asks first)' },
  { id: 'seen', keys: ['x'], show: 'x', label: 'Mark seen' },
  { id: 'group', keys: ['g'], show: 'g', label: 'Group by repo or initiative' },
  { id: 'list', keys: ['L'], show: 'Shift+L', label: 'Map or list view' },
  { id: 'help', keys: ['?'], show: '?', label: 'This help' },
];

export function actionFor(key: string): { id: ActionId; option?: number } | undefined {
  for (const a of KEY_ACTIONS) {
    if (!a.keys.includes(key)) continue;
    return a.id === 'option' ? { id: a.id, option: Number(key) } : { id: a.id };
  }
  return undefined;
}

export function isLeaveTerminal(e: KeyLike, platform: Platform = detectPlatform()): boolean {
  return matches(e, KEYMAP[platform].leaveTerminal);
}

export function paletteLabel(platform: Platform = detectPlatform()): string {
  return platform === 'mac' ? 'Cmd+K' : 'Ctrl+K';
}

export function leaveTerminalLabel(platform: Platform = detectPlatform()): string {
  return platform === 'mac' ? 'Cmd+Shift+M' : 'Ctrl+Alt+M';
}
