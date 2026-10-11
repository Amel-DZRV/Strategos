// The app icon, the tray icon and the taskbar badge, drawn here with plain code (no third-party art).
// Pure functions that return RGBA pixels, plus a tiny PNG encoder; the build script writes build/icon.png from them and
// the main process turns them into native images at run time.
import { deflateSync } from 'node:zlib';

export interface Raster { width: number; height: number; rgba: Uint8Array }

const BG: readonly [number, number, number] = [0x0f, 0x14, 0x24]; // tokens.css panel
const FG: readonly [number, number, number] = [0xe8, 0xec, 0xf2];
const RED: readonly [number, number, number] = [0xff, 0x6a, 0x5a];
const INK: readonly [number, number, number] = [0x0b, 0x0e, 0x16];

function blank(size: number): Raster {
  return { width: size, height: size, rgba: new Uint8Array(size * size * 4) };
}

/** Blend a colour into one pixel with coverage 0..1. */
function plot(r: Raster, x: number, y: number, c: readonly [number, number, number], cov: number): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height || cov <= 0) return;
  const i = (y * r.width + x) * 4;
  const a = Math.min(1, cov);
  const dstA = r.rgba[i + 3]! / 255;
  const outA = a + dstA * (1 - a);
  for (let k = 0; k < 3; k++) {
    r.rgba[i + k] = Math.round(((c[k]! * a) + (r.rgba[i + k]! * dstA * (1 - a))) / (outA === 0 ? 1 : outA));
  }
  r.rgba[i + 3] = Math.round(outA * 255);
}

/** Coverage of a pixel by a rounded rectangle, 4x4 supersampled. */
function fillRoundRect(r: Raster, x0: number, y0: number, x1: number, y1: number, rad: number, c: readonly [number, number, number]): void {
  const inside = (px: number, py: number): boolean => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = px < x0 + rad ? x0 + rad : px > x1 - rad ? x1 - rad : px;
    const cy = py < y0 + rad ? y0 + rad : py > y1 - rad ? y1 - rad : py;
    return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad;
  };
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let n = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) n++;
      plot(r, x, y, c, n / 16);
    }
  }
}

function fillCircle(r: Raster, cx: number, cy: number, rad: number, c: readonly [number, number, number]): void {
  fillRoundRect(r, cx - rad, cy - rad, cx + rad, cy + rad, rad, c);
}

/** The mark: a dark rounded square with a blocky "S" (three bars joined by two short stems). */
export function renderAppIcon(size: number): Raster {
  const r = blank(size);
  const u = size / 16;
  fillRoundRect(r, 0.5 * u, 0.5 * u, 15.5 * u, 15.5 * u, 3.5 * u, BG);
  const bar = (x0: number, y0: number, x1: number, y1: number): void => fillRoundRect(r, x0 * u, y0 * u, x1 * u, y1 * u, 0.5 * u, FG);
  bar(4, 3.2, 12, 5.2); // top
  bar(4, 3.2, 6, 8); // left stem
  bar(4, 7, 12, 9); // middle
  bar(10, 8, 12, 12.8); // right stem
  bar(4, 11, 12, 13); // bottom
  return r;
}

/** The tray icon: the mark, with a red dot in the corner while something needs you. */
export function renderTrayIcon(size: number, needsYou: number): Raster {
  const r = renderAppIcon(size);
  if (needsYou > 0) fillCircle(r, size * 0.76, size * 0.24, size * 0.2, RED);
  return r;
}

// 3x5 digits; "+" for ten or more.
const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], '+': ['000', '010', '111', '010', '000'],
};

/** The Windows taskbar overlay: a red disc with the count (digits 1-9, "9+" shown as 9 and a plus). 16x16. */
export function renderBadge(count: number, size = 16): Raster {
  const r = blank(size);
  fillCircle(r, size / 2, size / 2, size / 2 - 0.5, RED);
  const text = count > 9 ? '9+' : String(Math.max(0, Math.floor(count)));
  const scale = text.length === 1 ? Math.max(1, Math.floor(size / 8)) : Math.max(1, Math.floor(size / 16));
  const w = text.length * 3 * scale + (text.length - 1) * scale;
  const h = 5 * scale;
  let ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);
  for (const ch of text) {
    const rows = FONT[ch];
    if (rows !== undefined) {
      for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
        if (rows[y]![x] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) plot(r, ox + x * scale + dx, oy + y * scale + dy, INK, 1);
      }
    }
    ox += 4 * scale;
  }
  return r;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(r: Raster): Uint8Array {
  const head = new Uint8Array(13);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, r.width);
  dv.setUint32(4, r.height);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  const stride = r.width * 4;
  const raw = new Uint8Array((stride + 1) * r.height); // filter byte 0 per row
  for (let y = 0; y < r.height; y++) raw.set(r.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
