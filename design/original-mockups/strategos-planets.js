(function(){
const SY_P = [
  { id: 'rooblocks', name: 'Rooblocks', biome: 'tundra', bn: 'Tundra', orbit: 0, ang: 222, r: 40, color: 'oklch(0.62 0.16 28)', glow: 'rgba(170,200,235,.35)', hi: '#e8eef5', lo: '#6d7f94', wt: [
    { name: 'main', cap: true }, { name: 'filter-fix', sq: [['Fix filter reset on back nav', 'opus', 'petition']] },
    { name: 'store-header', sq: [['Rebuild store page header', 'sonnet', 'marching', [{ p: 'storefront', files: 2 }]]] }, { name: 'onboarding-copy', sq: [['Update onboarding copy', 'haiku', 'awaiting']] }] },
  { id: 'storefront', name: 'Storefront', biome: 'forest', bn: 'Ancient forest', orbit: 1, ang: 322, r: 52, color: 'oklch(0.70 0.14 80)', glow: 'rgba(120,200,120,.3)', hi: '#8fbf6a', lo: '#1f3d2a', wt: [
    { name: 'main', cap: true }, { name: 'search-v2', sq: [['Migrate search to v2 endpoint', 'opus', 'spoils']] },
    { name: 'menu-sync', sq: [['Sync menus from partner feed', 'fable', 'marching']] }, { name: 'legacy-cleanup', stale: true }] },
  { id: 'pedregal', name: 'Pedregal', biome: 'desert', bn: 'Badlands', orbit: 2, ang: 146, r: 36, color: 'oklch(0.62 0.13 245)', glow: 'rgba(240,170,110,.3)', hi: '#f0c890', lo: '#7a3e22', wt: [
    { name: 'main', cap: true, sq: [['Summarize OpenAPI v4 changes', 'haiku', 'marching']] }, { name: 'payments-retry', sq: [['Idempotent payment retries', 'sonnet', 'fallen']] }] },
  { id: 'gateway', name: 'Gateway', biome: 'volcanic', bn: 'Volcanic', orbit: 3, ang: 28, r: 46, color: 'oklch(0.62 0.15 310)', glow: 'rgba(255,110,50,.32)', hi: '#6a5a54', lo: '#140f0e', wt: [
    { name: 'main', cap: true }, { name: 'rate-limit', sq: [['Token-bucket rate limiter', 'fable', 'marching']] },
    { name: 'schema-migrate', sq: [['Add schema migration + backfill', 'sonnet', 'awaiting']] }] }
];
function syNoise(seed) {
  const h = (x, y) => { let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041); n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16; return (n >>> 0) / 4294967296; };
  const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; };
  return (x, y, o) => { let s = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < o; i++) { s += a * vn(x * f + i * 17.3, y * f + i * 9.1); n += a; a *= 0.5; f *= 2.03; } return s / n; };
}
const syS = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const syMix = (o, c, k) => { o[0] += (c[0] - o[0]) * k; o[1] += (c[1] - o[1]) * k; o[2] += (c[2] - o[2]) * k; };
function syColor(b, e, rg, dt, stripe) {
  const o = [0, 0, 0]; let emit = 0;
  if (b === 'tundra') {
    if (e < 0.4) { o[0] = 60; o[1] = 96; o[2] = 128; syMix(o, [150, 186, 210], syS(0.28, 0.4, e) * 0.8 + dt * 0.15); }
    else { o[0] = 176; o[1] = 190; o[2] = 202; syMix(o, [242, 246, 250], syS(0.42, 0.62, e)); if (rg > 0.82) syMix(o, [104, 112, 126], syS(0.82, 0.95, rg) * 0.8); }
  } else if (b === 'forest') {
    if (e < 0.36) { o[0] = 26; o[1] = 62; o[2] = 92; syMix(o, [58, 112, 128], syS(0.26, 0.36, e)); }
    else if (e < 0.39) { o[0] = 196; o[1] = 184; o[2] = 132; }
    else { o[0] = 88; o[1] = 132; o[2] = 60; syMix(o, [30, 70, 38], syS(0.35, 0.62, dt)); if (e > 0.66) syMix(o, [118, 118, 96], syS(0.66, 0.78, e)); }
  } else if (b === 'desert') {
    o[0] = 222; o[1] = 172; o[2] = 112; syMix(o, [196, 136, 84], stripe * 0.45);
    if (e < 0.34) syMix(o, [236, 214, 170], syS(0.34, 0.2, e));
    if (e > 0.52) syMix(o, [164, 86, 50], syS(0.52, 0.7, e));
    if (rg > 0.86) syMix(o, [120, 62, 38], syS(0.86, 0.96, rg) * 0.7);
  } else {
    o[0] = 70; o[1] = 60; o[2] = 56; syMix(o, [34, 28, 27], syS(0.3, 0.6, e) * 0.7 + dt * 0.2);
    if (e < 0.3) { emit = syS(0.3, 0.2, e); syMix(o, [255, 110, 30], emit); }
    if (rg > 0.93) { const k = syS(0.93, 0.99, rg); emit = Math.max(emit, k); syMix(o, [255, 150, 60], k); }
  }
  return [o, emit];
}
function syHeight(n, b, x, y) {
  const q = n(x * 0.5 + 3.1, y * 0.5 + 7.7, 3);
  let e = n(x + q * 1.4, y + q * 1.4, 6);
  const rg = 1 - Math.abs(2 * n(x * 1.7 + 11, y * 1.7 + q, 5) - 1);
  if (b === 'tundra') e = e * 0.8 + rg * rg * 0.28;
  if (b === 'desert') e = Math.floor(e * 9) / 9 * 0.6 + e * 0.4;
  return [e, rg];
}
function syBlobURL(dataUrl) { const [head, b64] = dataUrl.split(','), mime = head.slice(5).split(';')[0], bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return URL.createObjectURL(new Blob([u], { type: mime })); }
function syPlanetTex(p, seed) {
  const S = p.r * 4, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data, n = syNoise(seed);
  const L = [-0.55, -0.45, 0.7], ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const atm = { tundra: [170, 210, 255], forest: [130, 210, 160], desert: [255, 190, 130], volcanic: [255, 110, 60] }[p.biome];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1, d2 = dx * dx + dy * dy; if (d2 >= 1) continue;
    const z = Math.sqrt(1 - d2), lon = Math.atan2(dx, z), lat = Math.asin(dy);
    const u = lon * 1.4 + 2, v = lat * 2.1 + 2;
    const [e, rg] = syHeight(n, p.biome, u, v), dt = n(u * 9, v * 9, 2);
    const stripe = 0.5 + 0.5 * Math.sin(v * 26 + e * 8);
    const [c, emit] = syColor(p.biome, e, rg, dt, stripe);
    let lit = Math.max(0, dx * L[0] + dy * L[1] + z * L[2]);
    let sh = 0.05 + Math.pow(lit, 0.85) * 1.08;
    if (p.biome === 'tundra' && Math.abs(lat) > 1.05) syMix(c, [245, 248, 252], syS(1.05, 1.25, Math.abs(lat)));
    const rim = Math.pow(1 - z, 2.6) * (0.25 + lit * 0.9);
    const i = (y * S + x) * 4;
    for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, c[k] * (sh * (1 - emit) + emit * 0.95) + atm[k] * rim);
    d[i + 3] = Math.min(1, (1 - Math.sqrt(d2)) * S / 2) * 255;
  }
  ctx.putImageData(img, 0, 0); return syBlobURL(cv.toDataURL());
}
function sySurface(p, seed) {
  const GW = 470, GH = 350, n = syNoise(seed + 5), E = new Float32Array(GW * GH), RG = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const [e, rg] = syHeight(n, p.biome, x / 95, y / 95); const cx = (x / GW - 0.5), cy = (y / GH - 0.5); E[y * GW + x] = e + 0.1 - (cx * cx + cy * cy) * 0.35; RG[y * GW + x] = rg; }
  const cv = document.createElement('canvas'); cv.width = GW; cv.height = GH;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(GW, GH), d = img.data;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, e = E[i];
    const l = E[i - (x > 0 ? 1 : 0)], r = E[i + (x < GW - 1 ? 1 : 0)], u = E[i - (y > 0 ? GW : 0)], dn = E[i + (y < GH - 1 ? GW : 0)];
    let sh = 1 + (-(r - l) * 0.8 - (dn - u)) * 16; sh = Math.max(0.45, Math.min(1.55, sh));
    const water = (p.biome === 'tundra' && e < 0.4) || (p.biome === 'forest' && e < 0.36);
    if (water) sh = 1 + (sh - 1) * 0.15;
    const stripe = 0.5 + 0.5 * Math.sin(y / 5 + e * 14);
    const [c, emit] = syColor(p.biome, e, RG[i], n(x / 7, y / 7, 2), stripe);
    const g = 1 + (n(x / 2.3, y / 2.3, 1) - 0.5) * 0.08;
    const k = (sh * (1 - emit) + emit) * g;
    d[i * 4] = Math.min(255, c[0] * k); d[i * 4 + 1] = Math.min(255, c[1] * k); d[i * 4 + 2] = Math.min(255, c[2] * k); d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas'); out.width = 940; out.height = 700;
  const o = out.getContext('2d'); o.imageSmoothingQuality = 'high'; o.drawImage(cv, 0, 0, 940, 700);
  return syBlobURL(out.toDataURL('image/jpeg', 0.9));
}
const SY_STARS = (() => { const n = syNoise(77), s = []; for (let i = 0; i < 220; i++) { const x = n(i * 1.37, 0.5, 1) * 0 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 1200, y = ((Math.sin(i * 78.233) * 12543.113) % 1 + 1) % 1 * 700, r = ((Math.sin(i * 3.7) * 9123.1) % 1 + 1) % 1; s.push({ x: Math.round(x), y: Math.round(y), s: r > 0.93 ? 2.2 : r > 0.7 ? 1.5 : 1, o: (0.25 + r * 0.6).toFixed(2) }); } return s; })();

window.SGP = { SY_P, syPlanetTex, sySurface, SY_STARS };
})();
