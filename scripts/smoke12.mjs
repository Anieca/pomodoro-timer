import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 旧 pomodoros スキーマ(mode / intervals / taskTimes なし)からの移行検証
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// taskTimes も intervals も mode も持たない最古の形式を仕込む
fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: '旧タスク', completed: false, createdAt: '2026-06-09T01:00:00Z', completedAt: null }],
  pomodoros: [
    { id: 'p1', startedAt: '2026-06-09T01:00:00Z', endedAt: '2026-06-09T01:25:00Z', durationSec: 1500, completed: true, taskIds: ['t1'] },
    { id: 'p2', startedAt: '2026-06-09T02:00:00Z', endedAt: '2026-06-09T02:10:00Z', durationSec: 600, completed: false, taskIds: [] }
  ],
  selectedTaskId: null,
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4 }
}));

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
await page.waitForTimeout(800);

// 移行後の sessions 形状(taskTimes/intervals/mode が補われているか)
const migrated = await page.evaluate(() => data.sessions.map(s => {
  const sumSec = s.intervals.reduce((a, iv) => a + (new Date(iv.endedAt) - new Date(iv.startedAt)) / 1000, 0);
  return {
    mode: s.mode,
    hasTaskTimes: Array.isArray(s.taskTimes),
    hasTaskIds: Array.isArray(s.taskIds),
    intervals: Array.isArray(s.intervals) ? s.intervals.length : null,
    durationSec: s.durationSec,
    intervalSumSec: Math.round(sumSec)
  };
}));

// taskStats(旧コードでクラッシュした経路)が例外なく回るか
const statOk = await page.evaluate(() => {
  try { return typeof taskStats('t1').minutes === 'number'; } catch { return false; }
});

// 履歴描画(p.taskTimes を舐める経路)が例外なく回るか
await page.evaluate(() => document.querySelector('#historyBtn').click());
await page.waitForTimeout(300);
const historyText = await page.evaluate(() => document.querySelector('#historyList').innerText);
await page.evaluate(() => document.querySelector('#historyClose').click());

console.log('--- RESULT ---');
console.log('migrated sessions:', JSON.stringify(migrated));
console.log('taskStats ok:', statOk);
console.log('history rendered (chars):', historyText.length);
console.log('console/page errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(migrated.length === 2, 'both old records migrated');
assert(migrated.every(s => s.mode === 'work'), 'mode defaulted to work');
assert(migrated.every(s => s.hasTaskTimes && s.hasTaskIds), 'taskTimes/taskIds normalized to arrays');
assert(migrated.every(s => s.intervals === 1), 'synthesized one interval per record');
assert(migrated.every(s => s.intervalSumSec === s.durationSec), 'interval length equals durationSec (no over-count)');
assert(statOk, 'taskStats runs without throwing');
assert(historyText.length > 0, 'history rendered without throwing');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
