/**
 * Lightweight fuzzy subsequence scorer. Returns a score (higher is better) or
 * null when `query` is not a subsequence of `target`. Rewards consecutive
 * matches, matches right after a path/word separator, and matches in the
 * basename (the segment after the last `/`).
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const basenameStart = t.lastIndexOf("/") + 1;
  let score = 0;
  let qi = 0;
  let prevMatch = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = 1;
    if (ti === prevMatch + 1) bonus += 4; // consecutive run
    if (ti === basenameStart) bonus += 6; // start of filename
    const prev = t[ti - 1];
    if (prev === "/" || prev === "_" || prev === "-" || prev === ".") {
      bonus += 3; // boundary
    }
    if (ti >= basenameStart) bonus += 2; // anywhere in the basename
    score += bonus;
    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null; // not all query chars matched
  // Prefer shorter targets when scores tie.
  return score - t.length * 0.01;
}
