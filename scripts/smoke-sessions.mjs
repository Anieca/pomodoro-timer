import { launchApp, assert } from './test-env.mjs';

// sessions / 休憩記録 / 一時停止区間(intervals)の検証
const { page, errors, close } = await launchApp();

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const dumpSessions = () => page.evaluate(() => data.sessions.map(s => ({
  mode: s.mode, completed: s.completed, durationSec: s.durationSec,
  intervals: s.intervals.length, taskTimes: s.taskTimes.length
})));

// テスト用に短いフォーカス/休憩(秒単位)へ。設定は 1 分未満にできない(正規化で
// 丸まる)ので、モード長を求める関数だけを差し替える。data を直接書き換えても、
// 次の意図の応答で正本のスナップショットに戻されるため効かない。
await page.evaluate(() => { modeDurationMs = () => 3600; });

// --- 1) フォーカスを 一時停止 → 再開 → 完走(intervals が 2 区間になる) ---
await page.fill('.focus-quick-add input', '集中タスク');
await page.press('.focus-quick-add input', 'Enter');
await click('#startBtn');           // 開始
await page.waitForTimeout(1500);
await click('#startBtn');           // 一時停止(区間1を閉じる)
await page.waitForTimeout(1000);    // 一時停止ギャップ
await click('#startBtn');           // 再開(区間2を開く)
await page.waitForTimeout(3000);    // 完走待ち
const afterWork = await dumpSessions();

// --- 2) 休憩(short)を完走 → 休憩も記録される ---
const modeAfterWork = await page.evaluate(() => timer.mode);
await click('#startBtn');           // 休憩開始
await page.waitForTimeout(4500);    // 休憩完走待ち
const afterBreak = await dumpSessions();

// --- 3) 1分未満の中断は記録されない ---
await click('#startBtn');           // フォーカス開始
await page.waitForTimeout(800);
await click('#stopBtn');            // 即中止(<60s)→ 破棄
const afterAbort = await dumpSessions();

// --- 4) 一時停止ギャップが intervals に反映されているか ---
const intervalGap = await page.evaluate(() => {
  const w = data.sessions.find(s => s.mode === 'work' && s.intervals.length === 2);
  if (!w) return null;
  const gap = new Date(w.intervals[1].startedAt) - new Date(w.intervals[0].endedAt);
  const span = new Date(w.endedAt) - new Date(w.startedAt);
  return { gapMs: gap, spanMs: span, durationSec: w.durationSec };
});

const todayStat = await page.evaluate(() => ({
  count: document.querySelector('#todayCount').textContent,
  min: document.querySelector('#todayMin').textContent
}));

// 履歴に休憩行が出るか
await click('#historyBtn');
await page.waitForTimeout(300);
const historyText = await page.evaluate(() => document.querySelector('#historyList').innerText);
await click('#historyClose');

console.log('--- RESULT ---');
console.log('mode after work complete:', modeAfterWork, '(expect short)');
console.log('after work :', JSON.stringify(afterWork));
console.log('after break:', JSON.stringify(afterBreak));
console.log('after abort:', JSON.stringify(afterAbort), '(abort must NOT add a session)');
console.log('pause interval gap:', JSON.stringify(intervalGap));
console.log('today stat (work only):', JSON.stringify(todayStat));
console.log('history text:', JSON.stringify(historyText));

// アサーション
const work = afterWork.find(s => s.mode === 'work');
assert(work && work.completed, 'work session recorded & completed');
assert(work && work.intervals === 2, 'work has 2 intervals (pause split)');
assert(modeAfterWork === 'short', 'switches to short break after work');
assert(afterBreak.some(s => s.mode === 'short' && s.completed), 'break session recorded');
assert(afterBreak.find(s => s.mode === 'short').taskTimes === 0, 'break has no taskTimes');
assert(afterAbort.length === afterBreak.length, 'sub-60s abort is dropped');
assert(intervalGap && intervalGap.gapMs > 500, 'pause gap present in intervals');
assert(intervalGap && intervalGap.spanMs > intervalGap.gapMs, 'span includes pause gap');
assert(todayStat.count === '1', 'today count = 1 completed work (break excluded)');
assert(/休憩/.test(historyText), 'history shows break');
assert(errors.length === 0, 'no console errors');

await close();
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
