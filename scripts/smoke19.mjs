import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// レビュー指摘の修正検証:
//  P1) スリープ/スロットリングでタイマーが超過しても実時間(durationSec)が膨らまない
//  P2) 実行中に選択タスクを削除しても、進行中セグメントに削除済みIDが残らない
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForFunction(() => typeof startPauseResume === 'function', { timeout: 15000 });

// ===== P1: 25分タイマー開始直後に3時間スリープ→復帰したと仮定して完了させる =====
await page.evaluate(() => {
  startPauseResume(); // work 開始
  const now = Date.now();
  const H3 = 3 * 60 * 60 * 1000;
  timer.totalMs = 25 * 60 * 1000;
  timer.current.startedAt = new Date(now - H3).toISOString();
  timer.current.intStartAt = now - H3;          // 区間は3時間前に開いた
  timer.endAt = now - H3 + 25 * 60 * 1000;       // 予定終了は「開始+25分」(=すでに過去)
  finishSession(true);                            // スリープ復帰時の tick 相当
});
await page.waitForTimeout(500);
const saved1 = await page.evaluate(() => window.api.loadData());
const work1 = (saved1.sessions || []).find(s => s.mode === 'work');
const ivLenMin = work1 && work1.intervals[0]
  ? (new Date(work1.intervals[0].endedAt) - new Date(work1.intervals[0].startedAt)) / 60000 : -1;

// ===== P2: 実行中に選択タスクを削除し、進行中セグメントに削除済みIDが残らない =====
const delId = await page.evaluate(() => {
  timer.mode = 'work';
  const t = addTask('削除テスト');
  selectTask(t.id);
  startPauseResume();
  return t.id;
});
await page.waitForTimeout(1300); // closeSegment が区間を積む閾値(>=1s)を超える
const seg = await page.evaluate(id => {
  deleteTask(id);
  const c = timer.current;
  return {
    segTaskId: c ? c.segTaskId : 'no-current',
    segIds: c ? c.segments.map(s => s.taskId) : [],
    taskGone: !data.tasks.some(x => x.id === id)
  };
}, delId);

console.log('--- RESULT ---');
console.log('P1 work durationSec:', work1 && work1.durationSec, '/ interval len(min):', Math.round(ivLenMin));
console.log('P2 segTaskId:', seg.segTaskId, '/ segIds:', JSON.stringify(seg.segIds), '/ taskGone:', seg.taskGone);
console.log('errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(!!work1, 'P1: work session recorded');
assert(work1 && Math.abs(work1.durationSec - 1500) < 60, `P1: durationSec clamped to ~25min (got ${work1 && work1.durationSec})`);
assert(Math.abs(ivLenMin - 25) < 1, 'P1: interval end clipped to scheduled end (~25min)');
assert(seg.taskGone, 'P2: task removed from list');
assert(seg.segTaskId === null, 'P2: ongoing segment task cleared after delete');
assert(!seg.segIds.includes(delId), 'P2: no segment retains the deleted task id');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
