import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Sentence } from '../text/segments';
import { Player } from '../player/player';
import { findCandidateTranscripts, locateSelection, readReplies, ReplyBlock, slugForPath, TranscriptTail } from './transcriptTail';
import { errorMessage, log } from '../util/log';

export type FollowMode = 'now' | 'selection';

export interface FollowerDeps {
  sentencesForText(text: string): Sentence[];
  captureWebviewSelection(): Promise<{ text?: string; previousClipboard: string }>;
}

const RECENT_MS = 10 * 60 * 1000;

/** Speaks new Claude Code replies as they are appended to the session transcript. */
export class ClaudeFollower implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.changeEmitter.event;
  private tail: TranscriptTail | undefined;
  private watching = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly player: Player, private readonly deps: FollowerDeps) {
    this.subs.push(player.onDidChangeStatus((s) => {
      // The follow ends with its player session (Stop, or another read replacing it).
      if (this.watching && s.state === 'idle') this.stop();
    }));
  }

  get active(): boolean {
    return this.watching;
  }

  get transcript(): string | undefined {
    return this.tail?.file;
  }

  private get config() {
    const cfg = vscode.workspace.getConfiguration('readAloud.follow');
    const custom = cfg.get<string>('transcriptsDirectory', '').trim();
    return {
      baseDir: custom || path.join(os.homedir(), '.claude', 'projects'),
      pollIntervalMs: cfg.get<number>('pollIntervalMs', 500),
      announceStart: cfg.get<boolean>('announceStart', true),
      readSummaries: cfg.get<boolean>('readSummaries', true),
    };
  }

  async start(mode: FollowMode): Promise<void> {
    this.stop();
    const { baseDir, pollIntervalMs, announceStart, readSummaries } = this.config;
    const file = await this.pickTranscript(baseDir);
    if (!file) return;
    log(`Following Claude transcript ${file} (${mode})`);

    let sentences: Sentence[] = [];
    let startIndex = 0;
    let fromOffset: number | undefined; // undefined = current end of file
    if (mode === 'selection') {
      const { text, previousClipboard } = await this.deps.captureWebviewSelection();
      const selection = (text ?? previousClipboard).trim();
      if (!selection) throw new Error('Select the text in Claude\'s chat where reading should start (or copy it with Ctrl+C), then run Follow again.');
      const blocks = await readReplies(file, 60, readSummaries);
      const hit = locateSelection(blocks, selection);
      if (hit) {
        const block = blocks[hit.index];
        const own = this.deps.sentencesForText(block.text);
        startIndex = this.sentenceIndexAtOffset(own, block.text, hit.charOffset);
        sentences = own.concat(...blocks.slice(hit.index + 1).map((b) => this.deps.sentencesForText(b.text)));
        fromOffset = blocks[blocks.length - 1].endOffset;
        log(`Selection found in reply ${hit.index + 1}/${blocks.length}, sentence ${startIndex + 1}`);
      } else {
        void vscode.window.setStatusBarMessage('Read Aloud: selection not found in the transcript, reading it as copied', 5000);
        sentences = this.deps.sentencesForText(selection);
      }
    } else if (announceStart) {
      sentences = this.deps.sentencesForText('Following Claude. New replies will be read as they appear.');
    }

    const tail = new TranscriptTail(file, { fromOffset, pollIntervalMs, includeSummaries: readSummaries });
    this.tail = tail;
    this.watching = true;
    this.changeEmitter.fire(true);
    try {
      await this.player.start({ title: 'Claude Code', sentences, startIndex, live: true });
    } catch (e) {
      this.stop();
      throw e;
    }
    if (this.tail !== tail) return; // stopped while the voice was preparing
    tail.on('reply', (block: ReplyBlock) => {
      const s = this.deps.sentencesForText(block.text);
      if (s.length === 0) return;
      if (!this.player.enqueue(s)) { log('Player no longer live; stopping follow.'); this.stop(); }
    });
    tail.on('lost', () => { void vscode.window.showWarningMessage('Read Aloud: the Claude transcript disappeared; stopped following.'); this.stop(); this.player.stop('Transcript closed.'); });
    tail.on('error', (e) => log(`Transcript tail error: ${errorMessage(e)}`));
    await tail.start();
  }

  /** Text of the newest reply in the most recent transcript for this workspace (or any, if recent). */
  async lastReply(): Promise<string | undefined> {
    try {
      const slugs = (vscode.workspace.workspaceFolders ?? []).map((f) => slugForPath(f.uri.fsPath));
      const candidates = await findCandidateTranscripts(this.config.baseDir, slugs);
      const best = candidates.find((c) => Date.now() - c.mtime < 6 * 60 * 60 * 1000);
      if (!best) return undefined;
      const blocks = await readReplies(best.file, 1, this.config.readSummaries);
      return blocks[0]?.text;
    } catch (e) {
      log(`lastReply failed: ${errorMessage(e)}`);
      return undefined;
    }
  }

  stop(): void {
    const tail = this.tail;
    this.tail = undefined;
    tail?.stop();
    tail?.removeAllListeners();
    if (this.watching) {
      this.watching = false;
      this.changeEmitter.fire(false);
      log('Stopped following Claude.');
    }
  }

  dispose(): void {
    this.stop();
    this.subs.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }

  private sentenceIndexAtOffset(sentences: Sentence[], text: string, charOffset: number): number {
    // Sentences are stripped of markup, so walk the original text by locating each sentence's words.
    let pos = 0;
    for (let i = 0; i < sentences.length; i++) {
      const probe = sentences[i].text.slice(0, 24);
      const at = probe ? text.indexOf(probe, pos) : -1;
      const start = at >= 0 ? at : pos;
      const next = i + 1 < sentences.length ? text.indexOf(sentences[i + 1].text.slice(0, 24), start + 1) : text.length;
      const end = next >= 0 ? next : text.length;
      if (charOffset < end) return i;
      pos = end;
    }
    return Math.max(0, sentences.length - 1);
  }

  private async pickTranscript(baseDir: string): Promise<string | undefined> {
    const slugs = (vscode.workspace.workspaceFolders ?? []).map((f) => slugForPath(f.uri.fsPath));
    const candidates = await findCandidateTranscripts(baseDir, slugs);
    if (candidates.length === 0) {
      throw new Error(`No Claude Code transcripts found in ${baseDir}. Start a Claude Code chat first, or set readAloud.follow.transcriptsDirectory.`);
    }
    const now = Date.now();
    const best = candidates[0];
    if (slugs.includes(best.slug) && now - best.mtime < RECENT_MS) return best.file;
    const items = candidates.slice(0, 8).map((c) => ({
      label: `${path.basename(path.dirname(c.file))}`,
      description: `${ago(now - c.mtime)} · ${path.basename(c.file).slice(0, 8)}…`,
      detail: slugs.includes(c.slug) ? 'this workspace' : undefined,
      file: c.file,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Which Claude Code session should be followed?', placeHolder: 'Most recently active first' });
    return pick?.file;
  }
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Exposed for the simulated end-to-end test: whether a transcript directory exists. */
export function transcriptsDirectoryExists(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
