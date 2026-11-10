/**
 * Build one .vsix per platform. onnxruntime-node ships native binaries for every OS/CPU in a single
 * npm package, so each target only keeps its own binaries (a universal package would be ~250 MB).
 *
 *   node scripts/package.mjs                # all targets
 *   node scripts/package.mjs darwin-arm64   # one target
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ALL_TARGETS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = requested.length ? requested : ALL_TARGETS;
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const baseIgnore = fs.readFileSync('.vscodeignore', 'utf8');
fs.mkdirSync('dist', { recursive: true });

execFileSync('npm', ['run', 'build', '--', '--production'], { stdio: 'inherit' });

for (const target of targets) {
  if (!ALL_TARGETS.includes(target)) throw new Error(`Unknown target ${target}. Known: ${ALL_TARGETS.join(', ')}`);
  const [platform, arch] = target.split('-');
  const extra = [];
  for (const p of ['win32', 'darwin', 'linux']) {
    if (p !== platform) extra.push(`node_modules/onnxruntime-node/bin/napi-v3/${p}/**`);
  }
  for (const a of ['x64', 'arm64']) {
    if (a !== arch) extra.push(`node_modules/onnxruntime-node/bin/napi-v3/${platform}/${a}/**`);
  }
  const ignoreFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-')), `.vscodeignore-${target}`);
  fs.writeFileSync(ignoreFile, `${baseIgnore.trimEnd()}\n${extra.join('\n')}\n`);
  const out = path.join('dist', `${pkg.name}-${pkg.version}-${target}.vsix`);
  console.log(`\n==> Packaging ${target} -> ${out}`);
  execFileSync('npx', ['vsce', 'package', '--target', target, '--ignoreFile', ignoreFile, '--out', out, '--skip-license', '--no-update-package-json', '--no-git-tag-version'], { stdio: 'inherit' });
  const size = fs.statSync(out).size;
  console.log(`    ${(size / 1e6).toFixed(1)} MB`);
}
