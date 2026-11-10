import * as vscode from 'vscode';
import * as path from 'path';
import { markdownToSegments } from './text/markdownStripper';
import { plainTextToSegments } from './text/plainText';
import { splitSentences } from './text/sentenceSplitter';
import { Segment, Sentence } from './text/segments';
import { TtsProvider, ProviderId } from './tts/provider';
import { BenchmarkResult, KokoroProvider, ModelVariant } from './tts/kokoroProvider';
import { ProviderStatus } from './tts/provider';
import { NativeProvider } from './tts/nativeProvider';
import { PiperProvider } from './tts/piperProvider';
import { PlaybackPanel } from './player/panel';
import { Player, ReadingSession } from './player/player';
import { PdfSession } from './pdf/pdfText';
import { ClaudeFollower, FollowMode } from './follow/claudeFollower';
import { errorMessage, getLog, isCancelled, log } from './util/log';

let player: Player;
let panel: PlaybackPanel;
let statusBar: vscode.StatusBarItem;
let follower: ClaudeFollower;
const providers = new Map<ProviderId, TtsProvider>();
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  panel = new PlaybackPanel(context);
  player = new Player(panel, getProvider, path.join(context.globalStorageUri.fsPath, 'tmp'));
  follower = new ClaudeFollower(player, { sentencesForText, captureWebviewSelection });
  statusBar = vscode.window.createStatusBarItem('readAloud.status', vscode.StatusBarAlignment.Right, 50);
  statusBar.name = 'Read Aloud';
  statusBar.command = 'readAloud.pauseResume';
  context.subscriptions.push(panel, player, follower, statusBar, getLog());

  context.subscriptions.push(
    player.onDidChangeStatus((s) => {
      if (s.state === 'idle') { statusBar.hide(); return; }
      if (s.state === 'waiting') {
        statusBar.text = s.live ? '$(broadcast) Read Aloud: following Claude · waiting for the next reply' : '$(watch) Read Aloud: waiting for text';
        statusBar.tooltip = 'Click to stop.';
        statusBar.command = s.live ? 'readAloud.stopFollowing' : 'readAloud.stop';
        statusBar.show();
        return;
      }
      statusBar.command = 'readAloud.pauseResume';
      if (s.state === 'loading') {
        statusBar.text = `$(loading~spin) Read Aloud: ${s.detail || 'preparing…'}`;
        statusBar.tooltip = 'Starting the voice. Ctrl+Alt+S stops.';
        statusBar.show();
        return;
      }
      const icon = s.state === 'playing' ? '$(debug-pause)' : '$(play)';
      const stalled = s.detail && s.detail.startsWith('Waiting for speech synthesis');
      statusBar.text = `${icon} Read Aloud ${s.total ? `${Math.min(s.index + 1, s.total)}/${s.total}` : ''}${follower.active ? ' · following Claude' : ''}${stalled ? ' · $(loading~spin) synthesizing…' : ''}`;
      statusBar.tooltip = `${s.title ?? ''}\n${s.detail ?? ''}\nClick to pause / resume. Ctrl+Alt+S stops.`;
      statusBar.show();
    }),
    // Stop when the user moves to a different file. Decided from the active *tab* so custom editors
    // (Markdown preview editors, PDF viewers) count too, with a grace period because opening the
    // player panel itself shuffles the active tab.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      const uri = player.currentUri;
      if (!uri || !player.isActive) return;
      if (e.closed.some((t) => tabUri(t)?.toString() === uri.toString()) && !isUriOpenInAnyTab(uri)) { player.stop('Stopped (file closed).'); return; }
      if (!vscode.workspace.getConfiguration('readAloud').get<boolean>('stopOnEditorChange', true)) return;
      if (Date.now() - player.startedAt < 2500) return;
      const active = tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
      if (active && active.toString() !== uri.toString()) player.stop('Stopped (switched file).');
    }),
    player.onDidRequestStart(() => void vscode.commands.executeCommand('readAloud.readSelection')),
    follower.onDidChange(() => sendPanelConfig()),
    player.onSlowSynthesis((rtf) => void offerSpeedHelp(rtf)),
    panel.onMessage((msg) => {
      switch (msg.type) {
        case 'ready': sendPanelConfig(); break;
        case 'command':
          if (typeof msg.id === 'string' && msg.id.startsWith('readAloud.')) void vscode.commands.executeCommand(msg.id);
          break;
        case 'setting': {
          const allowed = new Set(['provider', 'kokoro.voice', 'kokoro.speed', 'stopOnEditorChange', 'pdf.announcePages', 'markdown.codeBlocks', 'output', 'follow.readSummaries']);
          if (allowed.has(msg.key)) void vscode.workspace.getConfiguration('readAloud').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'previewVoice':
          if (typeof msg.voice === 'string') void previewVoice(msg.voice);
          break;
        case 'seek':
          if (typeof msg.index === 'number') player.seekTo(msg.index);
          break;
        case 'restart':
          // The 'setting' message that precedes this is applied asynchronously; give it a moment.
          setTimeout(() => void player.restartCurrent(), 300);
          break;
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('readAloud')) sendPanelConfig();
      if (e.affectsConfiguration('readAloud.provider') || e.affectsConfiguration('readAloud.kokoro.model') || e.affectsConfiguration('readAloud.kokoro.modelDirectory') || e.affectsConfiguration('readAloud.piper')) {
        player.stop();
        for (const p of providers.values()) p.dispose();
        providers.clear();
      }
    }),
  );

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        if (isCancelled(e)) return;
        log(`Command ${id} failed: ${errorMessage(e)}`);
        void vscode.window.showErrorMessage(`Read Aloud: ${errorMessage(e)}`, 'Show Log').then((pick) => { if (pick) getLog().show(); });
      }
    }));

  register('readAloud.readSelection', readSelection);
  register('readAloud.readFromCursor', readFromCursor);
  register('readAloud.readFile', readFile);
  register('readAloud.readPdf', readPdf);
  register('readAloud.pauseResume', () => player.toggle());
  register('readAloud.stop', () => player.stop());
  register('readAloud.faster', () => player.changeRate(0.1));
  register('readAloud.slower', () => player.changeRate(-0.1));
  register('readAloud.showPlayer', () => panel.show(false));
  register('readAloud.selectVoice', selectVoice);
  register('readAloud.testVoice', testVoice);
  register('readAloud.readClipboard', readClipboard);
  register('readAloud.followClaude', followClaude);
  register('readAloud.benchmarkVoice', benchmarkVoice);
  register('readAloud.stopFollowing', () => { follower.stop(); player.stop('Stopped following.'); });
  register('readAloud.downloadModel', async () => {
    const kokoro = getOrCreate('kokoro') as KokoroProvider;
    const cts = new vscode.CancellationTokenSource();
    await kokoro.ensureDownloaded(cts.token);
    void vscode.window.showInformationMessage(`Read Aloud: Kokoro voice is ready in ${kokoro.modelDirectory()}.`);
  });
  log('Read Aloud activated.');
}

