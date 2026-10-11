// Pure Map layout (plan section 7, task 3.01): sticky planet cells, sticky ring slots, grid growth with hysteresis.
// Nothing here touches the DOM or signals. The caller keeps one LayoutMemory per group-by mode and calls
// stepLayout() for every snapshot or delta; the result tells where everything is. A planet or token that already
// has a place never gets another one because something else changed.

export const CELL_W = 380;
export const CELL_H = 280;
/** Orbit radius of ring 0; each further ring adds RING_STEP. */
export const RING_R0 = 80;
export const RING_STEP = 28;
export const SLOTS_PER_RING = 8;
/** A remembered cell stays reserved this long after its planet disappears (plan section 7). */
export const CELL_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
export const CELL_MEMORY_MAX = 80;
export const SHRINK_SNAPSHOTS = 3;
export const FOLD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Slot k sits at angle -90 + ORDER[k mod 8] * 45 degrees. The plan's literal formula is the identity order
 * (-90 + (k mod 8) * 45), which packs the first three tokens into one quadrant and makes their labels collide.
 * This order keeps the fixed angles but fills them so that the first slots are spread out: top, bottom, right,
 * left, then the diagonals. With 2 and 4 sessions it reproduces the prototype exactly. Set to [0..7] for the literal rule.
 */
export const SLOT_ANGLE_ORDER: readonly number[] = [0, 4, 2, 6, 1, 5, 3, 7];

export interface Cell { col: number; row: number }

export interface GroupInput {
  key: string;
  /** Daemon's cell for this planet (PlanetInfo.cell). A hint for a group we have never placed; authoritative when pinned. */
  hint?: Cell;
  pinned?: boolean;
  /** Earliest session creation time: decides who gets the first free cell when several arrive at once. */
  firstSeen?: number;
}

export interface TokenInput {
  id: string;
  group: string;
  /** The daemon's remembered slot for this group (ringSlotByGroup[key] or ringSlot). Used only for a token we have never placed. */
  slotHint?: number;
  createdAt?: number;
}

interface CellMemory extends Cell { lastSeen: number; pinned?: boolean }

export interface LayoutMemory {
  /** Grid is size x size cells. */
  size: number;
  shrinkStreak: number;
  cells: Record<string, CellMemory>;
  slots: Record<string, Record<string, number>>;
}

export function emptyLayout(): LayoutMemory {
  return { size: 2, shrinkStreak: 0, cells: {}, slots: {} };
}

export interface LayoutResult {
  memory: LayoutMemory;
  size: number;
  /** Groups that were moved by this step (new groups are not moves). Only a pin change or a shrink can cause one. */
  moved: string[];
}

export const sizeFor = (count: number): number => Math.max(2, Math.ceil(Math.sqrt(Math.max(0, count))));

function cellKey(c: Cell): string {
  return `${c.col},${c.row}`;
}

/** All cells of a size x size grid, nearest the centre first (spiral order); ties go top to bottom, left to right. */
export function spiralCells(size: number): Cell[] {
  const mid = (size - 1) / 2;
  const out: Cell[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) out.push({ col, row });
  const d = (c: Cell) => (c.col - mid) ** 2 + (c.row - mid) ** 2;
  return out.sort((a, b) => d(a) - d(b) || a.row - b.row || a.col - b.col);
}

function inRange(c: Cell, size: number): boolean {
  return Number.isInteger(c.col) && Number.isInteger(c.row) && c.col >= 0 && c.row >= 0 && c.col < size && c.row < size;
}

