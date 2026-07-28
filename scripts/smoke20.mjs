import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// データ堅牢性の検証:
//  A) 破損ファイル(回復不可) → 空起動 + 原本を .corrupt- に退避 + 警告トースト
//  B) 破損ファイル + 有効な .tmp → 直近保存から復元し、破損本体を退避
//  C) 破損した settings / sessions → クラッシュせず clamp / 正規化される
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

async function launch(userData) {
  const app = await electron.launch({
    executablePath: EXE, args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: userData }, timeout: 30000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForSelector('#startBtn', { timeout: 15000 });
  await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });
  await page.waitForTimeout(300); // init の consumeLoadWarning / render 完了待ち
  return { app, page, errors };
}
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const dataFile = ud => path.join(ud, 'pomodoro-data.json');
const backups = ud => fs.readdirSync(ud).filter(f => f.startsWith('pomodoro-data.json.corrupt-'));

/* ===== A: 回復不可の破損 ===== */
{
  const ud = mkdir();
  const corrupt = '{ this is : not valid json ,,, ';
  fs.writeFileSync(dataFile(ud), corrupt);
  const { app, page, errors } = await launch(ud);
  const taskCount = await page.evaluate(() => document.querySelectorAll('#taskList .task-item').length);
  const toast = await page.evaluate(() => ({ hidden: document.querySelector('#toast').hidden, text: document.querySelector('#toast').textContent }));
  const bk = backups(ud);
  console.log('A: tasks=', taskCount, 'toast=', JSON.stringify(toast), 'backups=', bk);
  assert(taskCount === 0, 'A: 破損時は空起動(タスク0)');
  assert(bk.length === 1, 'A: 破損本体を .corrupt- に退避');
  assert(fs.readFileSync(path.join(ud, bk[0]), 'utf8') === corrupt, 'A: 退避ファイルは原本を保全');
  assert(!toast.hidden && /破損/.test(toast.text), 'A: 破損の警告トーストを表示');
  assert(errors.length === 0, 'A: コンソールエラーなし');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== B: .tmp からの回復 ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), '{ broken ,,, ');
  const good = { tasks: [{ id: 'r1', title: '復元タスク', completed: false, createdAt: new Date().toISOString(), completedAt: null }], sessions: [], selectedTaskId: null, settings: {} };
  fs.writeFileSync(dataFile(ud) + '.tmp', JSON.stringify(good));
  const { app, page, errors } = await launch(ud);
  const titles = await page.evaluate(() => [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent));
  const bk = backups(ud);
  const promoted = JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));
  console.log('B: titles=', JSON.stringify(titles), 'backups=', bk, 'promoted has r1=', !!promoted.tasks.find(t => t.id === 'r1'));
  assert(titles.includes('復元タスク'), 'B: .tmp から復元したタスクを表示');
  assert(bk.length === 1, 'B: 破損本体を退避');
  assert(!!promoted.tasks.find(t => t.id === 'r1'), 'B: 本体ファイルを回復データで置換');
  assert(errors.length === 0, 'B: コンソールエラーなし');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== C: 不正な settings / sessions の正規化・clamp ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [{ id: 't1', title: 'A', completed: false, createdAt: new Date().toISOString(), completedAt: null }],
    // 壊れた/欠損セッション: taskIds/taskTimes/intervals 欠如、durationSec 文字列
    sessions: [
      { id: 's1', mode: 'work', startedAt: new Date().toISOString(), durationSec: 'oops' },
      { id: 's2', mode: 'bogus', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), taskTimes: [{ taskId: 't1' }] }
    ],
    selectedTaskId: null,
    settings: { workMin: 'x', shortMin: -5, longMin: 99999, longEvery: 1000000000, whiteNoise: { volume: 500 } }
  }));
  const { app, page, errors } = await launch(ud);
  const view = await page.evaluate(() => ({
    dots: document.querySelectorAll('#cycleDots i').length,
    time: document.querySelector('#timeDisplay').textContent,
    every: data.settings.longEvery, work: data.settings.workMin, vol: data.settings.whiteNoise.volume
  }));
  // 履歴を開いて壊れたセッションの描画がクラッシュしないことを確認
  await page.evaluate(() => document.querySelector('#historyBtn').click());
  await page.waitForTimeout(200);
  const histOpen = await page.evaluate(() => !document.querySelector('#historyModal').hidden);
  console.log('C: view=', JSON.stringify(view), 'historyOpen=', histOpen);
  assert(view.every === 12, 'C: longEvery を 12 に clamp');
  assert(view.dots === 12, 'C: cycle dots が clamp 後の個数で描画');
  assert(view.work === 25, 'C: 不正な workMin を既定値へ');
  assert(view.vol === 100, 'C: volume を 100 に clamp');
  assert(/^\d\d:\d\d$/.test(view.time) && !/NaN/.test(view.time), 'C: タイマー表示が NaN にならない');
  assert(histOpen, 'C: 壊れたセッションでも履歴が開ける');
  assert(errors.length === 0, 'C: コンソールエラーなし');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
