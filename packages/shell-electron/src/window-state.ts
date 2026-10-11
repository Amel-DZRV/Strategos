// Window size and position, saved in Electron's own userData folder (never in ~/.claude or ~/.strategos).
export interface Rect { x: number; y: number; width: number; height: number }
export interface SavedWindow extends Rect { maximized: boolean }

export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const MIN_SIZE = { width: 720, height: 520 };

export function parseSaved(raw: unknown): SavedWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : null);
  const x = n('x'), y = n('y'), width = n('width'), height = n('height');
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MIN_SIZE.width || height < MIN_SIZE.height || width > 20000 || height > 20000) return null;
  return { x, y, width, height, maximized: r['maximized'] === true };
}

const overlap = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * The bounds to open with. A saved window that no longer lies on any screen (a monitor was unplugged) is dropped:
 * we then open at the default size and let the system place it.
 */
export function restoreBounds(saved: SavedWindow | null, displays: readonly Rect[]): { bounds: Partial<Rect> & { width: number; height: number }; maximized: boolean } {
  if (saved !== null) {
    const visible = displays.reduce((m, d) => Math.max(m, overlap(saved, d)), 0);
    if (visible >= Math.min(saved.width * saved.height * 0.3, 120 * 120)) {
      return { bounds: { x: saved.x, y: saved.y, width: saved.width, height: saved.height }, maximized: saved.maximized };
    }
  }
  return { bounds: { ...DEFAULT_SIZE }, maximized: false };
}

export function tooltipFor(needsYou: number): string {
  return needsYou > 0 ? `Strategos — ${needsYou} need${needsYou === 1 ? 's' : ''} you` : 'Strategos — nothing needs you';
}
