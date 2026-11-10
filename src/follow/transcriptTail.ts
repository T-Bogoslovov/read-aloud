/**
 * Reads Claude Code session transcripts (~/.claude/projects/<slug>/<session>.jsonl).
 * Pure Node, no VS Code dependency, so it is unit-testable.
 *
 * Each line is one JSON object. Assistant replies arrive as `{"type":"assistant","message":{"content":[{"type":"text","text":…}]}}`
 * lines (one content block per line); tool calls and "thinking" are separate lines and ignored.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface ReplyBlock {
  uuid: string;
  text: string;
  timestamp: string;
  messageId?: string;
  /** Byte offset just after this line (where tailing can resume without re-reading it). */
  endOffset: number;
}

/** Claude Code names the project folder after the workspace path with every / \ : turned into '-'. */
export function slugForPath(p: string): string {
  return p.replace(/[\\/:]/g, '-');
}

/** Parse one transcript line; returns a reply block for assistant text, undefined for everything else. */
export function parseTranscriptLine(line: string, endOffset = 0, includeSummaries = false): ReplyBlock | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return undefined; }
  if (obj?.type !== 'assistant' || obj.isSidechain) return undefined;
  const content = obj.message?.content;
  if (!Array.isArray(content)) return undefined;
  // 'text' blocks are replies. 'thinking' blocks with visible text are the short progress
  // summaries the chat shows between tool calls (marked "· summary"); empty ones are private reasoning.
  const text = content.map((b: any) => {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text as string;
    if (includeSummaries && b?.type === 'thinking' && typeof b.thinking === 'string') return b.thinking as string;
    return '';
  }).filter(Boolean).join('\n').trim();
  if (!text) return undefined;
  return { uuid: String(obj.uuid ?? `${obj.message?.id ?? ''}:${endOffset}`), text, timestamp: String(obj.timestamp ?? ''), messageId: obj.message?.id, endOffset };
}

export interface TranscriptCandidate { file: string; mtime: number; slug: string }

/** List transcript files, workspace matches first, newest first. */
export async function findCandidateTranscripts(baseDir: string, workspaceSlugs: string[]): Promise<TranscriptCandidate[]> {
  const out: TranscriptCandidate[] = [];
  let dirs: string[];
  try { dirs = await fs.promises.readdir(baseDir); } catch { return out; }
  for (const slug of dirs) {
    const dir = path.join(baseDir, slug);
    let entries: string[];
    try { entries = await fs.promises.readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) out.push({ file, mtime: st.mtimeMs, slug });
      } catch { /* vanished */ }
    }
  }
  const matches = new Set(workspaceSlugs);
  out.sort((a, b) => {
    const am = matches.has(a.slug) ? 1 : 0;
    const bm = matches.has(b.slug) ? 1 : 0;
    return bm - am || b.mtime - a.mtime;
  });
  return out;
}

/** Read every assistant text block of a transcript (with end offsets); `last` keeps only the newest N. */
export async function readReplies(file: string, last?: number, includeSummaries = false): Promise<ReplyBlock[]> {
  const buf = await fs.promises.readFile(file);
  const blocks: ReplyBlock[] = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl < 0) nl = buf.length;
    const block = parseTranscriptLine(buf.toString('utf8', start, nl), nl + 1 <= buf.length ? nl + 1 : buf.length, includeSummaries);
    if (block) blocks.push(block);
    start = nl + 1;
  }
  return last !== undefined && blocks.length > last ? blocks.slice(-last) : blocks;
}

export interface TailOptions {
  /** Byte offset to start from (default: the current end of file). */
  fromOffset?: number;
  pollIntervalMs?: number;
  /** Also emit the visible reasoning summaries shown in the chat. */
  includeSummaries?: boolean;
}

/**
 * Polls a transcript for appended lines and emits 'reply' (ReplyBlock) for new assistant text,
 * 'lost' when the file disappears. Polling (not fs.watch) because appends on Windows are not
 * reported reliably.
 */
export class TranscriptTail extends EventEmitter {
  private offset: number;
  private pending: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | undefined;
  private reading = false;
  private readonly seen = new Set<string>();
  private readonly interval: number;
  private readonly includeSummaries: boolean;

  constructor(readonly file: string, options: TailOptions = {}) {
    super();
    this.offset = options.fromOffset ?? -1;
    this.interval = Math.max(100, options.pollIntervalMs ?? 500);
    this.includeSummaries = !!options.includeSummaries;
  }

  async start(): Promise<void> {
    if (this.offset < 0) {
      try { this.offset = (await fs.promises.stat(this.file)).size; } catch { this.offset = 0; }
    }
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One polling step; exposed for tests. */
  async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      let size: number;
      try { size = (await fs.promises.stat(this.file)).size; } catch { this.stop(); this.emit('lost'); return; }
      if (size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); } // truncated / rewritten
      if (size === this.offset) return;
      const fh = await fs.promises.open(this.file, 'r');
      try {
        const chunk = Buffer.alloc(size - this.offset);
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, this.offset);
        this.offset += bytesRead;
        this.consume(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    } catch (e) {
      this.emit('error', e);
    } finally {
      this.reading = false;
    }
  }

  private consume(chunk: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const lineEndOffsetBase = this.offset - data.length; // offset of data[0]
    let start = 0;
    for (;;) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;
      const block = parseTranscriptLine(data.toString('utf8', start, nl), lineEndOffsetBase + nl + 1, this.includeSummaries);
      start = nl + 1;
      if (!block || this.seen.has(block.uuid)) continue;
      this.seen.add(block.uuid);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
      this.emit('reply', block);
    }
    this.pending = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    data = Buffer.alloc(0);
  }
}

/** Collapse whitespace and case for fuzzy matching of copied chat text against transcript text. */
export function normalizeForMatch(s: string): string {
  return s.replace(/[*_`#>\\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Find the newest reply block containing the start of `selection` (a copied chunk of the chat).
 * Returns the block index and the character offset of the match inside the block's text, or undefined.
 */
export function locateSelection(blocks: ReplyBlock[], selection: string): { index: number; charOffset: number } | undefined {
  const needleFull = normalizeForMatch(selection);
  if (!needleFull) return undefined;
  for (const len of [60, 40, 25]) {
    const needle = needleFull.slice(0, len);
    if (needle.length < 12 && len !== 25) continue;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const hay = normalizeForMatch(blocks[i].text);
      const at = hay.indexOf(needle);
      if (at >= 0) return { index: i, charOffset: approximateOffset(blocks[i].text, at) };
    }
  }
  return undefined;
}

/** Map an offset in the normalized text back onto the original text (approximate: scales by ratio). */
function approximateOffset(original: string, normalizedOffset: number): number {
  const ratio = original.length / Math.max(1, normalizeForMatch(original).length);
  return Math.max(0, Math.min(original.length, Math.floor(normalizedOffset * ratio)));
}
