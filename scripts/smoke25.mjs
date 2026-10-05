import { _electron as electron } from 'playwright-core';
import { ELECTRON, isAppError } from './test-env.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 統計ビュー(週・月の振り返り)の検証。
//  AE) 週の集計: 開始日で日に帰属させ、休憩・期間外は含めない
//  AF) 前週との比較・タスク別の内訳(タスクなし含む)
//  AG) 月の集計
//  AH) 連続日数: 今日〜の連続と過去の最長
//  AI) 画面: 週7本/月の日数ぶんの棒、草16週、未来へは進めない
//  AJ) 棒をクリックするとその日のタイムテーブルを開く
const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOT = process.env.STATS_SHOT;   // 指定時はスクリーンショットを保存(目視確認用)

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const MIN = 60 * 1000;
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi);
let n = 0;
function work(start, min, { completed = true, taskId = 'a', mode = 'work' } = {}) {
  const end = new Date(start.getTime() + min * MIN);
  return {
    id: `s${n++}`, mode, startedAt: start.toISOString(), endedAt: end.toISOString(),
    durationSec: min * 60, completed, taskIds: taskId ? [taskId] : [],
    taskTimes: mode === 'work' ? [{ taskId, durationSec: min * 60 }] : [],
    intervals: [{ startedAt: start.toISOString(), endedAt: end.toISOString() }]
  };
}
const today = new Date(); today.setHours(9, 0, 0, 0);
const daysAgo = k => { const d = new Date(today); d.setDate(d.getDate() - k); return d; };

