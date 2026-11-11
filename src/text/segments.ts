export type BlockKind = 'heading' | 'bullet' | 'numbered' | 'quote' | 'table' | 'code' | 'paragraph';

/** An inline-formatted run found in the source, for display only. */
export interface Mark { text: string; kind: 'bold' | 'italic' | 'code' | 'link' }

/** Display hints carried from the source formatting (never spoken). */
export interface DisplayHints {
  block?: BlockKind;
  /** Heading level 1-6. */
  level?: number;
  /** List marker as written, e.g. "-" or "2.". */
  marker?: string;
  marks?: Mark[];
}

/** A piece of spoken text that maps back to a location in the source document. */
export interface Segment extends DisplayHints {
  /** Text to speak for this piece (already stripped of markup). */
  text: string;
  /** 0-based line in the source document (or in the PDF page). */
  line: number;
  /** Character offset in that line where the text starts. Only meaningful when `exact` is true. */
  startChar: number;
  /** True when `text` is a verbatim slice of the source line starting at `startChar`. */
  exact: boolean;
  /** Force a sentence boundary after this segment (headings, list items, table rows, paragraph ends). */
  blockEnd: boolean;
  /** 1-based PDF page number, when the source is a PDF. */
  page?: number;
}

/** Location of a sentence in the source document. `null` chars mean "line boundary". */
export interface SourceRange {
  startLine: number;
  startChar: number | null;
  endLine: number;
  endChar: number | null;
}

export interface Sentence extends DisplayHints {
  text: string;
  /** True for the first sentence of its block (the display starts a new line). */
  blockStart?: boolean;
  range?: SourceRange;
  page?: number;
}
