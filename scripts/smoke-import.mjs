import { launchApp, assert, dataFile } from './test-env.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

// JSON インポートの検証(ネイティブのダイアログは main 側で差し替える):
//  A) 選んだファイルの内容で正本を置き換え、元のデータを .before-import- に控える
//  B) 確認でキャンセルしたら何も変えない
//  C) このアプリのデータでないファイルは、確認を出す前に断る
//  D) タイマーの実行中は受け付けない(ファイルを選ばせない)
//  E) エクスポートした JSON を読み戻すと、同じ正本に戻る
//  F) インポート前の削除は、インポート後に取り消しても戻らない
// 中身の検証(何を断り、何を通すか)は schema-test.mjs で見る。

const readData = ud => JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));
const backups = ud => fs.readdirSync(ud).filter(f => f.startsWith('pomodoro-data.json.before-import-'));
const iso = h => new Date(2026, 0, 15, h, 0, 0, 0).toISOString();
const task = (id, title) => ({ id, title, completed: false, createdAt: iso(8), completedAt: null });

const SEED = { tasks: [task('old', '元のタスク')], sessions: [], selectedTaskId: 'old', settings: {} };
const IMPORTED = {
  tasks: [task('n1', '読み込んだタスク1'), task('n2', '読み込んだタスク2')],
  sessions: [{
    id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(9), endedAt: iso(10),
    intervals: [{ startedAt: iso(9), endedAt: iso(10) }], taskIds: ['n1'], taskTimes: [{ taskId: 'n1', durationSec: 1500 }]
  }],
  selectedTaskId: 'n2',
  settings: { workMin: 30, shortMin: 7 },
  timer: { mode: 'short', cycle: 1 }
};

// 開く・確認・保存のダイアログを差し替え、呼ばれた回数を数える。
// confirm: 確認で押すボタン(0=置き換える, 1=キャンセル)
const stubDialogs = (app, { open, confirm = 0, save }) => app.evaluate(({ dialog }, o) => {
  globalThis.dialogCalls = { open: 0, confirm: 0 };
  dialog.showOpenDialog = async () => { globalThis.dialogCalls.open++; return { canceled: false, filePaths: [o.open] }; };
  dialog.showMessageBox = async () => { globalThis.dialogCalls.confirm++; return { response: o.confirm }; };
  if (o.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: o.save });
}, { open, confirm, save });
const dialogCalls = app => app.evaluate(() => globalThis.dialogCalls);

const titles = page => page.evaluate(() => [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent));
const toastText = page => page.evaluate(() => document.querySelector('#toast').textContent);
// 履歴モーダルを開いてインポートを押し、応答(トースト)まで待つ
async function clickImport(page) {
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  await page.click('#historyBtn');
  await page.click('#importBtn');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 }).catch(() => {});
}

