// スモークテスト共通の実行環境。
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 実行中の OS 向けの Electron バイナリ(macOS の .app 決め打ちだと Linux / Windows で起動できない)
export const ELECTRON = electronPath;
const APP_DIR = path.resolve(import.meta.dirname, '..');

// 外部フォント(Google Fonts)はオフラインやプロキシ環境では読み込めず、そのたびに
// "Failed to load resource" がコンソールに出る。フォールバックのフォントで表示は続くので
// アプリの不具合ではない。この2ホストへの読み込み失敗だけを除き、ローカル資産の
// 読み込み失敗などはこれまでどおりエラーとして数える。
const EXTERNAL_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const isExternalFontFailure = m => {
  try { return EXTERNAL_FONT_HOSTS.has(new URL(m.location().url).hostname); }
  catch { return false; }
};

// テストが失敗として数えるべきコンソールエラーか
export const isAppError = m => m.type() === 'error' && !isExternalFontFailure(m);

export const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

export const tempUserData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
export const dataFile = userData => path.join(userData, 'pomodoro-data.json');

// init() が最後まで走り終えるのを待つ(読み込み・音源一覧・読み込み時の警告まで)。
// #startBtn は静的 HTML なので先に出るし、関数宣言は巻き上げで評価直後から見えるため、
// どちらも準備完了の目印にならない。init が途中で投げれば data-ready は付かず時間切れになる。
export const waitForApp = page => page.waitForSelector('html[data-ready]', { state: 'attached', timeout: 15000 });

// 一時的な userData でアプリを起動し、準備完了まで待つ。
//  seed:         pomodoro-data.json に書く中身(オブジェクトは JSON 化、文字列はそのまま)
//  userData:     既存のディレクトリを使う(後片付けは呼び出し側。権限を変えるテスト向け)
//  beforeWindow: ウィンドウを待つ前に main 側を差し替える(ネイティブダイアログなど)
// errors にはコンソールエラーとページの例外が溜まる。close() は userData も消す。
export async function launchApp({ seed, userData, beforeWindow } = {}) {
  const ud = userData ?? tempUserData();
  if (seed !== undefined) fs.writeFileSync(dataFile(ud), typeof seed === 'string' ? seed : JSON.stringify(seed));
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: ud },
    timeout: 30000
  });
  if (beforeWindow) await beforeWindow(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (isAppError(m)) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await waitForApp(page);
  const close = async () => {
    await app.close();
    if (!userData) fs.rmSync(ud, { recursive: true, force: true });
  };
  return { app, page, errors, userData: ud, close };
}
