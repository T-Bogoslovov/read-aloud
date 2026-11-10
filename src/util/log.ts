import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Read Aloud');
  return channel;
}

export function log(message: string): void {
  getLog().appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && (e.name === 'AbortError' || e.name === 'CancelledError'));
}
