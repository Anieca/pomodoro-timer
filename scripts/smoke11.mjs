import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// sessions / 休憩記録 / 一時停止区間(intervals)の検証
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
// app.js の評価完了を待つ(#startBtn は静的 HTML で先に出るため固定待ちはレースになる)
await page.waitForFunction(() => typeof data !== 'undefined' && Array.isArray(data.sessions), { timeout: 15000 });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const dumpSessions = () => page.evaluate(() => data.sessions.map(s => ({
  mode: s.mode, completed: s.completed, durationSec: s.durationSec,
  intervals: s.intervals.length, taskTimes: s.taskTimes.length
})));

// テスト用に短いフォーカス/休憩(秒単位)へ。設定値は分なので 0.06 分 ≈ 3.6 秒。
await page.evaluate(() => { data.settings.workMin = 0.06; data.settings.shortMin = 0.06; });

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
await page.evaluate(() => { if (timer.mode !== 'work') {} });
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
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
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

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