export function deactivate(): void {
  for (const p of providers.values()) p.dispose();
  providers.clear();
}

// ---- providers ---------------------------------------------------------------------------------

function getOrCreate(id: ProviderId): TtsProvider {
  let p = providers.get(id);
  if (!p) {
    p = id === 'kokoro' ? new KokoroProvider(extensionContext) : id === 'piper' ? new PiperProvider(extensionContext) : new NativeProvider(extensionContext);
    providers.set(id, p);
  }
  return p;
}

async function getProvider(token: vscode.CancellationToken, onStatus?: (s: ProviderStatus) => void): Promise<TtsProvider> {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const id = cfg.get<ProviderId>('provider', 'kokoro');
  const provider = getOrCreate(id);
  const sub = onStatus && provider.onStatus ? provider.onStatus(onStatus) : undefined;
  try {
    await provider.prepare(token);
    return provider;
  } catch (e) {
    if (isCancelled(e) || id === 'native' || !cfg.get<boolean>('fallbackToNative', true)) throw e;
    log(`${provider.label} unavailable (${errorMessage(e)}); falling back to the system voice.`);
    void vscode.window.showWarningMessage(`Read Aloud: ${provider.label} is unavailable (${errorMessage(e)}). Using the system voice instead.`, 'Show Log')
      .then((pick) => { if (pick) getLog().show(); });
    const native = getOrCreate('native');
    await native.prepare(token);
    return native;
  } finally {
    sub?.dispose();
  }
}

