/**
 * Child process that extracts text from a PDF with pdfjs-dist, so large files never block the
 * extension host. Protocol:
 *   -> { type: 'info', file }                      <- { type: 'info', numPages } | { type: 'error', message }
 *   -> { type: 'extract', file, from, to }         <- { type: 'page', page, lines } ... { type: 'done' } | { type: 'error', message }
 */
import '../pdf/pdfPolyfills';
import * as fs from 'fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractLinesFromItems } from '../pdf/pdfLayout';

function send(msg: unknown): void {
  if (process.send) process.send(msg);
}

let cached: { file: string; doc: Awaited<ReturnType<typeof load>> } | undefined;

async function load(file: string) {
  const data = new Uint8Array(await fs.promises.readFile(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  return task.promise;
}

/** Parse once per file; 'info' followed by 'extract' reuses the same document. */
async function open(file: string) {
  if (cached && cached.file === file) return cached.doc;
  if (cached) await cached.doc.destroy().catch(() => undefined);
  const doc = await load(file);
  cached = { file, doc };
  return doc;
}

process.on('message', async (msg: any) => {
  try {
    if (msg?.type === 'info') {
      const doc = await open(msg.file);
      send({ type: 'info', numPages: doc.numPages });
    } else if (msg?.type === 'extract') {
      const doc = await open(msg.file);
      const from = Math.max(1, msg.from ?? 1);
      const to = Math.min(doc.numPages, msg.to ?? doc.numPages);
      for (let p = from; p <= to; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items = content.items
          .filter((it: any) => typeof it.str === 'string')
          .map((it: any) => ({ str: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width as number, height: it.height as number, hasEOL: !!it.hasEOL }));
        send({ type: 'page', page: p, lines: extractLinesFromItems(items) });
        page.cleanup();
      }
      send({ type: 'done' });
    } else if (msg?.type === 'shutdown') {
      process.exit(0);
    }
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});

process.on('disconnect', () => process.exit(0));
