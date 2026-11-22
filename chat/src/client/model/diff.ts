/**
 * Small line diff for the activity log. The user should see WHAT the assistant changed before the model
 * is reloaded, not only a spinner: one line of context per changed hunk is enough.
 */

export type DiffLine = { k: " " | "+" | "-"; text: string };
export type DiffSummary = { added: number; removed: number; lines: DiffLine[]; truncated: boolean };

const MAX_LINES = 40;

/** Line diff via a trimmed LCS (code tabs are short, so O(n*m) is fine up to a few thousand lines). */
export function diffLines(before: string, after: string, maxLines = MAX_LINES): DiffSummary {
  const a = before.split("\n");
  const b = after.split("\n");
  // guard: pathological sizes fall back to a coarse summary
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    const added = b.filter((l) => !a.includes(l)).length;
    return { added, removed: a.filter((l) => !b.includes(l)).length, lines: [], truncated: true };
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ k: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      raw.push({ k: "-", text: a[i]! });
      i++;
    } else {
      raw.push({ k: "+", text: b[j]! });
      j++;
    }
  }
  while (i < n) raw.push({ k: "-", text: a[i++]! });
  while (j < m) raw.push({ k: "+", text: b[j++]! });

  let added = raw.filter((l) => l.k === "+").length;
  let removed = raw.filter((l) => l.k === "-").length;

  // keep changed lines plus two lines of context around each hunk
  const keep = new Set<number>();
  raw.forEach((l, idx) => {
    if (l.k === " ") return;
    for (let d = -2; d <= 2; d++) keep.add(idx + d);
  });
  const lines = [...keep]
    .filter((idx) => idx >= 0 && idx < raw.length)
    .sort((x, y) => x - y)
    .map((idx) => raw[idx]!);
  return { added, removed, lines: lines.slice(0, maxLines), truncated: lines.length > maxLines || lines.length < raw.length };
}

/** True when the diff is not worth showing (identical text). */
export function hasChanges(d: DiffSummary): boolean {
  return d.added > 0 || d.removed > 0;
}
