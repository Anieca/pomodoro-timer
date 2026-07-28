// Electron のバイナリ(dist/)を確実に用意する postinstall。
// electron 43 系は公式 package.json に postinstall(install.js 実行)が無く、
// npm ci/npm install だけではバイナリがダウンロードされないため、ここで明示的に
// 取得する。これで CI・ローカルとも `npm start` / `npm test` が動く。
//
// devDependencies 未インストール時(例: `npm install --omit=dev`)は electron が
// 無いので何もしない。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const dir = path.join('node_modules', 'electron');
const installer = path.join(dir, 'install.js');
const binMarker = path.join(dir, 'path.txt');

if (!existsSync(installer)) {
  console.log('[ensure-electron] electron 未インストールのためスキップ');
  process.exit(0);
}

// path.txt が空/未生成ならバイナリ未取得。install.js は取得済みなら即時終了(冪等)。
const r = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[ensure-electron] Electron バイナリの取得に失敗しました');
  process.exit(r.status ?? 1);
}
if (!existsSync(binMarker)) {
  console.error('[ensure-electron] path.txt が生成されませんでした(バイナリ未取得)');
  process.exit(1);
}