// ---- speed: benchmark and the slow-machine hint -------------------------------------------------

const SLOW_HINT_KEY = 'readAloud.slowHintDismissed';

async function offerSpeedHelp(rtf: number): Promise<void> {
  if (extensionContext.globalState.get<boolean>(SLOW_HINT_KEY)) return;
  const kokoro = providers.get('kokoro') as KokoroProvider | undefined;
  const already8 = kokoro?.variant === 'int8';
  const choice = await vscode.window.showInformationMessage(
    `Read Aloud: speech synthesis runs at ${(1 / Math.max(0.01, rtf)).toFixed(1)}× real time on this computer, so playback can pause between sentences.`,
    'Benchmark voice speed', ...(already8 ? [] : ['Try the 8-bit model']), "Don't show again",
  );
  if (choice === 'Benchmark voice speed') await vscode.commands.executeCommand('readAloud.benchmarkVoice');
  else if (choice === 'Try the 8-bit model') await benchmarkVoice('int8');
  else if (choice === "Don't show again") await extensionContext.globalState.update(SLOW_HINT_KEY, true);
}

function describe(r: BenchmarkResult): string {
  const speed = 1 / Math.max(0.01, r.rtf);
  const verdict = r.rtf < 0.6 ? 'comfortably ahead of playback' : r.rtf < 1 ? 'barely ahead of playback (expect occasional pauses)' : 'slower than playback (pauses between sentences)';
  return `${r.variant}: ${speed.toFixed(1)}× real time, ${verdict}. ${(r.synthMs / 1000).toFixed(1)} s to synthesize ${(r.audioMs / 1000).toFixed(1)} s of speech; engine start ${(r.loadMs / 1000).toFixed(1)} s.`;
}

