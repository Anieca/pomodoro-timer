const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.POMODORO_USER_DATA) app.setPath('userData', process.env.POMODORO_USER_DATA);

const DATA_FILE = () => path.join(app.getPath('userData'), 'pomodoro-data.json');
const SOUNDS_DIR = path.join(__dirname, 'assets', 'sounds');
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16110e',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // macOS の Dock アイコン(開発時も反映される)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'logo.png'));
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
  try {
    return fs.readdirSync(SOUNDS_DIR)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, path: path.join(SOUNDS_DIR, f) }));
  } catch {
    return [];
  }
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
  const file = path.join(SOUNDS_DIR, path.basename(name));
  if (!AUDIO_EXTS.has(path.extname(file).toLowerCase())) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
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
