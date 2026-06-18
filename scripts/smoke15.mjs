import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// DST(サマータイム)対応の検証。
// 米東部の春の切替日 2026-03-08 は 02:00→03:00 にスキップし、その日は23時間。
// 区間の位置を「壁時計」で出し、日境界をローカル0:00で扱えているかを確認する。
process.env.TZ = 'America/New_York';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// TZ 設定後に構築するので、これらはニューヨーク現地時刻として解釈される
const localISO = (y, mo, d, h, m) => new Date(y, mo, d, h, m).toISOString();
// 2026-03-08 01:30(EST) → 03:30(EDT): 壁時計では2時間ぶんだが、実時間は1時間(02時台が無い)
const s1Start = localISO(2026, 2, 8, 1, 30);
const s1End = localISO(2026, 2, 8, 3, 30);

fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: 'DST作業', completed: false, createdAt: localISO(2026, 2, 8, 0, 0), completedAt: null }],
  sessions: [
    { id: 's1', mode: 'work', startedAt: s1Start, endedAt: s1End, durationSec: 3600, completed: true,
      taskIds: ['t1'], intervals: [{ startedAt: s1Start, endedAt: s1End }],
      taskTimes: [{ taskId: 't1', durationSec: 3600 }] }
  ],
  selectedTaskId: null,
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4, whiteNoise: { enabled: false, file: '', volume: 50 } }
}));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData, TZ: 'America/New_York' },
  timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });

// 切替日(2026-03-08)のビューへ直接移動して描画
const view = await page.evaluate(() => {
  timelineDay = startOfDay(new Date(2026, 2, 8));
  renderTimeline();
  document.querySelector('#timelineModal').hidden = false;
  return {
    date: document.querySelector('#tlDate').textContent,
    blocks: [...document.querySelectorAll('#timelineBody .timeline-block')].map(el => ({
      top: parseFloat(el.style.top), height: parseFloat(el.style.height), text: el.textContent
    }))
  };
});

// 隣接日が空(=境界が正しいローカル日に収まっている)
const nextEmpty = await page.evaluate(() => {
  timelineDay = startOfDay(new Date(2026, 2, 9));
  renderTimeline();
  return !!document.querySelector('#timelineBody .empty-note');
});
const prevEmpty = await page.evaluate(() => {
  timelineDay = startOfDay(new Date(2026, 2, 7));
  renderTimeline();
  return !!document.querySelector('#timelineBody .empty-note');
});

console.log('--- RESULT ---');
console.log('date:', JSON.stringify(view.date));
console.log('blocks:', JSON.stringify(view.blocks));
console.log('neighbors empty: next=', nextEmpty, 'prev=', prevEmpty);
console.log('errors:', errors.length ? errors : 'none');

// 壁時計 01:30–03:30 = 120分 → 120*1.4 = 168px。
// もし実時間(epoch差=60分)で計算していたら 84px になる。168px であることが DST 正対応の証拠。
const b = view.blocks[0];
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(view.date.includes('2026/3/8'), 'view shows the DST transition day');
assert(view.blocks.length === 1, 'session assigned to the correct local day');
assert(b && Math.abs(b.height - 168) < 6, 'block height uses wall-clock span (01:30–03:30 = 120min, not 60)');
assert(nextEmpty && prevEmpty, 'neighbor days are empty (local-midnight boundaries correct)');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
