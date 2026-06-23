import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = '/tmp/pomodoro-shots';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// 履歴グルーピング確認用に2日分のデータを仕込む(現行 sessions スキーマ)
// at(dayOff, sec): dayOff 日前の 10:00 から sec 秒後のローカル ISO
const at = (dayOff, sec) => {
  const d = new Date(Date.now() - dayOff * 86400e3);
  d.setHours(10, 0, 0, 0);
  return new Date(d.getTime() + sec * 1000).toISOString();
};
fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: '既存タスク', completed: false, createdAt: at(2, 0), completedAt: null }],
  sessions: [
    { id: 'p1', mode: 'work', startedAt: at(1, 0), endedAt: at(1, 1500), durationSec: 1500, completed: true,
      taskIds: ['t1'], intervals: [{ startedAt: at(1, 0), endedAt: at(1, 1500) }],
      taskTimes: [{ taskId: 't1', durationSec: 1500 }] },
    { id: 'p2', mode: 'work', startedAt: at(0, 0), endedAt: at(0, 600), durationSec: 600, completed: false,
      taskIds: [], intervals: [{ startedAt: at(0, 0), endedAt: at(0, 600) }],
      taskTimes: [{ taskId: null, durationSec: 600 }] }
  ],
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4,
    whiteNoise: { enabled: true, file: 'white-noise.wav', volume: 50 } },
  selectedTaskId: null
}, null, 2));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(800);
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);

// 1) リネーム: ✎ → input → 入力 → Enter
await page.hover('#taskList .task-item');
await page.evaluate(() => document.querySelector('#taskList .task-btn').click());
await page.fill('.task-rename', 'リネーム済みタスク');
await page.press('.task-rename', 'Enter');
await page.waitForTimeout(300);
const renamed = await page.evaluate(async () => (await window.api.loadData()).tasks[0].title);
console.log('rename:', JSON.stringify(renamed));

// 1b) リネームの Esc キャンセル
await page.evaluate(() => document.querySelector('#taskList .task-btn').click());
await page.fill('.task-rename', '捨てられる名前');
await page.press('.task-rename', 'Escape');
await page.waitForTimeout(300);
const notRenamed = await page.evaluate(async () => (await window.api.loadData()).tasks[0].title);
console.log('esc cancel keeps:', JSON.stringify(notRenamed));

// 2) 削除 → Undo トースト → 復元(履歴の紐付きも戻る)
await page.evaluate(() => [...document.querySelectorAll('#taskList .task-btn')].at(-1).click());
await page.waitForTimeout(300);
const afterDelete = await page.evaluate(async () => {
  const d = await window.api.loadData();
  return {
    tasks: d.tasks.length,
    p1Link: d.sessions[0].taskTimes[0].taskId,
    toast: document.querySelector('#toast').textContent,
    undoBtn: !!document.querySelector('.toast-action')
  };
});
console.log('after delete:', JSON.stringify(afterDelete));
await page.screenshot({ path: path.join(SHOTS, 'u1-undo-toast.png') });
await page.evaluate(() => document.querySelector('.toast-action').click());
await page.waitForTimeout(300);
const afterUndo = await page.evaluate(async () => {
  const d = await window.api.loadData();
  return { tasks: d.tasks.map(t => t.title), p1Link: d.sessions[0].taskTimes[0].taskId,
    p1TaskIds: d.sessions[0].taskIds };
});
console.log('after undo:', JSON.stringify(afterUndo));

// 3) キーボード操作: 行にフォーカスして Enter でセット
await page.evaluate(() => document.querySelector('#taskList .task-item').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const kbSelected = await page.evaluate(() => document.querySelector('.focus-title')?.textContent);
console.log('keyboard select:', JSON.stringify(kbSelected));

// 4) 履歴の日付グルーピング
await click('#historyBtn');
await page.waitForTimeout(300);
const dayHeads = await page.evaluate(() =>
  [...document.querySelectorAll('.history-day')].map(li => li.textContent));
console.log('history day headers:', JSON.stringify(dayHeads));
await page.screenshot({ path: path.join(SHOTS, 'u2-history-grouped.png') });
await click('#historyClose');

// 5) 再生中の音量リアルタイム反映
await click('#startBtn');
await page.waitForTimeout(1200);
await click('#settingsBtn');
await page.fill('#setNoiseVol', '90');
await page.evaluate(() => document.querySelector('#setNoiseVol').dispatchEvent(new Event('input')));
await page.waitForTimeout(300);
const volLive = await page.evaluate(() => Math.round(noiseGain.gain.value * 100));
await click('#settingsCancel');
await page.waitForTimeout(300);
const volReverted = await page.evaluate(() => Math.round(noiseGain.gain.value * 100));
console.log('volume live:', volLive, '/ reverted on cancel:', volReverted);

console.log('console errors:', errors.length ? errors : 'none');
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
