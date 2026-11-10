import * as fs from 'fs';
import * as ort from 'onnxruntime-node';
import { phonemize } from 'phonemizer';
import { readNpz, NpyArray } from './npz';
import { chunkPhonemes, langForVoice, textToPhonemes, tokenizePhonemes } from './kokoroText';
import vocabJson from './kokoroVocab.json';

const VOCAB = vocabJson as Record<string, number>;
export const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;

/** Runs the Kokoro ONNX model directly with onnxruntime-node. Lives in the worker process. */
export class KokoroEngine {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly voices: Map<string, NpyArray>,
    private readonly tokensInput: string,
  ) {}

  static async load(modelPath: string, voicesPath: string, options: { threads?: number } = {}): Promise<KokoroEngine> {
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    };
    if (options.threads && options.threads > 0) sessionOptions.intraOpNumThreads = Math.floor(options.threads);
    const session = await ort.InferenceSession.create(modelPath, sessionOptions);
    const voices = readNpz(fs.readFileSync(voicesPath));
    const tokensInput = session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens';
    return new KokoroEngine(session, voices, tokensInput);
  }

  get voiceNames(): string[] {
    return [...this.voices.keys()];
  }

  async synthesize(text: string, voice: string, speed: number): Promise<Float32Array> {
    const pack = this.voices.get(voice) ?? this.voices.get('af_heart');
    if (!pack) throw new Error(`Voice "${voice}" not found`);
    const lang = langForVoice(voice);
    const phonemes = await textToPhonemes(text, lang, phonemize);
    if (phonemes.length === 0) return new Float32Array(0);
    const chunks = chunkPhonemes(phonemes, VOCAB);
    const parts: Float32Array[] = [];
    for (const chunk of chunks) {
      const ids = tokenizePhonemes(chunk, VOCAB);
      if (ids.length === 0) continue;
      const row = Math.min(ids.length, pack.shape[0] - 1);
      const style = pack.data.slice(row * STYLE_DIM, row * STYLE_DIM + STYLE_DIM);
      const tokens = BigInt64Array.from([0n, ...ids.map((i) => BigInt(i)), 0n]);
      const feeds: Record<string, ort.Tensor> = {
        [this.tokensInput]: new ort.Tensor('int64', tokens, [1, tokens.length]),
        style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
        speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
      };
      const out = await this.session.run(feeds);
      const audio = (out.audio ?? out[this.session.outputNames[0]]).data as Float32Array;
      parts.push(trimSilence(audio));
    }
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Float32Array(total);
    let off = 0;
    for (const p of parts) { joined.set(p, off); off += p.length; }
    return joined;
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}

/** Trim leading/trailing near-silence but keep a short natural pause. */
function trimSilence(audio: Float32Array, threshold = 0.004, keepMs = 120): Float32Array {
  const keep = Math.round((SAMPLE_RATE * keepMs) / 1000);
  let start = 0;
  while (start < audio.length && Math.abs(audio[start]) < threshold) start++;
  let end = audio.length;
  while (end > start && Math.abs(audio[end - 1]) < threshold) end--;
  start = Math.max(0, start - keep);
  end = Math.min(audio.length, end + keep);
  return audio.subarray(start, end);
}
