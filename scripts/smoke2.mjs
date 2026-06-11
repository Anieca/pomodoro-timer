import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = '/tmp/pomodoro-shots';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(1000);
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const ss = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

// タスク2つ追加(リスト順: タスクB, タスクA)
for (const t of ['タスクA', 'タスクB']) {
  await page.fill('#taskInput', t);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}

// 設定でフォーカスを1分に
await click('#settingsBtn');
await page.fill('#setWork', '1');
await click('#settingsSave');
await page.waitForTimeout(300);

// タスクAを選択して開始 → 30秒後にタスクBへ切り替え
await page.evaluate(() => {
  [...document.querySelectorAll('#taskList .task-item')]
    .find(li => li.textContent.includes('タスクA')).click();
});
await click('#startBtn');
console.log('running... switching to B at 30s');
await page.waitForTimeout(30000);
await page.evaluate(() => {
  [...document.querySelectorAll('#taskList .task-item')]
    .find(li => li.textContent.includes('タスクB')).click();
});

// 完走を待つ
await page.waitForFunction(
  () => document.querySelector('#phaseLabel').textContent === '準備完了',
  null,
  { timeout: 80000 }
);
await page.waitForTimeout(500);

const metas = await page.evaluate(() =>
  [...document.querySelectorAll('#taskList .task-item')].map(li => li.textContent));
await click('#historyBtn');
await page.waitForTimeout(300);
await ss('09-history-split');
const historyText = await page.evaluate(() => document.querySelector('#historyList').innerText);

const saved = await page.evaluate(async () => await window.api.loadData());
console.log('--- RESULT ---');
console.log('task rows:', JSON.stringify(metas));
console.log('pomodoro record:', JSON.stringify(saved.pomodoros[0], null, 1));
console.log('history shows:', JSON.stringify(historyText));
console.log('console errors:', errors.length ? errors : 'none');
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
