// 書き出しと読み込み(ファイルを選ぶダイアログから、置き換えまで)。
import { BrowserWindow, dialog, type WebContents } from 'electron';
import * as fs from 'node:fs';
import { parseImport } from '../core/codec.ts';
import { sessionsCsv, tasksCsv } from '../core/derive.ts';
import type { Data } from '../core/model.ts';
import type { ExportFormat, TransferResult } from '../shared/api.ts';
import type { Host } from './host.ts';
import { errorMessage, type Store } from './store.ts';

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];
const CSV_FILTER = [{ name: 'CSV', extensions: ['csv'] }];
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

const FORMATS: Record<ExportFormat, { name: string; ext: string; filters: Electron.FileFilter[]; build(data: Data): string }> = {
  // 進行中のセッションは書き出さない(読み込む側の時計と合わない)
  json: { name: 'pomodoro-atelier', ext: 'json', filters: JSON_FILTER, build: data => JSON.stringify({ ...data, run: null }, null, 2) },
  'csv-sessions': { name: 'sessions', ext: 'csv', filters: CSV_FILTER, build: sessionsCsv },
  'csv-tasks': { name: 'tasks', ext: 'csv', filters: CSV_FILTER, build: tasksCsv }
};

const owner = (wc: WebContents): BrowserWindow => BrowserWindow.fromWebContents(wc)!;

export async function exportData(host: Host, wc: WebContents, format: unknown): Promise<TransferResult> {
  const def = typeof format === 'string' && Object.hasOwn(FORMATS, format) ? FORMATS[format as ExportFormat] : null;
  if (!def) return { ok: false, error: '知らない形式です' };
  const day = new Date().toLocaleDateString('sv-SE');
  const { canceled, filePath } = await dialog.showSaveDialog(owner(wc), {
    defaultPath: `${def.name}-${day}.${def.ext}`,
    filters: def.filters
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, def.build(host.snapshot().data), 'utf8');
    return { ok: true, message: '書き出しました' };
  } catch (err) {
    return { ok: false, error: '書き出せませんでした: ' + errorMessage(err) };
  }
}

export async function importData(host: Host, store: Store, wc: WebContents): Promise<TransferResult> {
  const RUNNING = 'タイマーを止めてから読み込んでください';
  if (host.snapshot().data.run) return { ok: false, error: RUNNING };
  const picked = await dialog.showOpenDialog(owner(wc), { properties: ['openFile'], filters: JSON_FILTER });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };

  let text: string;
  try {
    if (fs.statSync(picked.filePaths[0]).size > MAX_IMPORT_BYTES) return { ok: false, error: 'ファイルが大きすぎます' };
    text = fs.readFileSync(picked.filePaths[0], 'utf8');
  } catch (err) {
    return { ok: false, error: 'ファイルを読めませんでした: ' + errorMessage(err) };
  }
  const parsed = parseImport(text);
  if (!parsed.ok) return parsed;

  const { counts } = parsed;
  const { response } = await dialog.showMessageBox(owner(wc), {
    type: 'warning',
    buttons: ['置き換える', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: 'いまのデータを、このファイルの内容で置き換えますか?',
    detail: `タスク ${counts.tasks} 件・記録 ${counts.sessions} 件を読み込みます。\nいまのデータは、保存先に「.before-import-」の付いた控えとして残します。`
  });
  if (response !== 0) return { ok: false, canceled: true };
  // 確認を待つあいだにタイマーが始まっているかもしれない
  if (host.snapshot().data.run) return { ok: false, error: RUNNING };
  try {
    store.backup('before-import');
    host.replace(parsed.data);
    return { ok: true, message: `読み込みました(タスク ${counts.tasks} 件・記録 ${counts.sessions} 件)` };
  } catch (err) {
    return { ok: false, error: '置き換えられませんでした: ' + errorMessage(err) };
  }
}
