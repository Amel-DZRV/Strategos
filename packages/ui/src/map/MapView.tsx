// The Map (home screen): planets in sticky grid cells, one token per session on fixed ring slots. Look B of the
// prototype; see layout.ts for why nothing moves when something else changes.
import { useEffect, useRef, useState } from 'preact/hooks';
import { branchOf, ctxPct, fmtWait, money, statusInfo } from '../format.ts';
import { now } from '../state/clock.ts';
import { store } from '../state/store.ts';
import { openDrawer, selectedId, selectSession } from '../state/ui.ts';
import { InitiativeLines } from './InitiativeLines.tsx';
import { CELL_H, CELL_W } from './layout.ts';
import { expandPlanet, focusInitiativeChip, hoverId, pinPlanet, scene } from './model.ts';
import { Planet, PlanetDefs } from './Planet.tsx';
import type { TokenScene } from './scene.ts';
import { Token } from './Token.tsx';

/** prefers-reduced-motion, live. The daemon's UiPrefs.reducedMotion overrides the OS when set. */
export function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [os, setOs] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return undefined;
    const fn = () => setOs(query.matches);
    query.addEventListener('change', fn);
    return () => query.removeEventListener('change', fn);
  }, [query]);
  return store.prefs.value.reducedMotion ?? os;
}

/** Deterministic star field, thinly scaled with the size of the view box like the prototype's 70 dots on 760 x 510. */
export function stars(w: number, h: number): { x: number; y: number; r: number }[] {
  const n = Math.round((70 * w * h) / (760 * 510));
  return Array.from({ length: n }, (_, k) => ({ x: Math.round((k * 137.5) % w), y: Math.round((k * 71.3 + 20) % h), r: k % 7 === 0 ? 1.2 : 0.7 }));
}

interface HoverState { id: string; left: number; top: number; flip: boolean }

function HoverCard({ h, t }: { h: HoverState; t: TokenScene }) {
  const s = t.session;
  const st = statusInfo(s.status);
  const git = s.git;
  const pct = ctxPct(s);
  const branch = git?.branch ?? branchOf(s);
  const sync = git && (git.ahead || git.behind) ? `${git.ahead ? `↑${git.ahead}` : ''}${git.ahead && git.behind ? ' ' : ''}${git.behind ? `↓${git.behind}` : ''}` : '';
  return (
    <div class={`hovercard ${h.flip ? 'flip' : ''}`} style={{ left: `${h.left}px`, top: `${h.top}px`, '--stc': st.colour }} role="tooltip">
      <div class="hc-title"><span class="hc-g" aria-hidden="true">{st.glyph}</span> {s.displayName}</div>
      <div class="hc-row mono">{st.label}{s.pending ? ` · ${fmtWait(now.value - s.pending.since)}` : ''}</div>
      {branch ? <div class="hc-row mono">{branch}{sync ? ` · ${sync}` : ''}{git?.dirty ? ' · uncommitted changes' : ''}</div> : null}
      {git?.diffStat ? (
        <div class="hc-row mono">{git.diffStat.files} {git.diffStat.files === 1 ? 'file' : 'files'} changed · +{git.diffStat.add} −{git.diffStat.del}</div>
      ) : null}
      {s.pr ? (
        <div class="hc-row mono">PR #{s.pr.number} {s.pr.state.toLowerCase()}{s.pr.ci !== 'none' ? ` · CI ${s.pr.ci}` : ''}{s.pr.review ? ` · ${s.pr.review.toLowerCase()}` : ''}</div>
      ) : null}
      <div class="hc-row mono">ctx {pct === null ? 'unknown' : `${pct}%`} · {money(s.cost.lineageUsd)}{s.resource ? ` · ${Math.round(s.resource.treeWorkingSetMb)} MB` : ''}</div>
      {s.flags.conflicts.map((c) => (
        <div key={`${c.file}|${c.other}`} class="hc-row hc-warn mono">
          <span aria-hidden="true">⚠</span> {c.file} is also being changed by {store.sessions.value.get(c.other)?.displayName ?? c.other}
        </div>
      ))}
      {s.flags.contractChanged.map((f) => <div key={f} class="hc-row hc-warn mono"><span aria-hidden="true">⚠</span> contract file changed: {f}</div>)}
      {s.flags.guardDenials > 0 ? (
        <div class="hc-row mono">{s.flags.guardDenials} {s.flags.guardDenials === 1 ? 'command' : 'commands'} blocked by safety rules</div>
      ) : null}
      {s.last ? <div class="hc-last">{s.last}</div> : null}
    </div>
  );
}

