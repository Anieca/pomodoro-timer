import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const APP_DIR = '/Users/ishiirub/Projects/pomodoro-timer';
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
// Space で開始
await page.evaluate(() => document.body.focus());
await page.keyboard.press('Space');
await page.waitForTimeout(400);
const afterSpace = await page.evaluate(() => document.querySelector('#phaseLabel').textContent);
// Space で一時停止
await page.keyboard.press('Space');
await page.waitForTimeout(300);
const afterSpace2 = await page.evaluate(() => document.querySelector('#phaseLabel').textContent);
// 中止して小休憩モードへ → スキップボタン
await page.evaluate(() => document.querySelector('#stopBtn').click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelectorAll('#modeTabs button')[1].click());
await page.waitForTimeout(300);
const skipVisible = await page.evaluate(() => !document.querySelector('#skipBtn').hidden);
await page.evaluate(() => document.querySelector('#skipBtn').click());
await page.waitForTimeout(300);
const modeAfterSkip = await page.evaluate(() => document.querySelector('#modeTabs button.active').dataset.mode);
// Esc でモーダルを閉じる
await page.evaluate(() => document.querySelector('#settingsBtn').click());
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const modalClosed = await page.evaluate(() => document.querySelector('#settingsModal').hidden);
console.log({ afterSpace, afterSpace2, skipVisible, modeAfterSkip, modalClosed });
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
