import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// タイムテーブルの日付境界: 日をまたぐ区間のクリップ表示と、0分/不正区間の除外
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// dayOffset 日後の h:m のローカル ISO
const iso = (dayOffset, h, m) => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + dayOffset * 86400000 + h * 3600000 + m * 60000).toISOString();
};

fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: '夜更かし作業', completed: false, createdAt: iso(0, 9, 0), completedAt: null }],
  sessions: [
    // 今日 23:30 → 翌 00:30 にまたぐフォーカス(実働1区間)
    { id: 'w1', mode: 'work', startedAt: iso(0, 23, 30), endedAt: iso(1, 0, 30), durationSec: 3600, completed: true,
      taskIds: ['t1'], intervals: [{ startedAt: iso(0, 23, 30), endedAt: iso(1, 0, 30) }],
      taskTimes: [{ taskId: 't1', durationSec: 3600 }] },
    // 今日 12:00 の 0分区間(除外されるべき)
    { id: 'z1', mode: 'work', startedAt: iso(0, 12, 0), endedAt: iso(0, 12, 0), durationSec: 0, completed: false,
      taskIds: [], intervals: [{ startedAt: iso(0, 12, 0), endedAt: iso(0, 12, 0) }], taskTimes: [] }
  ],
  selectedTaskId: null,
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4, whiteNoise: { enabled: false, file: '', volume: 50 } }
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
await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const dump = () => page.evaluate(() => [...document.querySelectorAll('#timelineBody .timeline-block')].map(el => ({
  top: parseFloat(el.style.top), height: parseFloat(el.style.height), text: el.textContent
})));

// 今日ビュー: 23:30→翌00:30 のうち 23:30–24:00 が末尾に表示される(↓継続)。0分区間は出ない。
await click('#timelineBtn');
await page.waitForTimeout(300);
const today = await dump();

// 翌日ビュー: 00:00–00:30 が先頭に表示される(↑継続)
await click('#tlNext');
await page.waitForTimeout(200);
const next = await dump();

console.log('--- RESULT ---');
console.log('today blocks:', JSON.stringify(today));
console.log('next blocks :', JSON.stringify(next));
console.log('errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(today.length === 1, 'today shows only the crossing block (0-min interval excluded)');
assert(today[0] && today[0].top > 0, 'crossing block sits near the bottom of the day (starts 23:30)');
assert(today[0] && Math.abs(today[0].height - 42) < 4, 'today portion height = 30min (clipped at midnight)');
assert(today[0] && today[0].text.includes('↓'), 'today portion marked as continuing to next day');
assert(next.length === 1, 'next day shows the carried-over block');
assert(next[0] && next[0].top < 4, 'next-day portion starts at top (00:00)');
assert(next[0] && Math.abs(next[0].height - 42) < 4, 'next-day portion height = 30min');
assert(next[0] && next[0].text.includes('↑'), 'next-day portion marked as continued from previous day');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
