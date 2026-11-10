import * as vscode from 'vscode';

export type ProviderId = 'kokoro' | 'native' | 'piper';

export interface SynthesisResult {
  /** Complete WAV file bytes (any PCM format the browser can decode). */
  wav: Buffer;
  /** Duration of the audio in milliseconds, when known. */
  audioMs?: number;
  /** Wall-clock time the synthesis took, when known. */
  synthMs?: number;
}

export interface SynthesisOptions {
  /** Override the configured voice for this request (used for voice previews). */
  voice?: string;
  /** Override the configured speaking rate (0.5–2.0) for this request. */
  speed?: number;
}

export type ProviderPhase = 'downloading' | 'starting' | 'loading' | 'warming' | 'ready' | 'error';

/** What the engine is doing right now, so the UI can say so. */
export interface ProviderStatus { phase: ProviderPhase; percent?: number; detail?: string }

/** Synthesis speed: real-time factor = seconds of compute per second of audio (lower is better). */
export interface ProviderStats { rtf: number; samples: number }

export interface TtsProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Fired when the engine changes phase (download, start, load, warm-up, ready). */
  readonly onStatus?: vscode.Event<ProviderStatus>;
  /** Running synthesis-speed statistics, when the provider measures them. */
  readonly stats?: ProviderStats;
  /** One-time setup (downloads, process start). Safe to call repeatedly. */
  prepare(token: vscode.CancellationToken): Promise<void>;
  /** Synthesize one sentence. */
  synthesize(text: string, token: vscode.CancellationToken, options?: SynthesisOptions): Promise<SynthesisResult>;
  /** Drop any queued synthesis work. */
  cancelPending(): void;
  dispose(): void;
}
