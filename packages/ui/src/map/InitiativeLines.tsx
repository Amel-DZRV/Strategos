// Straight lines between the tokens of the hovered or selected initiative, in its colour, under the tokens.
import type { Initiative } from '@strategos/shared';
import type { TokenScene } from './scene.ts';

export function InitiativeLines({ initiative, tokens }: { initiative: Initiative | undefined; tokens: readonly TokenScene[] }) {
  if (!initiative) return null;
  const mine = tokens.filter((t) => t.session.initiativeId === initiative.id);
  if (mine.length < 2) return null;
  // Chain left to right so the picture is stable and no line crosses itself needlessly.
  const pts = [...mine].sort((a, b) => a.x - b.x || a.y - b.y);
  return (
    <g class="init-lines" aria-hidden="true" pointer-events="none">
      {pts.slice(1).map((t, i) => {
        const a = pts[i]!;
        return (
          <line key={`${a.id}-${t.id}`} x1={a.x} y1={a.y} x2={t.x} y2={t.y} stroke={initiative.colour} stroke-width="2" stroke-opacity=".75" stroke-dasharray="6 4" />
        );
      })}
    </g>
  );
}
