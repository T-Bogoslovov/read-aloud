import * as vscode from 'vscode';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import { CancelledError, log } from '../util/log';
import { dehyphenate } from './pdfLayout';

export interface PdfPage { page: number; lines: string[] }

/**
 * One helper process per PDF command: the document is parsed once and reused for the page
 * count and the extraction. Dispose when done.
 */
export class PdfSession implements vscode.Disposable {
  private child: ChildProcess | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly file: string) {}

  private worker(): ChildProcess {
    if (this.child) return this.child;
    const script = this.context.asAbsolutePath(path.join('dist', 'pdfWorker.js'));
    const child = fork(script, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stderr?.on('data', (d) => log(`[pdf] ${String(d).trimEnd()}`));
    this.child = child;
    return child;
  }

  async pageCount(): Promise<number> {
    const child = this.worker();
    return new Promise<number>((resolve, reject) => {
      const onMessage = (msg: any) => {
        if (msg?.type === 'info') { cleanup(); resolve(msg.numPages); }
        else if (msg?.type === 'error') { cleanup(); reject(new Error(msg.message)); }
      };
      const onExit = (code: number | null) => { cleanup(); reject(new Error(`PDF helper exited with code ${code}`)); };
      const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', reject); };
      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', reject);
      child.send({ type: 'info', file: this.file });
    });
  }

  async extract(from: number, to: number, token: vscode.CancellationToken, onPage?: (page: PdfPage) => void): Promise<PdfPage[]> {
    const child = this.worker();
    const pages: PdfPage[] = [];
    const sub = token.onCancellationRequested(() => this.dispose());
    try {
      await new Promise<void>((resolve, reject) => {
        child.on('message', (msg: any) => {
          if (msg?.type === 'page') {
            const page = { page: msg.page, lines: dehyphenate(msg.lines) };
            pages.push(page);
            onPage?.(page);
          } else if (msg?.type === 'done') resolve();
          else if (msg?.type === 'error') reject(new Error(msg.message));
        });
        child.on('exit', (code) => (token.isCancellationRequested ? reject(new CancelledError()) : reject(new Error(`PDF helper exited with code ${code}`))));
        child.on('error', reject);
        child.send({ type: 'extract', file: this.file, from, to });
      });
      return pages;
    } finally {
      sub.dispose();
    }
  }

  dispose(): void {
    const c = this.child;
    this.child = undefined;
    if (c && !c.killed) c.kill();
  }
}
