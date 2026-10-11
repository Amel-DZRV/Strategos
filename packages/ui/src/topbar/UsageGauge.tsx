// Usage gauge (4.08): the 5-hour and 7-day rate-limit windows as a percentage with a small bar. The tooltip carries the
// reset times, the burn rate and the estimated time until the window is full (both from the daemon).
import type { Usage } from '@strategos/shared';
import { ctxColour, fmtWait } from '../format.ts';
import { now } from '../state/clock.ts';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { errorNotice } from '../state/ui.ts';

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function usageTip(u: Usage, nowMs: number): string[] {
  const lines: string[] = [];
  if (u.fiveHour) lines.push(`5-hour window: ${Math.round(u.fiveHour.pct)}% used, resets in ${fmtWait(Math.max(0, u.fiveHour.resetsAt - nowMs))}`);
  if (u.sevenDay) lines.push(`7-day window: ${Math.round(u.sevenDay.pct)}% used, resets in ${fmtWait(Math.max(0, u.sevenDay.resetsAt - nowMs))}`);
  if (u.burnPctPerHour !== undefined) {
    lines.push(`Burn rate: ${u.burnPctPerHour >= 10 ? Math.round(u.burnPctPerHour) : u.burnPctPerHour.toFixed(1)}% of the 5-hour window per hour`);
  }
  if (u.etaFull !== undefined) {
    lines.push(`At this pace the window is full in ${fmtWait(Math.max(0, u.etaFull - nowMs))} (about ${clock(u.etaFull)})`);
  }
  return lines;
}

function One({ label, pct }: { label: string; pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span class="g">
      {label}
      <span class="bar" aria-hidden="true"><i style={{ width: `${p}%`, background: ctxColour(p) }} /></span>
      <b>{p}%</b>
    </span>
  );
}

export function UsageGauge() {
  const u = store.usage.value;
  if (!u || (!u.fiveHour && !u.sevenDay)) return null;
  const tip = usageTip(u, now.value);
  return (
    <span class="gauge m">
      <button type="button" aria-label={`Usage. ${tip.join('. ')}`} aria-describedby="usage-tip">
        {u.fiveHour ? <One label="5h" pct={u.fiveHour.pct} /> : null}
        {u.sevenDay ? <One label="7d" pct={u.sevenDay.pct} /> : null}
      </button>
      <span class="tip" id="usage-tip" role="tooltip">
        {tip.map((l) => <div key={l}>{l}</div>)}
      </span>
    </span>
  );
}

/** The park nudge (and any other daemon suggestion the UI knows how to show): dismissible, never applied by itself. */
export function SuggestionBanners() {
  const list = store.suggestions.value.filter((s) => s.kind === 'park');
  if (list.length === 0) return null;
  const answer = (id: string, accept: boolean) => {
    send({ c: 'suggestion.respond', id, accept })
      .then(() => { store.removeSuggestion(id); })
      .catch((e: unknown) => { errorNotice.value = `Could not answer the suggestion: ${e instanceof Error ? e.message : String(e)}`; });
  };
  return (
    <>
      {list.map((s) => (
        <div key={s.id} class="banner suggest" role="note">
          <span>{s.text}</span>
          <span class="bactions">
            <button type="button" class="btn primary" onClick={() => answer(s.id, true)}>Accept</button>
            <button type="button" class="btn" onClick={() => answer(s.id, false)}>Dismiss</button>
          </span>
        </div>
      ))}
    </>
  );
}
