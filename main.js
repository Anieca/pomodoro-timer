const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.POMODORO_USER_DATA) app.setPath('userData', process.env.POMODORO_USER_DATA);

const DATA_FILE = () => path.join(app.getPath('userData'), 'pomodoro-data.json');
// 同梱音源(asar 内・読み取り専用)とユーザー追加音源(userData 配下・書き込み可)。
// パッケージ版では assets/ が asar に入り追記できないため、ユーザー音源は userData 側に置く。
const BUNDLED_SOUNDS_DIR = path.join(__dirname, 'assets', 'sounds');
const USER_SOUNDS_DIR = () => path.join(app.getPath('userData'), 'sounds');
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
// 角丸スクワークルに整形したアプリアイコン(scripts/make-icon.py 生成)。
// 配布版の Dock/アプリアイコンは electron-builder が build/icon.png から
// 生成する .icns/.ico を使うが、ウィンドウ/開発時の Dock 用にも参照する。
const ICON = path.join(__dirname, 'build', 'icon.png');

function listAudioFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  } catch {
    return [];
  }
}

// タイマー本体はレンダラ(renderer/app.js)側に存在する。main はその状態を
// 'timer:state' で受け取り、Tray タイトル・Dock・ミニウィンドウへ反映するだけ。
let mainWin = null;
let miniWin = null;
let tray = null;
let lastMenuKey = null;
let latestState = { status: 'idle', mode: 'work', mm: '25', ss: '00', ratio: 1, remainSec: 1500 };

const MODE_EMOJI = { work: '🍅', short: '☕', long: '🌙' };
const MODE_TEXT = { work: 'フォーカス', short: '小休憩', long: '長休憩' };

// file:// 以外への遷移と新規ウィンドウ生成を禁止する多層防御。万一 remote
// navigation が起きても preload API が外部 origin に晒されないようにする。
function hardenWebContents(wc) {
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url); // 外部リンクは既定ブラウザで
    return { action: 'deny' };
  });
}

