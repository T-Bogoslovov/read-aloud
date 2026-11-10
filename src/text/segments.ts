/** A piece of spoken text that maps back to a location in the source document. */
export interface Segment {
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

export interface Sentence {
  text: string;
  range?: SourceRange;
  page?: number;
}
