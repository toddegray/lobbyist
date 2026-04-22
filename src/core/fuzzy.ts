/**
 * Fuzzy string matching for entity resolution.
 *
 * Two algorithms:
 *   - Levenshtein distance: character edit count.
 *   - Jaro–Winkler similarity: 0..1 score weighted toward common prefixes.
 *
 * Used by resolve.ts to pick the best LDA search hit when the literal
 * user-supplied name doesn't match any record exactly. Example: user types
 * "Pfizer", LDA has "PFIZER INC." and "Pfizer Pharmaceuticals Holdings".
 * JW surfaces "PFIZER INC." as the closer match.
 *
 * Implementations are self-contained (no deps) and ASCII-safe.
 */

/** Edit distance. O(m*n) time, O(min(m,n)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter string for O(min) space
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const prev = new Array(a.length + 1);
  const cur = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      cur[i] = Math.min(
        cur[i - 1] + 1,      // insertion
        prev[i] + 1,          // deletion
        prev[i - 1] + cost,   // substitution
      );
    }
    for (let i = 0; i <= a.length; i++) prev[i] = cur[i];
  }
  return prev[a.length];
}

/** Jaro similarity (helper for Jaro–Winkler). */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDistance);
    const hi = Math.min(i + matchDistance + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
}

/**
 * Jaro–Winkler similarity. Returns 0..1. p is the prefix weight (0.1 is
 * the canonical default; higher emphasizes common starts more).
 */
export function jaroWinkler(a: string, b: string, p: number = 0.1): number {
  const jaroScore = jaro(a, b);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefix += 1;
  }
  return jaroScore + prefix * p * (1 - jaroScore);
}

/**
 * Pick the best match from a set of candidates for a query string. Returns
 * the index of the winning candidate and a 0..1 confidence score, or null
 * if no candidate exceeds `threshold` (default 0.75).
 */
export function bestMatch(
  query: string,
  candidates: string[],
  opts: { threshold?: number } = {},
): { index: number; score: number } | null {
  const threshold = opts.threshold ?? 0.75;
  if (candidates.length === 0) return null;
  const q = query.toUpperCase();
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!.toUpperCase();
    const s = jaroWinkler(q, c);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < threshold) return null;
  return { index: bestIdx, score: bestScore };
}
