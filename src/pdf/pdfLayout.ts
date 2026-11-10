/** Positioned text item from pdf.js (origin bottom-left, y grows upward). */
export interface TextItem { str: string; x: number; y: number; width: number; height: number; hasEOL: boolean }

/**
 * Group positioned text items into lines of text. Items on the same baseline are joined left to
 * right; a vertical gap noticeably larger than the usual line spacing becomes a blank line
 * (paragraph break). Returns lines in reading order, top to bottom.
 */
export function extractLinesFromItems(items: TextItem[]): string[] {
  const usable = items.filter((it) => it.str.trim() !== '' || it.hasEOL);
  if (usable.length === 0) return [];
  const heights = usable.map((it) => it.height).filter((h) => h > 0).sort((a, b) => a - b);
  const typical = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tolerance = Math.max(1.5, typical * 0.4);

  // Cluster into rows by y.
  interface Row { y: number; items: TextItem[] }
  const rows: Row[] = [];
  for (const it of usable) {
    if (it.str.trim() === '') continue;
    let row = rows.find((r) => Math.abs(r.y - it.y) <= tolerance);
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  const lines: string[] = [];
  let prevY: number | undefined;
  let prevBottomGap: number[] = [];
  for (const row of rows) {
    if (prevY !== undefined) {
      const gap = prevY - row.y;
      const median = prevBottomGap.length ? [...prevBottomGap].sort((a, b) => a - b)[Math.floor(prevBottomGap.length / 2)] : typical * 1.2;
      if (gap > Math.max(median * 1.6, typical * 1.9)) lines.push('');
      if (gap > 0 && gap < typical * 3) prevBottomGap.push(gap);
      if (prevBottomGap.length > 12) prevBottomGap = prevBottomGap.slice(-12);
    }
    prevY = row.y;
    row.items.sort((a, b) => a.x - b.x);
    let text = '';
    let lastEnd: number | undefined;
    for (const it of row.items) {
      const s = it.str;
      if (lastEnd !== undefined) {
        const gap = it.x - lastEnd;
        const needsSpace = gap > typical * 0.15 && !text.endsWith(' ') && !s.startsWith(' ');
        if (needsSpace) text += ' ';
      }
      text += s;
      lastEnd = it.x + it.width;
    }
    lines.push(text.replace(/\s+/g, ' ').trim());
  }
  return lines;
}

/** Join lines into paragraphs, repairing end-of-line hyphenation ("exam-" + "ple" -> "example"). */
export function dehyphenate(lines: string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (const line of lines) {
    if (line === '') { if (carry) { out.push(carry); carry = ''; } out.push(''); continue; }
    if (carry) {
      // Previous line ended with a hyphen: glue the word together.
      const joined = carry.replace(/-$/, '') + line;
      if (/-$/.test(line) && /\w-$/.test(line)) { carry = joined; continue; }
      out.push(joined);
      carry = '';
      continue;
    }
    if (/\w-$/.test(line)) { carry = line; continue; }
    out.push(line);
  }
  if (carry) out.push(carry);
  return out;
}