export function stepLayout(prev: LayoutMemory, groups: readonly GroupInput[], tokens: readonly TokenInput[], now: number): LayoutResult {
  const cells: Record<string, CellMemory> = { ...prev.cells };
  const live = new Set(groups.map((g) => g.key));
  const moved: string[] = [];

  // Grid size: grows at once, shrinks only after SHRINK_SNAPSHOTS consecutive snapshots at or below (smaller capacity - 2).
  let size = prev.size;
  let streak = prev.shrinkStreak;
  const need = sizeFor(groups.length);
  if (need > size) {
    size = need;
    streak = 0;
  } else if (size > 2 && groups.length <= (size - 1) ** 2 - 2) {
    streak++;
    if (streak >= SHRINK_SNAPSHOTS) {
      size = Math.max(need, size - 1);
      streak = 0;
    }
  } else {
    streak = 0;
  }

  // Forget memory that is too old or beyond the cap (least recently seen first). Live groups are never forgotten.
  for (const [k, m] of Object.entries(cells)) if (!live.has(k) && now - m.lastSeen > CELL_MEMORY_MS) delete cells[k];
  const gone = Object.entries(cells).filter(([k]) => !live.has(k)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  while (Object.keys(cells).length > CELL_MEMORY_MAX && gone.length > 0) delete cells[gone.shift()![0]];

  const taken = new Map<string, string>(); // cell -> live group
  const place = (key: string, c: Cell, pinned: boolean) => {
    cells[key] = { col: c.col, row: c.row, lastSeen: now, ...(pinned ? { pinned: true } : {}) };
    taken.set(cellKey(c), key);
  };

  // 1. Groups that already have a valid cell keep it.
  const pending: GroupInput[] = [];
  const ordered = [...groups].sort((a, b) => a.key.localeCompare(b.key));
  for (const g of ordered) {
    const mem = cells[g.key];
    // A pin from the daemon that differs from what we remember is the owner's drag: follow it.
    if (g.pinned && g.hint && inRange(g.hint, size) && (!mem || mem.col !== g.hint.col || mem.row !== g.hint.row) && !taken.has(cellKey(g.hint))) {
      if (mem) moved.push(g.key);
      place(g.key, g.hint, true);
    } else if (mem && inRange(mem, size) && !taken.has(cellKey(mem))) {
      place(g.key, mem, !!mem.pinned);
    } else {
      if (mem) moved.push(g.key); // had a cell, lost it (grid shrank, or a clash)
      pending.push(g);
    }
  }

  // 2. New or displaced groups: the daemon's hint if free, else the free cell nearest the centre.
  pending.sort((a, b) => (a.hint ? 0 : 1) - (b.hint ? 0 : 1) || (a.firstSeen ?? 0) - (b.firstSeen ?? 0) || a.key.localeCompare(b.key));
  const spiral = spiralCells(size);
  const reservedByGone = (c: Cell) => Object.entries(cells).some(([k, m]) => !live.has(k) && m.col === c.col && m.row === c.row);
  for (const g of pending) {
    const free = (c: Cell) => !taken.has(cellKey(c));
    let target: Cell | undefined;
    if (g.hint && inRange(g.hint, size) && free(g.hint) && !reservedByGone(g.hint)) target = g.hint;
    target ??= spiral.find((c) => free(c) && !reservedByGone(c));
    if (!target) {
      // Every free cell is reserved for a planet that is gone: evict the least recently seen reservation.
      let best: Cell | undefined;
      let bestSeen = Infinity;
      for (const c of spiral.filter(free)) {
        for (const [k, m] of Object.entries(cells)) {
          if (!live.has(k) && m.col === c.col && m.row === c.row && m.lastSeen < bestSeen) { best = c; bestSeen = m.lastSeen; }
        }
      }
      target = best;
    }
    if (!target) {
      // More groups than cells cannot happen (size is derived from the count); stay safe anyway.
      size++;
      target = spiralCells(size).find(free)!;
    }
    for (const [k, m] of Object.entries(cells)) if (!live.has(k) && m.col === target.col && m.row === target.row) delete cells[k];
    place(g.key, target, false);
  }

  // Ring slots: kept for life. A token we have never placed takes the daemon's slot if free, else the lowest free one.
  const slots: Record<string, Record<string, number>> = {};
  const byGroup = new Map<string, TokenInput[]>();
  for (const t of tokens) {
    const l = byGroup.get(t.group);
    if (l) l.push(t); else byGroup.set(t.group, [t]);
  }
  for (const [gk, list] of byGroup) {
    const old = prev.slots[gk] ?? {};
    const mine: Record<string, number> = {};
    const used = new Set<number>();
    const fresh: TokenInput[] = [];
    for (const t of list) {
      const s = old[t.id];
      if (s !== undefined && !used.has(s)) { mine[t.id] = s; used.add(s); } else fresh.push(t);
    }
    fresh.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    for (const t of fresh) {
      let s = t.slotHint;
      if (s === undefined || !Number.isInteger(s) || s < 0 || used.has(s)) {
        s = 0;
        while (used.has(s)) s++;
      }
      mine[t.id] = s;
      used.add(s);
    }
    slots[gk] = mine;
  }

  return { memory: { size, shrinkStreak: streak, cells, slots }, size, moved };
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------------

/** Room above the first row and below the last for ring-0 tokens and their labels (a label sits 49 units under its token). */
export const MAP_PAD_TOP = 12;
export const MAP_PAD_BOTTOM = 36;
export interface ViewBox { x: number; y: number; w: number; h: number }
export const viewBoxFor = (size: number): ViewBox => ({ x: 0, y: -MAP_PAD_TOP, w: size * CELL_W, h: size * CELL_H + MAP_PAD_TOP + MAP_PAD_BOTTOM });

export function cellCentre(c: Cell): { x: number; y: number } {
  return { x: c.col * CELL_W + CELL_W / 2, y: c.row * CELL_H + CELL_H / 2 };
}

export const ringOf = (slot: number): number => Math.floor(slot / SLOTS_PER_RING);
export const ringRadius = (ring: number): number => RING_R0 + RING_STEP * ring;

export function slotAngle(slot: number): number {
  const step = SLOT_ANGLE_ORDER[((slot % SLOTS_PER_RING) + SLOTS_PER_RING) % SLOTS_PER_RING] ?? 0;
  return (-90 + step * 45) * (Math.PI / 180);
}

/** Offset of a token from its planet's centre. */
export function slotOffset(slot: number): { dx: number; dy: number } {
  const r = ringRadius(ringOf(slot));
  const a = slotAngle(slot);
  return { dx: r * Math.cos(a), dy: r * Math.sin(a) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Folding and crowding
// ---------------------------------------------------------------------------------------------------------------------

interface FoldInput { status: string; archived: boolean; lastActivityAt: number }

/** A planet whose sessions are all stopped, parked or archived and older than 7 days folds into a dormant dot. */
export function isDormant(sessions: readonly FoldInput[], now: number): boolean {
  if (sessions.length === 0) return false;
  return sessions.every((s) => (s.archived || s.status === 'stopped' || s.status === 'parked') && now - s.lastActivityAt > FOLD_AFTER_MS);
}

export const CROWD_LIMIT = 8;

/**
 * More than CROWD_LIMIT quiet tokens on a planet: only the CROWD_LIMIT with the lowest slots stay, the rest collapse into
 * a "+N" badge. Needs-you tokens are never collapsed. Pure so the rule is testable.
 */
export function collapseQuiet(quiet: readonly { id: string; slot: number }[], limit = CROWD_LIMIT): { shown: Set<string>; hidden: number } {
  if (quiet.length <= limit) return { shown: new Set(quiet.map((q) => q.id)), hidden: 0 };
  const keep = [...quiet].sort((a, b) => a.slot - b.slot).slice(0, limit);
  return { shown: new Set(keep.map((q) => q.id)), hidden: quiet.length - limit };
}

// ---------------------------------------------------------------------------------------------------------------------
// Spatial keyboard navigation
// ---------------------------------------------------------------------------------------------------------------------

export type Dir = 'left' | 'right' | 'up' | 'down';
export interface Pt { id: string; x: number; y: number }

/** Space a token takes around its centre: the ring and risk chip above it, the name and "ctx . cost" lines below. */
export const LABEL_HALF_W = 64;
export const LABEL_TOP = -32;
export const LABEL_BOTTOM = 54;
export interface Box { left: number; top: number; right: number; bottom: number }

/** Box of a token's ring plus labels, relative to its planet's centre. */
export function labelBox(slot: number): Box {
  const { dx, dy } = slotOffset(slot);
  return { left: dx - LABEL_HALF_W, right: dx + LABEL_HALF_W, top: dy + LABEL_TOP, bottom: dy + LABEL_BOTTOM };
}

/** Nearest token in a direction: prefers close ones that are roughly in line. Returns undefined when nothing lies that way. */
export function nearestInDirection(from: Pt, others: readonly Pt[], dir: Dir): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const o of others) {
    if (o.id === from.id) continue;
    const dx = o.x - from.x;
    const dy = o.y - from.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0.5) continue;
    const score = along + 2 * across;
    if (score < bestScore) { bestScore = score; best = o.id; }
  }
  return best;
}
