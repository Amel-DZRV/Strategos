// Version guard (task 1.16, plan section 12 R-version). Strategos relies on hook payloads, the status-line JSON and the
// `sessions/<pid>.json` shape of one Claude Code release, checked by the contract tests over fixtures/claude/<version>/.
// A different version is not an error: the daemon runs, tells the UI (hello.inRange=false plus a banner flag in the
// snapshot prefs) and suggests running the contract tests. It never refuses to start or crashes.

/** The Claude Code versions the fixtures and contract tests cover. "a.b.c" is one version; "a.b.c - x.y.z" is an inclusive range. */
export const TESTED_RANGE = '2.1.292';

export type Triple = [number, number, number];

/** First x.y.z in the text (`claude --version` prints e.g. "2.1.292 (Claude Code)"), or null. */
export function parseVersion(text: string): Triple | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function inTestedRange(version: string, range: string = TESTED_RANGE): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const parts = range.split('-').map((p) => parseVersion(p));
  const lo = parts[0];
  if (lo === null || lo === undefined) return false;
  const hi = parts.length > 1 ? parts[1] : lo;
  if (hi === null || hi === undefined) return false;
  return compareVersions(v, lo) >= 0 && compareVersions(v, hi) <= 0;
}

export interface VersionStatus {
  claudeVersion: string;
  testedRange: string;
  inRange: boolean;
  /** For logs and the UI banner; empty when in range. */
  message: string;
}

export function checkClaudeVersion(version: string | undefined, range: string = TESTED_RANGE): VersionStatus {
  if (version === undefined || version === '') {
    return {
      claudeVersion: 'unknown', testedRange: range, inRange: false,
      message: `Claude Code was not found, so its version is unknown (tested with ${range}).`,
    };
  }
  const inRange = inTestedRange(version, range);
  return {
    claudeVersion: version, testedRange: range, inRange,
    message: inRange
      ? ''
      : `Claude Code ${version} is outside the tested range (${range}). Strategos still runs; run the contract tests (npm test) before trusting hook and status details.`,
  };
}
