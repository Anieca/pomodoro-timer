// メニューバー(Tray)と Dock。状態は Host から直接読むので、ウィンドウが無くても動く。
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { fmtClock, timerView, type TimerView } from '../core/derive.ts';
import { KIND_LABEL, isOpenTask, type Data } from '../core/model.ts';
import type { Host } from './host.ts';
import { ICON } from './paths.ts';
import * as windows from './windows.ts';

const IS_MAC = process.platform === 'darwin';
const APP_NAME = 'Pomodoro Atelier';

let tray: Tray | null = null;
let lastTitle = '';
let lastMenuKey = '';
let lastBadge = '';

const MARK = { focus: '●', short: '○', long: '○' } as const;

function title(v: TimerView): string {
  if (v.status === 'idle') return ` ${MARK[v.kind]}`;
  return ` ${v.status === 'paused' ? '❙❙' : MARK[v.kind]} ${fmtClock(v.remainingMs)}`;
}

function summary(v: TimerView): string {
  if (v.status === 'idle') return APP_NAME;
  return `${APP_NAME} — ${v.status === 'paused' ? '一時停止' : KIND_LABEL[v.kind]} ${fmtClock(v.remainingMs)}`;
}

function menu(host: Host, data: Data, v: TimerView): Menu {
  const send = host.dispatch.bind(host);
  const open = data.tasks.filter(isOpenTask);
  const active = open.find(t => t.id === data.activeTaskId);
  const isBreak = v.kind !== 'focus';
  const items: MenuItemConstructorOptions[] = [
    { label: active ? `いま: ${active.title}` : 'タスクを選んでいません', enabled: false },
    { type: 'separator' },
    {
      label: v.status === 'running' ? '一時停止' : v.status === 'paused' ? '再開' : `${KIND_LABEL[v.kind]}を始める`,
      click: () => send({ type: 'timer/toggle' })
    },
    { label: '5分のばす', enabled: v.status !== 'idle', click: () => send({ type: 'timer/extend', minutes: 5 }) },
    {
      label: isBreak ? (v.status === 'idle' ? '休憩を飛ばす' : '休憩を終える') : '中断する',
      enabled: v.status !== 'idle' || isBreak,
      click: () => send({ type: 'timer/stop' })
    },
    { type: 'separator' },
    {
      label: 'タスクを切り替える',
      enabled: open.length > 0,
      submenu: [
        ...open.slice(0, 20).map((t): MenuItemConstructorOptions => ({
          label: t.title,
          type: 'radio',
          checked: t.id === data.activeTaskId,
          click: () => send({ type: 'task/activate', id: t.id })
        })),
        { type: 'separator' },
        { label: 'タスクなし', type: 'radio', checked: data.activeTaskId === null, click: () => send({ type: 'task/activate', id: null }) }
      ]
    },
    { type: 'separator' },
    { label: windows.getMini() ? 'ミニタイマーを隠す' : 'ミニタイマーを表示', click: () => windows.toggleMini() },
    { label: 'ウィンドウを表示', click: () => windows.showMain() },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ];
  return Menu.buildFromTemplate(items);
}

function image(): Electron.NativeImage {
  // macOS は文字(タイトル)を主役にするので空画像。ほかはアイコンが無いと Tray 自体が見えない。
  if (IS_MAC) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

export function createTray(host: Host): void {
  const view = (): TimerView => timerView(host.snapshot().data, host.now());
  const popUp = (): void => tray?.popUpContextMenu(menu(host, host.snapshot().data, view()));

  try {
    tray = new Tray(image());
  } catch {
    // 一部の Linux 環境では Tray を作れない。アプリ本体は起動させる。
    tray = null;
  }
  if (tray) {
    tray.setToolTip(APP_NAME);
    if (IS_MAC) {
      // 左クリックで開始/一時停止、右クリックでメニュー。setContextMenu を使うと
      // 左クリックでもメニューが開いてしまうので、都度組み立てて出す。
      tray.on('click', () => host.dispatch({ type: 'timer/toggle' }));
      tray.on('right-click', popUp);
    } else {
      tray.on('click', popUp);
    }
  }

  const refresh = (): void => {
    const data = host.snapshot().data;
    const v = view();
    if (tray) {
      if (IS_MAC) {
        const t = title(v);
        if (t !== lastTitle) tray.setTitle((lastTitle = t), { fontType: 'monospacedDigit' });
      } else {
        tray.setToolTip(summary(v));
        // setContextMenu は固定なので、内容が変わるときだけ貼り替える
        const key = [v.status, v.kind, data.activeTaskId, windows.getMini() ? 1 : 0, data.tasks.filter(isOpenTask).map(t => t.id + t.title).join()].join('|');
        if (key !== lastMenuKey) { lastMenuKey = key; tray.setContextMenu(menu(host, data, v)); }
      }
    }
    // Dock: 残り分のバッジと、経過のプログレスバー
    const badge = v.status === 'running' ? String(Math.ceil(v.remainingMs / 60_000)) : '';
    if (IS_MAC && badge !== lastBadge) app.dock?.setBadge((lastBadge = badge));
    windows.getMain()?.setProgressBar(v.status === 'idle' ? -1 : v.progress);
  };

  host.on('pulse', refresh);
  host.on('change', refresh);
  windows.onMiniChanged(refresh);
  refresh();
}
