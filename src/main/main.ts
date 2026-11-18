// メインプロセスの入口。Host(エンジン)を一つ立て、ウィンドウ・Tray・IPC・通知をつなぐ。
import { app, ipcMain, Notification, powerMonitor } from 'electron';
import type { Command, Effect } from '../core/engine.ts';
import { KIND_LABEL } from '../core/model.ts';
import { USER_COMMANDS } from '../shared/api.ts';
import { Host } from './host.ts';
import { DATA_FILE, ICON, LEGACY_FILE } from './paths.ts';
import * as sounds from './sounds.ts';
import { Store } from './store.ts';
import { exportData, importData } from './transfer.ts';
import { createTray } from './tray.ts';
import * as windows from './windows.ts';

// userData の差し替え(テスト用)は、パスを解決する前に効かせる。
if (process.env.POMODORO_USER_DATA) app.setPath('userData', process.env.POMODORO_USER_DATA);

function notify(effect: Effect): void {
  if (!Notification.isSupported()) return;
  const focusEnded = effect.kind === 'focus';
  const next = KIND_LABEL[effect.next];
  const n = new Notification({
    title: focusEnded ? 'フォーカスおわり' : '休憩おわり',
    body: (focusEnded && effect.taskTitle ? `「${effect.taskTitle}」 ` : '') +
      (effect.autoStarted ? `${next}を始めました` : `次は${next}です`),
    silent: true // 音は画面側のチャイムが受け持つ
  });
  n.on('click', () => windows.showMain());
  n.show();
}

function isUserCommand(cmd: unknown): cmd is Command {
  return cmd !== null && typeof cmd === 'object' &&
    (USER_COMMANDS as readonly string[]).includes((cmd as { type?: unknown }).type as string);
}

function registerIpc(host: Host, store: Store): void {
  ipcMain.handle('state:get', e => {
    if (!windows.isTrusted(e)) return null;
    // 起動時の知らせはメインウィンドウにだけ渡す(ミニは出す場所を持たない)
    return { ...host.snapshot(), notices: windows.isFromMain(e) ? host.takeNotices() : [] };
  });
  ipcMain.on('cmd', (e, cmd) => {
    if (!windows.isTrusted(e) || !isUserCommand(cmd)) return;
    // 中身は reduce が検めるが、想定外の形で main ごと落ちないようにしておく
    try { host.dispatch(cmd); } catch (err) { console.error('[cmd]', err); }
  });
  ipcMain.handle('data:export', (e, format) =>
    windows.isFromMain(e) ? exportData(host, e.sender, format) : { ok: false, error: 'untrusted' });
  ipcMain.handle('data:import', e =>
    windows.isFromMain(e) ? importData(host, store, e.sender) : { ok: false, error: 'untrusted' });
  ipcMain.handle('sounds:list', e => (windows.isTrusted(e) ? sounds.listSounds() : []));
  ipcMain.handle('sounds:read', (e, name) => (windows.isTrusted(e) ? sounds.readSound(name) : null));
  ipcMain.on('sounds:open', e => { if (windows.isTrusted(e)) sounds.openUserDir(); });
  ipcMain.on('mini:toggle', e => { if (windows.isTrusted(e)) windows.toggleMini(); });
  ipcMain.on('main:show', e => { if (windows.isTrusted(e)) windows.showMain(); });
}

function watchPower(host: Host): void {
  let suspendedAt: number | null = null;
  powerMonitor.on('suspend', () => { suspendedAt = host.now(); });
  powerMonitor.on('resume', () => {
    if (suspendedAt !== null) host.slept(suspendedAt, host.now());
    suspendedAt = null;
  });
}

// 同じ保存ファイルを二つのプロセスが書かないよう、起動は一つだけにする。
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => windows.showMain());

void app.whenReady().then(() => {
  if (!single) return;
  const store = new Store(DATA_FILE(), LEGACY_FILE());
  const host = new Host(store);

  host.on('change', snapshot => windows.broadcast('state', snapshot));
  host.on('notice', message => windows.sendToMain('notice', message));
  host.on('effect', effect => {
    windows.sendToMain('effect', effect);
    // テスト中は、開発機に本物の通知を出さない
    if (process.env.POMODORO_TEST) return;
    notify(effect);
    windows.requestAttention();
  });

  registerIpc(host, store);
  sounds.ensureUserDir();
  // 開発時(electron .)は Dock が既定のアイコンになるので差し替える
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON);
  windows.createMain();
  createTray(host);
  watchPower(host);
  host.start();

  app.on('activate', () => windows.showMain());
  app.on('before-quit', () => {
    windows.setQuitting();
    // 終了は一時停止として残す。次の起動で続きから再開できる。
    host.dispatch({ type: 'timer/pause' });
    host.stop();
  });

  // スモークテストが main の時計を進めるための口
  if (process.env.POMODORO_TEST) (globalThis as { __host?: Host }).__host = host;
});

// macOS はメニューバーに常駐するので、ウィンドウを全部閉じても終了しない。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
