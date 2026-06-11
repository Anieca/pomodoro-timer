import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOTS = '/tmp/pomodoro-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(1500);

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const ss = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

await ss('01-initial');

// サークル下のクイック追加でタスクを作成してセット
await page.fill('.focus-quick-add input', 'クイック追加タスク');
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(300);
const quickAdded = await page.evaluate(() => ({
  focusTitle: document.querySelector('.focus-title')?.textContent,
  inList: [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent)
}));
await ss('01b-quick-added');
// セット解除
await page.evaluate(() => document.querySelector('.focus-clear-btn').click());
await page.waitForTimeout(200);

// タスク追加 x2
for (const t of ['設計レビュー', 'レポート作成']) {
  await page.fill('#taskInput', t);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}
await page.waitForTimeout(300);

// ポモドーロ開始(タスクなし)
await page.evaluate(() => document.querySelector('#startBtn').click());
await page.waitForTimeout(500);
await ss('02-running-no-task');

// 実行中にタスク行クリックで紐付け → 別タスクに切り替え(1タスクのみ紐付く)
await page.evaluate(() => document.querySelectorAll('#taskList .task-item')[0].click());
await page.evaluate(() => document.querySelectorAll('#taskList .task-item')[1].click());
await page.waitForTimeout(300);
const focusTitle = await page.evaluate(() => document.querySelector('.focus-title')?.textContent);
const currentTaskIds = await page.evaluate(() => document.querySelectorAll('#taskList .task-item.selected').length);
const noiseState = await page.evaluate(() => ({ paused: !noiseSrc, src: noisePlayingName }));
await ss('03-linked-switched');

// 実行中にタスク完了(チェック)
await page.evaluate(() => document.querySelector('#taskList .task-check').click());
await page.waitForTimeout(300);
await ss('04-task-completed-during');

// 中止 → 記録される(1分未満は記録されない仕様なので timer を細工して確認)
await page.evaluate(() => document.querySelector('#stopBtn').click());
await page.waitForTimeout(300);

// 履歴モーダル
await page.evaluate(() => document.querySelector('#historyBtn').click());
await page.waitForTimeout(300);
await ss('05-history');
const historyText = await page.evaluate(() => document.querySelector('#historyList').innerText);
await page.evaluate(() => document.querySelector('#historyClose').click());

// 設定モーダル
await page.evaluate(() => document.querySelector('#settingsBtn').click());
await page.waitForTimeout(500);
await ss('06-settings');
const noiseOptions = await page.evaluate(() =>
  [...document.querySelectorAll('#setNoiseFile option')].map(o => o.textContent));
await page.evaluate(() => document.querySelector('#settingsCancel').click());

// データ確認
const state = await page.evaluate(() => ({
  tasks: window.__dataDump || null
}));
const saved = await page.evaluate(async () => await window.api.loadData());

console.log('--- RESULT ---');
console.log('quick add:', JSON.stringify(quickAdded));
console.log('focus task (switched):', JSON.stringify(focusTitle), '/ selected rows:', currentTaskIds);
console.log('default noise while running:', JSON.stringify(noiseState));
console.log('history:', JSON.stringify(historyText));
console.log('noise options:', JSON.stringify(noiseOptions));
console.log('saved tasks:', saved ? saved.tasks.map(t => `${t.title}(${t.completed ? '完' : '未'})`).join(', ') : 'none');
console.log('saved pomodoros:', saved ? saved.pomodoros.length : 'none');
console.log('console errors:', errors.length ? errors : 'none');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
