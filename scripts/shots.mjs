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
await page.waitForTimeout(1000);
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const ss = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

// 空状態(クイック追加フォーム)
await ss('d1-idle-empty');

// サイドバーからタスク追加
for (const t of ['仕様書のレビュー', 'プレゼン資料づくり']) {
  await page.fill('#taskInput', t);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}
await page.waitForTimeout(300);

// クイック追加でタスクをセット
await page.fill('.focus-quick-add input', '論文の下読み');
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(300);
await ss('d2-idle-selected');

// 開始 → フォーカス中の沈み込み
await click('#startBtn');
await page.waitForTimeout(1500);
await ss('d3-running-focus');

// 一時停止
await click('#startBtn');
await page.waitForTimeout(400);
await ss('d4-paused');

// 中止して休憩タブへ
await click('#stopBtn');
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#modeTabs [data-mode="short"]').click());
await page.waitForTimeout(300);
await ss('d5-break-tab');
await page.evaluate(() => document.querySelector('#modeTabs [data-mode="work"]').click());

// 設定モーダル
await click('#settingsBtn');
await page.waitForTimeout(400);
await ss('d6-settings');
await click('#settingsCancel');

// 履歴(空)
await click('#historyBtn');
await page.waitForTimeout(400);
await ss('d7-history-empty');
await click('#historyClose');

// 履歴に既存データを入れて再表示
await page.evaluate(async () => {
  const d = await window.api.loadData();
  const tid = d.tasks[0].id;
  d.pomodoros.push({
    id: 'p1', startedAt: new Date(Date.now() - 3600e3).toISOString(),
    endedAt: new Date(Date.now() - 2100e3).toISOString(),
    durationSec: 1500, completed: true, taskIds: [tid],
    taskTimes: [{ taskId: tid, durationSec: 1200 }, { taskId: null, durationSec: 300 }]
  });
  await window.api.saveData(d);
  location.reload();
});
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(800);
await click('#historyBtn');
await page.waitForTimeout(400);
await ss('d8-history-filled');
await click('#historyClose');

// タスク行ホバー(削除ボタンのリビール)
await page.hover('#taskList .task-item');
await page.waitForTimeout(300);
await ss('d9-task-hover');

console.log('console errors:', errors.length ? errors : 'none');
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK ->', SHOTS);
