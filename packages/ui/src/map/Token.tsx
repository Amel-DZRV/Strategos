// One session on the Map, drawn after the prototype's mapSvg(): status ring and glyph, context arc outside it,
// pulse when it needs you, name and "ctx% . cost" under it. Everything extra (waiting number, risk chip, marks,
// subagent dots) is drawn only where the data exists. Coordinates are local: the group is translated to the token.
import { isNeedsYou, type Pending, type SessionRecord } from '@strategos/shared';
import { ctxColour, ctxPct, fmtWait, money, RISK_LABEL, statusInfo, waitingMs } from '../format.ts';
import { clipName, type TokenScene } from './scene.ts';

const R_TRACK = 20;
const C_TRACK = 2 * Math.PI * R_TRACK;

const RISK_COLOUR: Record<Pending['risk'][number], string> = {
  read: 'var(--c-ready)', write: 'var(--c-reply)', run: 'var(--c-reply)', network: 'var(--c-reply)',
  delete: 'var(--c-approve)', outside_repo: 'var(--c-approve)',
};
const PR_COLOUR: Record<NonNullable<SessionRecord['pr']>['state'], string> = {
  DRAFT: '#8b94aa', OPEN: 'var(--c-work)', MERGED: '#b48cff', CLOSED: 'var(--c-approve)',
};
const CI_COLOUR = { pass: 'var(--c-ready)', fail: 'var(--c-approve)', pending: 'var(--c-reply)' } as const;

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Point on a circle around the token at a clock position (12 = top, 3 = right). */
function atClock(hour: number, radius: number): { x: number; y: number } {
  const a = ((hour * 30 - 90) * Math.PI) / 180;
  return { x: r1(radius * Math.cos(a)), y: r1(radius * Math.sin(a)) };
}

/** Seconds per pulse: normal, faster after 5 minutes of waiting, fastest after 15 (plan section 7). */
export function pulseSeconds(waitMs: number): number {
  return waitMs >= 15 * 60_000 ? 0.7 : waitMs >= 5 * 60_000 ? 1.2 : 1.9;
}

export function tokenLabel(s: SessionRecord, nowMs: number): string {
  const st = statusInfo(s.status);
  const parts = [s.displayName, st.label];
  if (s.statusSource === 'transcript' || s.statusSource === 'reconciler') parts.push('probably');
  if (isNeedsYou(s)) parts.push(`waiting ${fmtWait(waitingMs(s, nowMs))}`);
  const pct = ctxPct(s);
  parts.push(pct === null ? 'context unknown' : `context ${pct} percent`);
  return parts.join(', ');
}

function cacheColour(c: NonNullable<SessionRecord['cache']>, nowMs: number): string | null {
  if (c.warm === null) return null;
  if (!c.warm) return '#6b7694';
  if (c.expiresAt !== undefined && c.expiresAt - nowMs < 5 * 60_000) return 'var(--c-reply)';
  return 'var(--c-ready)';
}

export interface TokenProps {
  t: TokenScene;
  selected: boolean;
  dimmed: boolean;
  reduced: boolean;
  nowMs: number;
  tabbable: boolean;
  onActivate: (id: string) => void;
  onFocusToken: (id: string) => void;
  onHover: (id: string | null, el: Element | null) => void;
}

