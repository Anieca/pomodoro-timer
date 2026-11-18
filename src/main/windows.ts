// メインウィンドウとミニタイマーの生成と参照。
import { app, BrowserWindow, nativeTheme, screen, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ICON, PRELOAD, page } from './paths.ts';

let mainWin: BrowserWindow | null = null;
let miniWin: BrowserWindow | null = null;
let quitting = false;
const miniListeners: (() => void)[] = [];

const alive = (win: BrowserWindow | null): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);
export const getMain = (): BrowserWindow | null => alive(mainWin);
export const getMini = (): BrowserWindow | null => alive(miniWin);
export const setQuitting = (): void => { quitting = true; };
export const onMiniChanged = (cb: () => void): void => { miniListeners.push(cb); };

// file:// 以外への遷移と新規ウィンドウ生成を禁じる。万一どこかへ遷移しても
// preload の API が外部の origin に晒されないようにする。
function harden(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** IPC の発信元が自前のウィンドウか */
export function isTrusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return [getMain(), getMini()].some(win => win !== null && win.webContents === e.sender);
}

export const isFromMain = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => getMain()?.webContents === e.sender;

const webPreferences = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };

export function createMain(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151618' : '#f7f7f6',
    icon: ICON,
    show: false,
    // 環境音はこのウィンドウが鳴らす。隠れている間もフェードが滞らないようにする。
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  });
  mainWin = win;
  void win.loadFile(page('index.html'));
  harden(win.webContents);
  win.once('ready-to-show', () => win.show());
  // macOS では閉じても隠すだけ(メニューバーに常駐し、環境音も鳴らし続ける)。
  // ほかの OS は Tray が出せない環境があるので、閉じたら終了する。
  win.on('close', e => {
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
  return win;
}

export function showMain(): void {
  const win = getMain() ?? createMain();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createMini(): BrowserWindow {
  const win = new BrowserWindow({
    width: 224,
    height: 92,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences
  });
  miniWin = win;
  // 全画面アプリの上や別のデスクトップでも手前に出す
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(workArea.x + workArea.width - 252, workArea.y + 20);
  void win.loadFile(page('mini.html'));
  harden(win.webContents);
  win.on('closed', () => {
    if (miniWin === win) miniWin = null;
    for (const cb of miniListeners) cb();
  });
  for (const cb of miniListeners) cb();
  return win;
}

export function toggleMini(): void {
  const win = getMini();
  if (win) win.close();
  else createMini();
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of [getMain(), getMini()]) win?.webContents.send(channel, payload);
}

export function sendToMain(channel: string, payload: unknown): void {
  getMain()?.webContents.send(channel, payload);
}

/** Dock を弾ませる(ウィンドウが手前に無いときだけ) */
export function requestAttention(): void {
  const win = getMain();
  if (win?.isFocused()) return;
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else win?.flashFrame(true);
}
