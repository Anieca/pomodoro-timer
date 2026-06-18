import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 休憩ノイズの後方互換(既存データに breakFile 無し)と、休憩音源が空のケース
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

// breakFile を持たない旧 whiteNoise 設定を仕込む
fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [], sessions: [], selectedTaskId: null,
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4,
    whiteNoise: { enabled: true, file: 'white-noise.wav', volume: 50 } }
}));

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
await page.waitForFunction(() => typeof noiseFileFor === 'function' && Array.isArray(soundsCache), { timeout: 15000 });

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const indicatorVisible = () => page.evaluate(() => !document.querySelector('#noiseIndicator').hidden);

// A) 後方互換: breakFile がデフォルト(white-noise.wav)で補完される
const compat = await page.evaluate(() => ({
  breakFile: data.settings.whiteNoise.breakFile,
  shortFile: noiseFileFor('short')
}));

// B) 休憩音源が空のとき: 休憩中はノイズを鳴らさない
await page.evaluate(() => {
  data.settings.workMin = 0.05;
  data.settings.shortMin = 0.05;
  data.settings.whiteNoise.breakFile = '';      // 休憩音源を未選択に
});
await click('#startBtn');                        // フォーカス開始
await page.waitForTimeout(800);
const workActive = await indicatorVisible();     // フォーカスは鳴る
await page.waitForTimeout(2800);                 // 完走 → short へ
const modeAfterWork = await page.evaluate(() => timer.mode);
await click('#startBtn');                        // 休憩開始(音源は空)
await page.waitForTimeout(800);
const breakActive = await indicatorVisible();
const breakSrc = await page.evaluate(() => noisePlayingName);
await click('#stopBtn');

console.log('--- RESULT ---');
console.log('compat:', JSON.stringify(compat));
console.log('work active:', workActive, '/ mode after work:', modeAfterWork);
console.log('break active:', breakActive, '/ playing:', breakSrc);
console.log('errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(compat.breakFile === 'white-noise.wav', 'missing breakFile filled by default merge (backward compat)');
assert(compat.shortFile === 'white-noise.wav', 'noiseFileFor(break) returns default when not customized');
assert(workActive, 'focus noise active');
assert(modeAfterWork === 'short', 'switched to short break');
assert(!breakActive, 'empty break sound → no noise during break (indicator hidden)');
assert(!breakSrc, 'nothing playing when break sound is empty');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
