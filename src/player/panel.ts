import * as vscode from 'vscode';
import * as crypto from 'crypto';

/** One sentence for the panel's text view, with its display formatting. */
export interface ScriptItem { text: string; block?: string; level?: number; marker?: string; blockStart?: boolean; marks?: Array<{ text: string; kind: string }> }

export type ToWebview =
  | { type: 'load'; index: number; total: number; text: string; wav: ArrayBuffer; title: string; page?: number; autoplay: boolean }
  | { type: 'preload'; index: number; total: number; text: string; wav: ArrayBuffer; page?: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop'; text?: string }
  | { type: 'rate'; rate: number }
  | { type: 'playing'; playing: boolean }
  | { type: 'script'; items: ScriptItem[] }
  | { type: 'append'; items: ScriptItem[] }
  | { type: 'status'; text: string; index?: number; total?: number; title?: string }
  | { type: 'sentence'; index: number; total: number; text: string; page?: number }
  | { type: 'config'; provider: string; voice: string; voices: Array<{ id: string; label: string }>; kokoroSpeed: number; stopOnEditorChange: boolean; announcePages: boolean; codeBlocks: string; following: boolean; output: string; readSummaries: boolean; footer: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'ended'; index: number }
  | { type: 'started'; index: number }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'skip'; delta: number }
  | { type: 'rate'; rate: number }
  | { type: 'playstate'; playing: boolean; blocked?: boolean }
  | { type: 'error'; message: string }
  | { type: 'command'; id: string }
  | { type: 'setting'; key: string; value: unknown }
  | { type: 'previewVoice'; voice: string }
  | { type: 'restart' }
  | { type: 'seek'; index: number };

