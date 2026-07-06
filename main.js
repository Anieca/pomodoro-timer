const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

function createWindow() {
  const win = new BrowserWindow({
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
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('data:load', () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('data:save', (_e, data) => {
  // クラッシュ時の破損を防ぐためアトミックに書き込む
  const tmp = DATA_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE());
  return true;
});

ipcMain.handle('sounds:list', () => {
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

ipcMain.handle('sounds:openDir', () => {
  const dir = USER_SOUNDS_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  shell.openPath(dir);
});

ipcMain.on('win:focus', e => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

ipcMain.on('win:attention', e => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isFocused() && app.dock) app.dock.bounce('informational');
});

ipcMain.handle('sounds:read', (_e, name) => {
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
  const s = String(v ?? '');
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

ipcMain.handle('data:export', async (e, { format, data }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const stamp = new Date().toISOString().slice(0, 10);
  const defs = {
    json: { name: `pomodoro-export-${stamp}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] },
    'csv-sessions': { name: `sessions-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] },
    'csv-tasks': { name: `tasks-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }
  };
  const def = defs[format];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: def.name,
    filters: def.filters
  });
  if (canceled || !filePath) return { saved: false };

  const taskTitle = id => (data.tasks.find(t => t.id === id) || {}).title || '(削除済み)';
  const MODE_LABEL = { work: 'フォーカス', short: '小休憩', long: '長休憩' };
  let content;
  const min = sec => Math.round((sec / 60) * 10) / 10;
  const sessions = data.sessions || [];
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
    for (const t of data.tasks) {
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
  fs.writeFileSync(filePath, content, 'utf8');
  return { saved: true, filePath };
});