/** Measure the current model, optionally the other one, and offer to switch to the faster. */
async function benchmarkVoice(also?: ModelVariant): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  if (cfg.get<ProviderId>('provider', 'kokoro') !== 'kokoro') {
    void vscode.window.showInformationMessage('Read Aloud: the benchmark measures the Kokoro voice. Set readAloud.provider to "kokoro" first.');
    return;
  }
  const kokoro = getOrCreate('kokoro') as KokoroProvider;
  const current = kokoro.variant;
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Read Aloud: measuring voice speed', cancellable: true },
    async (progress, token) => {
      const out: BenchmarkResult[] = [];
      progress.report({ message: `${current} model…` });
      out.push(await kokoro.benchmark(current, token, (m) => progress.report({ message: m })));
      if (also && also !== current) {
        progress.report({ message: `${also} model…` });
        out.push(await kokoro.benchmark(also, token, (m) => progress.report({ message: m })));
      }
      return out;
    },
  );
  const first = results[0];
  const other: ModelVariant = current === 'fp32' ? 'int8' : 'fp32';
  log(`Benchmark on ${first.cpu} (${first.cores} threads): ${results.map(describe).join(' | ')}`);
  if (results.length === 1) {
    const choice = await vscode.window.showInformationMessage(
      `Read Aloud speed on ${first.cpu} (${first.cores} threads). ${describe(first)}`,
      `Try the ${other} model too`, 'Show log',
    );
    if (choice === `Try the ${other} model too`) await benchmarkVoice(other);
    else if (choice === 'Show log') getLog().show();
    return;
  }
  const second = results[1];
  const faster = second.rtf < first.rtf * 0.9 ? second : first;
  const summary = `${describe(first)}\n${describe(second)}`;
  if (faster.variant !== current) {
    const choice = await vscode.window.showInformationMessage(`Read Aloud speed on ${first.cpu}. ${summary}`, `Switch to ${faster.variant} (${(first.rtf / Math.max(0.01, second.rtf)).toFixed(1)}× faster)`, 'Keep current');
    if (choice && choice.startsWith('Switch')) {
      await cfg.update('kokoro.model', faster.variant, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Read Aloud: now using the ${faster.variant} model.`);
    }
  } else {
    void vscode.window.showInformationMessage(`Read Aloud speed on ${first.cpu}. ${summary} The current model is already the faster one.`);
  }
}

/** Chunk size for synthesis units; 140 keeps the first sound after a new reply quick on modest CPUs. */
function maxSentenceLength(): number {
  return vscode.workspace.getConfiguration('readAloud').get<number>('maxSentenceLength', 140);
}

// ---- building sentences from documents ----------------------------------------------------------

function sentencesFor(doc: vscode.TextDocument, start: vscode.Position, end: vscode.Position): Sentence[] {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const lines: string[] = [];
  for (let l = start.line; l <= end.line; l++) {
    let text = doc.lineAt(l).text;
    if (l === end.line) text = text.slice(0, end.character);
    if (l === start.line) text = text.slice(start.character);
    lines.push(text);
  }
  let segments: Segment[];
  const lang = doc.languageId;
  if (lang === 'markdown' || lang === 'mdx' || lang === 'quarto') {
    segments = markdownToSegments(lines, {
      codeBlocks: cfg.get('markdown.codeBlocks', 'announce'),
      lineOffset: start.line,
      firstLineOffset: start.character,
    });
  } else {
    const prose = new Set(['plaintext', 'latex', 'tex', 'restructuredtext', 'asciidoc', 'org', 'git-commit', 'bibtex', 'log']);
    segments = plainTextToSegments(lines, { mode: prose.has(lang) ? 'paragraphs' : 'lines', lineOffset: start.line, firstLineOffset: start.character });
  }
  return splitSentences(segments, { maxLength: maxSentenceLength() });
}

function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  return undefined;
}

function isUriOpenInAnyTab(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => tabUri(t)?.toString() === uri.toString()));
}

interface Target { doc: vscode.TextDocument; editor?: vscode.TextEditor; fromCustomEditor: boolean }

/**
 * The document the user means: the active text editor, or, when the active tab is a custom editor
 * such as a Markdown preview editor, that tab's file opened as a text document (no selection then).
 */
async function targetDocument(): Promise<Target> {
  const editor = vscode.window.activeTextEditor;
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const active = tabUri(activeTab);
  const fromCustomEditor = activeTab?.input instanceof vscode.TabInputCustom;
  if (editor && (!active || active.toString() === editor.document.uri.toString())) return { doc: editor.document, editor, fromCustomEditor };
  if (active) {
    if (active.fsPath.toLowerCase().endsWith('.pdf')) throw new Error('This is a PDF: use "Read Aloud: Read PDF Aloud" instead.');
    try {
      const doc = await vscode.workspace.openTextDocument(active);
      const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
      return { doc, editor: visible, fromCustomEditor };
    } catch (e) {
      throw new Error(`Cannot read ${path.basename(active.fsPath)} as text (${errorMessage(e)}).`);
    }
  }
  if (editor) return { doc: editor.document, editor, fromCustomEditor: false };
  throw new Error('Open a text or Markdown file first.');
}

function titleFor(doc: vscode.TextDocument): string {
  return doc.isUntitled ? 'Untitled' : path.basename(doc.uri.fsPath);
}

function wholeDocument(doc: vscode.TextDocument): Sentence[] {
  return sentencesFor(doc, new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isForeignWebviewActive(): boolean {
  const input: any = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputWebview)) return false;
  return !String(input.viewType).includes('readAloud.player');
}

/**
 * Webviews (Claude's chat, Markdown preview, other extensions' panels) cannot be read directly, but
 * VS Code can copy their selection. Uses a sentinel so a stale clipboard is never mistaken for a
 * selection; the user's clipboard is restored when nothing was copied.
 */
async function captureWebviewSelection(): Promise<{ text?: string; previousClipboard: string }> {
  const clipboard = vscode.env.clipboard;
  const previousClipboard = await clipboard.readText();
  const sentinel = `\u2063read-aloud-${Date.now()}`;
  await clipboard.writeText(sentinel);
  // A toolbar click moves focus out of the webview; put it back so "copy" targets the chat.
  try { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); await delay(120); } catch { /* older builds */ }
  let text = sentinel;
  // The generic copy action is routed to the focused webview; the webview-specific id only exists in some builds.
  for (const command of ['editor.action.clipboardCopyAction', 'editor.action.webvieweditor.copy']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch (e) {
      log(`copy via ${command} unavailable: ${errorMessage(e)}`);
      continue;
    }
    for (let i = 0; i < 5; i++) {
      await delay(80);
      text = await clipboard.readText();
      if (text !== sentinel) break;
    }
    if (text !== sentinel) break;
  }
  if (text === sentinel) {
    await clipboard.writeText(previousClipboard);
    return { previousClipboard };
  }
  return { text, previousClipboard };
}

function sentencesForText(text: string): Sentence[] {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const segments = markdownToSegments(text.split(/\r?\n/), { codeBlocks: cfg.get('markdown.codeBlocks', 'announce') });
  return splitSentences(segments, { maxLength: maxSentenceLength() });
}

async function readClipboard(): Promise<void> {
  const text = await vscode.env.clipboard.readText();
  if (!text.trim()) throw new Error('The clipboard is empty. Select some text, press Ctrl+C, then run this command again.');
  await player.start({ title: 'Clipboard', sentences: sentencesForText(text) });
}

async function readWebviewSelection(): Promise<void> {
  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? 'Selection';
  const { text, previousClipboard } = await captureWebviewSelection();
  if (text && text.trim()) {
    await player.start({ title: label, sentences: sentencesForText(text) });
    return;
  }
  // The view could not be copied from. Text the user copied themselves (Ctrl+C) comes first;
  // with an empty clipboard, a Claude Code chat still has a transcript: read the latest reply.
  if (previousClipboard.trim()) {
    void vscode.window.setStatusBarMessage('Read Aloud: reading the copied text (clipboard)', 5000);
    await player.start({ title: `${label} (clipboard)`, sentences: sentencesForText(previousClipboard) });
    return;
  }
  const last = await follower.lastReply();
  if (last) {
    void vscode.window.setStatusBarMessage("Read Aloud: no selection captured, reading Claude's latest reply", 5000);
    await player.start({ title: `${label} (latest reply)`, sentences: sentencesForText(last) });
    return;
  }
  throw new Error(`Could not read the selection in "${label}". Select the text, press Ctrl+C, then run Read Aloud again, or use Follow Claude (Ctrl+Alt+L).`);
}

async function readSelection(): Promise<void> {
  if (isForeignWebviewActive()) { await readWebviewSelection(); return; }
  let target: Target;
  try {
    target = await targetDocument();
  } catch (e) {
    // No text editor anywhere (for example only a webview is open): try the clipboard route.
    if (!vscode.window.activeTextEditor && !vscode.window.tabGroups.activeTabGroup.activeTab) throw e;
    await readWebviewSelection();
    return;
  }
  const { doc, editor, fromCustomEditor } = target;
  const nonEmpty = editor ? editor.selections.filter((s) => !s.isEmpty).sort((a, b) => a.start.compareTo(b.start)) : [];
  if (!editor || (fromCustomEditor && nonEmpty.length === 0)) {
    // Preview / WYSIWYG editors have no text selection: read the whole file.
    void vscode.window.setStatusBarMessage('Read Aloud: no text selection in this editor, reading the whole file', 4000);
    await player.start({ title: titleFor(doc), sentences: wholeDocument(doc), uri: doc.uri });
    return;
  }
  if (nonEmpty.length === 0) { await readFromCursor(); return; }
  const sentences = nonEmpty.flatMap((s) => sentencesFor(doc, s.start, s.end));
  await player.start({ title: titleFor(doc), sentences, uri: doc.uri });
}

async function readFromCursor(): Promise<void> {
  const { doc, editor } = await targetDocument();
  if (!editor) { await player.start({ title: titleFor(doc), sentences: wholeDocument(doc), uri: doc.uri }); return; }
  const cursor = editor.selection.active;
  const start = new vscode.Position(cursor.line, 0);
  const sentences = sentencesFor(doc, start, doc.lineAt(doc.lineCount - 1).range.end);
  // Begin with the sentence containing the cursor, if the cursor is mid-line.
  let startIndex = 0;
  for (let i = 0; i < sentences.length; i++) {
    const r = sentences[i].range;
    if (!r) break;
    const endsBeforeCursor = r.endLine < cursor.line || (r.endLine === cursor.line && r.endChar !== null && r.endChar <= cursor.character);
    if (endsBeforeCursor) startIndex = i + 1; else break;
  }
  if (sentences.length === 0 || startIndex >= sentences.length) {
    // Cursor is at the end of the file: read it from the top instead of saying there is nothing.
    void vscode.window.setStatusBarMessage('Read Aloud: cursor is at the end of the file, reading from the top', 4000);
    await player.start({ title: titleFor(doc), sentences: wholeDocument(doc), uri: doc.uri });
    return;
  }
  await player.start({ title: titleFor(doc), sentences, uri: doc.uri, startIndex });
}

async function readFile(): Promise<void> {
  const { doc } = await targetDocument();
  await player.start({ title: titleFor(doc), sentences: wholeDocument(doc), uri: doc.uri });
}

async function testVoice(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const provider = cfg.get<ProviderId>('provider', 'kokoro');
  const voice = provider === 'kokoro' ? cfg.get<string>('kokoro.voice', 'af_heart') : cfg.get<string>('native.voice', '') || 'the system default voice';
  const text = `Hello! This is the Read Aloud extension, speaking with ${provider === 'kokoro' ? 'the Kokoro voice ' + voice.replace('_', ' ') : voice}. If you can hear this, everything is working. You can change the voice with the Select Voice command.`;
  const sentences = splitSentences(plainTextToSegments([text], { mode: 'paragraphs' }));
  await player.start({ title: 'Voice test', sentences });
}

// ---- PDF ---------------------------------------------------------------------------------------

function activePdfUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input: any = tab?.input;
  const uri: vscode.Uri | undefined = input?.uri ?? input?.modified;
  if (uri && uri.fsPath.toLowerCase().endsWith('.pdf')) return uri;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.fsPath.toLowerCase().endsWith('.pdf')) return doc.uri;
  return undefined;
}

async function readPdf(arg?: vscode.Uri): Promise<void> {
  let uri = arg instanceof vscode.Uri ? arg : activePdfUri();
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ['pdf'] }, title: 'Choose a PDF to read aloud' });
    uri = picked?.[0];
  }
  if (!uri) return;
  if (uri.scheme !== 'file') throw new Error('Only PDF files on disk can be read.');
  const file = uri.fsPath;
  const pdf = new PdfSession(extensionContext, file);
  try {
    await readPdfWith(pdf, file);
  } finally {
    pdf.dispose();
  }
}

async function readPdfWith(pdf: PdfSession, file: string): Promise<void> {
  const numPages = await pdf.pageCount();
  const input = await vscode.window.showInputBox({
    title: `Read "${path.basename(file)}" (${numPages} pages)`,
    prompt: 'Pages to read, e.g. "1-5", "3", or "all"',
    value: numPages > 1 ? `1-${numPages}` : '1',
    validateInput: (v) => (parsePageRange(v, numPages) ? undefined : `Enter a page or range between 1 and ${numPages}`),
  });
  if (input === undefined) return;
  const range = parsePageRange(input, numPages)!;
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const announce = cfg.get<boolean>('pdf.announcePages', true);

  const pages = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Read Aloud: extracting text from ${path.basename(file)}`, cancellable: true },
    (progress, token) => pdf.extract(range[0], range[1], token, (p) => progress.report({ message: `page ${p.page}` })),
  );
  const segments: Segment[] = [];
  for (const p of pages) {
    const pageSegments = plainTextToSegments(p.lines, { mode: 'paragraphs', page: p.page });
    if (pageSegments.length === 0) continue;
    if (announce) segments.push({ text: `Page ${p.page}.`, line: 0, startChar: 0, exact: false, blockEnd: true, page: p.page });
    segments.push(...pageSegments);
  }
  const sentences = splitSentences(segments, { maxLength: maxSentenceLength() });
  if (sentences.length === 0) throw new Error('No text found in the selected pages (scanned PDFs need OCR first).');
  const session: ReadingSession = { title: path.basename(file), sentences };
  await player.start(session);
}

