'use strict';
// アプリが読み書きする場所の一覧。userData 配下は app.setPath の上書き
// (POMODORO_USER_DATA)が効いたあとに解決したいので、関数で遅延評価する。
const { app } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  DATA_FILE: () => path.join(app.getPath('userData'), 'pomodoro-data.json'),
  // 同梱音源(asar 内・読み取り専用)とユーザー追加音源(userData 配下・書き込み可)。
  // パッケージ版では assets/ が asar に入り追記できないため、ユーザー音源は userData 側に置く。
  BUNDLED_SOUNDS_DIR: path.join(ROOT, 'assets', 'sounds'),
  USER_SOUNDS_DIR: () => path.join(app.getPath('userData'), 'sounds'),
  // 角丸スクワークルに整形したアプリアイコン(scripts/make-icon.py 生成)。
  // 配布版の Dock/アプリアイコンは electron-builder が build/icon.png から
  // 生成する .icns/.ico を使うが、ウィンドウ/開発時の Dock 用にも参照する。
  ICON: path.join(ROOT, 'build', 'icon.png'),
  PRELOAD: path.join(ROOT, 'preload.js'),
  page: name => path.join(ROOT, 'renderer', name)
};
