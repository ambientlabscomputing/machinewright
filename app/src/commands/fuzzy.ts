/**
 * Subsequence fuzzy matching for the command palette and quick-open.
 * Scores favor consecutive runs, word/path-segment starts and camelCase
 * humps, and matches near the start of the target — the same heuristics
 * people expect from editor quick-open — without any external dependency.
 */

export interface FuzzyMatch {
  /** Higher is better. */
  readonly score: number;
  /** Indices into the target of each matched query character, ascending. */
  readonly indices: readonly number[];
}

const SEPARATORS = new Set([" ", "/", "\\", "-", "_", ".", ":"]);

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target.charAt(index - 1);
  if (SEPARATORS.has(previous)) return true;
  const current = target.charAt(index);
  return previous === previous.toLowerCase() && previous !== previous.toUpperCase() && current !== current.toLowerCase();
}

/** Returns `null` when `query` is not a case-insensitive subsequence of `target`. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  if (needle.length === 0) return { score: 0, indices: [] };
  const haystack = target.toLowerCase();
  if (needle.length > haystack.length) return null;

  // Dynamic programming over (query index, target index) so the *best*
  // alignment wins, not merely the leftmost greedy one.
  const n = needle.length;
  const m = haystack.length;
  const NEG = Number.NEGATIVE_INFINITY;
  // best[i][j]: best score matching needle[0..i] with needle[i] at target j.
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (haystack.charAt(j) !== needle.charAt(i)) continue;
      let base = 1;
      if (isBoundary(target, j)) base += 8;
      if (target.charAt(j) === query.replace(/\s+/g, "").charAt(i)) base += 1; // exact-case bonus
      if (i === 0) {
        best[i]![j] = base - Math.min(j, 12) * 0.25;
        continue;
      }
      let bestPrevious = NEG;
      let bestPreviousIndex = -1;
      for (let k = i - 1; k < j; k++) {
        const previousScore = best[i - 1]![k]!;
        if (previousScore === NEG) continue;
        const consecutive = k === j - 1 ? 6 : -Math.min(j - k - 1, 6) * 0.5;
        if (previousScore + consecutive > bestPrevious) {
          bestPrevious = previousScore + consecutive;
          bestPreviousIndex = k;
        }
      }
      if (bestPreviousIndex >= 0) {
        best[i]![j] = bestPrevious + base;
        from[i]![j] = bestPreviousIndex;
      }
    }
  }

  let endIndex = -1;
  let endScore = NEG;
  for (let j = n - 1; j < m; j++) {
    const score = best[n - 1]![j]!;
    if (score > endScore) {
      endScore = score;
      endIndex = j;
    }
  }
  if (endIndex < 0) return null;

  const indices = new Array<number>(n);
  let cursor = endIndex;
  for (let i = n - 1; i >= 0; i--) {
    indices[i] = cursor;
    cursor = from[i]![cursor]!;
  }
  // Mild preference for shorter targets when matches are otherwise equal.
  return { score: endScore - m * 0.01, indices };
}

export interface Ranked<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

/** Filters and ranks `items` by `getText`, best first; ties keep input order. */
export function rankByFuzzy<T>(items: readonly T[], query: string, getText: (item: T) => string, limit = 100): Ranked<T>[] {
  const ranked: { ranked: Ranked<T>; order: number }[] = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, getText(item));
    if (match) ranked.push({ ranked: { item, match }, order });
  });
  ranked.sort((a, b) => b.ranked.match.score - a.ranked.match.score || a.order - b.order);
  return ranked.slice(0, limit).map((entry) => entry.ranked);
}
