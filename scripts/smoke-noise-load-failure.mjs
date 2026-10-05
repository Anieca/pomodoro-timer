import { launchApp, assert } from './test-env.mjs';

// 切替先の音源が読み込み/decode に失敗しても、旧音源が鳴り続けないことの検証
const { page, errors, close } = await launchApp();

const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const playing = () => page.evaluate(() => noisePlayingName);

// テスト用に短いフォーカス/休憩へ。設定は 1 分未満にできない(正規化で丸まる)ので、
// モード長を求める関数だけを差し替える。data を直接書き換えても、次の意図の応答で
// 正本のスナップショットに戻されるため効かない。
await page.evaluate(async () => {
  modeDurationMs = () => 3000;
  await mutate({ type: 'settings/update', patch: { whiteNoise: { enabled: true, file: 'white-noise.wav', breakFile: 'brown-noise.wav', volume: 50 } } });
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

assert(workSound === 'white-noise.wav', 'focus sound played and cached');
assert(modeAfterWork === 'short', 'switched to short break');
assert(breakSound === null, 'old sound stops even when the new sound fails to load (no stale playback)');
assert(errors.length === 0, 'no console/page errors');

await close();
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
