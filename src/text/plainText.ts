import { Segment } from './segments';

export interface PlainTextOptions {
  /** 'paragraphs': lines of a paragraph are joined into flowing text; a blank line ends a block.
   *  'lines': every line is its own block (used for source code). */
  mode: 'paragraphs' | 'lines';
  lineOffset?: number;
  firstLineOffset?: number;
  page?: number;
}

/** Convert plain text (or code) lines into segments. Text is kept verbatim so highlighting is exact. */
export function plainTextToSegments(lines: string[], options: PlainTextOptions): Segment[] {
  const segments: Segment[] = [];
  const lineOffset = options.lineOffset ?? 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const base = i === 0 ? options.firstLineOffset ?? 0 : 0;
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text === '') continue;
    const next = i + 1 < lines.length ? lines[i + 1] : undefined;
    const blockEnd = options.mode === 'lines' || next === undefined || next.trim() === '';
    segments.push({ text, line: lineOffset + i, startChar: base + leading, exact: true, blockEnd, page: options.page });
  }
  return segments;
}
