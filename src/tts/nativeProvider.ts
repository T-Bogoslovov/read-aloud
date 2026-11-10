import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SynthesisResult, TtsProvider } from './provider';
import { aiffToWav } from '../util/wav';
import { CancelledError, log } from '../util/log';

const execFileAsync = promisify(execFile);

const PS_SCRIPT = `param([string]$In, [string]$Out, [string]$Voice, [int]$Rate)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -ne '') { try { $s.SelectVoice($Voice) } catch { Write-Error "Voice '$Voice' not found. Installed: $(($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join ', ')" } }
$s.Rate = $Rate
$s.SetOutputToWaveFile($Out)
$s.Speak([IO.File]::ReadAllText($In, [Text.Encoding]::UTF8))
$s.Dispose()
`;

/** Operating-system voices: macOS `say`, Windows System.Speech, Linux espeak-ng. Produces WAV files. */
export class NativeProvider implements TtsProvider {
  readonly id = 'native' as const;
  readonly label = 'System voice';
  private tmpDir: string;
  private linuxBinary: string | undefined;
  private counter = 0;
  private prepared = false;

  constructor(context: vscode.ExtensionContext) {
    this.tmpDir = path.join(context.globalStorageUri.fsPath, 'tmp');
  }

  private get config() {
    const cfg = vscode.workspace.getConfiguration('readAloud.native');
    return { voice: cfg.get<string>('voice', '').trim(), wpm: cfg.get<number>('wordsPerMinute', 175) };
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    if (process.platform === 'linux' && !this.linuxBinary) {
      for (const bin of ['espeak-ng', 'espeak']) {
        try { await execFileAsync(bin, ['--version']); this.linuxBinary = bin; break; } catch { /* try next */ }
      }
      if (!this.linuxBinary) {
        throw new Error(
          'No system voice found. Install espeak-ng (for example: sudo apt install espeak-ng) or switch readAloud.provider to "kokoro". ' +
          '(spd-say cannot write audio files, so it is not used.)',
        );
      }
    }
    if (process.platform === 'win32') {
      await fs.promises.writeFile(path.join(this.tmpDir, 'speak.ps1'), PS_SCRIPT, 'utf8');
    }
    this.prepared = true;
  }

  async synthesize(text: string, token: vscode.CancellationToken): Promise<SynthesisResult> {
    await this.prepare();
    const base = path.join(this.tmpDir, `s${process.pid}-${++this.counter}`);
    const inFile = `${base}.txt`;
    await fs.promises.writeFile(inFile, text, 'utf8');
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
      if (token.isCancellationRequested) throw new CancelledError();
      const { voice, wpm } = this.config;
      switch (process.platform) {
        case 'darwin': {
          const out = `${base}.aiff`;
          const args = ['-r', String(wpm), '-o', out, '-f', inFile];
          if (voice) args.unshift('-v', voice);
          await execFileAsync('say', args, { signal: controller.signal });
          const wav = aiffToWav(await fs.promises.readFile(out));
          await fs.promises.rm(out, { force: true });
          return { wav };
        }
        case 'win32': {
          const out = `${base}.wav`;
          // System.Speech rate is -10..10; map words-per-minute (80..400, 175 = normal) onto it.
          const rate = Math.max(-10, Math.min(10, Math.round((wpm - 175) / 15)));
          const ps = path.join(this.tmpDir, 'speak.ps1');
          await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, '-In', inFile, '-Out', out, '-Voice', voice, '-Rate', String(rate)],
            { signal: controller.signal, windowsHide: true },
          );
          const wav = await fs.promises.readFile(out);
          await fs.promises.rm(out, { force: true });
          return { wav };
        }
        default: {
          const out = `${base}.wav`;
          const args = ['-s', String(wpm), '-w', out, '-f', inFile];
          if (voice) args.unshift('-v', voice);
          await execFileAsync(this.linuxBinary ?? 'espeak-ng', args, { signal: controller.signal });
          const wav = await fs.promises.readFile(out);
          await fs.promises.rm(out, { force: true });
          return { wav };
        }
      }
    } catch (e) {
      if (controller.signal.aborted) throw new CancelledError();
      const msg = e instanceof Error ? e.message : String(e);
      log(`System voice failed: ${msg}`);
      throw new Error(`System voice failed: ${msg.split('\n')[0]}`);
    } finally {
      sub.dispose();
      await fs.promises.rm(inFile, { force: true }).catch(() => undefined);
    }
  }

  cancelPending(): void { /* each request is cancelled through its token */ }
  dispose(): void { /* nothing persistent */ }
}