/** The playback webview: hosts the <audio> element and the transport controls. */
export class PlaybackPanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly onMessageEmitter = new vscode.EventEmitter<FromWebview>();
  readonly onMessage = this.onMessageEmitter.event;
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDisposeEmitter.event;
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** Create the panel if needed. Returns once the webview script has reported ready. */
  async show(preserveFocus = true): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      await this.readyPromise;
      return;
    }
    this.readyPromise = new Promise<void>((resolve) => { this.readyResolve = resolve; });
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('readAloud.player', 'Read Aloud', { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    panel.iconPath = {
      light: vscode.Uri.joinPath(mediaRoot, 'icon-light.svg'),
      dark: vscode.Uri.joinPath(mediaRoot, 'icon-dark.svg'),
    };
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, mediaRoot);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => {
      if (msg.type === 'ready') this.readyResolve?.();
      this.onMessageEmitter.fire(msg);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.readyPromise = undefined;
      this.onDisposeEmitter.fire();
    });
    await Promise.race([this.readyPromise, new Promise<void>((r) => setTimeout(r, 5000))]);
  }

  post(msg: ToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.onMessageEmitter.dispose();
    this.onDisposeEmitter.dispose();
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; media-src data: blob:; img-src ${webview.cspSource} data:;`;
    const icon = (d: string, size = 24) => `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><path d="${d}"/></svg>`;
    const action = (cmd: string, label: string, key?: string) =>
      `<button type="button" data-command="${cmd}" title="${label}${key ? ` (${key})` : ''}"><span>${label}</span>${key ? `<small>${key}</small>` : ''}</button>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Read Aloud</title>
</head>
<body>
<main>
  <header>
    <div class="brand"><svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg><span class="title" id="title">Read Aloud</span></div>
    <span class="live" id="live" hidden>● live</span>
    <div class="counter" id="counter"></div>
    <button type="button" class="icon" id="expand" aria-expanded="false" aria-controls="script" title="Show more text">${icon('M3 6l5 5 5-5', 16)}</button>
  </header>

  <section class="now" aria-label="Now reading">
    <div class="script" id="script" tabindex="0" aria-label="Text being read; click a sentence to jump to it" hidden></div>
    <p class="sentence" id="sentence" aria-live="polite">Select text and press Play.</p>
    <div class="progress"><div id="bar"></div></div>
  </section>

  <section class="bar" aria-label="Playback">
    <div class="group">
      <button type="button" class="icon" id="prev" aria-label="Previous sentence" title="Previous sentence (Left arrow)">${icon('M6 6h2v12H6zM20 6v12L9 12z')}</button>
      <button type="button" class="icon primary" id="toggle" aria-label="Play" title="Play (Ctrl+Alt+P)">${icon('M7 4v16l13-8z')}</button>
      <button type="button" class="icon" id="stop" aria-label="Stop" title="Stop (Ctrl+Alt+S)">${icon('M5 5h14v14H5z')}</button>
      <button type="button" class="icon" id="next" aria-label="Next sentence" title="Next sentence (Right arrow)">${icon('M16 6h2v12h-2zM4 6v12l11-6z')}</button>
    </div>
    <div class="group" role="group" aria-label="Speed">
      <button type="button" class="icon" id="slower" aria-label="Slower" title="Slower (Ctrl+Alt+-)">−</button>
      <strong id="rateLabel" title="Playback speed">1.0×</strong>
      <button type="button" class="icon" id="faster" aria-label="Faster" title="Faster (Ctrl+Alt+=)">+</button>
    </div>
    <div class="group voice">
      <label class="sr" for="voice">Voice</label>
      <select id="voice"><option>Voice…</option></select>
      <button type="button" class="icon" id="preview" aria-label="Preview voice" title="Play a sample of this voice">${icon('M2 6h3l4-3v10l-4-3H2zM11 5.5a3.5 3.5 0 0 1 0 5', 16)}</button>
    </div>
  </section>

  <div class="status" id="status"></div>
  <div class="note" id="blocked" hidden role="status">
    <span><strong>Sound needs one click</strong> (once each time this panel opens). Press Space or click here.</span>
    <span class="note-actions">
      <button type="button" id="enableSound" class="primary">Enable sound</button>
      <button type="button" id="useSystemAudio" title="Play through the operating system: no clicks needed; pause restarts the sentence">Use system audio</button>
    </span>
  </div>

  <details class="settings" id="settings">
    <summary>Settings and more</summary>
    <div class="row">
      <label for="rate">Speed</label>
      <input type="range" id="rate" min="0.5" max="3" step="0.1" value="1">
    </div>
    <section class="grid2" aria-label="Voice engine">
      <div class="field">
        <label for="output">Output</label>
        <select id="output">
          <option value="panel">This panel (gapless, needs one click)</option>
          <option value="system">System audio (no clicks; pause restarts sentence)</option>
        </select>
      </div>
      <div class="field">
        <label for="engine">Engine</label>
        <select id="engine">
          <option value="kokoro">Kokoro (neural, offline)</option>
          <option value="native">System voice</option>
          <option value="piper">Piper</option>
        </select>
      </div>
      <div class="field wide">
        <label for="kspeed">Speaking rate (Kokoro) <strong id="kspeedLabel">1.0</strong></label>
        <input type="range" id="kspeed" min="0.5" max="2" step="0.1" value="1">
      </div>
    </section>
    <section class="grid3 actions" aria-label="Read">
      <button type="button" id="follow" data-command="readAloud.followClaude" title="Read Claude Code replies as they appear (Ctrl+Alt+L)"><span>Follow Claude</span><small>Ctrl+Alt+L</small></button>
      ${action('readAloud.readSelection', 'Read selection', 'Ctrl+Alt+R')}
      ${action('readAloud.readFromCursor', 'From cursor', 'Ctrl+Alt+Shift+R')}
      ${action('readAloud.readFile', 'Whole file', 'Ctrl+Alt+Shift+F')}
      ${action('readAloud.readClipboard', 'Clipboard text')}
      ${action('readAloud.readPdf', 'PDF…')}
      ${action('readAloud.testVoice', 'Test voice')}
      <button type="button" data-command="readAloud.benchmarkVoice" title="Measure synthesis speed and try the faster 8-bit model"><span>Benchmark</span></button>
    </section>
    <section class="options" id="options" aria-label="Options">
      <label class="opt"><span>Stop when I switch to another file</span><input type="checkbox" id="optStop"></label>
      <label class="opt"><span>Say the page number in PDFs</span><input type="checkbox" id="optPages"></label>
      <label class="opt"><span>Follow Claude: also read progress summaries</span><input type="checkbox" id="optSummaries"></label>
      <div class="opt">
        <label for="optCode">Code blocks in Markdown</label>
        <select id="optCode">
          <option value="announce">Announce and skip</option>
          <option value="skip">Skip silently</option>
          <option value="read">Read the code</option>
        </select>
      </div>
    </section>
    <footer id="footer"><span class="dot" aria-hidden="true"></span><span class="text">Everything runs on this computer.</span></footer>
  </details>
  <audio id="audio" preload="auto"></audio>
  <audio id="audio2" preload="auto"></audio>
</main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
