import * as vscode from 'vscode';
import { Sentence } from '../text/segments';
import { splitForFastStart } from '../text/sentenceSplitter';
import { ProviderStatus, SynthesisResult, TtsProvider } from '../tts/provider';
import { BufferItem, bufferedSeconds, countToKeepInFlight } from './buffering';
import { AudioSink, SinkMeta, SystemSink } from './systemAudio';
import { PlaybackPanel, ScriptItem } from './panel';
import { CancelledError, errorMessage, isCancelled, log } from '../util/log';

export interface ReadingSession {
  title: string;
  sentences: Sentence[];
  /** Document to highlight while reading (absent for PDFs). */
  uri?: vscode.Uri;
  startIndex?: number;
  /** Voice override for this session (voice previews). */
  voice?: string;
  /** Live sessions grow over time (enqueue); reaching the end waits instead of finishing. */
  live?: boolean;
}

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'waiting';

export interface PlayerStatus { state: PlayerState; index: number; total: number; title?: string; detail?: string; live?: boolean }

/** WAV files at or below this size carry no audible audio (header + 50 ms of silence). */
const SILENT_WAV_BYTES = 44 + 2400;

function toScriptItem(s: Sentence): ScriptItem {
  return { text: s.text, block: s.block, level: s.level, marker: s.marker, blockStart: s.blockStart, marks: s.marks };
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Plays through the webview's <audio> elements (needs one user gesture per panel instance). */
class PanelSink implements AudioSink {
  readonly appliesRate = true;
  constructor(private readonly panel: PlaybackPanel) {}
  load(meta: SinkMeta, wav: Buffer, autoplay: boolean): void {
    this.panel.post({ type: 'load', index: meta.index, total: meta.total, text: meta.text, wav: toArrayBuffer(wav), title: meta.title, page: meta.page, autoplay });
  }
  preload(meta: SinkMeta, wav: Buffer): void {
    this.panel.post({ type: 'preload', index: meta.index, total: meta.total, text: meta.text, page: meta.page, wav: toArrayBuffer(wav) });
  }
  pause(): void { this.panel.post({ type: 'pause' }); }
  resume(): void { this.panel.post({ type: 'resume' }); }
  stop(): void { /* the panel's 'stop' message is posted by the player */ }
  setRate(rate: number): void { this.panel.post({ type: 'rate', rate }); }
  dispose(): void { /* nothing to release */ }
}

export type OutputMode = 'panel' | 'system';

/**
 * Drives a reading session: synthesizes sentences ahead of playback, hands audio to the webview
 * (the next sentence is preloaded so the webview can switch without a round trip), highlights
 * the current sentence in the editor and reacts to transport commands.
 */
export class Player implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<PlayerStatus>();
  readonly onDidChangeStatus = this.stateEmitter.event;
  private readonly requestStartEmitter = new vscode.EventEmitter<void>();
  /** Fired when the user presses Play in the panel while nothing is loaded. */
  readonly onDidRequestStart = this.requestStartEmitter.event;
  /** Time the current session started (ms since epoch); 0 when idle. */
  startedAt = 0;
  private state: PlayerState = 'idle';
  private session: ReadingSession | undefined;
  private provider: TtsProvider | undefined;
  private index = 0;
  private generation = 0;
  private cache = new Map<number, Promise<SynthesisResult>>();
  /** Audio length of synthesized sentences, by index (for buffer accounting). */
  private ready = new Map<number, number>();
  private cts: vscode.CancellationTokenSource | undefined;
  private providerSub: vscode.Disposable | undefined;
  private sink: AudioSink;
  private output: OutputMode = 'panel';
  private detail = '';
  private stallTimer: NodeJS.Timeout | undefined;
  private slowHintShown = false;
  private readonly slowEmitter = new vscode.EventEmitter<number>();
  /** Fired once per session when synthesis is measured to be slower than playback (argument: RTF). */
  readonly onSlowSynthesis = this.slowEmitter.event;
  private rate: number;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: PlaybackPanel,
    private readonly getProvider: (token: vscode.CancellationToken, onStatus?: (s: ProviderStatus) => void) => Promise<TtsProvider>,
    private readonly tmpDir: string,
  ) {
    this.rate = vscode.workspace.getConfiguration('readAloud').get<number>('playbackRate', 1.0);
    this.sink = new PanelSink(panel);
    this.decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderRadius: '2px',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.disposables.push(
      panel.onMessage((msg) => {
        switch (msg.type) {
          case 'ready': this.panel.post({ type: 'rate', rate: this.rate }); break;
          case 'ended': this.onEnded(msg.index); break;
          case 'started': this.onStarted(msg.index); break;
          case 'toggle': if (this.state === 'idle') this.requestStartEmitter.fire(); else this.toggle(); break;
          case 'stop': this.stop(); break;
          case 'skip': this.skip(msg.delta); break;
          case 'rate': this.rate = msg.rate; break;
          case 'playstate':
            if (this.state === 'playing' || this.state === 'paused') this.setState(msg.playing ? 'playing' : 'paused');
            if (msg.blocked) {
              // Chromium needs one gesture inside the panel; bring it up with focus so a keypress lands there.
              this.setDetail('Sound needs one click: press Space or click in the Read Aloud panel (or switch Output to System audio).');
              void this.panel.show(false);
            }
            break;
          case 'restart': void this.restartCurrent(); break;
          case 'error':
            log(`Webview playback error: ${msg.message}`);
            void vscode.window.showErrorMessage(`Read Aloud: ${msg.message}`);
            this.onEnded(this.index);
            break;
        }
      }),
      panel.onDidDispose(() => this.stop('Player closed.')),
    );
  }

  get status(): PlayerStatus {
    return { state: this.state, index: this.index, total: this.session?.sentences.length ?? 0, title: this.session?.title, detail: this.detail, live: this.session?.live };
  }

  get currentUri(): vscode.Uri | undefined {
    return this.session?.uri;
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  async start(session: ReadingSession): Promise<void> {
    this.stop();
    if (session.sentences.length === 0 && !session.live) {
      void vscode.window.showInformationMessage('Read Aloud: nothing to read.');
      return;
    }
    const generation = ++this.generation;
    const sentences = [...session.sentences];
    const startIndex = Math.min(Math.max(0, session.startIndex ?? 0), Math.max(0, sentences.length - 1));
    // A short lead-in lets audio start sooner: nothing plays until the first unit is synthesized.
    if (sentences.length > 0) sentences.splice(startIndex, 1, ...splitForFastStart(sentences[startIndex]));
    this.session = { ...session, sentences };
    this.index = startIndex;
    this.startedAt = Date.now();
    this.cache = new Map();
    this.ready = new Map();
    this.cts = new vscode.CancellationTokenSource();
    this.slowHintShown = false;
    this.selectSink();
    this.setState('loading');
    this.setDetail('Preparing voice…');
    await this.panel.show(true);
    if (generation !== this.generation) return;
    this.panel.post({ type: 'script', items: sentences.map(toScriptItem) });
    this.panel.post({ type: 'status', text: this.detail, title: session.title, index: this.index, total: sentences.length });
    if (sentences.length > 0) {
      this.panel.post({ type: 'sentence', index: this.index, total: sentences.length, text: sentences[this.index].text, page: sentences[this.index].page });
    }
    if (!(await this.ensureProvider(generation))) return;
    if (sentences.length === 0) {
      this.enterWaiting();
      return;
    }
    this.setDetail('Synthesizing the first sentence…');
    this.schedule(generation);
    await this.playCurrent(generation);
  }

  /** Append sentences to a live session. Returns false when no live session is active. */
  enqueue(sentences: Sentence[]): boolean {
    const session = this.session;
    if (!session || !session.live || this.state === 'idle' || sentences.length === 0) return false;
    const firstNew = session.sentences.length;
    session.sentences.push(...sentences);
    this.panel.post({ type: 'append', items: sentences.map(toScriptItem) });
    const generation = this.generation;
    if (this.state === 'waiting') {
      this.index = firstNew;
      this.setDetail('Reply received, synthesizing…');
      this.schedule(generation);
      void this.playCurrent(generation);
    } else {
      // Playing or paused: the preload/schedule logic picks the new sentences up at the boundary.
      this.schedule(generation);
      if (this.index + 1 === firstNew) void this.preloadNext(generation);
    }
    return true;
  }

  private async ensureProvider(generation: number): Promise<boolean> {
    const token = this.cts?.token;
    if (!token) return false;
    try {
      this.provider = await this.getProvider(token, (status) => this.onProviderStatus(status, generation));
    } catch (e) {
      if (generation === this.generation) this.stop(isCancelled(e) ? 'Cancelled.' : 'Voice unavailable.');
      if (!isCancelled(e)) throw e;
      return false;
    }
    if (this.provider.onStatus) {
      this.providerSub?.dispose();
      this.providerSub = this.provider.onStatus((status) => this.onProviderStatus(status, this.generation));
    }
    return generation === this.generation;
  }

  private onProviderStatus(status: ProviderStatus, generation: number): void {
    if (generation !== this.generation || this.state === 'idle') return;
    if (status.phase === 'ready') return; // the next buffer/synthesis message replaces it
    if (status.detail) this.setDetail(status.detail);
  }

  /** Show what is happening in the panel status line and the status bar. */
  private setDetail(text: string): void {
    this.detail = text;
    this.panel.post({ type: 'status', text });
    if (this.state !== 'idle') this.stateEmitter.fire(this.status); // never report "idle" with a detail: listeners treat idle as "session over"
  }

  /** Pick the output (panel or system) from settings; recreate the system sink if needed. */
  private selectSink(): void {
    const cfg = vscode.workspace.getConfiguration('readAloud');
    const wanted = cfg.get<OutputMode>('output', 'panel');
    if (wanted === this.output && (wanted === 'panel' || this.sink instanceof SystemSink)) return;
    this.sink.dispose();
    this.output = wanted;
    if (wanted === 'system') {
      const sink = new SystemSink(this.tmpDir, {
        onEnded: (i) => this.onEnded(i),
        onPlaystate: (playing) => {
          this.panel.post({ type: 'playing', playing });
          if (this.state === 'playing' || this.state === 'paused') this.setState(playing ? 'playing' : 'paused');
        },
        onError: (message) => {
          log(`System audio failed: ${message}`);
          void vscode.window.showWarningMessage(`Read Aloud: system audio failed (${message}). Switching back to panel output for this session.`);
          this.sink.dispose();
          this.sink = new PanelSink(this.panel);
          this.output = 'panel';
          this.cache.clear();
          this.ready.clear();
          const g = this.generation;
          this.schedule(g);
          void this.playCurrent(g);
        },
      }, log, cfg.get<string>('systemAudio.command', ''));
      this.sink = sink;
      log(`System audio output: ${sink.describe()}`);
    } else {
      this.sink = new PanelSink(this.panel);
    }
  }

  /** Synthesis speed: in system mode the playback-rate slider is applied here (upcoming sentences). */
  private synthesisSpeed(): number | undefined {
    if (this.sink.appliesRate) return undefined;
    const base = vscode.workspace.getConfiguration('readAloud.kokoro').get<number>('speed', 1.0);
    return Math.max(0.5, Math.min(2.0, base * this.rate));
  }

  /** Re-run the current session from the current sentence (used when the output changes). */
  async restartCurrent(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const index = Math.min(this.index, Math.max(0, session.sentences.length - 1));
    const live = session.live;
    const sentences = session.sentences.slice();
    await this.start({ ...session, sentences, startIndex: index, live });
  }

  private enterWaiting(): void {
    this.clearStall();
    this.setDetail(this.session?.live ? 'Following Claude · waiting for the next reply' : 'Waiting for new text…');
    this.setState('waiting');
  }

  private clearStall(): void {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  /** Called while playCurrent waits for audio: after 1.5 s, explain the wait and keep a ticking counter. */
  private startStall(index: number): void {
    this.clearStall();
    const started = Date.now();
    this.stallTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (secs < 2) return;
      const rtf = this.provider?.stats?.rtf ?? 0;
      const why = rtf > 0.9 ? ' Your computer synthesizes slower than real time; run "Read Aloud: Benchmark Voice Speed" to try the faster 8-bit model.' : '';
      this.setDetail(`Waiting for speech synthesis of sentence ${index + 1}… ${secs}s.${why}`);
    }, 1000);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.sink.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.sink.resume();
    this.setState('playing');
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  skip(delta: number): void {
    if (!this.session || this.state === 'idle' || this.state === 'loading') return;
    const next = this.index + delta;
    if (next < 0 || next >= this.session.sentences.length) return;
    this.index = next;
    const generation = ++this.generation; // invalidate any in-flight load of the previous sentence
    this.schedule(generation);
    void this.playCurrent(generation);
  }

  /** Jump to a sentence (clicked in the panel's text view). */
  seekTo(index: number): void {
    if (!this.session) return;
    if (this.state === 'waiting' && index >= 0 && index < this.session.sentences.length) {
      this.index = index;
      const g = ++this.generation;
      this.schedule(g);
      void this.playCurrent(g);
      return;
    }
    this.skip(index - this.index);
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(3, Math.round(rate * 10) / 10));
    this.panel.post({ type: 'rate', rate: this.rate });
    this.sink.setRate(this.rate);
    void vscode.window.setStatusBarMessage(this.sink.appliesRate ? `Read Aloud speed ${this.rate.toFixed(1)}×` : `Read Aloud speed ${this.rate.toFixed(1)}× (applies to upcoming sentences)`, 2500);
  }

  changeRate(delta: number): void {
    this.setRate(this.rate + delta);
  }

  stop(statusText = 'Stopped.'): void {
    if (this.state === 'idle' && !this.session) return;
    this.generation++;
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = undefined;
    this.provider?.cancelPending();
    this.sink.stop();
    this.clearStall();
    this.cache.clear();
    this.ready.clear();
    this.detail = '';
    this.session = undefined;
    this.startedAt = 0;
    this.clearHighlight();
    if (this.panel.isOpen) this.panel.post({ type: 'stop', text: statusText });
    this.setState('idle');
  }

  dispose(): void {
    this.stop();
    this.sink.dispose();
    this.providerSub?.dispose();
    this.slowEmitter.dispose();
    this.decoration.dispose();
    this.stateEmitter.dispose();
    this.requestStartEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- internals -------------------------------------------------------------------------

  private setState(state: PlayerState): void {
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'readAloud.active', state !== 'idle');
    this.stateEmitter.fire(this.status);
  }

  /** Target seconds of audio to keep synthesized ahead of playback. */
  private bufferTargetSeconds(): number {
    const cfg = vscode.workspace.getConfiguration('readAloud');
    let target = Math.max(5, Math.min(120, cfg.get<number>('bufferSeconds', 40)));
    const rtf = this.provider?.stats?.rtf ?? 0;
    if (rtf > 0.8) target *= 2; // slow machine: work further ahead so playback is less likely to stall
    return target;
  }

  private maxInFlight(): number {
    return Math.max(2, Math.min(16, vscode.workspace.getConfiguration('readAloud').get<number>('prefetchSentences', 8)));
  }

  private bufferItems(from: number): BufferItem[] {
    const session = this.session;
    if (!session) return [];
    const items: BufferItem[] = [];
    for (let i = from; i < session.sentences.length; i++) items.push({ audioMs: this.ready.get(i), textLength: session.sentences[i].text.length });
    return items;
  }

  /** Queue synthesis for the current sentence and enough following ones to cover the buffer target. */
  private schedule(generation: number): void {
    const session = this.session;
    const provider = this.provider;
    const token = this.cts?.token;
    if (!session || !provider || !token || generation !== this.generation) return;
    const want = countToKeepInFlight(this.bufferItems(this.index), this.bufferTargetSeconds(), this.maxInFlight());
    const end = Math.min(session.sentences.length, this.index + want);
    for (let i = this.index; i < end; i++) {
      if (this.cache.has(i)) continue;
      const p = provider.synthesize(session.sentences[i].text, token, { voice: session.voice, speed: this.synthesisSpeed() });
      p.then((r) => {
        if (generation !== this.generation) return;
        this.ready.set(i, r.audioMs ?? Math.max(0, (r.wav.length - 44) / 48));
        this.checkSlow();
        this.postBufferStatus();
        this.schedule(generation); // measured lengths may call for more
      }, () => undefined); // errors are handled where the result is awaited
      this.cache.set(i, p);
    }
    // Drop audio we have already played to keep memory small.
    for (const key of [...this.cache.keys()]) if (key < this.index - 1) { this.cache.delete(key); this.ready.delete(key); }
  }

  /** "Buffered 14 s · synthesizing 3 of 48" while playing. */
  private postBufferStatus(): void {
    const session = this.session;
    if (!session || this.state !== 'playing') return;
    const ahead = this.bufferItems(this.index + 1);
    const secs = Math.round(bufferedSeconds(ahead));
    let pending = 0;
    for (let i = this.index + 1; i < session.sentences.length; i++) if (this.cache.has(i) && !this.ready.has(i)) pending++;
    const rtf = this.provider?.stats;
    const speed = rtf && rtf.samples >= 3 ? ` · speed ${(1 / Math.max(0.01, rtf.rtf)).toFixed(1)}× real time` : '';
    this.setDetail(`Buffered ${secs} s ahead${pending ? ` · synthesizing ${pending} more` : ''}${speed}`);
  }

  private checkSlow(): void {
    const stats = this.provider?.stats;
    if (!stats || this.slowHintShown || stats.samples < 5 || stats.rtf <= 0.9) return;
    this.slowHintShown = true;
    this.slowEmitter.fire(stats.rtf);
  }

  /** Load and play the sentence at `this.index` (host-driven path: start, skip, or no preload available). */
  private async playCurrent(generation: number): Promise<void> {
    const session = this.session;
    if (!session || generation !== this.generation) return;
    const i = this.index;
    const sentence = session.sentences[i];
    this.panel.post({ type: 'sentence', index: i, total: session.sentences.length, text: sentence.text, page: sentence.page });
    this.highlight(sentence);
    let result: SynthesisResult;
    try {
      const pending = this.cache.get(i) ?? this.provider!.synthesize(sentence.text, this.cts!.token, { voice: session.voice, speed: this.synthesisSpeed() });
      this.cache.set(i, pending);
      if (!this.ready.has(i)) this.startStall(i);
      result = await pending;
    } catch (e) {
      this.clearStall();
      if (generation !== this.generation || isCancelled(e) || e instanceof CancelledError) return;
      log(`Synthesis failed for sentence ${i}: ${errorMessage(e)}`);
      void vscode.window.showErrorMessage(`Read Aloud: ${errorMessage(e)}`);
      this.stop('Error.');
      return;
    }
    this.clearStall();
    if (generation !== this.generation) return;
    this.ready.set(i, result.audioMs ?? Math.max(0, (result.wav.length - 44) / 48));
    if (result.wav.length <= SILENT_WAV_BYTES) {
      // Nothing audible (symbols only) — move on.
      this.onEnded(i);
      return;
    }
    this.sink.load({ index: i, total: session.sentences.length, text: sentence.text, title: session.title, page: sentence.page }, result.wav, true);
    this.setState('playing');
    this.schedule(generation);
    this.postBufferStatus();
    void this.preloadNext(generation);
  }

  /** Hand the next sentence's audio to the webview as soon as it exists, so it can start it gaplessly. */
  private async preloadNext(generation: number): Promise<void> {
    const session = this.session;
    if (!session || generation !== this.generation) return;
    const current = this.index;
    const next = current + 1;
    if (next >= session.sentences.length) return;
    const pending = this.cache.get(next);
    if (!pending) return;
    let result: SynthesisResult;
    try {
      result = await pending;
    } catch {
      return; // the host-driven path will surface the error when it reaches this sentence
    }
    if (generation !== this.generation || this.index !== current) return;
    if (result.wav.length <= SILENT_WAV_BYTES) return;
    const sentence = session.sentences[next];
    this.sink.preload({ index: next, total: session.sentences.length, text: sentence.text, title: session.title, page: sentence.page }, result.wav);
  }

  /** The webview switched to a preloaded sentence on its own. */
  private onStarted(index: number): void {
    const session = this.session;
    if (!session || this.state === 'idle' || index !== this.index + 1 || index >= session.sentences.length) return;
    this.index = index;
    this.highlight(session.sentences[index]);
    this.setState('playing');
    const generation = this.generation;
    this.schedule(generation);
    this.postBufferStatus();
    void this.preloadNext(generation);
  }

  private onEnded(index: number): void {
    if (!this.session || index !== this.index || this.state === 'idle') return;
    if (this.index + 1 >= this.session.sentences.length) {
      if (this.session.live) { this.index++; this.enterWaiting(); return; }
      this.stop('Finished.');
      return;
    }
    this.index++;
    const generation = this.generation;
    this.schedule(generation);
    void this.playCurrent(generation);
  }

  private highlight(sentence: Sentence): void {
    const uri = this.session?.uri;
    if (!uri || !sentence.range) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) continue;
      const doc = editor.document;
      const r = sentence.range;
      if (r.startLine >= doc.lineCount) continue;
      const endLine = Math.min(r.endLine, doc.lineCount - 1);
      const start = new vscode.Position(r.startLine, r.startChar ?? 0);
      const end = new vscode.Position(endLine, r.endChar ?? doc.lineAt(endLine).range.end.character);
      const range = doc.validateRange(new vscode.Range(start, end));
      editor.setDecorations(this.decoration, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private clearHighlight(): void {
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, []);
  }
}
