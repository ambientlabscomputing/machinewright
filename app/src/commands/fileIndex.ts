/**
 * Quick-open ranking over project-relative file paths. A match in the file
 * name outranks the same match spread across directories, so typing
 * "app" prefers `App.tsx` over `src/analysis/pp.ts`-style incidental hits.
 */
import { fuzzyMatch, type FuzzyMatch } from "./fuzzy";

export interface FileMatch {
  readonly path: string;
  readonly match: FuzzyMatch;
  /** Indices into the path's base name when the query matched there, else empty. */
  readonly nameIndices: readonly number[];
}

const NAME_BONUS = 25;

export function rankFiles(paths: readonly string[], query: string, limit = 60): FileMatch[] {
  const results: { entry: FileMatch; order: number }[] = [];
  paths.forEach((path, order) => {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const nameMatch = query ? fuzzyMatch(query, name) : null;
    const fullMatch = fuzzyMatch(query, path);
    if (!fullMatch && !nameMatch) return;
    const match: FuzzyMatch = nameMatch
      ? { score: nameMatch.score + NAME_BONUS, indices: nameMatch.indices.map((index) => index + slash + 1) }
      : (fullMatch as FuzzyMatch);
    results.push({
      entry: { path, match, nameIndices: nameMatch ? nameMatch.indices : [] },
      order,
    });
  });
  results.sort((a, b) => b.entry.match.score - a.entry.match.score || a.order - b.order);
  return results.slice(0, limit).map((result) => result.entry);
}
