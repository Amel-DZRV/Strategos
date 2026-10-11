import { describe, expect, it } from 'vitest';
import { renderAppIcon, renderBadge, renderTrayIcon, encodePng } from './icon.ts';
import { DEFAULT_SIZE, parseSaved, restoreBounds, tooltipFor } from './window-state.ts';

const screen1 = { x: 0, y: 0, width: 1920, height: 1040 };

describe('window state', () => {
  it('restores a saved window that is on a screen', () => {
    const saved = parseSaved({ x: 100, y: 80, width: 1000, height: 700, maximized: true });
    expect(restoreBounds(saved, [screen1])).toEqual({ bounds: { x: 100, y: 80, width: 1000, height: 700 }, maximized: true });
  });
  it('falls back to the default size when the screen is gone', () => {
    const saved = parseSaved({ x: 3000, y: 100, width: 1000, height: 700, maximized: false });
    expect(restoreBounds(saved, [screen1])).toEqual({ bounds: DEFAULT_SIZE, maximized: false });
  });
  it('rejects junk and tiny or absurd sizes', () => {
    for (const bad of [null, 'x', {}, { x: 'a', y: 0, width: 900, height: 700 }, { x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 99999, height: 700 }, { x: 0, y: 0, width: NaN, height: 700 }]) {
      expect(parseSaved(bad)).toBeNull();
    }
    expect(restoreBounds(null, [screen1]).bounds).toEqual(DEFAULT_SIZE);
  });
});

describe('tray text', () => {
  it('says how many need you', () => {
    expect(tooltipFor(3)).toBe('Strategos — 3 need you');
    expect(tooltipFor(1)).toBe('Strategos — 1 needs you');
    expect(tooltipFor(0)).toBe('Strategos — nothing needs you');
  });
});

describe('generated icons', () => {
  const lit = (r: { rgba: Uint8Array }): number => r.rgba.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0);
  it('draws something at every size and a badge that differs by count', () => {
    for (const s of [16, 32, 256, 512]) expect(lit(renderAppIcon(s))).toBeGreaterThan(s * s * 0.5);
    expect(renderTrayIcon(32, 2).rgba).not.toEqual(renderTrayIcon(32, 0).rgba);
    expect(renderBadge(3).rgba).not.toEqual(renderBadge(4).rgba);
    expect(renderBadge(12).rgba).toEqual(renderBadge(99).rgba); // "9+"
  });
  it('encodes a valid PNG (signature, IHDR size, IEND)', () => {
    const png = encodePng(renderAppIcon(32));
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(32);
    expect(dv.getUint32(20)).toBe(32);
    expect(Buffer.from(png.subarray(png.length - 8, png.length - 4)).toString('latin1')).toBe('IEND');
  });
});
