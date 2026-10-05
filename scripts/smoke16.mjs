import { _electron as electron } from 'playwright-core';
import { ELECTRON, isAppError, waitForApp } from './test-env.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 休憩中のホワイトノイズ(休憩用音源への切替)の検証
const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: ELECTRON,
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (isAppError(m)) errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await waitForApp(page);

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const indicatorVisible = () => page.evaluate(() => !document.querySelector('#noiseIndicator').hidden);
const playing = () => page.evaluate(() => noisePlayingName);

// テスト用に短いフォーカス/休憩へ。設定は 1 分未満にできない(正規化で丸まる)ので、
// モード長を求める関数だけを差し替える。data を直接書き換えても、次の意図の応答で
// 正本のスナップショットに戻されるため効かない。
// 音源の設定は正規の意図で入れる(正本を通るので、あとから巻き戻らない)。
await page.evaluate(async () => {
  modeDurationMs = () => 3000;
  await mutate({ type: 'settings/update', patch: { whiteNoise: { enabled: true, file: 'white-noise.wav', breakFile: 'brown-noise.wav', volume: 50 } } });
});

// モード→音源の選択ロジック(決定的)
const fileFor = await page.evaluate(() => ({
  work: noiseFileFor('work'), short: noiseFileFor('short'), long: noiseFileFor('long')
}));

// フォーカス開始 → 再生(white)
await click('#startBtn');
await page.waitForTimeout(900);
const workActive = await indicatorVisible();
const workSound = await playing();

// 完走を待って休憩(short)へ → 休憩開始 → 再生(brown)
await page.waitForTimeout(2800);
const modeAfterWork = await page.evaluate(() => timer.mode);
await click('#startBtn');               // 休憩開始
await page.waitForTimeout(900);
const breakActive = await indicatorVisible();
const breakSound = await playing();
await click('#stopBtn');                // 片付け

// 設定 UI: 休憩音源セレクトが breakFile を反映し、保存で永続化する
await click('#settingsBtn');
await page.waitForTimeout(300);
const ui = await page.evaluate(() => ({
  breakVal: document.querySelector('#setNoiseBreakFile').value,
  opts: [...document.querySelector('#setNoiseBreakFile').options].map(o => o.value),
  hasPreview: !!document.querySelector('#previewBreakBtn')
}));
// 休憩音源を pink に変えて保存
await page.evaluate(() => { document.querySelector('#setNoiseBreakFile').value = 'pink-noise.wav'; });
await click('#settingsSave');
await page.waitForTimeout(200);
const saved = await page.evaluate(async () => (await window.api.loadData()).settings.whiteNoise.breakFile);

console.log('--- RESULT ---');
console.log('noiseFileFor:', JSON.stringify(fileFor));
console.log('work: active=', workActive, 'sound=', workSound);
console.log('mode after work:', modeAfterWork, '(expect short)');
console.log('break: active=', breakActive, 'sound=', breakSound);
console.log('settings break select:', JSON.stringify(ui));
console.log('persisted breakFile:', saved);
console.log('errors:', errors.length ? errors : 'none');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
assert(fileFor.work === 'white-noise.wav', 'work uses focus sound');
assert(fileFor.short === 'brown-noise.wav' && fileFor.long === 'brown-noise.wav', 'breaks use break sound (short & long)');
assert(workActive, 'noise active during focus');
assert(modeAfterWork === 'short', 'switches to short break after work');
assert(breakActive, 'noise active during break (new behavior)');
assert(workSound === 'white-noise.wav', 'focus actually plays focus sound');
assert(breakSound === 'brown-noise.wav', 'break actually plays break sound (switched)');
assert(ui.breakVal === 'brown-noise.wav', 'settings break-select reflects breakFile');
assert(ui.opts.includes('pink-noise.wav') && ui.hasPreview, 'break select lists sounds and has a preview button');
assert(saved === 'pink-noise.wav', 'changed breakFile persists');
assert(errors.length === 0, 'no console/page errors');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
