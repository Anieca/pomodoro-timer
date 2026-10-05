'use strict';
// 正本の書き出し(JSON / CSV)。ファイル内容の組み立てだけを担い、保存ダイアログと
// 書き込みは呼び出し側(ipc.js)が行う。
const { MODE_LABEL } = require('../shared/schema');

function csvEscape(v) {
  let s = String(v ?? '');
  // Excel/Google スプレッドシート等の数式注入(CSV injection)対策。
  // 先頭が = + - @ やタブ/復帰のセルは数式として解釈され得るため、先頭に ' を付けて
  // テキストとして扱わせる(タスク名を外部から貼り付ける運用を想定)。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 先頭の BOM は Excel に UTF-8 と認識させるため。
const toCsv = rows => '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\n');

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const minutes = sec => Math.round((sec / 60) * 10) / 10;

function sessionsCsv({ tasks, sessions }) {
  const taskTitle = id => (tasks.find(t => t.id === id) || {}).title || '(削除済み)';
  const rows = [['ID', '種別', '開始', '終了', '実時間(分)', '完走', '一時停止回数', '実働区間', 'タスク内訳']];
  for (const p of sessions) {
    const intervals = p.intervals || [{ startedAt: p.startedAt, endedAt: p.endedAt }];
    rows.push([
      p.id,
      MODE_LABEL[p.mode] || p.mode || '',
      fmtDate(p.startedAt),
      fmtDate(p.endedAt),
      minutes(p.durationSec),
      p.completed ? 'はい' : 'いいえ',
      Math.max(0, intervals.length - 1),
      intervals.map(iv => `${fmtDate(iv.startedAt)}〜${fmtDate(iv.endedAt)}`).join('; '),
      (p.taskTimes || [])
        .map(tt => `${tt.taskId ? taskTitle(tt.taskId) : '(未割当)'}: ${minutes(tt.durationSec)}分`)
        .join('; ')
    ]);
  }
  return toCsv(rows);
}

function tasksCsv({ tasks, sessions }) {
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
      minutes(totalSec)
    ]);
  }
  return toCsv(rows);
}

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];
const CSV_FILTER = [{ name: 'CSV', extensions: ['csv'] }];
const FORMATS = {
  json: { name: 'pomodoro-export', filters: JSON_FILTER, ext: 'json', build: data => JSON.stringify(data, null, 2) },
  'csv-sessions': { name: 'sessions', filters: CSV_FILTER, ext: 'csv', build: sessionsCsv },
  'csv-tasks': { name: 'tasks', filters: CSV_FILTER, ext: 'csv', build: tasksCsv }
};

// 未知のフォーマットは null(IPC 境界の防御)。
function exportFormat(format) {
  const def = Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
  if (!def) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  return { defaultPath: `${def.name}-${stamp}.${def.ext}`, filters: def.filters, build: def.build };
}

module.exports = { exportFormat };
