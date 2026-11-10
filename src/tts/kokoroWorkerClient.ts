import { ChildProcess, fork } from 'child_process';
import { CancelledError } from '../util/log';

export type WorkerPhase = 'starting' | 'loading' | 'warming' | 'ready';

export interface WorkerAudio { pcm: Buffer; sampleRate: number; synthMs: number; audioMs: number }

interface Pending { resolve: (a: WorkerAudio) => void; reject: (e: Error) => void }

/**
 * Owns one Kokoro helper process: start-up phases, synthesis requests with timing, cancellation
 * and shutdown. The provider uses one for normal reading; the benchmark can run a second one for a
 * different model without touching the user's settings.
 */
export class KokoroWorkerClient {
  private worker: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;
  loadMs = 0;

  constructor(
    private readonly script: string,
    private readonly onPhase: (phase: WorkerPhase, detail?: string) => void,
    private readonly log: (line: string) => void,
    private readonly onExit?: (err: Error) => void,
  ) {}

  get alive(): boolean {
    return !!this.worker && !this.exited;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  start(modelPath: string, voicesPath: string, threads: number): Promise<void> {
    const t0 = Date.now();
    this.onPhase('starting');
    const worker = fork(this.script, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Structured-clone IPC: audio buffers cross the channel as bytes, not base64 JSON.
      serialization: 'advanced',
    });
    this.worker = worker;
    worker.stdout?.on('data', (d) => this.log(`[kokoro] ${String(d).trimEnd()}`));
    worker.stderr?.on('data', (d) => this.log(`[kokoro] ${String(d).trimEnd()}`));

    return new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => reject(new Error('Kokoro worker did not start within 3 minutes')), 180_000);
      worker.on('message', (msg: any) => {
        switch (msg?.type) {
          case 'phase':
            this.onPhase(msg.phase, msg.detail);
            break;
          case 'ready':
            clearTimeout(startTimer);
            this.loadMs = Date.now() - t0;
            this.log(`Kokoro ready with ${msg.voices?.length ?? 0} voices in ${this.loadMs} ms (load ${msg.loadMs} ms, warm-up ${msg.warmMs} ms).`);
            this.onPhase('ready');
            resolve();
            break;
          case 'init-error':
            clearTimeout(startTimer);
            reject(new Error(`Kokoro failed to load: ${msg.message}`));
            this.shutdown();
            break;
          case 'audio': {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            const raw = msg.pcm;
            const pcm = Buffer.isBuffer(raw) ? raw
              : raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
              : Buffer.from(String(raw), 'base64');
            p.resolve({ pcm, sampleRate: msg.sampleRate, synthMs: msg.synthMs ?? 0, audioMs: msg.audioMs ?? (pcm.length / 2 / msg.sampleRate) * 1000 });
            break;
          }
          case 'synth-error': {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            p.reject(new Error(msg.message));
            break;
          }
          case 'fatal':
            this.log(`Kokoro worker fatal error: ${msg.message}`);
            break;
        }
      });
      worker.on('exit', (code, signal) => {
        clearTimeout(startTimer);
        this.exited = true;
        this.log(`Kokoro worker exited (code ${code}, signal ${signal}).`);
        const err = new Error(`Kokoro worker exited unexpectedly (code ${code ?? signal})`);
        reject(err);
        this.failAll(err);
        this.onExit?.(err);
      });
      worker.on('error', (e) => { clearTimeout(startTimer); reject(e); });
      worker.send({ type: 'init', modelPath, voicesPath, threads });
    });
  }

  synthesize(text: string, voice: string, speed: number, onCancel?: (cb: () => void) => { dispose(): void }): Promise<WorkerAudio> {
    const worker = this.worker;
    if (!worker || this.exited) return Promise.reject(new Error('Kokoro worker is not running'));
    const id = this.nextId++;
    return new Promise<WorkerAudio>((resolve, reject) => {
      const sub = onCancel?.(() => { if (this.pending.delete(id)) reject(new CancelledError()); });
      this.pending.set(id, {
        resolve: (a) => { sub?.dispose(); resolve(a); },
        reject: (e) => { sub?.dispose(); reject(e); },
      });
      worker.send({ type: 'synth', id, text, voice, speed });
    });
  }

  cancel(): void {
    try { this.worker?.send({ type: 'cancel' }); } catch { /* exiting */ }
    this.failAll(new CancelledError());
  }

  shutdown(): void {
    const w = this.worker;
    this.worker = undefined;
    this.failAll(new CancelledError());
    if (!w || this.exited) return;
    try { w.send({ type: 'shutdown' }); } catch { /* already gone */ }
    setTimeout(() => { if (!w.killed && !this.exited) w.kill(); }, 2000);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
