import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 切替先の音源が読み込み/decode に失敗しても、旧音源が鳴り続けないことの検証
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForFunction(() => typeof startNoise === 'function' && Array.isArray(soundsCache), { timeout: 15000 });

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const playing = () => page.evaluate(() => noisePlayingName);

await page.evaluate(() => {
  data.settings.workMin = 0.05;
  data.settings.shortMin = 0.05;
  data.settings.whiteNoise = { enabled: true, file: 'white-noise.wav', breakFile: 'brown-noise.wav', volume: 50 };
});

// フォーカス開始 → 実際に white を再生(バッファをキャッシュ)
await click('#startBtn');
await page.waitForTimeout(900);
const workSound = await playing();

// 以降の音源読み込みを失敗させる(file は listed だが decode/read に失敗する状況を模擬)
await page.evaluate(() => { window.noiseBuffer = async () => null; });

// 完走 → 休憩へ。休憩開始で brown へ切替を試みるが読み込み失敗
await page.waitForTimeout(2800);
const modeAfterWork = await page.evaluate(() => timer.mode);
await click('#startBtn');                 // 休憩開始(brown 読み込み失敗)
await page.waitForTimeout(700);
const breakSound = await playing();
await click('#stopBtn');

console.log('--- RESULT ---');
console.log('work sound:', workSound, '/ mode after work:', modeAfterWork);
console.log('break sound after failed load:', breakSound, '(should be null = old stopped, new not playing)');
console.log('errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(workSound === 'white-noise.wav', 'focus sound played and cached');
assert(modeAfterWork === 'short', 'switched to short break');
assert(breakSound === null, 'old sound stops even when the new sound fails to load (no stale playback)');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
