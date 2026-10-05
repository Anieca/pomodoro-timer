'use strict';
// レンダラとの IPC の受け口。preload.js が公開する API と一対一に対応する。
// 発信元の検証(isTrusted)はすべてここで行い、各モジュールは検証済みの要求だけを受ける。
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const { DEFAULT_SETTINGS } = require('../shared/schema');
const windows = require('./windows');
const store = require('./store');
const sounds = require('./sounds');
const tray = require('./tray');
const { exportFormat } = require('./export');

const { isTrusted } = windows;
const UNTRUSTED = { ok: false, error: 'untrusted sender' };

// 応答には必ず正本を添える。成功なら適用結果、失敗なら適用前の内容が入るので、
// レンダラはどちらでもそれを描けば画面と保存内容が食い違わない。
// 原本を退避したことは黙らせない(preserved。レンダラがトーストで知らせる)。
function mutate(action, senderWc) {
  try {
    const preserved = store.commit(action, senderWc);
    return preserved
      ? { ok: true, snapshot: store.snapshot(), preserved }
      : { ok: true, snapshot: store.snapshot() };
  } catch (err) {
    return { ok: false, error: store.errorMessage(err), snapshot: store.snapshot() };
  }
}

async function exportData(e, payload) {
  // 書き出すのは正本。レンダラから受け取った blob を書き出していた頃は、
  // 保存されていない内容や検証を通っていない値がそのまま出力されえた。
  const def = exportFormat((payload || {}).format);
  if (!def) return { saved: false, error: 'invalid request' };
  const content = def.build(store.snapshot());
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: def.defaultPath,
    filters: def.filters
  });
  if (canceled || !filePath) return { saved: false };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    return { saved: false, error: store.errorMessage(err) };
  }
  return { saved: true, filePath };
}

function registerIpc() {
  /* ---- タイマー(Tray / Dock / ミニ) ---- */
  // 状態の発信元はメインウィンドウのみ(ミニ等からの誤送信は無視する)。
  ipcMain.on('timer:state', (e, state) => {
    if (windows.isMainSender(e)) tray.applyTimerState(state);
  });
  // ミニウィンドウからの操作要求を本体タイマーに転送する。
  ipcMain.on('ui:command', (e, cmd) => {
    if (!isTrusted(e)) return;
    if (cmd === 'toggleMini') windows.toggleMini();
    else windows.sendCommand(cmd);
  });
  ipcMain.on('mini:toggle', e => { if (isTrusted(e)) windows.toggleMini(); });

  /* ---- 保存データ ---- */
  // 呼び出し元へは戻り値で渡る(他のウィンドウへは data:snapshot で配られる)。
  ipcMain.handle('data:load', e => (isTrusted(e) ? store.load(e.sender) : null));
  // preload がウィンドウ生成直後に同期で取りに来る。isTrusted は使えない
  // (mainWin.webContents はまだこの sender と結び付いていないことがある)が、
  // 返すのは定数の既定値だけで、渡す情報は無い。
  ipcMain.on('data:defaults', e => { e.returnValue = DEFAULT_SETTINGS; });
  // 終了直前に正本を同期で読む(beforeunload 用)。main は意図を受け取った順に処理する
  // ので、ここで返す正本にはレンダラが送った意図がすべて反映されている。
  ipcMain.on('data:snapshot-sync', e => { e.returnValue = isTrusted(e) ? store.snapshot() : null; });
  ipcMain.handle('data:consume-warning', e => (isTrusted(e) ? store.consumeLoadWarning() : null));
  ipcMain.handle('data:mutate', (e, action) => (isTrusted(e) ? mutate(action, e.sender) : UNTRUSTED));

  // 終了直前の同期の意図。sendSync でレンダラをブロックし、書き込み完了を保証する。
  // 通常の保存は意図ごとに即ディスクへ乗るため、ここを通るのは終了時に実行中
  // セッションを打ち切って記録する一件だけ。
  // 失敗は握りつぶさず、ユーザーが気づけるようネイティブダイアログで通知する。
  ipcMain.on('data:mutate-sync', (e, action) => {
    if (!isTrusted(e)) { e.returnValue = UNTRUSTED; return; }
    const res = mutate(action, e.sender);
    try {
      if (!res.ok) {
        dialog.showErrorBox('保存に失敗しました', 'データを保存できませんでした:\n' + res.error);
      } else if (res.preserved) {
        // 何も保存せずに終了/リロードした場合、原本を退避するのはこの同期保存が最初になる。
        // 呼び出し元(beforeunload)は戻り値を使えずトーストも出せないため、退避先を伝える
        // 手段がここしかない。黙って移すと次回起動は普通に空で開き、原本を追えなくなる。
        dialog.showMessageBoxSync({
          type: 'warning',
          title: '元のデータファイルを退避しました',
          message: '起動時に読み込めなかったデータファイルを退避し、新しいファイルに保存しました。',
          detail: '退避先:\n' + res.preserved
        });
      }
    } catch {}
    e.returnValue = res;
  });

  ipcMain.handle('data:export', (e, payload) => (isTrusted(e) ? exportData(e, payload) : { saved: false, error: 'untrusted sender' }));

  /* ---- 音源 ---- */
  ipcMain.handle('sounds:list', e => (isTrusted(e) ? sounds.listSounds() : []));
  ipcMain.handle('sounds:read', (e, name) => (isTrusted(e) ? sounds.readSound(name) : null));
  ipcMain.handle('sounds:openDir', e => { if (isTrusted(e)) sounds.openUserDir(); });

  /* ---- ウィンドウ ---- */
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
}

module.exports = { registerIpc };