export function MapView() {
  const sc = scene.value;
  const nowMs = now.value;
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const dragRef = useRef<{ key: string; sx: number; sy: number; pointerId: number; moved: boolean } | null>(null);

  const sel = selectedId.value;
  const initiatives = store.initiatives.value;
  const hovered = hover ? sc.tokens.find((t) => t.id === hover.id) : undefined;
  const selected = sel ? sc.tokens.find((t) => t.id === sel) : undefined;
  const focusInit = hovered?.session.initiativeId ?? focusInitiativeChip.value ?? selected?.session.initiativeId ?? undefined;
  const hoverInit = hovered?.session.initiativeId ?? focusInitiativeChip.value ?? undefined;
  const initiative = initiatives.find((i) => i.id === focusInit);
  const dimming = hoverInit !== undefined;
  const firstId = sc.tokens[0]?.id;
  const tabStop = sel && sc.tokens.some((t) => t.id === sel) ? sel : firstId;

  const showHover = (id: string | null) => {
    hoverId.value = id;
    if (!id) { setHover(null); return; }
    const el = wrap.current?.querySelector(`[data-sid="${CSS.escape(id)}"]`);
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const flip = r.left - box.left > box.width * 0.6;
    setHover({ id, left: flip ? r.left - box.left - 8 : r.right - box.left + 8, top: Math.max(4, r.top - box.top - 8), flip });
  };

  const toSvg = (e: PointerEvent): { x: number; y: number } | null => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onDragStart = (key: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = toSvg(e);
    if (!p) return;
    dragRef.current = { key, sx: p.x, sy: p.y, pointerId: e.pointerId, moved: false };
    svg.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    const p = toSvg(e);
    if (!d || !p) return;
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    setDrag({ key: d.key, dx, dy });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    svg.current?.releasePointerCapture?.(d.pointerId);
    const p = toSvg(e);
    setDrag(null);
    const planet = sc.planets.find((x) => x.key === d.key);
    if (!d.moved || !p || !planet) return;
    const col = Math.min(sc.size - 1, Math.max(0, Math.floor((planet.cx + (p.x - d.sx)) / CELL_W)));
    const row = Math.min(sc.size - 1, Math.max(0, Math.floor((planet.cy + (p.y - d.sy)) / CELL_H)));
    pinPlanet(d.key, col, row);
  };

  const activate = (id: string) => openDrawer(id);
  const planetHasInitiative = (tokens: readonly TokenScene[]) => tokens.some((t) => t.session.initiativeId === hoverInit);
  const empty = sc.planets.length === 0;

  return (
    <div class="mapbox" ref={wrap}>
      <svg
        ref={svg} class={`map ${reduced ? 'reduced' : ''}`} viewBox={`${sc.vb.x} ${sc.vb.y} ${sc.vb.w} ${sc.vb.h}`} preserveAspectRatio="xMidYMid meet"
        role="group" aria-label="Campaign map of repos and sessions"
        onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      >
        <defs><PlanetDefs planets={sc.planets} /></defs>
        {stars(sc.vb.w, sc.vb.h).map((d, k) => <circle key={k} cx={d.x} cy={d.y} r={d.r} fill="#6b7694" opacity=".35" />)}
        {empty ? (
          <text class="mapempty" x={sc.vb.w / 2} y={sc.vb.y + sc.vb.h / 2} text-anchor="middle">
            {store.synced.value ? 'No sessions yet. Press c to start one.' : 'Waiting for the daemon…'}
          </text>
        ) : null}
        {sc.planets.map((p) => {
          const dragging = drag?.key === p.key;
          return (
            <g key={p.key} transform={dragging ? `translate(${drag.dx} ${drag.dy})` : undefined}>
              <Planet
                p={p} dragging={dragging} dimmed={dimming && !planetHasInitiative(p.tokens)}
                onExpand={expandPlanet} onDragStart={onDragStart}
              />
            </g>
          );
        })}
        <InitiativeLines initiative={initiative} tokens={sc.tokens} />
        {sc.planets.map((p) => {
          const dragging = drag?.key === p.key;
          return (
            <g key={p.key} class="ptokens" transform={dragging ? `translate(${drag.dx} ${drag.dy})` : undefined}>
              {p.tokens.map((t) => (
                <Token
                  key={t.id} t={t} selected={sel === t.id} reduced={reduced} nowMs={nowMs} tabbable={tabStop === t.id}
                  dimmed={dimming && t.session.initiativeId !== hoverInit}
                  onActivate={activate} onFocusToken={selectSession} onHover={(id) => showHover(id)}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {hover && hovered ? <HoverCard h={hover} t={hovered} /> : null}
    </div>
  );
}