// IPC の発信元が自前のウィンドウ(メイン/ミニ)かを検証する。外部/未知フレームからの
// データ保存・エクスポート・音源読み取り等を拒否する。
function isTrusted(e) {
  const wc = e.sender;
  return (mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents) ||
         (miniWin && !miniWin.isDestroyed() && wc === miniWin.webContents);
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16110e',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // タイマー本体はこのレンダラの setInterval。Tray 常駐で隠れている間も
      // Chromium の background throttling で tick(=完了/通知/自動遷移)が
      // 遅延しないよう抑止する。
      backgroundThrottling: false
    }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  hardenWebContents(mainWin.webContents);
  // macOS はタイマー本体がこのレンダラにあるため、閉じるボタンでは破棄せず
  // 隠すだけにして Tray/ミニ常駐のまま実行中タイマーを維持する。
  // 非 macOS は Tray タイトルが出せず常駐 UI が弱いので、従来どおり閉じたら終了。
  mainWin.on('close', e => {
    if (process.platform === 'darwin' && !app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

// Tray/ミニからの操作要求を本体タイマー(メインウィンドウ)に転送する。
// 本体が無ければ復帰させてから送る。
function sendCommand(cmd) {
  if (!mainWin || mainWin.isDestroyed()) {
    const win = createWindow();
    win.webContents.once('did-finish-load', () => win.webContents.send('timer:command', cmd));
    return;
  }
  mainWin.webContents.send('timer:command', cmd);
}

/* ============ ミニ(PiP)ウィンドウ ============ */
function createMiniWindow() {
  miniWin = new BrowserWindow({
    width: 220,
    height: 176,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 全画面アプリの上や他のデスクトップでも手前に出す(PiP 的な常時前面)。
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 右上に配置
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  miniWin.setPosition(workArea.x + workArea.width - 240, workArea.y + 20);
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  hardenWebContents(miniWin.webContents);
  miniWin.webContents.once('did-finish-load', () => miniWin.webContents.send('timer:state', latestState));
  miniWin.on('closed', () => { miniWin = null; refreshTrayMenu(); });
  return miniWin;
}

function toggleMini() {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.close();
    return;
  }
  createMiniWindow();
  refreshTrayMenu();
}

/* ============ Tray(メニューバー常駐) ============ */
// macOS メニューバー用のテキストタイトル(🍅 12:34)
function trayTitle(s) {
  const emoji = MODE_EMOJI[s.mode] || '🍅';
  if (s.status === 'running') return ` ${emoji} ${s.mm}:${s.ss}`;
  if (s.status === 'paused') return ` ⏸️ ${s.mm}:${s.ss}`;
  return ` ${emoji}`;
}

// 非 macOS はタイトルを出せないため、残り時間はツールチップで示す。
function traySummary(s) {
  const label = MODE_TEXT[s.mode] || '';
  if (s.status === 'running') return `Pomodoro Atelier — ${label} ${s.mm}:${s.ss}`;
  if (s.status === 'paused') return `Pomodoro Atelier — 一時停止 ${s.mm}:${s.ss}`;
  return 'Pomodoro Atelier';
}

function trayMenu(s) {
  const isBreak = s.mode !== 'work';
  return Menu.buildFromTemplate([
    {
      label: s.status === 'running' ? '一時停止' : s.status === 'paused' ? '再開' : `開始(${MODE_TEXT[s.mode]})`,
      click: () => sendCommand('toggle')
    },
    { label: '休憩をスキップ', enabled: isBreak && s.status !== 'idle', click: () => sendCommand('skip') },
    { label: '中止', enabled: s.status !== 'idle', click: () => sendCommand('stop') },
    { type: 'separator' },
    { label: miniWin ? 'ミニタイマーを隠す' : 'ミニタイマーを表示', click: () => toggleMini() },
    { label: 'メインウィンドウを表示', click: () => { const w = mainWin && !mainWin.isDestroyed() ? mainWin : createWindow(); w.show(); w.focus(); } },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

// 非 macOS のコンテキストメニューは setContextMenu で固定するため、状態変化
// (status/mode/ミニ有無)に応じて貼り替える。macOS は popUp で都度組むので不要。
function refreshTrayMenu() {
  if (!tray || process.platform === 'darwin') return;
  lastMenuKey = latestState.status + latestState.mode + (miniWin ? '1' : '0');
  tray.setContextMenu(trayMenu(latestState));
}

function trayImage() {
  // macOS はタイトル(絵文字)を主役にするため空画像。
  // 非 macOS はアイコンが無いと Tray 自体が不可視になるためアプリアイコンを使う。
  if (process.platform === 'darwin') return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch {
    // 一部 Linux 環境(libappindicator 無し等)で Tray 生成が失敗しても
    // アプリ本体は起動させる。
    tray = null;
    return;
  }
  tray.setToolTip('Pomodoro Atelier');
  if (process.platform === 'darwin') {
    tray.setTitle(trayTitle(latestState));
    // 左クリックで開始/一時停止のみ。右クリックでメニューを都度組み立てて表示する。
    // 注: setContextMenu を使うと macOS では左クリックでもメニューが開いてしまい
    // 'click'(トグル)と二重発火するため、popUpContextMenu で明示表示する。
    tray.on('click', () => sendCommand('toggle'));
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu(latestState)));
  } else {
    // 非 macOS はタイトル表示不可。左右どちらのクリックでもメニューを出して
    // 操作・終了できるようにする。
    tray.setContextMenu(trayMenu(latestState));
    tray.on('click', () => tray.popUpContextMenu(trayMenu(latestState)));
  }
}

/* ============ Dock(バッジ + プログレスバー) ============ */
function updateDock(s) {
  if (process.platform === 'darwin' && app.dock) {
    // 残り分をバッジに(0 分未満は表示しない)
    app.dock.setBadge(s.status === 'running' ? String(Math.ceil(s.remainSec / 60)) : '');
  }
  // Dock アイコン上に経過割合のプログレスバー。idle は非表示(-1)。
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setProgressBar(s.status === 'idle' ? -1 : 1 - s.ratio);
  }
}

// レンダラから届く state を検証・正規化する。壊れた値でも Tray/Dock/ミニが
// 落ちないよう、モードは許可リスト、数値は有限値へ丸める(setProgressBar(NaN) 防止)。
function sanitizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const status = ['idle', 'running', 'paused'].includes(s.status) ? s.status : 'idle';
  const mode = ['work', 'short', 'long'].includes(s.mode) ? s.mode : 'work';
  const ratio = Number.isFinite(s.ratio) ? Math.min(1, Math.max(0, s.ratio)) : 1;
  const remainSec = Number.isFinite(s.remainSec) ? Math.max(0, s.remainSec) : 0;
  const mm = typeof s.mm === 'string' ? s.mm.slice(0, 3) : '00';
  const ss = typeof s.ss === 'string' ? s.ss.slice(0, 2) : '00';
  return { status, mode, mm, ss, ratio, remainSec };
}

function applyState(raw) {
  const s = sanitizeState(raw);
  latestState = s;
  if (tray) {
    if (process.platform === 'darwin') {
      tray.setTitle(trayTitle(s));
    } else {
      tray.setToolTip(traySummary(s));
      const key = s.status + s.mode + (miniWin ? '1' : '0');
      if (key !== lastMenuKey) refreshTrayMenu();
    }
  }
  updateDock(s);
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('timer:state', s);
}

app.whenReady().then(() => {
  // ユーザーが音源を置けるフォルダを用意しておく(配布版でも追加できるように)
  try { fs.mkdirSync(USER_SOUNDS_DIR(), { recursive: true }); } catch {}
  // 開発時(electron .)は Dock が既定の Electron アイコンになるため上書きする。
  // 配布版は electron-builder 生成の .icns が使われるので上書きしない(角丸 .icns を優先)。
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    app.dock.setIcon(ICON);
  }
  createWindow();
  createTray();
  app.on('activate', () => {
    if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); return; }
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cmd+Q など通常終了時は close を抑止せず本当に閉じられるようにする。
app.on('before-quit', () => { app.isQuitting = true; });

// Tray 常駐のため、ウィンドウを全て閉じても終了しない(メニューから明示終了)。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// レンダラ(本体)からのタイマー状態通知。Tray/Dock/ミニへ反映する。
// 状態の発信元はメインウィンドウのみ(ミニ等からの誤送信は無視する)。
ipcMain.on('timer:state', (e, state) => {
  if (!mainWin || e.sender !== mainWin.webContents) return;
  applyState(state);
});

// ミニウィンドウからの操作要求を本体タイマーに転送する。
ipcMain.on('ui:command', (e, cmd) => {
  if (!isTrusted(e)) return;
  if (cmd === 'toggleMini') return toggleMini();
  sendCommand(cmd);
});

ipcMain.on('mini:toggle', e => { if (isTrusted(e)) toggleMini(); });

// 壊れた保存ファイルを退避して原本を保全する(上書きによる損失を防ぐ)。
function quarantineCorrupt(file, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}`;
  try { fs.writeFileSync(backup, raw, 'utf8'); } catch {}
  return backup;
}

// 読み込み時の警告(破損退避・回復・権限エラー)。起動をブロックしないよう
// モーダルではなくレンダラのトーストで通知する(data:consume-warning で回収)。
let pendingLoadWarning = null;

// 原本を読めないまま起動した状態。null なら通常どおり保存してよい。
// 警告だけではレンダラ(beforeunload の同期保存など)が素通りで上書きしてしまうため、
// 保存を止める権威は main が持つ。詳細は preserveUnreadable() を参照。
let unreadableOriginal = null;

ipcMain.handle('data:load', e => {
  if (!isTrusted(e)) return null;
  const file = DATA_FILE();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 初回起動(ファイル無し)は空データとして扱う。
    if (err && err.code === 'ENOENT') return null;
    // 権限エラー等で読めない場合、空起動→上書きで原本が失われる。書き込みを
    // 保留し、実際に保存が要求された時点で退避してから通す(下記 gate)。
    unreadableOriginal = String((err && err.message) || err);
    pendingLoadWarning = 'セーブファイルを読み込めませんでした。データ保護のため保存前に確認してください: ' + unreadableOriginal;
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 破損。まず直近のアトミック書き込み残骸(.tmp)からの回復を試みる。
    try {
      const tmp = file + '.tmp';
      const recovered = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      quarantineCorrupt(file, raw);       // 壊れた本体を退避してから
      try { fs.copyFileSync(tmp, file); } catch {} // 回復データを昇格
      pendingLoadWarning = '保存ファイルが壊れていたため、直前の自動保存から復元しました。';
      return recovered;
    } catch {}
    // 回復不可: 壊れたファイルを退避(原本保全)し、警告して空で継続する。
    const backup = quarantineCorrupt(file, raw);
    console.warn('[data:load] 破損ファイルを退避しました:', backup);
    pendingLoadWarning = '保存ファイルが破損していたため退避し、空の状態で起動しました(元ファイルは .corrupt- として保存)。';
    return null;
  }
});

// 読み込み時警告を一度だけ回収する(レンダラがトースト表示に使う)。
ipcMain.handle('data:consume-warning', e => {
  if (!isTrusted(e)) return null;
  const w = pendingLoadWarning;
  pendingLoadWarning = null;
  return w;
});

// 読めなかった原本を、中身を読まずに保全する。rename は対象ファイルの読み取り権限を
// 必要とせず(ディレクトリの書き込み権限だけで済む)、破損退避の writeFileSync と違って
// 内容が取り出せなくても確実に原本を残せる。退避できた時点で上書きは安全になる。
function preserveUnreadable(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.unreadable-${stamp}`;
  fs.renameSync(file, backup);   // 失敗時は呼び出し側で保存自体を中止する
  return backup;
}

// 保存前のゲート。原本を読めていない間は、退避に成功するまで書き込みを通さない。
// 「退避していないバイト列は壊さない」不変条件をここ一箇所で守る。
// 退避したパス(または null)を返し、失敗時は例外を投げて保存を中止させる。
function gateWrite() {
  if (!unreadableOriginal) return null;
  const file = DATA_FILE();
  let backup;
  try {
    backup = preserveUnreadable(file);
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      // 退避できない = 上書きすれば原本が失われる。保存を中止する。
      throw new Error('読み込めなかった元データを退避できないため、保存を中止しました: ' + String((err && err.message) || err));
    }
    backup = null;              // 既に消えている場合は保全すべき原本がない
  }
  unreadableOriginal = null;    // 以降は通常の保存に戻る
  if (backup) console.warn('[data:save] 読めなかった原本を退避しました:', backup);
  return backup;
}

// クラッシュ時の破損を防ぐためアトミックに書き込む
function writeData(data) {
  const preserved = gateWrite();
  const tmp = DATA_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE());
  return preserved;
}

ipcMain.handle('data:save', (e, data) => {
  if (!isTrusted(e)) return { ok: false, error: 'untrusted sender' };
  try {
    const preserved = writeData(data);
    // 原本を退避したことは黙らせない(レンダラがトーストで知らせる)。
    return preserved ? { ok: true, preserved } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 終了直前の同期保存。sendSync でレンダラをブロックし、書き込み完了を保証する。
// 失敗は握りつぶさず、ユーザーが気づけるようネイティブダイアログで通知する。
ipcMain.on('data:save-sync', (e, data) => {
  if (!isTrusted(e)) { e.returnValue = { ok: false, error: 'untrusted sender' }; return; }
  try {
    const preserved = writeData(data);
    e.returnValue = preserved ? { ok: true, preserved } : { ok: true };
  } catch (err) {
    const msg = String((err && err.message) || err);
    try { dialog.showErrorBox('保存に失敗しました', 'データを保存できませんでした:\n' + msg); } catch {}
    e.returnValue = { ok: false, error: msg };
  }
});

ipcMain.handle('sounds:list', e => {
  if (!isTrusted(e)) return [];
  // 同名はユーザー音源を優先(ユーザーが同名で差し替え可能)
  const seen = new Set();
  const out = [];
  for (const [dir, source] of [[USER_SOUNDS_DIR(), 'user'], [BUNDLED_SOUNDS_DIR, 'bundled']]) {
    for (const f of listAudioFiles(dir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ name: f, path: path.join(dir, f), source });
    }
  }
  return out;
});

ipcMain.handle('sounds:openDir', e => {
  if (!isTrusted(e)) return;
  const dir = USER_SOUNDS_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  shell.openPath(dir);
});

ipcMain.on('win:focus', e => {
  if (!isTrusted(e)) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

ipcMain.on('win:attention', e => {
  if (!isTrusted(e)) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isFocused() && app.dock) app.dock.bounce('informational');
});

ipcMain.handle('sounds:read', (e, name) => {
  if (!isTrusted(e)) return null;
  const base = path.basename(name);
  if (!AUDIO_EXTS.has(path.extname(base).toLowerCase())) return null;
  // ユーザー音源を優先し、無ければ同梱音源にフォールバック
  for (const dir of [USER_SOUNDS_DIR(), BUNDLED_SOUNDS_DIR]) {
    try {
      return fs.readFileSync(path.join(dir, base));
    } catch {}
  }
  return null;
});

function csvEscape(v) {
  let s = String(v ?? '');
  // Excel/Google スプレッドシート等の数式注入(CSV injection)対策。
  // 先頭が = + - @ やタブ/復帰のセルは数式として解釈され得るため、先頭に ' を付けて
  // テキストとして扱わせる(タスク名を外部から貼り付ける運用を想定)。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\n');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

ipcMain.handle('data:export', async (e, payload) => {
  if (!isTrusted(e)) return { saved: false, error: 'untrusted sender' };
  const { format, data } = payload || {};
  const stamp = new Date().toISOString().slice(0, 10);
  const defs = {
    json: { name: `pomodoro-export-${stamp}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] },
    'csv-sessions': { name: `sessions-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] },
    'csv-tasks': { name: `tasks-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }
  };
  const def = defs[format];
  // 未知フォーマットや不正な data 形状はここで弾く(IPC 境界の防御)。
  if (!def || !data || typeof data !== 'object') return { saved: false, error: 'invalid request' };
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: def.name,
    filters: def.filters
  });
  if (canceled || !filePath) return { saved: false };

  const taskTitle = id => (tasks.find(t => t.id === id) || {}).title || '(削除済み)';
  const MODE_LABEL = { work: 'フォーカス', short: '小休憩', long: '長休憩' };
  let content;
  const min = sec => Math.round((sec / 60) * 10) / 10;
  if (format === 'json') {
    content = JSON.stringify(data, null, 2);
  } else if (format === 'csv-sessions') {
    const rows = [['ID', '種別', '開始', '終了', '実時間(分)', '完走', '一時停止回数', '実働区間', 'タスク内訳']];
    for (const p of sessions) {
      const intervals = p.intervals || [{ startedAt: p.startedAt, endedAt: p.endedAt }];
      rows.push([
        p.id,
        MODE_LABEL[p.mode] || p.mode || '',
        fmtDate(p.startedAt),
        fmtDate(p.endedAt),
        min(p.durationSec),
        p.completed ? 'はい' : 'いいえ',
        Math.max(0, intervals.length - 1),
        intervals.map(iv => `${fmtDate(iv.startedAt)}〜${fmtDate(iv.endedAt)}`).join('; '),
        (p.taskTimes || [])
          .map(tt => `${tt.taskId ? taskTitle(tt.taskId) : '(未割当)'}: ${min(tt.durationSec)}分`)
          .join('; ')
      ]);
    }
    content = toCsv(rows);
  } else {
    const rows = [['ID', 'タイトル', '状態', '作成日時', '完了日時', 'ポモドーロ数(完走)', '合計フォーカス(分)']];
    for (const t of tasks) {
      let pomos = 0, totalSec = 0;
      for (const p of sessions) {
        if (p.completed && (p.taskIds || []).includes(t.id)) pomos++;
        for (const tt of (p.taskTimes || [])) if (tt.taskId === t.id) totalSec += tt.durationSec;
      }
      rows.push([
        t.id,
        t.title,
        t.completed ? '完了' : '未完了',
        fmtDate(t.createdAt),
        fmtDate(t.completedAt),
        pomos,
        min(totalSec)
      ]);
    }
    content = toCsv(rows);
  }
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    return { saved: false, error: String((err && err.message) || err) };
  }
  return { saved: true, filePath };
});
