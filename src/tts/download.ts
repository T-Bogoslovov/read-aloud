import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { CancelledError } from '../util/log';

export interface DownloadProgress { loaded: number; total: number | undefined }

/**
 * Download a URL to a file, streaming through a `.part` file and renaming on success. A retry
 * resumes the `.part` file with a Range request when the server allows it.
 * Uses the global fetch so VS Code's proxy settings apply.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
  expectedSize?: number,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new CancelledError();
    try {
      let have = 0;
      try { have = (await fs.promises.stat(part)).size; } catch { have = 0; }
      const headers: Record<string, string> = {};
      if (have > 0) headers.Range = `bytes=${have}-`;
      const res = await fetch(url, { signal, redirect: 'follow', headers });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      const resumed = res.status === 206 && have > 0;
      if (!resumed) have = 0; // server sent the whole file: start over
      const lengthHeader = res.headers.get('content-length');
      const remaining = lengthHeader ? parseInt(lengthHeader, 10) : undefined;
      const total = remaining !== undefined ? have + remaining : expectedSize;
      let loaded = have;
      const source = Readable.fromWeb(res.body as any);
      source.on('data', (chunk: Buffer) => { loaded += chunk.length; onProgress({ loaded, total }); });
      await pipeline(source, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal });
      const stat = await fs.promises.stat(part);
      if (total && stat.size !== total) throw new Error(`Download incomplete (${stat.size} of ${total} bytes)`);
      await fs.promises.rename(part, dest);
      return;
    } catch (e) {
      lastError = e;
      // Keep the partial file for a resumed retry unless it is clearly unusable.
      if (e instanceof Error && /HTTP 4\d\d|incomplete/.test(e.message)) await fs.promises.rm(part, { force: true }).catch(() => undefined);
      if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) throw new CancelledError();
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
