// Small fuzzy matcher for the command palette: every query character must appear in order. Higher score = better.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return 0;
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 2; // run of consecutive characters
    if (at === 0 || t[at - 1] === ' ' || t[at - 1] === '/' || t[at - 1] === '-') score += 3; // start of a word
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.01; // shorter labels win ties
}

export function fuzzyFilter<T>(items: readonly T[], query: string, textOf: (i: T) => string): T[] {
  if (query.trim() === '') return [...items];
  const scored: { i: T; s: number; n: number }[] = [];
  items.forEach((i, n) => {
    const s = fuzzyScore(query, textOf(i));
    if (s !== null) scored.push({ i, s, n });
  });
  return scored.sort((a, b) => b.s - a.s || a.n - b.n).map((x) => x.i);
}
