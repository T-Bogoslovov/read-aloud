import { Segment } from './segments';

export type CodeBlockMode = 'announce' | 'skip' | 'read';

export interface MarkdownOptions {
  codeBlocks?: CodeBlockMode;
  /** Absolute line number of lines[0] in the source document. */
  lineOffset?: number;
  /** Character offset of lines[0] in its source line (when the first line was sliced). */
  firstLineOffset?: number;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
};

/** Remove inline Markdown markup from a single line of text, keeping the human-readable words. */
export function stripInline(input: string): string {
  // Protect backslash-escaped characters so the markup rules below leave them alone.
  let s = input.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, c: string) => `\uE000${c.charCodeAt(0).toString(16).padStart(4, '0')}\uE001`);
  // Images: keep alt text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt);
  // Inline links [text](url "title") and reference links [text][ref] / [text][] -> text.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, (_m, t: string) => t);
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, (_m, t: string) => t);
  // Footnote references [^1].
  s = s.replace(/\[\^[^\]]+\]/g, '');
  // Autolinks <https://example.com> -> https://example.com
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_m, u: string) => u);
  // HTML tags (keep content). <br> becomes a space.
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, '');
  // HTML comments.
  s = s.replace(/<!--.*?-->/g, '');
  // Inline code: keep the content.
  s = s.replace(/`{1,3}([^`]*)`{1,3}/g, (_m, c: string) => c);
  // Strikethrough.
  s = s.replace(/~~(.+?)~~/g, (_m, t: string) => t);
  // Bold / italic with asterisks. Repeat to handle nesting.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1$2');
  }
  // Bold / italic with underscores, only at word boundaries (so snake_case survives).
  s = s.replace(/(^|[^\w])___([^_]+)___(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2');
  // Task list checkboxes.
  s = s.replace(/^\s*\[( |x|X)\]\s+/, '');
  // Restore escaped characters.
  s = s.replace(/\uE000([0-9a-f]{4})\uE001/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  // HTML entities.
  s = s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e] ?? m;
  });
  return s.replace(/[ \t]+/g, ' ').trim();
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const SETEXT_RE = /^\s{0,3}(=+|-+)\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const BLOCKQUOTE_RE = /^\s{0,3}>\s?/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s+\S+/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  return t.startsWith('|') || t.split('|').length >= 3;
}

function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => stripInline(c.replace(/\\\|/g, '|')));
}

/** True when this line begins a new block (so the previous segment must end a sentence). */
function startsBlock(line: string): boolean {
  if (line.trim() === '') return true;
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    LIST_RE.test(line) ||
    FENCE_RE.test(line) ||
    isTableRow(line) ||
    BLOCKQUOTE_RE.test(line)
  );
}

/**
 * Convert Markdown source lines into spoken segments. Each segment remembers its source line so the
 * player can highlight what is being read. Returns segments in document order.
 */
export function markdownToSegments(lines: string[], options: MarkdownOptions = {}): Segment[] {
  const codeBlocks = options.codeBlocks ?? 'announce';
  const lineOffset = options.lineOffset ?? 0;
  const firstLineOffset = options.firstLineOffset ?? 0;
  const segments: Segment[] = [];
  let inFence: string | null = null;
  let fenceStartIndex = -1;
  let fenceHadContent = false;
  let inFrontMatter = false;
  let inHtmlComment = false;

  const push = (index: number, text: string, blockEnd: boolean, sourceLine: string) => {
    if (text.trim() === '') return;
    const base = index === 0 ? firstLineOffset : 0;
    const exactIdx = sourceLine.indexOf(text);
    const exact = exactIdx >= 0 && sourceLine.trim() === text;
    segments.push({
      text,
      line: lineOffset + index,
      startChar: exact ? base + exactIdx : base,
      exact,
      blockEnd,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : undefined;
    const nextStartsBlock = next === undefined ? true : startsBlock(next);

    // YAML front matter at the very top of the file.
    if (i === 0 && raw.trim() === '---') { inFrontMatter = true; continue; }
    if (inFrontMatter) { if (raw.trim() === '---' || raw.trim() === '...') inFrontMatter = false; continue; }

    // Multi-line HTML comments.
    if (inHtmlComment) { if (raw.includes('-->')) inHtmlComment = false; continue; }
    if (raw.trimStart().startsWith('<!--') && !raw.includes('-->')) { inHtmlComment = true; continue; }

    // Fenced code blocks.
    const fence = FENCE_RE.exec(raw);
    if (inFence) {
      if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length) {
        if (codeBlocks === 'announce' && fenceHadContent) {
          segments.push({ text: 'Code block skipped.', line: lineOffset + fenceStartIndex, startChar: 0, exact: false, blockEnd: true });
        }
        inFence = null;
      } else if (codeBlocks === 'read') {
        push(i, raw.trim(), true, raw);
        fenceHadContent = true;
      } else {
        fenceHadContent = fenceHadContent || raw.trim() !== '';
      }
      continue;
    }
    if (fence) { inFence = fence[1]; fenceStartIndex = i; fenceHadContent = false; continue; }

    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (HR_RE.test(raw) || REF_DEF_RE.test(raw)) continue;
    // Setext underline directly under a paragraph line: drop it (heading text was already emitted).
    if (SETEXT_RE.test(raw) && i > 0 && lines[i - 1].trim() !== '') continue;

    // Indented code (4 spaces) that is not part of a list continuation.
    if (INDENTED_CODE_RE.test(raw) && (i === 0 || lines[i - 1].trim() === '')) {
      if (codeBlocks === 'read') push(i, trimmed, true, raw);
      else if (codeBlocks === 'announce') segments.push({ text: 'Code block skipped.', line: lineOffset + i, startChar: 0, exact: false, blockEnd: true });
      // skip following indented lines
      while (i + 1 < lines.length && (INDENTED_CODE_RE.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        if (codeBlocks === 'read' && lines[i + 1].trim() !== '') push(i + 1, lines[i + 1].trim(), true, lines[i + 1]);
        i++;
      }
      continue;
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) { push(i, stripInline(heading[2]), true, raw); continue; }

    // Tables.
    if (isTableRow(raw)) {
      if (TABLE_SEP_RE.test(raw)) continue;
      const cells = splitTableCells(raw).filter((c) => c !== '');
      if (cells.length === 0) continue;
      const isHeader = next !== undefined && TABLE_SEP_RE.test(next);
      if (isHeader) {
        push(i, `Table with columns: ${cells.join(', ')}.`, true, raw);
      } else {
        push(i, `${cells.join(', ')}.`, true, raw);
      }
      continue;
    }

    let body = raw;
    // Blockquotes (possibly nested).
    while (BLOCKQUOTE_RE.test(body)) body = body.replace(BLOCKQUOTE_RE, '');
    // List items.
    const list = LIST_RE.exec(body);
    if (list) body = list[3];

    const text = stripInline(body);
    if (text === '') continue;
    const blockEnd = nextStartsBlock || /^\s{0,3}#{1,6}\s/.test(next ?? '') || (next !== undefined && SETEXT_RE.test(next));
    push(i, text, blockEnd, raw);
  }
  return segments;
}
