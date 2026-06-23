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

// タスクをセットして開始 → 65秒後にリロード(=終了相当)
await page.fill('.focus-quick-add input', '中断されるタスク');
await page.press('.focus-quick-add input', 'Enter');
await page.evaluate(() => document.querySelector('#startBtn').click());
console.log('running 65s before reload...');
await page.waitForTimeout(65000);
await page.evaluate(() => location.reload());
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(800);

const saved = await page.evaluate(async () => {
  const d = await window.api.loadData();
  return d.sessions.map(p => ({
    completed: p.completed, durationSec: p.durationSec,
    taskTimes: p.taskTimes.map(tt => ({ task: tt.taskId ? d.tasks.find(t => t.id === tt.taskId)?.title : null, sec: tt.durationSec }))
  }));
});
console.log('recorded on unload:', JSON.stringify(saved, null, 1));
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
