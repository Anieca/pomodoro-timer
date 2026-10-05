import { launchApp, assert } from './test-env.mjs';

// タイムテーブルの日付境界: 日をまたぐ区間のクリップ表示と、0分/不正区間の除外

// dayOffset 日後の h:m のローカル ISO
const iso = (dayOffset, h, m) => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + dayOffset * 86400000 + h * 3600000 + m * 60000).toISOString();
};

const { page, errors, close } = await launchApp({ seed: {
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
} });

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

assert(today.length === 1, 'today shows only the crossing block (0-min interval excluded)');
assert(today[0] && today[0].top > 0, 'crossing block sits near the bottom of the day (starts 23:30)');
assert(today[0] && Math.abs(today[0].height - 21) < 4, 'today portion height = 30min (0.7px/分 → ~21px, clipped at midnight)');
assert(today[0] && today[0].text.includes('↓'), 'today portion marked as continuing to next day');
assert(next.length === 1, 'next day shows the carried-over block');
assert(next[0] && next[0].top < 4, 'next-day portion starts at top (00:00)');
assert(next[0] && Math.abs(next[0].height - 21) < 4, 'next-day portion height = 30min (0.7px/分 → ~21px)');
assert(next[0] && next[0].text.includes('↑'), 'next-day portion marked as continued from previous day');
assert(errors.length === 0, 'no console/page errors');

await close();
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
