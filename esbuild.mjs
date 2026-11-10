import * as esbuild from 'esbuild';
import * as fs from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode', '@napi-rs/canvas', 'canvas'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/worker/kokoroWorker.ts'],
    outfile: 'dist/kokoroWorker.js',
    external: ['onnxruntime-node', 'phonemizer'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/worker/pdfWorker.ts'],
    outfile: 'dist/pdfWorker.js',
    external: ['@napi-rs/canvas', 'canvas'],
  }),
]);

// pdf.js loads its worker module next to our bundle at runtime.
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist/pdf.worker.mjs');

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
