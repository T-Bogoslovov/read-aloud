/**
 * Child process that hosts the Kokoro model so synthesis never blocks the extension host.
 * The parent forks it with `serialization: 'advanced'`, so audio travels as a raw Buffer.
 * Protocol (IPC messages):
 *   -> { type: 'init', modelPath, voicesPath, threads }  <- { type: 'phase', phase } … { type: 'ready', voices, loadMs, warmMs } | { type: 'init-error', message }
 *   -> { type: 'synth', id, text, voice, speed }         <- { type: 'audio', id, sampleRate, pcm: Buffer, synthMs, audioMs } | { type: 'synth-error', id, message }
 *   -> { type: 'cancel' }                                 drops queued requests
 *   -> { type: 'shutdown' }
 */
import { KokoroEngine, SAMPLE_RATE } from '../tts/kokoroEngine';
import { float32ToPcm16 } from '../util/wav';

interface SynthRequest { id: number; text: string; voice: string; speed: number }

let engine: KokoroEngine | undefined;
const queue: SynthRequest[] = [];
let busy = false;

function send(msg: unknown): void {
  if (process.send) process.send(msg);
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length > 0) {
    const req = queue.shift()!;
    try {
      if (!engine) throw new Error('Engine not initialized');
      const t0 = Date.now();
      const audio = await engine.synthesize(req.text, req.voice, req.speed);
      const synthMs = Date.now() - t0;
      send({ type: 'audio', id: req.id, sampleRate: SAMPLE_RATE, pcm: float32ToPcm16(audio), synthMs, audioMs: (audio.length / SAMPLE_RATE) * 1000 });
    } catch (e) {
      send({ type: 'synth-error', id: req.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  busy = false;
}

process.on('message', async (msg: any) => {
  switch (msg?.type) {
    case 'init':
      try {
        send({ type: 'phase', phase: 'loading' });
        const t0 = Date.now();
        engine = await KokoroEngine.load(msg.modelPath, msg.voicesPath, { threads: msg.threads });
        const loadMs = Date.now() - t0;
        // The first inference pays one-off graph initialisation costs: do it now, not on the first sentence.
        send({ type: 'phase', phase: 'warming' });
        const t1 = Date.now();
        await engine.synthesize('Ready.', 'af_heart', 1.0);
        send({ type: 'ready', voices: engine.voiceNames, loadMs, warmMs: Date.now() - t1 });
      } catch (e) {
        send({ type: 'init-error', message: e instanceof Error ? `${e.message}` : String(e) });
      }
      break;
    case 'synth':
      queue.push({ id: msg.id, text: msg.text, voice: msg.voice, speed: msg.speed });
      void pump();
      break;
    case 'cancel':
      queue.length = 0;
      break;
    case 'shutdown':
      queue.length = 0;
      await engine?.dispose().catch(() => undefined);
      process.exit(0);
  }
});

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (e) => {
  send({ type: 'fatal', message: e.message });
  process.exit(1);
});
