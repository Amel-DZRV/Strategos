// Usage gauge maths (task 4.08): burn rate, time to full, and the park suggestion.
//
// The status line gives the 5-hour and 7-day percentages (statusline/ingest.ts -> Usage). This keeps a two-hour window of
// samples of the 5-hour percentage and adds to each Usage:
//   burnPctPerHour : least-squares slope of the last 30 minutes, in percentage points per hour (omitted when unknown or <= 0)
//   etaFull        : epoch ms when the 5-hour window reaches 100% at that rate (omitted when the burn is <= 0, when it is
//                    unknown, or when the window resets first)
// and returns a park suggestion once per 5-hour window when the percentage reaches 85. A suggestion is only a suggestion:
// nothing here parks anything (the person accepts it, or not).
import type { Usage } from '@strategos/shared';

const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface Sample {
  /** epoch ms */
  t: number;
  pct: number;
}

/** Least-squares slope of pct over time, in percentage points per hour. undefined with fewer than 2 distinct times. */
export function slopePerHour(samples: readonly Sample[]): number | undefined {
  const n = samples.length;
  if (n < 2) return undefined;
  const t0 = samples[0]!.t;
  let sx = 0; let sy = 0;
  for (const s of samples) { sx += (s.t - t0); sy += s.pct; }
  const mx = sx / n; const my = sy / n;
  let sxx = 0; let sxy = 0;
  for (const s of samples) { const dx = (s.t - t0) - mx; sxx += dx * dx; sxy += dx * (s.pct - my); }
  if (sxx === 0) return undefined;
  return (sxy / sxx) * HOUR;
}

export interface ParkSuggestion {
  id: string;
  kind: 'park';
  text: string;
}

export interface UsageUpdate {
  usage: Usage;
  suggestion?: ParkSuggestion;
}

export interface UsageTracker {
  /** Add a reading; returns it with burn rate and ETA filled in, and a park suggestion at most once per 5-hour window. */
  ingest(u: Usage): UsageUpdate;
  /** The samples of the 5-hour percentage currently kept (oldest first). */
  samples(): readonly Sample[];
}

export interface UsageTrackerOptions {
  /** Default 2 h. */
  windowMs?: number;
  /** The part of the window the slope is fitted over. Default 30 min. */
  slopeMs?: number;
  /** Default 85. */
  parkPct?: number;
  /** Fewer seconds of data than this give no burn rate (a slope from two points a second apart is noise). Default 120 s. */
  minSpanMs?: number;
}

export function createUsageTracker(o: UsageTrackerOptions = {}): UsageTracker {
  const windowMs = o.windowMs ?? 2 * HOUR;
  const slopeMs = o.slopeMs ?? 30 * MINUTE;
  const parkPct = o.parkPct ?? 85;
  const minSpanMs = o.minSpanMs ?? 120_000;
  let samples: Sample[] = [];
  let resetsAt: number | undefined;
  let parkedWindowEnd: number | undefined;

  function ingest(u: Usage): UsageUpdate {
    const five = u.fiveHour;
    if (five === undefined) return { usage: u };
    const at = u.at;

    // A new 5-hour window (the reset time moved on, or the percentage fell): the old samples describe a window that is gone.
    const last = samples[samples.length - 1];
    if ((resetsAt !== undefined && Math.abs(five.resetsAt - resetsAt) > 10 * MINUTE) || (last !== undefined && five.pct < last.pct - 5)) samples = [];
    resetsAt = five.resetsAt;

    // Keep a flat reading only every 30 s, a changed one always.
    const prev = samples[samples.length - 1];
    if (prev === undefined || prev.pct !== five.pct || at - prev.t >= 30_000) samples.push({ t: at, pct: five.pct });
    samples = samples.filter((s) => s.t >= at - windowMs);

    const recent = samples.filter((s) => s.t >= at - slopeMs);
    const span = recent.length < 2 ? 0 : recent[recent.length - 1]!.t - recent[0]!.t;
    const slope = span >= minSpanMs ? slopePerHour(recent) : undefined;
    const out: Usage = { ...u };
    if (slope !== undefined && slope > 0.05) {
      out.burnPctPerHour = Math.round(slope * 10) / 10;
      const eta = at + ((100 - five.pct) / slope) * HOUR;
      if (five.pct < 100 && eta < five.resetsAt) out.etaFull = Math.round(eta / MINUTE) * MINUTE;
    }

    let suggestion: ParkSuggestion | undefined;
    if (five.pct >= parkPct && (parkedWindowEnd === undefined || five.resetsAt - parkedWindowEnd > 30 * MINUTE)) {
      parkedWindowEnd = five.resetsAt;
      const minsLeft = Math.max(0, Math.round((five.resetsAt - at) / MINUTE));
      suggestion = {
        id: `park-${five.resetsAt}`,
        kind: 'park',
        text: `The 5-hour limit is at ${Math.round(five.pct)}% and resets in ${minsLeft} min. Park the working sessions to keep what is left?`,
      };
    }
    return suggestion === undefined ? { usage: out } : { usage: out, suggestion };
  }

  return { ingest, samples: () => samples };
}
