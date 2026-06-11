import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
// 旧形式(taskTimes なし)のデータを仕込む
fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [{ id: 't1', title: '旧タスク', completed: false, createdAt: '2026-06-09T01:00:00Z', completedAt: null }],
  pomodoros: [{ id: 'p1', startedAt: '2026-06-09T01:00:00Z', endedAt: '2026-06-09T01:25:00Z', durationSec: 1500, completed: true, taskIds: ['t1'] }],
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4, whiteNoise: { enabled: true, file: 'white-noise.wav', volume: 50 } }
}));
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(1500);
// タスク追加を試す
await page.fill('#taskInput', '新タスク');
await page.evaluate(() => document.querySelector('#taskForm button').click());
await page.waitForTimeout(500);
const titles = await page.evaluate(() => [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent));
// 履歴を試す
await page.evaluate(() => document.querySelector('#historyBtn').click());
await page.waitForTimeout(500);
const historyOpen = await page.evaluate(() => !document.querySelector('#historyModal').hidden);
console.log('tasks shown:', JSON.stringify(titles));
console.log('history opened:', historyOpen);
console.log('errors:', errors.length ? errors : 'none');
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
