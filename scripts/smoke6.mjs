import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
await page.waitForTimeout(800);
await page.fill('#taskInput', '計測テスト');
await page.evaluate(() => document.querySelector('#taskForm button').click());
await page.evaluate(() => document.querySelector('#taskList .task-item').click());
await page.evaluate(() => document.querySelector('#startBtn').click());
console.log('running 75s...');
await page.waitForTimeout(75000);
const during = await page.evaluate(() => document.querySelector('#taskList .task-meta').textContent);
await page.evaluate(() => document.querySelector('#stopBtn').click());
await page.waitForTimeout(500);
const after = await page.evaluate(() => document.querySelector('#taskList .task-meta').textContent);
const saved = await page.evaluate(async () => await window.api.loadData());
console.log('実行中(75秒経過時)の表示:', JSON.stringify(during));
console.log('中止後の表示:', JSON.stringify(after));
console.log('記録:', JSON.stringify(saved.sessions.map(p => ({ durationSec: p.durationSec, taskTimes: p.taskTimes }))));
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
