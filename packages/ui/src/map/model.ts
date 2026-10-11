// Reactive side of the Map: owns the layout memory (one per group-by mode, so switching back restores positions
// exactly) and exposes the current scene as a computed signal. Also the small bits of view state the Map needs.
import { computed, signal } from '@preact/signals';
import { fire } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { groupBy } from '../state/ui.ts';
import { emptyLayout, nearestInDirection, type Dir, type LayoutMemory, type Pt } from './layout.ts';
import { buildScene, type Scene } from './scene.ts';

const memories: Record<'repo' | 'initiative', LayoutMemory> = { repo: emptyLayout(), initiative: emptyLayout() };
/** Bumped when a drag changes the memory outside buildScene. */
const memoryVersion = signal(0);

export const EXPAND_MS = 30_000;
/** group key -> time the +N expansion ends */
export const expandedUntil = signal<Readonly<Record<string, number>>>({});

/** Hovered token (or initiative chip): everything outside that initiative dims to 25 %. */
export const hoverId = signal<string | null>(null);
export const focusInitiativeChip = signal<string | null>(null);

export const scene = computed<Scene>(() => {
  void memoryVersion.value;
  const mode = groupBy.value;
  const nowMs = Date.now();
  const expanded = new Set(Object.entries(expandedUntil.value).filter(([, t]) => t > nowMs).map(([k]) => k));
  const res = buildScene({
    sessions: [...store.sessions.value.values()],
    planets: store.planets.value,
    initiatives: store.initiatives.value,
    groupBy: mode,
    expanded,
    now: nowMs,
  }, memories[mode]);
  memories[mode] = res.memory; // the layout remembers where things are; this is the one intended side effect
  return res.scene;
});

export const tokenPoints = computed<Pt[]>(() => scene.value.tokens.map((t) => ({ id: t.id, x: t.x, y: t.y })));

export function expandPlanet(key: string): void {
  const until = Date.now() + EXPAND_MS;
  expandedUntil.value = { ...expandedUntil.value, [key]: until };
  setTimeout(() => {
    const cur = expandedUntil.value[key];
    if (cur !== undefined && cur <= Date.now()) {
      const { [key]: _gone, ...rest } = expandedUntil.value;
      expandedUntil.value = rest;
    }
  }, EXPAND_MS + 50);
}

/** Next token in a direction from the selected one. With nothing selected, the first token. */
export function spatialNext(fromId: string | null, dir: Dir): string | undefined {
  const pts = tokenPoints.value;
  if (pts.length === 0) return undefined;
  const from = pts.find((p) => p.id === fromId);
  if (!from) return pts[0]!.id;
  return nearestInDirection(from, pts, dir);
}

/** Planet drag (3.07): remember the pin locally at once, and tell the daemon so it survives a restart. */
export function pinPlanet(key: string, col: number, row: number): void {
  const mode = groupBy.value;
  if (mode !== 'repo') return;
  const mem = memories[mode];
  const taken = Object.entries(mem.cells).some(([k, c]) => k !== key && c.col === col && c.row === row && scene.value.planets.some((p) => p.key === k));
  const cur = mem.cells[key];
  if (taken || !cur || (cur.col === col && cur.row === row)) return;
  memories[mode] = { ...mem, cells: { ...mem.cells, [key]: { ...cur, col, row, pinned: true } } };
  memoryVersion.value++;
  fire({ c: 'layout.setPlanetCell', planetKey: key, col, row });
}

/** Test hook: forget all layout memory. */
export function resetMapModel(): void {
  memories.repo = emptyLayout();
  memories.initiative = emptyLayout();
  expandedUntil.value = {};
  hoverId.value = null;
  focusInitiativeChip.value = null;
  memoryVersion.value++;
}
