// UI のスクリーンショットを撮る(テストではない。見た目の確認や README・PR 用)。
//   node scripts/shots.mjs [出力先]   既定は <OS の一時ディレクトリ>/pomodoro-shots
// 動作の検証は smoke-*.mjs が受け持つ。ここで失敗とするのは、撮影中のコンソールエラーだけ。
import { launchApp, waitForApp, dataFile } from './test-env.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'pomodoro-shots'));
fs.mkdirSync(SHOTS, { recursive: true });

const { page, errors, userData, close } = await launchApp();
const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);
const ss = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

// 保存ファイルを直接書き換えて読み直させる(スクリーンショット用の下ごしらえ)。
// 正本を持つのは main なので、レンダラ側から履歴を作ったり消したりはできない。
async function reseed(edit) {
  const d = JSON.parse(fs.readFileSync(dataFile(userData), 'utf8'));
  edit(d);
  fs.writeFileSync(dataFile(userData), JSON.stringify(d, null, 2));
  await page.evaluate(() => location.reload());
  await waitForApp(page);
}

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

// 中止 → 休憩画面はオートサイクルで入る(実行中のフォーカスを即終了させて完走 → 小休憩)。
// 設定(workMin)は正規化で 1 分未満に落とせないため、タイマー側の終了予定を縮める。
await click('#stopBtn');
await page.waitForTimeout(300);
await click('#startBtn');
await page.evaluate(() => { timer.endAt = Date.now() + 200; });
await page.waitForFunction(() => timer.mode !== 'work', null, { timeout: 15000 });
await page.waitForTimeout(300);
await ss('d5-break');
await click('#skipBtn');                                    // フォーカスに戻す
await page.waitForTimeout(300);
// break用に出来た完走セッションを消して履歴を空に保つ。正本は main が持っていて
// レンダラからは消せないので、ファイルを置き直して読み直させる。
await reseed(d => { d.sessions = []; });

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
await reseed(d => {
  const tid = d.tasks[0].id;
  const st = new Date(Date.now() - 3600e3).toISOString();
  const en = new Date(Date.now() - 2100e3).toISOString();
  d.sessions.push({
    id: 'p1', mode: 'work', startedAt: st, endedAt: en,
    durationSec: 1500, completed: true, taskIds: [tid],
    intervals: [{ startedAt: st, endedAt: en }],
    taskTimes: [{ taskId: tid, durationSec: 1200 }, { taskId: null, durationSec: 300 }]
  });
});
await click('#historyBtn');
await page.waitForTimeout(400);
await ss('d8-history-filled');
await click('#historyClose');

// タスク行ホバー(削除ボタンのリビール)
await page.hover('#taskList .task-item');
await page.waitForTimeout(300);
await ss('d9-task-hover');

await close();
if (errors.length) {
  console.error('console errors:', errors);
  process.exitCode = 1;
}
console.log(`${errors.length ? 'DONE (with console errors)' : 'OK'} -> ${SHOTS}`);
