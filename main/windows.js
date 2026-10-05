'use strict';
// メインウィンドウ(タイマー本体)とミニ(PiP)ウィンドウの生成と参照。
// ミニの開閉は 'mini-changed'、読み込み完了は 'mini-loaded' で知らせる(Tray の
// メニュー貼り替えと最新状態の初回配信は tray.js が受け持つ)。
const { app, BrowserWindow, shell, screen } = require('electron');
const { EventEmitter } = require('events');
const { ICON, PRELOAD, page } = require('./paths');

const events = new EventEmitter();
let mainWin = null;
let miniWin = null;

const alive = win => (win && !win.isDestroyed() ? win : null);
const getMain = () => alive(mainWin);
const getMini = () => alive(miniWin);

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
  return [getMain(), getMini()].some(win => win && win.webContents === wc);
}

const isMainSender = e => { const win = getMain(); return !!win && e.sender === win.webContents; };

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
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // タイマー本体はこのレンダラの setInterval。Tray 常駐で隠れている間も
      // Chromium の background throttling で tick(=完了/通知/自動遷移)が
      // 遅延しないよう抑止する。
      backgroundThrottling: false
    }
  });
  mainWin.loadFile(page('index.html'));
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

function showMainWindow() {
  const win = getMain() || createWindow();
  win.show();
  win.focus();
}

// main → メインウィンドウ(居なければ何もしない)
function sendToMain(channel, payload) {
  const win = getMain();
  if (win) win.webContents.send(channel, payload);
}

// Tray/ミニからの操作要求を本体タイマー(メインウィンドウ)に転送する。
// 本体が無ければ復帰させてから送る。
function sendCommand(cmd) {
  const win = getMain();
  if (win) {
    win.webContents.send('timer:command', cmd);
    return;
  }
  const created = createWindow();
  created.webContents.once('did-finish-load', () => created.webContents.send('timer:command', cmd));
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
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 全画面アプリの上や他のデスクトップでも手前に出す(PiP 的な常時前面)。
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 右上に配置
  const { workArea } = screen.getPrimaryDisplay();
  miniWin.setPosition(workArea.x + workArea.width - 240, workArea.y + 20);
  miniWin.loadFile(page('mini.html'));
  hardenWebContents(miniWin.webContents);
  const wc = miniWin.webContents;
  wc.once('did-finish-load', () => events.emit('mini-loaded', wc));
  miniWin.on('closed', () => { miniWin = null; events.emit('mini-changed'); });
  events.emit('mini-changed');
  return miniWin;
}

function toggleMini() {
  const win = getMini();
  if (win) win.close();
  else createMiniWindow();
}

module.exports = {
  events,
  getMain,
  getMini,
  isTrusted,
  isMainSender,
  createWindow,
  showMainWindow,
  sendToMain,
  sendCommand,
  toggleMini
};