/* ===== A: 置き換えと控え ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: SEED });
  const src = path.join(ud, 'import.json');
  fs.writeFileSync(src, JSON.stringify(IMPORTED));
  const before = fs.readFileSync(dataFile(ud), 'utf8');
  await stubDialogs(app, { open: src });
  await clickImport(page);

  const saved = readData(ud);
  const bk = backups(ud);
  const state = await page.evaluate(() => ({
    mode: timer.mode, cycle: timer.cycle, totalMs: timer.totalMs,
    history: document.querySelectorAll('#historyList .history-item').length
  }));
  console.log('A: tasks=', JSON.stringify(saved.tasks.map(t => t.id)), 'backups=', bk, 'state=', JSON.stringify(state));
  assert(JSON.stringify(saved.tasks.map(t => t.id)) === '["n1","n2"]', 'A: ディスクの正本がファイルの内容になる');
  assert(saved.sessions.length === 1 && saved.selectedTaskId === 'n2', 'A: 記録と選択も置き換わる');
  assert(saved.settings.workMin === 30 && saved.settings.shortMin === 7, 'A: 設定も置き換わる');
  assert(JSON.stringify(await titles(page)) === '["読み込んだタスク1","読み込んだタスク2"]', 'A: 画面のタスクも置き換わる');
  assert(state.history === 1, 'A: 開いている履歴も描き直す');
  assert(state.mode === 'short' && state.cycle === 1, 'A: タイマーの進行状態を取り込む');
  assert(state.totalMs === 7 * 60 * 1000, 'A: 残り時間は取り込んだ設定の長さになる');
  assert(bk.length === 1 && fs.readFileSync(path.join(ud, bk[0]), 'utf8') === before, 'A: 置き換える前の保存ファイルを控える');
  assert(/インポートしました/.test(await toastText(page)), 'A: 完了をトーストで知らせる');
  assert(errors.length === 0, 'A: コンソールエラーなし');
  await close();
}

/* ===== B: 確認でキャンセル ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: SEED });
  const src = path.join(ud, 'import.json');
  fs.writeFileSync(src, JSON.stringify(IMPORTED));
  const before = fs.readFileSync(dataFile(ud), 'utf8');
  await stubDialogs(app, { open: src, confirm: 1 });
  await clickImport(page);
  await page.waitForTimeout(300);
  const calls = await dialogCalls(app);
  console.log('B: calls=', JSON.stringify(calls));
  assert(calls.confirm === 1, 'B: 置き換える前に確認する');
  assert(fs.readFileSync(dataFile(ud), 'utf8') === before, 'B: キャンセルしたらディスクは変わらない');
  assert(JSON.stringify(await titles(page)) === '["元のタスク"]', 'B: 画面も変わらない');
  assert(backups(ud).length === 0, 'B: 控えも作らない');
  assert(errors.length === 0, 'B: コンソールエラーなし');
  await close();
}

/* ===== C: このアプリのデータでないファイル ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: SEED });
  const before = fs.readFileSync(dataFile(ud), 'utf8');
  for (const [name, content] of [['空のオブジェクト', '{}'], ['壊れた JSON', '{ tasks: ']]) {
    const src = path.join(ud, 'wrong.json');
    fs.writeFileSync(src, content);
    await stubDialogs(app, { open: src });
    await clickImport(page);
    const calls = await dialogCalls(app);
    const text = await toastText(page);
    console.log(`C(${name}): calls=`, JSON.stringify(calls), 'toast=', text);
    assert(calls.confirm === 0, `C(${name}): 確認を出す前に断る`);
    assert(/インポートに失敗しました/.test(text), `C(${name}): 失敗をトーストで知らせる`);
    await page.click('#historyClose');
  }
  assert(fs.readFileSync(dataFile(ud), 'utf8') === before, 'C: ディスクは変わらない');
  assert(backups(ud).length === 0, 'C: 控えも作らない');
  assert(errors.length === 0, 'C: コンソールエラーなし');
  await close();
}

/* ===== D: タイマーの実行中 ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: SEED });
  const src = path.join(ud, 'import.json');
  fs.writeFileSync(src, JSON.stringify(IMPORTED));
  await stubDialogs(app, { open: src });
  await page.click('#startBtn');
  await clickImport(page);
  const calls = await dialogCalls(app);
  const text = await toastText(page);
  console.log('D: calls=', JSON.stringify(calls), 'toast=', text);
  assert(calls.open === 0, 'D: 実行中はファイルを選ばせない');
  assert(/タイマーを止めて/.test(text), 'D: 止めるよう知らせる');
  assert(readData(ud).tasks[0].id === 'old', 'D: ディスクは変わらない');
  assert(errors.length === 0, 'D: コンソールエラーなし');
  await close();
}

/* ===== E: エクスポートしたものを読み戻す ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: IMPORTED });
  const out = path.join(ud, 'export.json');
  await stubDialogs(app, { open: out, save: out });
  const exported = await page.evaluate(() => window.api.exportData('json'));
  // 起動時に置いた seed は正規化前なので、比べる相手は書き出した正本にする
  const original = JSON.parse(fs.readFileSync(out, 'utf8'));
  // 書き出したあとに変えた分が、読み戻しで元に戻ることを見る
  await page.evaluate(() => mutate({ type: 'task/rename', id: 'n1', title: '書き出し後に変更' }));
  await clickImport(page);
  console.log('E: exported=', exported.saved);
  assert(exported.saved === true, 'E: エクスポートできる');
  assert(JSON.stringify(readData(ud)) === JSON.stringify(original), 'E: 読み戻すとエクスポートした時点の正本に戻る');
  assert(errors.length === 0, 'E: コンソールエラーなし');
  await close();
}

/* ===== F: インポート前の削除の取り消し ===== */
{
  const { app, page, errors, userData: ud, close } = await launchApp({ seed: SEED });
  const src = path.join(ud, 'import.json');
  fs.writeFileSync(src, JSON.stringify(IMPORTED));
  await stubDialogs(app, { open: src });
  await page.evaluate(() => window.api.mutate({ type: 'task/delete', id: 'old' }));
  await clickImport(page);
  // 取り消しのボタンはトーストに残りうる。押されても、置き換え前のタスクを持ち込まない。
  const res = await page.evaluate(() => window.api.mutate({ type: 'task/undelete', id: 'old' }));
  const ids = readData(ud).tasks.map(t => t.id);
  console.log('F: undelete ok=', res.ok, 'tasks=', JSON.stringify(ids));
  assert(!ids.includes('old'), 'F: インポート前に削除したタスクは戻らない');
  assert(errors.length === 0, 'F: コンソールエラーなし');
  await close();
}

console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
