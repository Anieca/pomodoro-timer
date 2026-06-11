import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});
const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(800);
const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);

// 設定:ホワイトノイズON、音源選択、音量30
await click('#settingsBtn');
const opts = await page.evaluate(() =>
  [...document.querySelectorAll('#setNoiseFile option')].map(o => o.textContent));
console.log('sound options:', JSON.stringify(opts));
await page.evaluate(() => { document.querySelector('#setNoiseOn').checked = true; });
await page.evaluate(() => {
  const sel = document.querySelector('#setNoiseFile');
  sel.value = [...sel.options].find(o => o.value)?.value || '';
});
await page.fill('#setNoiseVol', '30');
await click('#settingsSave');
await page.waitForTimeout(300);

// 開始 → 再生確認
await click('#startBtn');
await page.waitForTimeout(1500);
const playing = await page.evaluate(() => ({
  paused: !noiseSrc,
  volume: Math.round(noiseGain.gain.value * 100) / 100,
  src: noisePlayingName,
  ctxState: noiseCtx.state,
  indicator: !document.querySelector('#noiseIndicator').hidden
}));
console.log('while running:', JSON.stringify(playing));

// 表示クリックでオフ→再クリックでオン
await click('#noiseIndicator');
await page.waitForTimeout(400);
const muted = await page.evaluate(async () => ({
  playing: !!noiseSrc,
  label: document.querySelector('#noiseIndicator').textContent,
  savedEnabled: (await window.api.loadData()).settings.whiteNoise.enabled
}));
console.log('after toggle off:', JSON.stringify(muted));
await click('#noiseIndicator');
await page.waitForTimeout(400);
const unmuted = await page.evaluate(() => ({
  playing: !!noiseSrc,
  label: document.querySelector('#noiseIndicator').textContent
}));
console.log('after toggle on:', JSON.stringify(unmuted));

// 一時停止 → 停止確認
await click('#startBtn');
await page.waitForTimeout(500);
const pausedState = await page.evaluate(() => !noiseSrc);
console.log('noise paused after timer pause:', pausedState);

// 設定モーダルの試聴(タイマー停止中でも3秒だけ鳴る)
await click('#stopBtn');
await click('#settingsBtn');
await click('#previewBtn');
await page.waitForTimeout(600);
const previewing = await page.evaluate(() => !!noiseSrc);
await page.waitForTimeout(3000);
const afterPreview = await page.evaluate(() => !!noiseSrc);
console.log('preview playing:', previewing, '/ stopped after 3s:', !afterPreview);

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
console.log('OK');
