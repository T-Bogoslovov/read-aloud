import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { SynthesisResult, TtsProvider } from './provider';
import { CancelledError, log } from '../util/log';

/** Piper neural TTS through a user-installed `piper` executable. */
export class PiperProvider implements TtsProvider {
  readonly id = 'piper' as const;
  readonly label = 'Piper';
  private tmpDir: string;
  private counter = 0;

  constructor(context: vscode.ExtensionContext) {
    this.tmpDir = path.join(context.globalStorageUri.fsPath, 'tmp');
  }

  private get config() {
    const cfg = vscode.workspace.getConfiguration('readAloud.piper');
    return {
      executable: cfg.get<string>('executable', 'piper').trim() || 'piper',
      model: cfg.get<string>('model', '').trim(),
      speaker: cfg.get<number>('speaker', 0),
    };
  }

  async prepare(): Promise<void> {
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    const { model } = this.config;
    if (!model) throw new Error('Set readAloud.piper.model to the path of a Piper voice (.onnx) file.');
    if (!fs.existsSync(model)) throw new Error(`Piper model not found: ${model}`);
    if (!fs.existsSync(`${model}.json`)) throw new Error(`Piper model config not found next to the model: ${model}.json`);
  }

  async synthesize(text: string, token: vscode.CancellationToken): Promise<SynthesisResult> {
    await this.prepare();
    const { executable, model, speaker } = this.config;
    const out = path.join(this.tmpDir, `piper-${process.pid}-${++this.counter}.wav`);
    const kokoroSpeed = vscode.workspace.getConfiguration('readAloud.kokoro').get<number>('speed', 1.0);
    const args = ['--model', model, '--output_file', out, '--length_scale', String(1 / Math.max(0.5, Math.min(2, kokoroSpeed)))];
    if (speaker) args.push('--speaker', String(speaker));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', (e) => reject(new Error(`Could not start "${executable}": ${e.message}. Install Piper from https://github.com/rhasspy/piper and set readAloud.piper.executable.`)));
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`piper exited with code ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
      });
      const sub = token.onCancellationRequested(() => { child.kill(); reject(new CancelledError()); });
      child.on('close', () => sub.dispose());
      child.stdin.end(text + '\n');
    });
    const wav = await fs.promises.readFile(out);
    await fs.promises.rm(out, { force: true }).catch(() => undefined);
    log(`Piper synthesized ${wav.length} bytes`);
    return { wav };
  }

  cancelPending(): void { /* per-request cancellation via token */ }
  dispose(): void { /* nothing persistent */ }
}