export function parsePageRange(input: string, numPages: number): [number, number] | undefined {
  const v = input.trim().toLowerCase();
  if (v === '' || v === 'all') return [1, numPages];
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(v);
  if (!m) return undefined;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  if (a < 1 || b < a || b > numPages) return undefined;
  return [a, b];
}

// ---- follow Claude --------------------------------------------------------------------------

async function followClaude(arg?: FollowMode): Promise<void> {
  if (follower.active && arg === undefined) {
    follower.stop();
    player.stop('Stopped following.');
    return;
  }
  let mode = arg;
  if (!mode) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'From now on', description: 'Read new replies as Claude writes them', mode: 'now' as FollowMode },
        { label: 'From my selection', description: 'Start at the text selected (or copied) in Claude\'s chat, then keep following', mode: 'selection' as FollowMode },
      ],
      { title: 'Follow Claude Code replies', placeHolder: 'Where should reading start?' },
    );
    mode = pick?.mode;
  }
  if (!mode) return;
  await follower.start(mode);
}

// ---- voice picker -----------------------------------------------------------------------------

function voiceLabel(id: string): string {
  const quality = BEST_VOICES.has(id) ? ' · ★ best' : GOOD_VOICES.has(id) ? ' · good' : '';
  return `${id} · ${LANGUAGE_NAMES[id[0]] ?? id[0]} · ${id[1] === 'f' ? 'female' : 'male'}${quality}`;
}

