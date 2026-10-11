// Turns daemon state into positions: which planets, in which cells, which tokens on which slots. Pure apart from
// the LayoutMemory it threads through (see layout.ts). The components only draw what this returns.
import { isNeedsYou, type Initiative, type PlanetInfo, type SessionRecord } from '@strategos/shared';
import { repoName } from '../format.ts';
import {
  cellCentre, collapseQuiet, isDormant, ringOf, slotOffset, stepLayout, viewBoxFor,
  type GroupInput, type LayoutMemory, type TokenInput, type ViewBox,
} from './layout.ts';

export type GroupBy = 'repo' | 'initiative';
export const UNASSIGNED = 'unassigned';

export const PLANET_PALETTE = ['#3a4c8a', '#5a3f7a', '#2f6a6a', '#7a5a3a', '#4a6a3a', '#7a3a52', '#3a6a8a', '#6a5a8a'];

export function hashColour(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PLANET_PALETTE[h % PLANET_PALETTE.length]!;
}

export interface TokenScene {
  id: string;
  group: string;
  slot: number;
  x: number;
  y: number;
  session: SessionRecord;
}

export interface PlanetScene {
  key: string;
  label: string;
  colour: string;
  cx: number;
  cy: number;
  col: number;
  row: number;
  folded: boolean;
  /** Highest ring in use, for drawing the orbit lines. */
  rings: number;
  /** Quiet tokens hidden behind the "+N" badge. */
  hidden: number;
  tokens: TokenScene[];
  sessionCount: number;
}

export interface Scene {
  size: number;
  vb: ViewBox;
  planets: PlanetScene[];
  tokens: TokenScene[];
}

export interface SceneInput {
  sessions: readonly SessionRecord[];
  planets: readonly PlanetInfo[];
  initiatives: readonly Initiative[];
  groupBy: GroupBy;
  /** Group keys whose quiet tokens are expanded right now. */
  expanded: ReadonlySet<string>;
  now: number;
}

export function groupKeyOf(s: SessionRecord, groupBy: GroupBy, initiativeIds: ReadonlySet<string>): string {
  if (groupBy === 'repo') return s.planetKey;
  return s.initiativeId && initiativeIds.has(s.initiativeId) ? s.initiativeId : UNASSIGNED;
}

export function buildScene(input: SceneInput, memory: LayoutMemory): { scene: Scene; memory: LayoutMemory } {
  const { groupBy, now } = input;
  const live = input.sessions.filter((s) => !s.archived);
  const initById = new Map(input.initiatives.map((i) => [i.id, i]));
  const initIds = new Set(initById.keys());
  const planetInfo = new Map(input.planets.map((p) => [p.planetKey, p]));

  const bySession = new Map<string, SessionRecord[]>();
  for (const s of live) {
    const k = groupKeyOf(s, groupBy, initIds);
    const l = bySession.get(k);
    if (l) l.push(s); else bySession.set(k, [s]);
  }
  // Repo mode also shows planets the daemon lists without sessions (an empty repo is still a place), unless folded.
  if (groupBy === 'repo') for (const p of input.planets) if (!bySession.has(p.planetKey) && !p.folded) bySession.set(p.planetKey, []);

  const groups: GroupInput[] = [];
  const tokenInputs: TokenInput[] = [];
  for (const [key, list] of bySession) {
    const info = groupBy === 'repo' ? planetInfo.get(key) : undefined;
    groups.push({
      key,
      ...(info ? { hint: { col: info.cell.col, row: info.cell.row }, pinned: info.pinned } : {}),
      firstSeen: list.reduce((m, s) => Math.min(m, s.createdAt), Infinity),
    });
    for (const s of list) {
      const hint = s.ringSlotByGroup[key] ?? (groupBy === 'repo' ? s.ringSlot : undefined);
      tokenInputs.push({ id: s.strategosId, group: key, createdAt: s.createdAt, ...(hint !== undefined ? { slotHint: hint } : {}) });
    }
  }
  for (const g of groups) if (!Number.isFinite(g.firstSeen)) delete g.firstSeen;

  const res = stepLayout(memory, groups, tokenInputs, now);
  const planets: PlanetScene[] = [];
  const allTokens: TokenScene[] = [];

  // At least one planet stays unfolded: if every planet is dormant, the most recently active one is shown in full.
  const dormant = new Map<string, boolean>();
  for (const [key, list] of bySession) {
    dormant.set(key, (groupBy === 'repo' && planetInfo.get(key)?.folded === true) || isDormant(list, now));
  }
  if (dormant.size > 0 && [...dormant.values()].every(Boolean)) {
    let best: string | undefined;
    let bestAt = -1;
    for (const [key, list] of bySession) {
      const at = list.reduce((m, s) => Math.max(m, s.lastActivityAt), 0);
      if (at > bestAt) { best = key; bestAt = at; }
    }
    if (best) dormant.set(best, false);
  }

  for (const [key, list] of bySession) {
    const cell = res.memory.cells[key]!;
    const { x: cx, y: cy } = cellCentre(cell);
    const slots = res.memory.slots[key] ?? {};
    const info = groupBy === 'repo' ? planetInfo.get(key) : undefined;
    const init = groupBy === 'initiative' ? initById.get(key) : undefined;
    const folded = dormant.get(key) === true;

    const all = list.map((s) => ({ s, slot: slots[s.strategosId] ?? 0 }));
    const quiet = all.filter(({ s }) => !isNeedsYou(s)).map(({ s, slot }) => ({ id: s.strategosId, slot }));
    const col = input.expanded.has(key) ? { shown: new Set(quiet.map((q) => q.id)), hidden: 0 } : collapseQuiet(quiet);
    const tokens: TokenScene[] = [];
    let rings = 0;
    if (!folded) {
      for (const { s, slot } of all) {
        if (!isNeedsYou(s) && !col.shown.has(s.strategosId)) continue;
        const { dx, dy } = slotOffset(slot);
        rings = Math.max(rings, ringOf(slot));
        tokens.push({ id: s.strategosId, group: key, slot, x: cx + dx, y: cy + dy, session: s });
      }
    }
    const first = list[0];
    planets.push({
      key,
      label: key === UNASSIGNED && groupBy === 'initiative' ? 'Unassigned' : init?.name ?? info?.label ?? (first ? repoName(first) : key),
      colour: init?.colour ?? info?.colour ?? hashColour(key),
      cx, cy, col: cell.col, row: cell.row, folded, rings, hidden: folded ? 0 : col.hidden, tokens, sessionCount: list.length,
    });
    allTokens.push(...tokens);
  }
  planets.sort((a, b) => a.row - b.row || a.col - b.col);

  return { scene: { size: res.size, vb: viewBoxFor(res.size), planets, tokens: allTokens }, memory: res.memory };
}

/** "strategos-app" becomes ["strategos", "app"]; one word stays one line. Lines are clipped to fit the disc. */
export function planetLines(label: string): string[] {
  const clip = (t: string) => (t.length > 11 ? `${t.slice(0, 10)}…` : t);
  const i = label.indexOf('-');
  if (i <= 0 || i === label.length - 1) return [clip(label)];
  return [clip(label.slice(0, i)), clip(label.slice(i + 1).replace(/-/g, ' '))];
}

export function clipName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}
