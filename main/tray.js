'use strict';
// タイマー本体はレンダラ(renderer/timer.js)側に存在する。main はその状態を
// 'timer:state' で受け取り、Tray タイトル・Dock・ミニウィンドウへ反映するだけ。
const { app, Tray, Menu, nativeImage } = require('electron');
const { MODES, MODE_LABEL } = require('../shared/schema');
const { ICON } = require('./paths');
const windows = require('./windows');

const IS_MAC = process.platform === 'darwin';
const MODE_EMOJI = { work: '🍅', short: '☕', long: '🌙' };
const STATUSES = ['idle', 'running', 'paused'];

let tray = null;
let lastMenuKey = null;
let latestState = { status: 'idle', mode: 'work', mm: '25', ss: '00', ratio: 1, remainSec: 1500 };

// レンダラから届く state を検証・正規化する。壊れた値でも Tray/Dock/ミニが
// 落ちないよう、モードは許可リスト、数値は有限値へ丸める(setProgressBar(NaN) 防止)。
function sanitizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    status: STATUSES.includes(s.status) ? s.status : 'idle',
    mode: MODES.includes(s.mode) ? s.mode : 'work',
    mm: typeof s.mm === 'string' ? s.mm.slice(0, 3) : '00',
    ss: typeof s.ss === 'string' ? s.ss.slice(0, 2) : '00',
    ratio: Number.isFinite(s.ratio) ? Math.min(1, Math.max(0, s.ratio)) : 1,
    remainSec: Number.isFinite(s.remainSec) ? Math.max(0, s.remainSec) : 0
  };
}

// macOS メニューバー用のテキストタイトル(🍅 12:34)
function trayTitle(s) {
  const emoji = MODE_EMOJI[s.mode] || '🍅';
  if (s.status === 'running') return ` ${emoji} ${s.mm}:${s.ss}`;
  if (s.status === 'paused') return ` ⏸️ ${s.mm}:${s.ss}`;
  return ` ${emoji}`;
}

// 非 macOS はタイトルを出せないため、残り時間はツールチップで示す。
function traySummary(s) {
  if (s.status === 'running') return `Pomodoro Atelier — ${MODE_LABEL[s.mode]} ${s.mm}:${s.ss}`;
  if (s.status === 'paused') return `Pomodoro Atelier — 一時停止 ${s.mm}:${s.ss}`;
  return 'Pomodoro Atelier';
}

function trayMenu(s) {
  const isBreak = s.mode !== 'work';
  return Menu.buildFromTemplate([
    {
      label: s.status === 'running' ? '一時停止' : s.status === 'paused' ? '再開' : `開始(${MODE_LABEL[s.mode]})`,
      click: () => windows.sendCommand('toggle')
    },
    { label: '休憩をスキップ', enabled: isBreak && s.status !== 'idle', click: () => windows.sendCommand('skip') },
    { label: '中止', enabled: s.status !== 'idle', click: () => windows.sendCommand('stop') },
    { type: 'separator' },
    { label: windows.getMini() ? 'ミニタイマーを隠す' : 'ミニタイマーを表示', click: () => windows.toggleMini() },
    { label: 'メインウィンドウを表示', click: () => windows.showMainWindow() },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

// 非 macOS のコンテキストメニューは setContextMenu で固定するため、状態変化
// (status/mode/ミニ有無)に応じて貼り替える。macOS は popUp で都度組むので不要。
const menuKey = s => s.status + s.mode + (windows.getMini() ? '1' : '0');

function refreshTrayMenu({ force = true } = {}) {
  if (!tray || IS_MAC) return;
  const key = menuKey(latestState);
  if (!force && key === lastMenuKey) return;
  lastMenuKey = key;
  tray.setContextMenu(trayMenu(latestState));
}

function trayImage() {
  // macOS はタイトル(絵文字)を主役にするため空画像。
  // 非 macOS はアイコンが無いと Tray 自体が不可視になるためアプリアイコンを使う。
  if (IS_MAC) return nativeImage.createEmpty();
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
  if (IS_MAC) {
    tray.setTitle(trayTitle(latestState));
    // 左クリックで開始/一時停止のみ。右クリックでメニューを都度組み立てて表示する。
    // 注: setContextMenu を使うと macOS では左クリックでもメニューが開いてしまい
    // 'click'(トグル)と二重発火するため、popUpContextMenu で明示表示する。
    tray.on('click', () => windows.sendCommand('toggle'));
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu(latestState)));
  } else {
    // 非 macOS はタイトル表示不可。左右どちらのクリックでもメニューを出して
    // 操作・終了できるようにする。
    refreshTrayMenu();
    tray.on('click', () => tray.popUpContextMenu(trayMenu(latestState)));
  }
}

// ミニの有無はメニューの文言に出る。開いたミニには最新の状態を先に渡しておく
// (Tray を作れなかった環境でもミニは動くので、Tray の有無に依らず購読する)。
windows.events.on('mini-changed', () => refreshTrayMenu());
windows.events.on('mini-loaded', wc => wc.send('timer:state', latestState));

/* ============ Dock(バッジ + プログレスバー) ============ */
function updateDock(s) {
  if (IS_MAC && app.dock) {
    // 残り分をバッジに(0 分未満は表示しない)
    app.dock.setBadge(s.status === 'running' ? String(Math.ceil(s.remainSec / 60)) : '');
  }
  // Dock アイコン上に経過割合のプログレスバー。idle は非表示(-1)。
  const win = windows.getMain();
  if (win) win.setProgressBar(s.status === 'idle' ? -1 : 1 - s.ratio);
}

// レンダラ(本体)からのタイマー状態通知を Tray/Dock/ミニへ反映する。
function applyTimerState(raw) {
  const s = sanitizeState(raw);
  latestState = s;
  if (tray) {
    if (IS_MAC) {
      tray.setTitle(trayTitle(s));
    } else {
      tray.setToolTip(traySummary(s));
      refreshTrayMenu({ force: false });
    }
  }
  updateDock(s);
  const mini = windows.getMini();
  if (mini) mini.webContents.send('timer:state', s);
}

module.exports = { createTray, applyTimerState };
