// One repo (or initiative) on the Map: dotted orbit that drifts slowly, a shaded disc and the name split on "-".
import { planetLines, type PlanetScene } from './scene.ts';
import { ringRadius } from './layout.ts';

export const planetGradientId = (key: string): string => `pg-${key.replace(/[^a-zA-Z0-9]/g, '_')}`;

export function PlanetDefs({ planets }: { planets: readonly PlanetScene[] }) {
  return (
    <>
      {planets.map((p) => (
        <radialGradient key={p.key} id={planetGradientId(p.key)} cx="35%" cy="30%">
          <stop offset="0" stop-color={p.colour} />
          <stop offset="1" stop-color="#0c1020" />
        </radialGradient>
      ))}
    </>
  );
}

export interface PlanetProps {
  p: PlanetScene;
  dimmed: boolean;
  dragging: boolean;
  onExpand: (key: string) => void;
  onDragStart: (key: string, e: PointerEvent) => void;
}

export function Planet({ p, dimmed, dragging, onExpand, onDragStart }: PlanetProps) {
  const lines = planetLines(p.label);
  const y0 = lines.length === 1 ? p.cy + 4 : p.cy - 1;
  if (p.folded) {
    // Dormant planet: a small dot in its cell, no orbit and no tokens.
    return (
      <g class="planet folded" data-planet={p.key} style={{ opacity: dimmed ? 0.25 : 1 }} onPointerDown={(e) => onDragStart(p.key, e)}>
        <title>{`${p.label}: dormant`}</title>
        <circle cx={p.cx} cy={p.cy} r="9" fill={`url(#${planetGradientId(p.key)})`} stroke="#2a3350" />
        <text class="plabel dormant" x={p.cx} y={p.cy + 24} text-anchor="middle">{p.label}</text>
      </g>
    );
  }
  return (
    <g class={`planet ${dragging ? 'dragging' : ''}`} data-planet={p.key} style={{ opacity: dimmed ? 0.25 : 1 }}>
      {Array.from({ length: p.rings + 1 }, (_, i) => (
        <g key={i} class="drift" style={{ transformOrigin: `${p.cx}px ${p.cy}px` }}>
          <circle cx={p.cx} cy={p.cy} r={ringRadius(i)} fill="none" stroke="#2a3350" stroke-dasharray="3 6" />
        </g>
      ))}
      <circle
        class="disc" cx={p.cx} cy={p.cy} r="34" fill={`url(#${planetGradientId(p.key)})`} stroke="#2a3350"
        onPointerDown={(e) => onDragStart(p.key, e)}
      />
      {lines.map((l, i) => (
        <text
          key={i} class={`plabel ${i === 0 ? 'first' : 'rest'}`} x={p.cx} y={i === 0 ? y0 : y0 + 13} text-anchor="middle"
          style={{ pointerEvents: 'none' }}
        >{l}</text>
      ))}
      {p.hidden > 0 ? (
        <g
          class="more" role="button" tabindex={0} aria-label={`Show ${p.hidden} more quiet sessions on ${p.label}`}
          onClick={() => onExpand(p.key)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(p.key); } }}
        >
          <rect x={p.cx - 15} y={p.cy + 17} width="30" height="14" rx="7" fill="#0c1020" stroke="#8b94aa" />
          <text x={p.cx} y={p.cy + 27.5} text-anchor="middle" class="badge">+{p.hidden}</text>
        </g>
      ) : null}
    </g>
  );
}
