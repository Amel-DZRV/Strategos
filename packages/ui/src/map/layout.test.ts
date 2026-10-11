import { describe, expect, test } from 'vitest';
import {
  CELL_H, CELL_W, collapseQuiet, emptyLayout, isDormant, nearestInDirection, slotOffset, sizeFor, spiralCells, stepLayout,
  type GroupInput, type LayoutMemory, type TokenInput, viewBoxFor,
} from './layout.ts';

/** Small deterministic PRNG so a failing run can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = 1_700_000_000_000;

function groupsOf(tokens: TokenInput[], extra: string[] = []): GroupInput[] {
  const keys = new Set([...tokens.map((t) => t.group), ...extra]);
  return [...keys].map((key) => ({ key }));
}

describe('grid', () => {
  test('capacity grows 2x2 to 3x3 to 4x4', () => {
    expect([0, 1, 4, 5, 9, 10, 16].map(sizeFor)).toEqual([2, 2, 2, 3, 3, 4, 4]);
    expect(viewBoxFor(2)).toMatchObject({ w: 2 * CELL_W });
    expect(viewBoxFor(2).h).toBeGreaterThan(2 * CELL_H); // padded so the bottom row labels fit
  });

  test('new planets take the free cell nearest the centre, in spiral order', () => {
    const order = spiralCells(3);
    expect(order[0]).toEqual({ col: 1, row: 1 });
    expect(order.slice(1, 5)).toEqual([{ col: 1, row: 0 }, { col: 0, row: 1 }, { col: 2, row: 1 }, { col: 1, row: 2 }]);
    let m = emptyLayout();
    for (const k of ['a', 'b', 'c', 'd']) m = stepLayout(m, [...Object.keys(m.cells), k].map((key) => ({ key })), [], T).memory;
    // 2x2: all four cells are equally central; ties break top-left first
    expect(Object.values(m.cells).map((c) => `${c.col},${c.row}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });

  test('the daemon hint places a planet we have not seen; a pinned hint wins over memory', () => {
    let r = stepLayout(emptyLayout(), [{ key: 'a', hint: { col: 1, row: 1 } }], [], T);
    expect(r.memory.cells['a']).toMatchObject({ col: 1, row: 1 });
    r = stepLayout(r.memory, [{ key: 'a', hint: { col: 0, row: 1 } }], [], T); // unpinned hint ignored: we remember
    expect(r.memory.cells['a']).toMatchObject({ col: 1, row: 1 });
    r = stepLayout(r.memory, [{ key: 'a', hint: { col: 0, row: 1 }, pinned: true }], [], T);
    expect(r.memory.cells['a']).toMatchObject({ col: 0, row: 1, pinned: true });
    expect(r.moved).toEqual(['a']);
  });

  test('shrinks only after 3 consecutive snapshots at or below capacity minus 2', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `p${i}` }));
    let m = stepLayout(emptyLayout(), keys(7), [], T).memory;
    expect(m.size).toBe(3);
    m = stepLayout(m, keys(6), [], T).memory; // 6 is above the threshold (3x3 shrinks to 2x2 only at 2 or fewer)
    expect(m.size).toBe(3);
    m = stepLayout(m, keys(2), [], T).memory;
    m = stepLayout(m, keys(2), [], T).memory;
    expect(m.size).toBe(3);
    m = stepLayout(m, keys(3), [], T).memory; // breaks the streak
    m = stepLayout(m, keys(2), [], T).memory;
    m = stepLayout(m, keys(2), [], T).memory;
    expect(m.size).toBe(3);
    m = stepLayout(m, keys(2), [], T).memory;
    expect(m.size).toBe(2);
  });

  test('a remembered cell stays reserved for 30 days after the planet goes, then frees up', () => {
    let m = stepLayout(emptyLayout(), [{ key: 'a' }, { key: 'b' }], [], T).memory;
    const cellA = m.cells['a']!;
    m = stepLayout(m, [{ key: 'b' }], [], T + 1000).memory;
    m = stepLayout(m, [{ key: 'b' }, { key: 'c' }], [], T + 2000).memory;
    expect(m.cells['c']).not.toMatchObject({ col: cellA.col, row: cellA.row });
    m = stepLayout(m, [{ key: 'a' }, { key: 'b' }, { key: 'c' }], [], T + 3000).memory;
    expect(m.cells['a']).toMatchObject({ col: cellA.col, row: cellA.row });
    m = stepLayout(m, [{ key: 'b' }, { key: 'c' }], [], T + 4000).memory;
    m = stepLayout(m, [{ key: 'b' }, { key: 'c' }], [], T + 31 * 86_400_000).memory;
    expect(m.cells['a']).toBeUndefined();
  });
});

describe('ring slots', () => {
  test('lowest free slot, kept for life, freed slots reused lowest first', () => {
    const t = (id: string, createdAt: number): TokenInput => ({ id, group: 'g', createdAt });
    let m = stepLayout(emptyLayout(), [{ key: 'g' }], [t('a', 1), t('b', 2), t('c', 3)], T).memory;
    expect(m.slots['g']).toEqual({ a: 0, b: 1, c: 2 });
    m = stepLayout(m, [{ key: 'g' }], [t('a', 1), t('c', 3)], T).memory; // b leaves
    expect(m.slots['g']).toEqual({ a: 0, c: 2 });
    m = stepLayout(m, [{ key: 'g' }], [t('a', 1), t('c', 3), t('d', 4)], T).memory;
    expect(m.slots['g']).toEqual({ a: 0, c: 2, d: 1 });
  });

  test('a daemon slot is used for a new token when free, otherwise the lowest free one', () => {
    const m = stepLayout(emptyLayout(), [{ key: 'g' }], [
      { id: 'a', group: 'g', slotHint: 3, createdAt: 1 }, { id: 'b', group: 'g', slotHint: 3, createdAt: 2 }, { id: 'c', group: 'g', slotHint: 0, createdAt: 3 },
    ], T).memory;
    expect(m.slots['g']).toEqual({ a: 3, b: 0, c: 1 });
  });

  test('slot k is on ring floor(k/8) with radius 80 + 28 ring, at fixed angles', () => {
    const r = (k: number) => Math.hypot(slotOffset(k).dx, slotOffset(k).dy);
    expect(r(0)).toBeCloseTo(80);
    expect(r(7)).toBeCloseTo(80);
    expect(r(8)).toBeCloseTo(108);
    expect(r(17)).toBeCloseTo(136);
    expect(slotOffset(0).dy).toBeCloseTo(-80); // the first token sits at 12 o'clock
    expect(slotOffset(1).dy).toBeCloseTo(80); // the second opposite, as with two tokens in the prototype
    expect(slotOffset(8)).toEqual(expect.objectContaining({ dx: expect.closeTo(0), dy: expect.closeTo(-108) }));
    const angles = new Set(Array.from({ length: 8 }, (_, k) => Math.round(slotOffset(k).dx) + ',' + Math.round(slotOffset(k).dy)));
    expect(angles.size).toBe(8);
  });
});

describe('stability (property test)', () => {
  test('0 moves of existing planets or tokens across 10 000 random edits', () => {
    const rand = rng(42);
    const tokens = new Map<string, TokenInput>();
    const extraGroups = new Set<string>();
    let mem: LayoutMemory = emptyLayout();
    let nextId = 0;
    let prevCells: Record<string, string> = {};
    let prevSlots: Record<string, number> = {};
    let prevSize = 2;
    let prevLive = new Set<string>();
    let moves = 0;
    let shrinks = 0;
    let grows = 0;

    for (let i = 0; i < 10_000; i++) {
      const roll = rand();
      const groupName = () => `repo${Math.floor(rand() * 14)}`;
      if (roll < 0.45 || tokens.size === 0) {
        const id = `s${nextId++}`;
        tokens.set(id, { id, group: groupName(), createdAt: nextId });
      } else if (roll < 0.85) {
        const ids = [...tokens.keys()];
        tokens.delete(ids[Math.floor(rand() * ids.length)]!);
      } else if (roll < 0.93) {
        extraGroups.add(groupName());
      } else {
        extraGroups.delete(groupName());
      }
      const list = [...tokens.values()];
      const groups = groupsOf(list, [...extraGroups]);
      const res = stepLayout(mem, groups, list, T + i);
      mem = res.memory;
      const live = new Set(groups.map((g) => g.key));

      const size = res.size;
      if (size < prevSize) shrinks++;
      if (size > prevSize) grows++;
      // Every live planet has a distinct cell inside the grid.
      const seen = new Set<string>();
      for (const k of live) {
        const c = mem.cells[k]!;
        expect(c.col).toBeLessThan(size);
        expect(c.row).toBeLessThan(size);
        const ck = `${c.col},${c.row}`;
        expect(seen.has(ck)).toBe(false);
        seen.add(ck);
      }
      // Planets that were there before keep their cell, except those out of range after a shrink.
      for (const k of live) {
        const before = prevCells[k];
        if (before === undefined || !prevLive.has(k)) continue;
        const now = `${mem.cells[k]!.col},${mem.cells[k]!.row}`;
        if (now !== before) {
          const [bc, br] = before.split(',').map(Number) as [number, number];
          const displaced = size < prevSize && (bc >= size || br >= size);
          if (!displaced) moves++;
          expect(res.moved).toContain(k);
        }
      }
      // Tokens keep their slot for as long as they exist.
      for (const t of list) {
        const s = mem.slots[t.group]![t.id]!;
        const b = prevSlots[t.id];
        if (b !== undefined && b !== s) moves++;
      }
      // Slots in a group are distinct.
      for (const [g, m] of Object.entries(mem.slots)) {
        const vals = Object.values(m);
        expect(new Set(vals).size, g).toBe(vals.length);
      }

      prevCells = Object.fromEntries(Object.entries(mem.cells).map(([k, c]) => [k, `${c.col},${c.row}`]));
      prevSlots = Object.fromEntries(list.map((t) => [t.id, mem.slots[t.group]![t.id]!]));
      prevSize = size;
      prevLive = live;
    }
    expect(moves).toBe(0);
    // The run must actually exercise growth and shrinking, or the test proves little.
    expect(grows).toBeGreaterThan(0);
    expect(shrinks).toBeGreaterThan(0);
  }, 60_000);
});

describe('folding and crowding', () => {
  test('a planet folds only when every session is stopped, parked or archived for over 7 days', () => {
    const old = T - 8 * 86_400_000;
    expect(isDormant([{ status: 'stopped', archived: false, lastActivityAt: old }, { status: 'parked', archived: false, lastActivityAt: old }], T)).toBe(true);
    expect(isDormant([{ status: 'stopped', archived: false, lastActivityAt: old }, { status: 'working', archived: false, lastActivityAt: old }], T)).toBe(false);
    expect(isDormant([{ status: 'stopped', archived: false, lastActivityAt: T - 86_400_000 }], T)).toBe(false);
    expect(isDormant([], T)).toBe(false);
  });

  test('more than 8 quiet tokens collapse into +N, keeping the lowest slots', () => {
    const quiet = Array.from({ length: 13 }, (_, i) => ({ id: `q${i}`, slot: 12 - i }));
    const r = collapseQuiet(quiet);
    expect(r.hidden).toBe(5);
    expect(r.shown.size).toBe(8);
    expect(r.shown.has('q12')).toBe(true); // slot 0
    expect(r.shown.has('q0')).toBe(false); // slot 12
    expect(collapseQuiet(quiet.slice(0, 8)).hidden).toBe(0);
  });
});

describe('spatial navigation', () => {
  const pts = [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 10 }, { id: 'c', x: 100, y: 200 }, { id: 'd', x: -80, y: 0 }, { id: 'e', x: 5, y: 120 },
  ];
  test('picks the nearest token that lies in that direction', () => {
    const a = pts[0]!;
    expect(nearestInDirection(a, pts, 'right')).toBe('b');
    expect(nearestInDirection(a, pts, 'left')).toBe('d');
    expect(nearestInDirection(a, pts, 'down')).toBe('e');
    expect(nearestInDirection(a, pts, 'up')).toBeUndefined();
  });
});
