import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// タイムテーブル(1日ビュー)表示の検証。
// 分スケールの確定データを仕込み、ブロック配置・一時停止ギャップ・ナビを検証する。
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// 当日のローカル時刻で ISO を作る(タイムテーブルはローカル時刻で配置する)
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: '設計レビュー', completed: false, createdAt: at(9, 0), completedAt: null }],
  sessions: [
    // フォーカス: 10:00–10:20 / (5分停止) / 10:25–10:40 = 実働2区間
    { id: 'w1', mode: 'work', startedAt: at(10, 0), endedAt: at(10, 40), durationSec: 2100, completed: true,
      taskIds: ['t1'],
      intervals: [{ startedAt: at(10, 0), endedAt: at(10, 20) }, { startedAt: at(10, 25), endedAt: at(10, 40) }],
      taskTimes: [{ taskId: 't1', durationSec: 2100 }] },
    // 長休憩: 10:40–10:55(ラベルが出る高さ)
    { id: 'b1', mode: 'long', startedAt: at(10, 40), endedAt: at(10, 55), durationSec: 900, completed: true,
      taskIds: [], intervals: [{ startedAt: at(10, 40), endedAt: at(10, 55) }], taskTimes: [] }
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
// app.js の評価とイベント配線が終わるまで待つ(#startBtn は静的 HTML で先に出る)
await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);

await click('#timelineBtn');
await page.waitForTimeout(300);

const view = await page.evaluate(() => ({
  hidden: document.querySelector('#timelineModal').hidden,
  date: document.querySelector('#tlDate').textContent,
  hours: document.querySelectorAll('#timelineBody .timeline-hour').length,
  blocks: [...document.querySelectorAll('#timelineBody .timeline-block')].map(el => ({
    isBreak: el.classList.contains('break'),
    top: parseFloat(el.style.top),
    height: parseFloat(el.style.height),
    text: el.textContent
  }))
}));

// 前/今日ナビ
const dToday = view.date;
await click('#tlPrev');
await page.waitForTimeout(150);
const dPrev = await page.evaluate(() => document.querySelector('#tlDate').textContent);
const prevEmpty = await page.evaluate(() => !!document.querySelector('#timelineBody .empty-note'));
await click('#tlToday');
await page.waitForTimeout(150);
const dBack = await page.evaluate(() => document.querySelector('#tlDate').textContent);

const workBlocks = view.blocks.filter(b => !b.isBreak).sort((a, b) => a.top - b.top);
const breakBlocks = view.blocks.filter(b => b.isBreak);
const gap = workBlocks.length >= 2 ? workBlocks[1].top - (workBlocks[0].top + workBlocks[0].height) : 0;

console.log('--- RESULT ---');
console.log('modal open:', !view.hidden, '/ date:', JSON.stringify(view.date));
console.log('hour lines:', view.hours);
console.log('blocks:', JSON.stringify(view.blocks));
console.log('work gap(px):', Math.round(gap), '(5分停止 → 約7px)');
console.log('nav: today=', dToday, 'prev=', dPrev, '(empty:', prevEmpty, ') back=', dBack);
console.log('console/page errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(!view.hidden, 'timeline modal opened');
assert(view.blocks.length === 3, '3 blocks (2 work intervals + 1 break)');
assert(workBlocks.length === 2, 'paused work split into 2 blocks');
assert(workBlocks[0].text === '設計レビュー', 'work block labeled with task title');
assert(workBlocks[0].height > 20 && workBlocks[1].height > 15, 'block heights scale with duration');
assert(gap > 4, 'visible vertical gap between work blocks (5min pause)');
assert(breakBlocks.length === 1 && breakBlocks[0].text === '長休憩', 'break rendered with label/class');
assert(view.hours >= 1, 'hour grid lines drawn');
assert(dPrev !== dToday, 'prev day changes the date label');
assert(prevEmpty, 'previous (empty) day shows empty note');
assert(dBack === dToday, 'today button restores current day');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
