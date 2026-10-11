// The shared action registry (4.09): what every key does, as functions of the current selection. The keyboard handler
// (global-keys.ts) and the command palette (palette/commands.ts) both call perform(); a key without a palette command, or
// the reverse, cannot happen because both read KEY_ACTIONS and this one function.
import { always, answerQuestion, approve } from '../drawer/pending-actions.ts';
import { canStop } from '../format.ts';
import { spatialNext } from '../map/model.ts';
import { fire, send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import {
  assignTarget, closeDrawer, denyFocusTick, drawerOpen, drawerTab, errorNotice, groupBy, helpOpen, newSessionOpen, openDrawer, parkTarget,
  replyFocusTick, selectedId, selectSession, setGroupBy, stopTarget, view,
} from '../state/ui.ts';
import type { ActionId } from './keymap.ts';

/** Focus the Map token or the list row of a session. */
export function focusSession(id: string, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('.tok, .row')) if (el.dataset['sid'] === id) { el.focus(); return; }
}

export function select(id: string): void {
  selectSession(id);
  focusSession(id);
}

function move(delta: number, onlyNeeds: boolean): void {
  const list = onlyNeeds ? store.needsYou.value : store.sorted.value;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.strategosId === selectedId.value);
  const next = list[i === -1 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length]!;
  select(next.strategosId);
}

function arrow(dir: 'left' | 'right' | 'up' | 'down'): void {
  if (view.value === 'list') {
    if (dir === 'down') move(1, false);
    else if (dir === 'up') move(-1, false);
    return;
  }
  const id = spatialNext(selectedId.value, dir);
  if (id) select(id);
}

const fail = (what: string) => (err: unknown) => {
  errorNotice.value = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
};

export interface PerformOptions {
  /** 1 to 9, for the `option` action. */
  option?: number;
}

/** Whether an action can do something right now (palette: greyed out when not). */
export function canPerform(id: ActionId, opt: PerformOptions = {}): boolean {
  const s = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  const p = s?.pending;
  switch (id) {
    case 'approve': return p?.kind === 'permission' && p.held;
    case 'always': return !!p?.suggestions?.length && p.kind === 'permission' && p.held;
    case 'deny': return p?.kind === 'permission' && p.held;
    case 'option': {
      if (!p || p.kind !== 'question' || !p.held) return false;
      return opt.option === undefined || (p.questions?.[0]?.options.length ?? 0) >= opt.option;
    }
    case 'next': case 'prev': return store.needsYou.value.length > 0;
    case 'seen': case 'open': case 'terminal': case 'review': case 'reply': case 'initiative': return s !== undefined;
    case 'stop': case 'park': return !!s && canStop(s);
    case 'close': return drawerOpen.value || helpOpen.value;
    default: return true;
  }
}

/**
 * Do an action on the selection. Returns true when it did something (the key handler then stops the browser's default).
 * The key handler decides *where* a key counts (not while typing); this decides *what* it does.
 */
export function perform(id: ActionId, opt: PerformOptions = {}): boolean {
  const s = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  switch (id) {
    case 'help':
      helpOpen.value = !helpOpen.value;
      return true;
    case 'close':
      if (helpOpen.value) { helpOpen.value = false; return false; }
      if (drawerOpen.value) {
        closeDrawer();
        if (selectedId.value) focusSession(selectedId.value);
      }
      return false;
    case 'approve':
      if (s?.pending) { void approve(s); return true; }
      return false;
    case 'always':
      if (s?.pending) { void always(s); return true; }
      return false;
    case 'deny':
      if (s?.pending?.kind === 'permission' && s.pending.held) {
        openDrawer(s.strategosId);
        denyFocusTick.value++;
        return true;
      }
      return false;
    case 'option': {
      const p = s?.pending;
      if (!s || !p || p.kind !== 'question' || !p.held) return false;
      const q = p.questions?.length === 1 ? p.questions[0] : undefined;
      const o = q && !q.multiSelect ? q.options[(opt.option ?? 1) - 1] : undefined;
      if (q && o) void answerQuestion(s, { [q.question]: o.label });
      else openDrawer(s.strategosId); // several questions or multi-select: answer on the card
      return true;
    }
    case 'seen':
      if (s) { send({ c: 'session.seen', strategosId: s.strategosId }).catch(fail('Mark seen')); return true; }
      return false;
    case 'next': case 'prev': // Tab stays the browser's: trapping it would break keyboard navigation
      if (store.needsYou.value.length > 0) {
        move(id === 'prev' ? -1 : 1, true);
        if (selectedId.value) openDrawer(selectedId.value); // the drawer shows the command and Approve / Deny
        return true;
      }
      return false;
    case 'left': case 'right': case 'up': case 'down':
      arrow(id);
      return true;
    case 'open':
      if (s) { openDrawer(s.strategosId); return true; }
      return false;
    case 'terminal':
      if (s) {
        if (!drawerOpen.value) openDrawer(s.strategosId, 'term');
        else drawerTab.value = drawerTab.value === 'term' ? 'chat' : 'term';
        return true;
      }
      return false;
    case 'review':
      if (s) { openDrawer(s.strategosId, 'review'); return true; }
      return false;
    case 'reply':
      if (s) { openDrawer(s.strategosId, 'chat'); replyFocusTick.value++; return true; }
      return false;
    case 'initiative':
      if (s) { assignTarget.value = s.strategosId; return true; }
      return false;
    case 'new':
      newSessionOpen.value = true;
      return true;
    case 'stop':
      if (s && canStop(s)) { stopTarget.value = s.strategosId; return true; }
      return false;
    case 'park':
      if (s && canStop(s)) { parkTarget.value = s.strategosId; return true; }
      return false;
    case 'group': {
      const next = groupBy.value === 'repo' ? 'initiative' : 'repo';
      setGroupBy(next);
      fire({ c: 'prefs.set', prefs: { groupBy: next } });
      return true;
    }
    case 'list':
      view.value = view.value === 'map' ? 'list' : 'map';
      return true;
    default:
      return false;
  }
}
