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
await page.waitForTimeout(800);
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const state = () => page.evaluate(async () => {
  const d = await window.api.loadData();
  return {
    titles: d.tasks.map(t => t.title),
    selected: document.querySelector('.focus-title')?.textContent ?? null,
    listOpen: !!document.querySelector('.suggest-list:not([hidden])')
  };
});

// サイドバーからタスク2つ
for (const t of ['設計レビュー', 'レポート作成']) {
  await page.fill('#taskInput', t);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}
await page.waitForTimeout(300);

// 1) フォーカスで既存タスクが浮かぶ
await page.click('.focus-quick-add input');
await page.waitForTimeout(200);
const onFocus = await page.evaluate(() =>
  [...document.querySelectorAll('.suggest-list li')].map(li => li.textContent));
await page.screenshot({ path: path.join(SHOTS, 's1-suggest-on-focus.png') });

// 2) 部分一致 + Enter → 既存タスクをセット(重複作成なし)
await page.fill('.focus-quick-add input', 'レポ');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, 's2-suggest-filtered.png') });
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(200);
console.log('partial match → set existing:', JSON.stringify(await state()));

// 3) 解除して新規名 → create 行から作成
await page.evaluate(() => document.querySelector('.focus-clear-btn').click());
await page.waitForTimeout(200);
await page.fill('.focus-quick-add input', '新企画のたたき台');
await page.waitForTimeout(200);
const createRow = await page.evaluate(() =>
  document.querySelector('.suggest-list li.create')?.textContent);
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(200);
console.log('create row label:', JSON.stringify(createRow));
console.log('new task created+set:', JSON.stringify(await state()));

// 4) ↓↓ で2番目を選択
await page.evaluate(() => document.querySelector('.focus-clear-btn').click());
await page.waitForTimeout(200);
await page.click('.focus-quick-add input');
await page.press('.focus-quick-add input', 'ArrowDown');
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(200);
console.log('arrow nav → 2nd item:', JSON.stringify(await state()));

// 5) Esc はドロップダウンだけ閉じる
await page.evaluate(() => document.querySelector('.focus-clear-btn').click());
await page.waitForTimeout(200);
await page.click('.focus-quick-add input');
await page.waitForTimeout(200);
await page.press('.focus-quick-add input', 'Escape');
await page.waitForTimeout(200);
console.log('after Esc:', JSON.stringify(await state()));

console.log('suggestions on focus:', JSON.stringify(onFocus));
console.log('console errors:', errors.length ? errors : 'none');
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
