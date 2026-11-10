import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderStats, ProviderStatus, SynthesisOptions, SynthesisResult, TtsProvider } from './provider';
import { downloadFile, formatBytes } from './download';
import { KokoroWorkerClient } from './kokoroWorkerClient';
import { RtfTracker } from './stats';
import { pcm16ToWav } from '../util/wav';
import { CancelledError, log } from '../util/log';

export const KOKORO_FILES = {
  fp32: { name: 'kokoro-v1.0.onnx', size: 325532387 },
  int8: { name: 'kokoro-v1.0.int8.onnx', size: 92361271 },
  voices: { name: 'voices-v1.0.bin', size: 28214398 },
} as const;

export type ModelVariant = 'fp32' | 'int8';

export interface BenchmarkResult {
  variant: ModelVariant;
  loadMs: number;
  synthMs: number;
  audioMs: number;
  rtf: number;
  cpu: string;
  cores: number;
}

/** Text used by the benchmark: about 12 seconds of speech. */
export const BENCHMARK_TEXT =
  'This is the Read Aloud speed test. It measures how long your computer needs to turn one paragraph of text into speech, ' +
  'compared with how long that speech takes to play. A result below one means the voice can keep ahead of playback.';

export class KokoroProvider implements TtsProvider {
  readonly id = 'kokoro' as const;
  readonly label = 'Kokoro';
  private readonly statusEmitter = new vscode.EventEmitter<ProviderStatus>();
  readonly onStatus = this.statusEmitter.event;
  private readonly tracker = new RtfTracker();
  private client: KokoroWorkerClient | undefined;
  private readyPromise: Promise<void> | undefined;
  private loadedModelPath: string | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly verified = new Set<ModelVariant>();
  private readonly downloads = new Map<ModelVariant, Promise<void>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  get stats(): ProviderStats {
    return { rtf: this.tracker.rtf, samples: this.tracker.samples };
  }

  private get config() {
    const cfg = vscode.workspace.getConfiguration('readAloud.kokoro');
    return {
      voice: cfg.get<string>('voice', 'af_heart'),
      speed: cfg.get<number>('speed', 1.0),
      model: cfg.get<ModelVariant>('model', 'fp32'),
      baseUrl: cfg.get<string>('downloadBaseUrl', 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0').replace(/\/+$/, ''),
      modelDirectory: cfg.get<string>('modelDirectory', ''),
      keepAliveMinutes: cfg.get<number>('keepAliveMinutes', 30),
      threads: cfg.get<number>('threads', 0),
    };
  }

  get variant(): ModelVariant {
    return this.config.model;
  }

  modelDirectory(): string {
    const custom = this.config.modelDirectory.trim();
    return custom || path.join(this.context.globalStorageUri.fsPath, 'kokoro');
  }

  private filePaths(variant: ModelVariant = this.config.model) {
    const dir = this.modelDirectory();
    const modelInfo = KOKORO_FILES[variant];
    return { model: path.join(dir, modelInfo.name), voices: path.join(dir, KOKORO_FILES.voices.name), modelInfo };
  }

  /** Whether the model files for a variant are already on disk. */
  async isDownloaded(variant: ModelVariant = this.config.model): Promise<boolean> {
    const { model, voices, modelInfo } = this.filePaths(variant);
    const ok = async (p: string, size: number) => {
      try { const st = await fs.promises.stat(p); return st.size === size || size === 0; } catch { return false; }
    };
    return (await ok(model, modelInfo.size)) && (await ok(voices, KOKORO_FILES.voices.size));
  }

  /** Download model + voices with a progress notification. Concurrent callers share one download. */
  async ensureDownloaded(token: vscode.CancellationToken, variant: ModelVariant = this.config.model): Promise<void> {
    if (this.verified.has(variant)) return;
    if (await this.isDownloaded(variant)) { this.verified.add(variant); return; }
    let job = this.downloads.get(variant);
    if (!job) {
      job = this.runDownload(token, variant).finally(() => this.downloads.delete(variant));
      this.downloads.set(variant, job);
    }
    await job;
    this.verified.add(variant);
  }

  private async runDownload(token: vscode.CancellationToken, variant: ModelVariant): Promise<void> {
    const { model, voices, modelInfo } = this.filePaths(variant);
    const { baseUrl } = this.config;
    const jobs: Array<{ url: string; dest: string; size: number; label: string }> = [];
    if (!fs.existsSync(model)) jobs.push({ url: `${baseUrl}/${modelInfo.name}`, dest: model, size: modelInfo.size, label: `voice model (${formatBytes(modelInfo.size)})` });
    if (!fs.existsSync(voices)) jobs.push({ url: `${baseUrl}/${KOKORO_FILES.voices.name}`, dest: voices, size: KOKORO_FILES.voices.size, label: `voice styles (${formatBytes(KOKORO_FILES.voices.size)})` });
    const totalBytes = jobs.reduce((n, j) => n + j.size, 0);
    log(`Downloading Kokoro files to ${this.modelDirectory()}: ${jobs.map((j) => j.url).join(', ')}`);
    this.statusEmitter.fire({ phase: 'downloading', percent: 0, detail: `Downloading voice model (${formatBytes(totalBytes)})` });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Read Aloud: downloading Kokoro voice (one time)', cancellable: true },
      async (progress, progressToken) => {
        const controller = new AbortController();
        const subs = [token, progressToken].map((t) => t.onCancellationRequested(() => controller.abort()));
        try {
          let doneBytes = 0;
          let lastPercent = 0;
          for (const job of jobs) {
            progress.report({ message: `${job.label}…` });
            await downloadFile(job.url, job.dest, ({ loaded }) => {
              const percent = Math.floor(((doneBytes + loaded) / totalBytes) * 100);
              if (percent > lastPercent) {
                progress.report({ increment: percent - lastPercent, message: `${job.label} ${percent}%` });
                this.statusEmitter.fire({ phase: 'downloading', percent, detail: `Downloading voice model ${percent}%` });
                lastPercent = percent;
              }
            }, controller.signal, job.size);
            doneBytes += job.size;
          }
        } finally {
          subs.forEach((s) => s.dispose());
        }
      },
    );
    log('Kokoro download complete.');
  }