export function Token({ t, selected, dimmed, reduced, nowMs, tabbable, onActivate, onFocusToken, onHover }: TokenProps) {
  const s = t.session;
  const st = statusInfo(s.status);
  const needs = isNeedsYou(s);
  const pct = ctxPct(s);
  const inferred = s.statusSource === 'transcript' || s.statusSource === 'reconciler';
  const wait = needs ? waitingMs(s, nowMs) : 0;
  const pulses = needs && s.status !== 'done' && !reduced;
  const running = s.subagents.filter((a) => a.running).length;
  const risk = s.pending?.kind === 'permission' ? s.pending.risk[0] : undefined;
  const cache = s.cache ? cacheColour(s.cache, nowMs) : null;
  const flags = s.flags;
  const hasConflict = flags.conflicts.length > 0 || flags.contractChanged.length > 0;
  const glyph = s.status === 'seen' ? '✓' : st.glyph;

  const ci = s.pr && s.pr.ci !== 'none' ? CI_COLOUR[s.pr.ci] : null;
  const p2 = atClock(2, 28);
  const p4 = atClock(4, 28);
  const p8 = atClock(8, 28);
  const p10 = atClock(10, 28);
  const p5 = atClock(5, 28);
  const denied = flags.guardDenials;
  const a0 = atClock(11, 24.5);
  const a1 = atClock(1, 24.5);
  const rw = risk ? RISK_LABEL[risk].length * 5.2 + 8 : 0;

  return (
    <g
      class={`tok ${needs ? 'needs' : ''} ${selected ? 'sel' : ''}`}
      data-sid={t.id} data-status={s.status}
      transform={`translate(${r1(t.x)} ${r1(t.y)})`}
      style={{ '--stc': st.colour, opacity: dimmed ? 0.25 : 1 }}
      tabindex={tabbable ? 0 : -1} role="button" aria-label={tokenLabel(s, nowMs)} aria-pressed={selected}
      onClick={() => onActivate(t.id)}
      onFocus={() => { onFocusToken(t.id); onHover(t.id, null); }}
      onBlur={() => onHover(null, null)}
      onMouseEnter={(e) => onHover(t.id, e.currentTarget)}
      onMouseLeave={() => onHover(null, null)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(t.id);
        }
      }}
    >
      {pulses ? (
        <circle class="pulse" r="16" fill="none" stroke={st.colour} stroke-width="2" style={{ animationDuration: `${pulseSeconds(wait)}s` }} />
      ) : null}
      <circle class="hit" r="26" fill="transparent" />
      <circle r={R_TRACK} fill="none" stroke="#222a3f" stroke-width="3" />
      {pct === null ? (
        <circle class="ctx-null" r={R_TRACK} fill="none" stroke="#3a4262" stroke-width="1" stroke-dasharray="2 4" />
      ) : (
        <circle
          class="ctx" r={R_TRACK} fill="none" stroke={ctxColour(pct)} stroke-width="3" opacity=".85" transform="rotate(-90)"
          stroke-dasharray={`${r1((C_TRACK * pct) / 100)} ${r1(C_TRACK)}`}
        />
      )}
      {cache ? (
        <path class="cache" d={`M ${a0.x} ${a0.y} A 24.5 24.5 0 0 1 ${a1.x} ${a1.y}`} fill="none" stroke={cache} stroke-width="2" stroke-linecap="round" />
      ) : null}
      <circle
        class="ring" r="14.5" fill="#161d33" stroke={st.colour} stroke-width={reduced && needs ? 4.5 : 3}
        stroke-dasharray={inferred ? '4 3' : undefined}
      />
      {selected ? <circle class="selring" r="25.5" fill="none" stroke="#e8ecf2" stroke-width="1.5" stroke-dasharray="3 3" /> : null}
      <text class="glyph" y="5" text-anchor="middle" font-size="14" fill={st.colour} opacity={s.status === 'seen' ? 0.55 : 1}>{glyph}</text>
      {running > 0 ? (
        <g class="subs" fill={st.colour} opacity=".9">
          {Array.from({ length: Math.min(3, running) }, (_, i) => (
            <circle key={i} cx={(i - (Math.min(3, running) - 1) / 2) * 5} cy="9" r="1.7" />
          ))}
        </g>
      ) : null}
      {ci ? <circle class="mark mark-ci" cx={p2.x} cy={p2.y} r="3.4" fill={ci} stroke="#06080f" stroke-width="1" /> : null}
      {s.pr ? (
        <g class="mark mark-pr" transform={`translate(${p4.x} ${p4.y})`}>
          <circle r="5" fill="#0c1020" stroke={PR_COLOUR[s.pr.state]} stroke-width="1.2" />
          <text y="2.5" text-anchor="middle" font-size="7" font-weight="700" fill={PR_COLOUR[s.pr.state]}>P</text>
        </g>
      ) : null}
      {hasConflict ? (
        <g class="mark mark-conflict" transform={`translate(${p8.x} ${p8.y})`}>
          <path d="M0 -5 L5.2 4 L-5.2 4 Z" fill="var(--c-reply)" stroke="#06080f" stroke-width="1" />
          <text y="3" text-anchor="middle" font-size="6.5" font-weight="800" fill="#06080f">!</text>
        </g>
      ) : null}
      {flags.stuck ? (
        <g class="mark mark-stuck" transform={`translate(${p10.x} ${p10.y})`}>
          <circle r="4.6" fill="var(--c-approve)" stroke="#06080f" stroke-width="1" />
          <text y="2.6" text-anchor="middle" font-size="7" font-weight="800" fill="#06080f">!</text>
        </g>
      ) : null}
      {denied > 0 ? (
        <g class="mark mark-guard" transform={`translate(${p5.x} ${p5.y})`}>
          <title>{`${denied} ${denied === 1 ? 'command' : 'commands'} blocked by safety rules`}</title>
          <circle r="4.6" fill="#0c1020" stroke="var(--c-reply)" stroke-width="1.2" />
          <path d="M-2.4 -2.4 L2.4 2.4 M2.4 -2.4 L-2.4 2.4" stroke="var(--c-reply)" stroke-width="1.4" stroke-linecap="round" />
        </g>
      ) : null}
      {risk ? (
        <g class="risk-chip" transform="translate(0 -25)">
          <rect x={-rw / 2} y="-6" width={r1(rw)} height="12" rx="6" fill="#0c1020" stroke={RISK_COLOUR[risk]} stroke-width="1" />
          <text y="2.8" text-anchor="middle" font-size="7.5" font-weight="700" fill={RISK_COLOUR[risk]}>{RISK_LABEL[risk]}</text>
        </g>
      ) : null}
      <text class="nm" y="37" text-anchor="middle">{clipName(s.displayName)}</text>
      <text class="sub" y="49" text-anchor="middle">{pct === null ? '–' : `${pct}%`} · {money(s.cost.lineageUsd)}</text>
      {needs ? <text class="sub wait" x="27" y="3.5" text-anchor="start" fill={st.colour}>{fmtWait(wait)}</text> : null}
      {inferred ? <text class="sub probably" x="-27" y="3.5" text-anchor="end">probably</text> : null}
    </g>
  );
}
