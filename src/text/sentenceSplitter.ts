import { Mark, Segment, Sentence } from './segments';

export interface SplitOptions {
  /** Sentences longer than this are split at punctuation / spaces. */
  maxLength?: number;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'eg', 'ie', 'cf', 'al', 'fig', 'no', 'nos', 'vol', 'pp', 'p',
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'est', 'approx', 'misc', 'gen', 'col', 'lt', 'sgt', 'capt', 'cmdr', 'gov', 'sen', 'rep',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'u.s', 'u.k', 'e.g', 'i.e', 'a.m', 'p.m', 'ph.d', 'b.a', 'm.a', 'b.sc', 'm.sc',
]);

const TERMINALS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", ')', ']', '}', '”', '’', '»']);

function wordBefore(text: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  return text.slice(i + 1, index);
}

function isBoundary(text: string, i: number): boolean {
  const ch = text[i];
  if (!TERMINALS.has(ch)) return false;
  // Consume runs like "?!" or "..." — only the last one can be a boundary.
  if (i + 1 < text.length && TERMINALS.has(text[i + 1])) return false;
  let j = i + 1;
  while (j < text.length && CLOSERS.has(text[j])) j++;
  if (j < text.length && !/\s/.test(text[j])) return false; // "3.14", "e.g.x", "file.txt"
  if (ch !== '.') return true;
  const word = wordBefore(text, i).replace(/^[("'[“‘]+/, '');
  if (word === '') return true;
  const lower = word.toLowerCase().replace(/\.$/, '');
  if (ABBREVIATIONS.has(lower)) return false;
  if (/^[A-Za-z]$/.test(word)) return false; // initials: "J. K. Rowling"
  if (/^(?:[A-Za-z]\.)+[A-Za-z]?$/.test(word)) return false; // "U.S.A"
  if (/https?:\/\/|www\.|@|\//.test(word)) return false;
  // Next non-space char lowercase → probably not a sentence end ("vs. the", "approx. 3").
  let k = j;
  while (k < text.length && /\s/.test(text[k])) k++;
  if (k < text.length && /[a-z]/.test(text[k])) return false;
  if (/^\d+$/.test(word) && k < text.length && /\d/.test(text[k])) return false; // "No 5. 2nd"? keep it simple
  return true;
}

/** Split a single run of text (no hard breaks) into sentence spans [start, end). */
export function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (isBoundary(text, i)) {
      let end = i + 1;
      while (end < text.length && CLOSERS.has(text[end])) end++;
      spans.push([start, end]);
      start = end;
    }
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

/** Split an over-long span at the best available punctuation or space. */
function chunkSpan(text: string, start: number, end: number, maxLength: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  while (end - s > maxLength) {
    const window = text.slice(s, s + maxLength);
    let cut = -1;
    // Prefer a clause break (keep the punctuation with the first part), else the last space.
    const punct = /[;:,—–](?=\s)/g;
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = punct.exec(window)) !== null) if (m.index > maxLength * 0.3) last = m.index + 1;
    if (last > 0) cut = last;
    else {
      const space = window.lastIndexOf(' ');
      if (space > maxLength * 0.3) cut = space;
    }
    if (cut <= 0) cut = maxLength;
    out.push([s, s + cut]);
    s += cut;
  }
  if (s < end) out.push([s, end]);
  return out;
}

/**
 * Turn segments into sentences, preserving source positions. Segments that are not block ends flow
 * together (soft line breaks); block ends force a sentence boundary.
 */
export function splitSentences(segments: Segment[], options: SplitOptions = {}): Sentence[] {
  const maxLength = options.maxLength ?? 300;
  const sentences: Sentence[] = [];

  // Build flowing text blocks. Two parallel numeric arrays map each character back to its
  // segment and offset (cheap even for multi-megabyte documents).
  let text = '';
  let originSeg: number[] = [];
  let originOff: number[] = [];
  const flush = () => {
    if (text.length === 0) return;
    const spans = sentenceSpans(text).flatMap(([a, b]) => chunkSpan(text, a, b, maxLength));
    let first = true;
    for (const [a0, b0] of spans) {
      let a = a0;
      let b = b0;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (a >= b) continue;
      const sentenceText = text.slice(a, b);
      const segA = segments[originSeg[a]];
      const segB = segments[originSeg[b - 1]];
      // Display hints: block kind from the first segment, inline marks from every segment touched.
      let marks: Mark[] | undefined;
      for (let si = originSeg[a]; si <= originSeg[b - 1]; si++) {
        for (const mk of segments[si].marks ?? []) if (sentenceText.includes(mk.text)) (marks ??= []).push(mk);
      }
      sentences.push({
        text: sentenceText,
        page: segA.page,
        block: segA.block,
        level: segA.level,
        marker: first ? segA.marker : undefined,
        blockStart: first,
        marks,
        range: {
          startLine: segA.line,
          startChar: segA.exact ? segA.startChar + originOff[a] : null,
          endLine: segB.line,
          endChar: segB.exact ? segB.startChar + originOff[b - 1] + 1 : null,
        },
      });
      first = false;
    }
    text = '';
    originSeg = [];
    originOff = [];
  };

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (text.length > 0) { text += ' '; originSeg.push(s); originOff.push(0); }
    for (let c = 0; c < seg.text.length; c++) { originSeg.push(s); originOff.push(c); }
    text += seg.text;
    if (seg.blockEnd) flush();
  }
  flush();
  return sentences;
}

/** Convenience for tests and simple callers: split a plain string into sentence strings. */
export function splitText(text: string, maxLength = 300): string[] {
  const segs: Segment[] = text.split(/\r?\n/).map((line, i) => ({ text: line.trim(), line: i, startChar: 0, exact: true, blockEnd: line.trim() === '' }))
    .filter((s) => s.text !== '');
  return splitSentences(segs, { maxLength }).map((s) => s.text);
}

/**
 * Split the first sentence of a session into a short lead-in plus the rest, so audio starts
 * sooner: synthesis time grows with text length and nothing can play until the first unit is done.
 * Returns the sentence unchanged when it is already short or has no good break point.
 */
export function splitForFastStart(sentence: Sentence, maxLead = 110, minLead = 40): Sentence[] {
  const t = sentence.text;
  if (t.length <= maxLead) return [sentence];
  const window = t.slice(0, maxLead);
  let cut = -1;
  const punct = /[,;:—–](?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = punct.exec(window)) !== null) if (m.index + 1 >= minLead) cut = m.index + 1;
  if (cut < 0) {
    const space = window.lastIndexOf(' ');
    if (space >= minLead) cut = space;
  }
  if (cut < 0) return [sentence];
  const lead = t.slice(0, cut).trim();
  const rest = t.slice(cut).trim();
  if (!lead || !rest) return [sentence];
  const r = sentence.range;
  const exactSingleLine = r && r.startLine === r.endLine && r.startChar !== null && r.endChar !== null;
  const restStart = t.length - rest.length;
  const hints = { block: sentence.block, level: sentence.level };
  const marksIn = (t2: string) => sentence.marks?.filter((mk) => t2.includes(mk.text));
  return [
    { ...hints, text: lead, page: sentence.page, marker: sentence.marker, blockStart: sentence.blockStart, marks: marksIn(lead), range: r && exactSingleLine ? { ...r, endChar: r.startChar! + lead.length } : r },
    { ...hints, text: rest, page: sentence.page, blockStart: false, marks: marksIn(rest), range: r && exactSingleLine ? { ...r, startChar: r.startChar! + restStart } : r },
  ];
}
