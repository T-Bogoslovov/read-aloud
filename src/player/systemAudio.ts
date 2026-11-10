/**
 * Plays WAV files through the operating system instead of the webview, so no browser gesture is
 * needed. Windows uses one persistent PowerShell process (System.Media.SoundPlayer), macOS uses
 * afplay, Linux the first of paplay / aplay / ffplay, and `readAloud.systemAudio.command` can
 * name any player with a {file} placeholder.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

export interface SinkMeta { index: number; total: number; text: string; page?: number; title: string }

export interface AudioSink {
  /** Whether this sink changes tempo itself; otherwise the player speeds up synthesis instead. */
  readonly appliesRate: boolean;
  load(meta: SinkMeta, wav: Buffer, autoplay: boolean): void;
  preload(meta: SinkMeta, wav: Buffer): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  dispose(): void;
}

export interface SinkEvents {
  onEnded(index: number): void;
  onPlaystate(playing: boolean): void;
  onError(message: string): void;
}

export const PS_PLAYER_SCRIPT = `$ErrorActionPreference = 'Stop'
$in = [Console]::In
$out = [Console]::Out
while (($line = $in.ReadLine()) -ne $null) {
  if ($line -eq 'QUIT') { break }
  if ($line.StartsWith('PLAY ')) {
    $file = $line.Substring(5)
    try {
      $player = New-Object System.Media.SoundPlayer $file
      $player.PlaySync()
      $out.WriteLine('DONE')
    } catch {
      $out.WriteLine('ERROR ' + $_.Exception.Message)
    }
    $out.Flush()
  }
}
`;

export interface PlayerCommand { command: string; args: string[]; label: string }

/** Split a user-supplied command line on spaces, substituting {file}. Quotes are not interpreted. */
export function parseCustomCommand(template: string, file: string): PlayerCommand | undefined {
  const parts = template.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (!parts.some((p) => p.includes('{file}'))) parts.push('{file}');
  const [command, ...rest] = parts.map((p) => p.replace(/\{file\}/g, file));
  return { command, args: rest, label: parts[0] };
}

/** Pick the per-sentence player for this platform. `available` says whether a binary is on PATH. */
export function choosePlayer(platform: NodeJS.Platform, available: (bin: string) => boolean, file: string): PlayerCommand | undefined {
  if (platform === 'darwin') return { command: 'afplay', args: [file], label: 'afplay' };
  if (platform === 'linux') {
    if (available('paplay')) return { command: 'paplay', args: [file], label: 'paplay' };
    if (available('aplay')) return { command: 'aplay', args: ['-q', file], label: 'aplay' };
    if (available('ffplay')) return { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'error', file], label: 'ffplay' };
  }
  return undefined;
}

