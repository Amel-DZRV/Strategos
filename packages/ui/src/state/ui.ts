// View state that belongs to this browser tab only (selection, open drawer, dialogs). Never authoritative data.
import { computed, signal } from '@preact/signals';
import type { UiPrefs } from '@strategos/shared';
import { store } from './store.ts';

export type DrawerTab = 'term' | 'chat' | 'review';

export const selectedId = signal<string | null>(null);
export const drawerOpen = signal(false);
export const drawerTab = signal<DrawerTab>('term');
export const newSessionOpen = signal(false);
export const stopTarget = signal<string | null>(null);
/** Bumped by the `d` key: the pending card focuses its optional deny message. */
export const denyFocusTick = signal(0);

/** A visible error from a refused or failed command (role="alert"). */
export const errorNotice = signal('');

export function selectSession(id: string | null): void {
  selectedId.value = id;
}

export function openDrawer(id: string, tab?: DrawerTab): void {
  selectedId.value = id;
  drawerOpen.value = true;
  if (tab) drawerTab.value = tab;
}

export function closeDrawer(): void {
  drawerOpen.value = false;
}

// --- Map view state (M3) ---------------------------------------------------------------------------------------------
export type ViewMode = 'map' | 'list';
/** The Map is the home screen; the session list is the secondary view (key L). */
export const view = signal<ViewMode>('map');

export type GroupBy = UiPrefs['groupBy'];
const groupByOverride = signal<GroupBy | null>(null);
/** Group by repo or initiative (key g). Follows the daemon's saved preference until the owner toggles it here. */
export const groupBy = computed<GroupBy>(() => groupByOverride.value ?? store.prefs.value.groupBy);
export function setGroupBy(g: GroupBy): void { groupByOverride.value = g; }

export const helpOpen = signal(false);
/** Session the park confirmation is open for (key p). */
export const parkTarget = signal<string | null>(null);