  async prepare(token: vscode.CancellationToken): Promise<void> {
    await this.ensureDownloaded(token);
    const { model, voices } = this.filePaths();
    if (this.client && this.loadedModelPath !== model) this.shutdownWorker();
    if (!this.readyPromise) {
      const client = this.newClient();
      this.client = client;
      this.loadedModelPath = model;
      this.tracker.reset();
      log(`Starting Kokoro worker (model ${path.basename(model)}, threads ${this.config.threads || 'auto'})`);
      this.readyPromise = client.start(model, voices, this.config.threads);
    }
    await this.readyPromise;
    this.touch();
  }

  private newClient(onExit?: (e: Error) => void): KokoroWorkerClient {
    const script = this.context.asAbsolutePath(path.join('dist', 'kokoroWorker.js'));
    const sizeLabel = formatBytes(this.filePaths().modelInfo.size);
    return new KokoroWorkerClient(
      script,
      (phase) => {
        const detail = phase === 'starting' ? 'Starting voice engine…'
          : phase === 'loading' ? `Loading voice model (${sizeLabel})…`
          : phase === 'warming' ? 'Warming up the voice…'
          : 'Voice ready';
        this.statusEmitter.fire({ phase, detail });
      },
      log,
      (err) => {
        if (this.client && !this.client.alive) { this.client = undefined; this.readyPromise = undefined; }
        this.statusEmitter.fire({ phase: 'error', detail: err.message });
        onExit?.(err);
      },
    );
  }

  async synthesize(text: string, token: vscode.CancellationToken, options: SynthesisOptions = {}): Promise<SynthesisResult> {
    await this.prepare(token);
    const client = this.client;
    if (!client) throw new Error('Kokoro worker is not running');
    this.touch();
    if (token.isCancellationRequested) throw new CancelledError();
    const audio = await client.synthesize(text, options.voice ?? this.config.voice, options.speed ?? this.config.speed, (cb) => token.onCancellationRequested(cb));
    this.tracker.add(audio.synthMs, audio.audioMs);
    return { wav: pcm16ToWav(audio.pcm, audio.sampleRate), audioMs: audio.audioMs, synthMs: audio.synthMs };
  }

  /**
   * Measure synthesis speed for a model variant. Uses the running engine when it already has that
   * model loaded; otherwise starts (and afterwards stops) a separate helper so the user's setting
   * and the current session are untouched.
   */
  async benchmark(variant: ModelVariant, token: vscode.CancellationToken, report: (message: string) => void): Promise<BenchmarkResult> {
    await this.ensureDownloaded(token, variant);
    const { model, voices } = this.filePaths(variant);
    const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown CPU';
    const cores = os.cpus().length;
    let client: KokoroWorkerClient;
    let temporary = false;
    let loadMs: number;
    if (this.client?.alive && this.loadedModelPath === model) {
      await this.prepare(token);
      client = this.client;
      loadMs = client.loadMs;
    } else {
      temporary = true;
      report(`Loading ${variant} model…`);
      client = new KokoroWorkerClient(this.context.asAbsolutePath(path.join('dist', 'kokoroWorker.js')), (phase) => report(`${variant}: ${phase}…`), log);
      await client.start(model, voices, this.config.threads);
      loadMs = client.loadMs;
    }
    try {
      report(`Synthesizing test paragraph with ${variant}…`);
      // One warm run for the running engine too, so both variants are measured the same way.
      await client.synthesize('Warm up.', 'af_heart', 1.0, (cb) => token.onCancellationRequested(cb));
      const audio = await client.synthesize(BENCHMARK_TEXT, 'af_heart', 1.0, (cb) => token.onCancellationRequested(cb));
      const rtf = audio.synthMs / Math.max(1, audio.audioMs);
      log(`Benchmark ${variant}: load ${loadMs} ms, synth ${audio.synthMs} ms for ${Math.round(audio.audioMs)} ms audio, RTF ${rtf.toFixed(2)} on ${cpu} (${cores} threads)`);
      return { variant, loadMs, synthMs: audio.synthMs, audioMs: audio.audioMs, rtf, cpu, cores };
    } finally {
      if (temporary) client.shutdown();
    }
  }

  cancelPending(): void {
    this.client?.cancel();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = this.config.keepAliveMinutes;
    if (!(minutes > 0)) return; // 0 = keep the worker alive until VS Code closes
    this.idleTimer = setTimeout(() => {
      if ((this.client?.pendingCount ?? 0) === 0) { log(`Kokoro worker idle for ${minutes} min, shutting down to free memory.`); this.shutdownWorker(); }
    }, minutes * 60 * 1000);
  }

  private shutdownWorker(): void {
    const c = this.client;
    this.client = undefined;
    this.readyPromise = undefined;
    c?.shutdown();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.shutdownWorker();
    this.statusEmitter.dispose();
  }
}