const sessions = [
  // 2026-09-14(月)〜09-20(日)の週
  work(at(2026, 9, 14, 10), 25, { taskId: 'a' }),
  work(at(2026, 9, 14, 10, 30), 5, { mode: 'short' }),           // 休憩は集計しない
  work(at(2026, 9, 14, 11), 25, { taskId: 'b' }),
  work(at(2026, 9, 16, 23, 50), 30, { taskId: 'gone' }),          // 日またぎ → 開始日(16日)に帰属 / 削除済みタスク
  work(at(2026, 9, 17, 10), 10, { completed: false, taskId: null }),
  work(at(2026, 9, 21, 0, 10), 25, { taskId: 'a' }),              // 翌週の月曜(週には入らない)
  // 前週
  work(at(2026, 9, 10, 10), 50, { taskId: 'a' }),
  // 過去の最長連続(8/1〜8/5 の5日)
  ...[1, 2, 3, 4, 5].map(d => work(at(2026, 8, d, 10), 25)),
  // 今日・昨日・一昨日(連続3日)。3日前は中断のみ(完走なし)で途切れる
  work(daysAgo(0), 25), work(daysAgo(1), 25), work(daysAgo(2), 25),
  work(daysAgo(3), 25, { completed: false })
];
const seed = {
  tasks: [
    { id: 'a', title: '設計書', completed: false, createdAt: at(2026, 8, 1, 9).toISOString() },
    { id: 'b', title: 'レビュー', completed: false, createdAt: at(2026, 8, 1, 9).toISOString() }
  ],
  sessions
};

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
fs.writeFileSync(path.join(ud, 'pomodoro-data.json'), JSON.stringify(seed));
const app = await electron.launch({
  executablePath: ELECTRON, args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: ud }, timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (isAppError(m)) errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForFunction(() => typeof computeStats === 'function' && data.sessions.length > 0, { timeout: 15000 });

const stats = (range, y, m, d) => page.evaluate(([range, y, m, d]) => {
  const st = computeStats(range, new Date(y, m - 1, d));
  return {
    days: st.days.map(x => Math.round(x.min)),
    sumMin: Math.round(st.sumMin), pomos: st.pomos, prevMin: Math.round(st.prevMin),
    tasks: st.tasks.map(t => [t.taskId, Math.round(t.min)]),
    streak: st.streak
  };
}, [range, y, m, d]);

/* ===== AE: 週の集計 ===== */
const wk = await stats('week', 2026, 9, 16);
console.log('AE:', JSON.stringify(wk));
assert(wk.days.length === 7, 'AE: 週は7日');
assert(JSON.stringify(wk.days) === JSON.stringify([50, 0, 30, 10, 0, 0, 0]), 'AE: 日別は開始日に帰属(日またぎは16日、休憩・翌週は含まない)');
assert(wk.sumMin === 90 && wk.pomos === 3, 'AE: 合計90分・完走3(中断は時間のみ数える)');

/* ===== AF: 前週比・タスク別 ===== */
assert(wk.prevMin === 50, 'AF: 前週の集中時間を比較に使う');
const tmap = Object.fromEntries(wk.tasks.map(([id, m]) => [String(id), m]));
assert(tmap.a === 25 && tmap.b === 25 && tmap.gone === 30 && tmap.null === 10, 'AF: タスク別(削除済み・タスクなし含む)');
assert(wk.tasks[0][0] === 'gone', 'AF: 時間の長い順に並ぶ');

/* ===== AG: 月の集計 ===== */
const mo = await stats('month', 2026, 9, 1);
console.log('AG:', JSON.stringify({ sum: mo.sumMin, pomos: mo.pomos, prev: mo.prevMin }));
assert(mo.days.length === 30, 'AG: 9月は30日');
assert(mo.sumMin === 165 && mo.pomos === 5, 'AG: 月の合計165分・完走5');
assert(mo.prevMin === 125, 'AG: 前月(8月)の合計と比べる');

/* ===== AH: 連続日数 ===== */
console.log('AH:', JSON.stringify(wk.streak));
assert(wk.streak.current === 3, 'AH: 今日から遡った連続日数(中断のみの日で途切れる)');
assert(wk.streak.best === 5, 'AH: 過去の最長連続');

/* ===== AI: 画面 ===== */
await page.click('#statsBtn');
await page.waitForSelector('#statsModal:not([hidden])');
const ui = await page.evaluate(() => ({
  tiles: document.querySelectorAll('.stat-tile').length,
  cols: document.querySelectorAll('.stat-col').length,
  heat: document.querySelectorAll('.heat-grid .heat-cell').length,
  nextDisabled: document.querySelector('#stNext').disabled,
  streak: document.querySelectorAll('.stat-tile-value')[3].textContent
}));
console.log('AI:', JSON.stringify(ui));
assert(ui.tiles === 4, 'AI: 集計タイルが4つ');
assert(ui.cols === 7, 'AI: 週表示は7本');
assert(ui.heat === 16 * 7, 'AI: 草は16週×7日');
assert(ui.nextDisabled, 'AI: 今週より先へは進めない');
assert(ui.streak === '3日', 'AI: 連続日数を表示');

await page.click('#stRange button[data-range="month"]');
const monthCols = await page.evaluate(() => {
  const d = new Date();
  return { cols: document.querySelectorAll('.stat-col').length, expect: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() };
});
assert(monthCols.cols === monthCols.expect, 'AI: 月表示はその月の日数ぶんの棒');

// 2026年9月まで戻ってスクリーンショット用の画面にする
await page.evaluate(() => { statsAnchor = new Date(2026, 8, 1); renderStats(); });
const label = await page.textContent('#stLabel');
assert(label === '2026年9月', 'AI: 月表示のラベル');
const taskRows = await page.evaluate(() => [...document.querySelectorAll('.stat-task-name')].map(e => e.textContent));
assert(taskRows.includes('(削除済み)') && taskRows.includes('タスクなし'), 'AI: 削除済み・タスクなしを区別して表示');
if (SHOT) {
  await page.evaluate(() => { statsRange = 'week'; statsAnchor = new Date(2026, 8, 16); renderStats(); });
  await page.hover('.stat-col:nth-child(1)');
  await page.waitForTimeout(200);
  await page.screenshot({ path: SHOT });
}

/* ===== AJ: 棒クリックでその日のタイムテーブル ===== */
await page.evaluate(() => { statsRange = 'week'; statsAnchor = new Date(2026, 8, 16); renderStats(); });
await page.click('.stat-col:nth-child(3)');
await page.waitForSelector('#timelineModal:not([hidden])');
const tl = await page.evaluate(() => ({
  date: document.querySelector('#tlDate').textContent,
  statsHidden: document.querySelector('#statsModal').hidden,
  blocks: document.querySelectorAll('.timeline-block').length
}));
console.log('AJ:', JSON.stringify(tl));
assert(tl.date.startsWith('2026/9/16'), 'AJ: クリックした日のタイムテーブルを開く');
assert(tl.statsHidden, 'AJ: 統計は閉じる');
assert(tl.blocks >= 1, 'AJ: その日の記録が描かれる');

assert(errors.length === 0, `コンソール/ページエラーが出ない ${JSON.stringify(errors)}`);
await app.close();