function allKokoroVoices(): string[] {
  return extensionContext.extension.packageJSON.contributes.configuration.properties['readAloud.kokoro.voice'].enum as string[];
}

/** Push the current settings into the panel so its controls reflect them. */
function sendPanelConfig(): void {
  if (!panel.isOpen) return;
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const provider = cfg.get<string>('provider', 'kokoro');
  const voice = cfg.get<string>('kokoro.voice', 'af_heart');
  const engineName = provider === 'kokoro' ? 'Kokoro' : provider === 'piper' ? 'Piper' : 'System voice';
  panel.post({
    type: 'config',
    provider,
    voice,
    voices: allKokoroVoices().map((id) => ({ id, label: voiceLabel(id) })),
    kokoroSpeed: cfg.get<number>('kokoro.speed', 1.0),
    stopOnEditorChange: cfg.get<boolean>('stopOnEditorChange', true),
    announcePages: cfg.get<boolean>('pdf.announcePages', true),
    codeBlocks: cfg.get<string>('markdown.codeBlocks', 'announce'),
    following: follower.active,
    output: cfg.get<string>('output', 'panel'),
    readSummaries: cfg.get<boolean>('follow.readSummaries', true),
    footer: provider === 'kokoro'
      ? `${engineName} · ${cfg.get<string>('kokoro.model', 'fp32')} model · voice ${voice} · everything runs on this computer`
      : `${engineName} · everything runs on this computer`,
  });
}

