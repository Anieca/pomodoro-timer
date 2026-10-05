// メインプロセスの入口。各機能は main/ 配下に分けてある:
//   windows.js  メイン/ミニウィンドウ      tray.js   Tray・Dock・ミニへの状態反映
//   store.js    保存データの正本と永続化    ipc.js    レンダラとの IPC
//   export.js   JSON / CSV 書き出し        sounds.js 音源
//   power.js    システムスリープの検知      paths.js  ファイルの場所
const { app, BrowserWindow } = require('electron');

// userData の差し替え(テスト用)は、パスを解決するモジュールより先に効かせる。
if (process.env.POMODORO_USER_DATA) app.setPath('userData', process.env.POMODORO_USER_DATA);

const { ICON } = require('./main/paths');
const windows = require('./main/windows');
const { createTray } = require('./main/tray');
const { watchPower } = require('./main/power');
const { ensureUserDir } = require('./main/sounds');
const { registerIpc } = require('./main/ipc');

registerIpc();

app.whenReady().then(() => {
  ensureUserDir();
  // 開発時(electron .)は Dock が既定の Electron アイコンになるため上書きする。
  // 配布版は electron-builder 生成の .icns が使われるので上書きしない(角丸 .icns を優先)。
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    app.dock.setIcon(ICON);
  }
  windows.createWindow();
  createTray();
  watchPower();
  app.on('activate', () => {
    const win = windows.getMain();
    if (win) { win.show(); return; }
    if (BrowserWindow.getAllWindows().length === 0) windows.createWindow();
  });
});

// Cmd+Q など通常終了時は close を抑止せず本当に閉じられるようにする。
app.on('before-quit', () => { app.isQuitting = true; });

// macOS は Tray 常駐のため、ウィンドウを全て閉じても終了しない(メニューから明示終了)。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
