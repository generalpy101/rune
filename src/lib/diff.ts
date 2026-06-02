/**
 * Minimal line-level diff (Myers/LCS) for the AI "apply patch" review UI.
 *
 * The agent's `edit_file` tool sends an exact `old_string` → `new_string`
 * replacement; `write_file` sends the full new `contents`. We render these as a
 * GitHub-style colorized diff so the user can review a change before approving
 * it (and inspect it afterwards). This is purely presentational — the actual
 * edit is applied by the Rust backend.
 */

export type DiffOp = "ctx" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text (null for added lines). */
  oldNo: number | null;
  /** 1-based line number in the new text (null for deleted lines). */
  newNo: number | null;
}

/** Longest-common-subsequence table over two arrays of lines. */
function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Split into lines without a trailing empty element from a final newline. */
function toLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Compute a line-level diff between `oldText` and `newText`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const dp = lcs(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "del", text: a[i], oldNo: oldNo++, newNo: null });
      i++;
    } else {
      out.push({ op: "add", text: b[j], oldNo: null, newNo: newNo++ });
      j++;
    }
  }
  while (i < a.length)
    out.push({ op: "del", text: a[i++], oldNo: oldNo++, newNo: null });
  while (j < b.length)
    out.push({ op: "add", text: b[j++], oldNo: null, newNo: newNo++ });
  return out;
}

/** Treat the whole text as additions (used for write_file's new contents). */
export function allAdded(text: string): DiffLine[] {
  return toLines(text).map((line, idx) => ({
    op: "add" as const,
    text: line,
    oldNo: null,
    newNo: idx + 1,
  }));
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") removed++;
  }
  return { added, removed };
}
