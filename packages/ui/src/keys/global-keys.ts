// Keyboard shortcuts for the Map and the session list (plan section 7). Mouse and keyboard work equally: every key
// here has a button somewhere, and a command in the palette. The table of keys lives in keymap.ts, what they do in
// actions.ts; this file only decides where a key counts.
import { lowRiskOpen, newSessionOpen, paletteOpen, parkTarget, stopTarget } from '../state/ui.ts';
import { focusSession, perform } from './actions.ts';
import { actionFor, detectPlatform, KEYMAP, matches } from './keymap.ts';

export { focusSession };
/** Older name, kept for the list view's callers. */
export const focusRow = focusSession;

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('.xterm')) return true; // in a terminal every key belongs to Claude
  return t.matches('input, textarea, select, [contenteditable="true"]');
}

export function handleKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  // Ctrl+K / Cmd+K opens the palette from anywhere except a terminal (there it is Claude's: kill to end of line).
  if (matches(e, KEYMAP[detectPlatform()].palette) && !(e.target instanceof Element && e.target.closest('.xterm'))) {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (paletteOpen.value || lowRiskOpen.value) return; // those dialogs own the keyboard
  if (typingTarget(e.target) || newSessionOpen.value || stopTarget.value !== null || parkTarget.value !== null) return;
  const act = actionFor(e.key);
  if (!act) return;
  const t = e.target;
  // Movement keys only act while focus is on the page, a token or a row; never while a button, link or dialog has it.
  const onMap = t === document.body || (t instanceof Element && (t.classList.contains('row') || t.classList.contains('tok') || t.closest('.mapbox') !== null));
  if ((act.id === 'left' || act.id === 'right' || act.id === 'up' || act.id === 'down') && !onMap) return;
  if (act.id === 'open' && t !== document.body) return;
  if (perform(act.id, act.option === undefined ? {} : { option: act.option })) e.preventDefault();
}