/** Speak a short sample with the given voice (Kokoro) or the configured system voice. */
async function previewVoice(voice: string): Promise<void> {
  const provider = vscode.workspace.getConfiguration('readAloud').get<ProviderId>('provider', 'kokoro');
  if (provider !== 'kokoro') { await testVoice(); return; }
  const sentences = splitSentences(plainTextToSegments([voiceSample(voice)], { mode: 'paragraphs' }));
  try {
    await player.start({ title: `Voice preview: ${voice}`, sentences, voice });
  } catch (e) {
    if (!isCancelled(e)) void vscode.window.showErrorMessage(`Read Aloud: ${errorMessage(e)}`);
  }
}

const LANGUAGE_NAMES: Record<string, string> = { a: 'American English', b: 'British English', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin' };
const BEST_VOICES = new Set(['af_heart', 'af_bella']);
const GOOD_VOICES = new Set(['af_nicole', 'af_aoede', 'af_kore', 'af_sarah', 'am_fenrir', 'am_michael', 'am_puck', 'bf_emma', 'bf_isabella', 'bm_fable', 'bm_george']);

function voiceSample(id: string): string {
  const name = id.slice(3).replace(/^./, (c) => c.toUpperCase());
  return `Hi, I'm ${name}. This is how I sound when I read your documents aloud. The quick brown fox jumps over the lazy dog.`;
}

/** Voice picker that speaks a sample of the highlighted voice while you browse. */
async function selectVoice(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('readAloud');
  const provider = cfg.get<ProviderId>('provider', 'kokoro');
  if (provider !== 'kokoro') {
    const v = await vscode.window.showInputBox({ title: 'System voice name', prompt: 'Leave empty for the default voice', value: cfg.get<string>('native.voice', '') });
    if (v !== undefined) {
      await cfg.update('native.voice', v, vscode.ConfigurationTarget.Global);
      await testVoice();
    }
    return;
  }
  const current = cfg.get<string>('kokoro.voice', 'af_heart');
  const items: vscode.QuickPickItem[] = allKokoroVoices().map((id) => ({
    label: id,
    description: voiceLabel(id).slice(id.length + 3) + (id === current ? ' · current' : ''),
  }));
  const pick = vscode.window.createQuickPick();
  pick.title = 'Read Aloud: choose a voice (move through the list to hear each one)';
  pick.placeholder = 'Enter saves the highlighted voice, Escape keeps the current one';
  pick.matchOnDescription = true;
  pick.ignoreFocusOut = true;
  pick.items = items;
  pick.activeItems = items.filter((i) => i.label === current);

  let timer: NodeJS.Timeout | undefined;
  let previewed: string | undefined;
  const preview = (id: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (previewed === id) return;
      previewed = id;
      void previewVoice(id);
    }, 350);
  };

  await new Promise<void>((resolve) => {
    let accepted = false;
    pick.onDidChangeActive((active) => { if (active[0]) preview(active[0].label); });
    pick.onDidAccept(async () => {
      accepted = true;
      const chosen = pick.selectedItems[0]?.label ?? pick.activeItems[0]?.label;
      pick.hide();
      if (chosen) {
        await cfg.update('kokoro.voice', chosen, vscode.ConfigurationTarget.Global);
        void vscode.window.setStatusBarMessage(`Read Aloud voice set to ${chosen}`, 4000);
        if (previewed !== chosen) preview(chosen);
      }
    });
    pick.onDidHide(() => {
      if (timer) clearTimeout(timer);
      if (!accepted) player.stop('Voice preview cancelled.');
      pick.dispose();
      resolve();
    });
    pick.show();
  });
}