export function isOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`] : [bin];
  return dirs.some((d) => names.some((n) => { try { fs.accessSync(path.join(d, n), fs.constants.X_OK); return true; } catch { return false; } }));
}

interface Current { index: number; file: string; proc?: ChildProcess; token: number }

export class SystemSink implements AudioSink {
  readonly appliesRate = false;
  private current: Current | undefined;
  private pausedFile: { index: number; file: string; meta: SinkMeta } | undefined;
  private files = new Map<number, string>();
  private counter = 0;
  private token = 0;
  private ps: ChildProcess | undefined;
  private psBuffer = '';
  private psWaiting: ((line: string) => void) | undefined;
  private disposed = false;

  constructor(
    private readonly tmpDir: string,
    private readonly events: SinkEvents,
    private readonly log: (line: string) => void,
    private readonly customCommand = '',
  ) {
    fs.mkdirSync(tmpDir, { recursive: true });
    if (process.platform === 'win32' && !customCommand) this.startPowerShell();
  }

  /** Human-readable name of the player in use, for messages. */
  describe(): string {
    if (this.customCommand) return this.customCommand.split(/\s+/)[0];
    if (process.platform === 'win32') return 'Windows SoundPlayer (PowerShell)';
    return choosePlayer(process.platform, isOnPath, 'x')?.label ?? 'no system player found';
  }

  private writeFile(meta: SinkMeta, wav: Buffer): string {
    let file = this.files.get(meta.index);
    if (file && fs.existsSync(file)) return file;
    file = path.join(this.tmpDir, `play-${process.pid}-${++this.counter}.wav`);
    fs.writeFileSync(file, wav);
    this.files.set(meta.index, file);
    return file;
  }

  preload(meta: SinkMeta, wav: Buffer): void {
    this.writeFile(meta, wav);
  }

  load(meta: SinkMeta, wav: Buffer, autoplay: boolean): void {
    this.killCurrent();
    this.pausedFile = undefined;
    const file = this.writeFile(meta, wav);
    if (!autoplay) { this.pausedFile = { index: meta.index, file, meta }; this.events.onPlaystate(false); return; }
    this.play(meta.index, file, meta);
  }

  private play(index: number, file: string, meta: SinkMeta): void {
    const token = ++this.token;
    this.current = { index, file, token };
    this.events.onPlaystate(true);
    const finish = (ok: boolean, message?: string) => {
      if (this.current?.token !== token) return; // superseded by stop/pause/next
      this.current = undefined;
      this.cleanup(index);
      if (ok) this.events.onEnded(index);
      else this.events.onError(message ?? 'system audio player failed');
    };
    if (process.platform === 'win32' && !this.customCommand) {
      void this.playViaPowerShell(file).then((line) => finish(line === 'DONE', line.replace(/^ERROR\s*/, '')), (e) => finish(false, String(e)));
      return;
    }
    const cmd = this.customCommand ? parseCustomCommand(this.customCommand, file) : choosePlayer(process.platform, isOnPath, file);
    if (!cmd) { finish(false, 'No system audio player found (install paplay, aplay or ffplay, or set readAloud.systemAudio.command).'); return; }
    let proc: ChildProcess;
    try {
      proc = spawn(cmd.command, cmd.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      finish(false, `Could not start ${cmd.label}: ${String(e)}`);
      return;
    }
    this.current.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += String(d); });
    proc.on('error', (e) => finish(false, `Could not start ${cmd.label}: ${e.message}`));
    proc.on('exit', (code, signal) => {
      if (signal) return; // killed by us
      finish(code === 0, `${cmd.label} exited with code ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
    });
    void meta;
  }

  pause(): void {
    const c = this.current;
    if (!c) return;
    const meta = { index: c.index, total: 0, text: '', title: '' };
    this.killCurrent();
    this.pausedFile = { index: c.index, file: c.file, meta };
    this.events.onPlaystate(false);
  }

  resume(): void {
    const p = this.pausedFile;
    if (!p) return;
    this.pausedFile = undefined;
    this.play(p.index, p.file, p.meta); // restarts the sentence from its beginning
  }

  stop(): void {
    this.killCurrent();
    this.pausedFile = undefined;
    for (const f of this.files.values()) fs.promises.rm(f, { force: true }).catch(() => undefined);
    this.files.clear();
  }

  setRate(): void { /* tempo is applied at synthesis time by the player */ }

  dispose(): void {
    this.disposed = true;
    this.stop();
    const ps = this.ps;
    this.ps = undefined;
    if (ps) { try { ps.stdin?.write('QUIT\n'); } catch { /* gone */ } setTimeout(() => { if (!ps.killed) ps.kill(); }, 500); }
  }

  private cleanup(index: number): void {
    const f = this.files.get(index);
    if (f) { this.files.delete(index); fs.promises.rm(f, { force: true }).catch(() => undefined); }
  }

  private killCurrent(): void {
    const c = this.current;
    this.current = undefined;
    this.token++;
    if (!c) return;
    if (c.proc && !c.proc.killed) c.proc.kill();
    if (!c.proc && process.platform === 'win32' && !this.customCommand) {
      // PlaySync cannot be interrupted: restart the helper.
      const ps = this.ps;
      this.ps = undefined;
      ps?.kill();
      this.psWaiting = undefined;
      this.psBuffer = '';
      if (!this.disposed) this.startPowerShell();
    }
  }

  // ---- Windows: persistent PowerShell SoundPlayer ---------------------------------------------

  private startPowerShell(): void {
    const script = path.join(this.tmpDir, 'play.ps1');
    try { fs.writeFileSync(script, PS_PLAYER_SCRIPT, 'utf8'); } catch (e) { this.log(`cannot write player script: ${String(e)}`); }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ps = ps;
    ps.stdout?.on('data', (d) => {
      this.psBuffer += String(d);
      let nl: number;
      while ((nl = this.psBuffer.indexOf('\n')) >= 0) {
        const line = this.psBuffer.slice(0, nl).replace(/\r$/, '');
        this.psBuffer = this.psBuffer.slice(nl + 1);
        const w = this.psWaiting;
        this.psWaiting = undefined;
        w?.(line);
      }
    });
    ps.stderr?.on('data', (d) => this.log(`[system audio] ${String(d).trimEnd()}`));
    ps.on('error', (e) => { this.log(`PowerShell player failed to start: ${e.message}`); const w = this.psWaiting; this.psWaiting = undefined; w?.(`ERROR ${e.message}`); });
    ps.on('exit', (code) => { if (this.ps === ps) { this.ps = undefined; const w = this.psWaiting; this.psWaiting = undefined; w?.(`ERROR player exited (${code})`); } });
  }

  private playViaPowerShell(file: string): Promise<string> {
    if (!this.ps) this.startPowerShell();
    const ps = this.ps!;
    return new Promise<string>((resolve) => {
      this.psWaiting = resolve;
      try { ps.stdin?.write(`PLAY ${file}\n`); } catch (e) { this.psWaiting = undefined; resolve(`ERROR ${String(e)}`); }
    });
  }
}
