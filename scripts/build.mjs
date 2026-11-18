// src/ を out/ へ束ねる。`--watch` で変更を見張る。
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out');
const watch = process.argv.includes('--watch');

const common = { bundle: true, sourcemap: 'linked', logLevel: 'info', absWorkingDir: ROOT };

const builds = [
  // main と preload は Electron が読む CommonJS(preload はサンドボックス下なので一枚に束ねる)
  { ...common, entryPoints: { main: 'src/main/main.ts', preload: 'src/preload.ts' }, outdir: OUT, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] },
  {
    ...common,
    entryPoints: { app: 'src/ui/main.tsx', mini: 'src/ui/mini.tsx' },
    outdir: path.join(OUT, 'ui'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: !watch
  }
];

function copyPages() {
  fs.mkdirSync(path.join(OUT, 'ui'), { recursive: true });
  for (const name of ['index.html', 'mini.html']) {
    fs.copyFileSync(path.join(ROOT, 'src/ui', name), path.join(OUT, 'ui', name));
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyPages();
if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  fs.watch(path.join(ROOT, 'src/ui'), (_e, file) => { if (file?.endsWith('.html')) copyPages(); });
} else {
  await Promise.all(builds.map(options => esbuild.build(options)));
}
