import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 保存データの権威が main にあることの検証。レンダラは正本を持たず、受け取った
// スナップショットを表示するだけ:
//  O) レンダラが範囲外・型違いを送ってきても、ディスクに出るのは正規形
//  P) 書き出しは main が持つ正本。レンダラの未保存の編集は混ざらない
//  Q) 書き込み元へはスナップショットを送り返さない(丸ごと置換での取りこぼし防止)
//  R) レンダラは受け取ったスナップショットをそのまま表示する(自分では正規化しない)
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const dataFile = ud => path.join(ud, 'pomodoro-data.json');
const readData = ud => JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));

async function launch(userData) {
  const app = await electron.launch({
    executablePath: EXE, args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: userData }, timeout: 30000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForSelector('#startBtn', { timeout: 15000 });
  await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });
  await page.waitForTimeout(300);
  return { app, page, errors };
}

/* ===== O: レンダラが何を送ってもディスクは正規形 ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  // レンダラのバグや設定ダイアログの範囲外入力を想定した、検証を通っていない内容。
  // 以前は main がそのまま書いていたため、次回起動の読み込み側正規化で
  // 黙って別の値に化けていた(ディスク上の正史と画面が食い違う)。
  const res = await page.evaluate(() => window.api.saveData({
    tasks: [{ id: 'keep', title: 42, completed: 'yes', createdAt: 'いつか' }, { title: 'id 無し' }],
    sessions: [{ id: 's1', mode: 'まだ', durationSec: -5, startedAt: '不明', taskIds: 'x' }],
    settings: { workMin: 9999, whiteNoise: { volume: -20 } },
    selectedTaskId: '存在しない',
    timer: { mode: 'zzz', cycle: -1 }
  }));
  const saved = readData(ud);
  console.log('O: res=', JSON.stringify(res), 'settings=', JSON.stringify(saved.settings), 'errors=', errors);
  assert(errors.length === 0, 'O: コンソール/ページエラーが出ない');
  assert(res && res.ok === true, 'O: 保存自体は成功する(拒否ではなく正規化)');
  assert(saved.settings.workMin === 120, 'O: 範囲外の設定はディスクに出る前に丸める');
  assert(saved.settings.whiteNoise.volume === 0, 'O: 入れ子の設定も丸める');
  assert(saved.tasks.length === 1 && saved.tasks[0].title === '42', 'O: id 無しのタスクを捨て、title は文字列にする');
  assert(saved.tasks[0].createdAt === null, 'O: 不正な日付は捏造せず null で書く');
  assert(saved.sessions[0].mode === 'work' && saved.sessions[0].durationSec === 0, 'O: 未知のモード・負の長さを直す');
  assert(Array.isArray(saved.sessions[0].taskIds), 'O: 配列でない taskIds を配列にする');
  assert(saved.selectedTaskId === null, 'O: 存在しないタスクを指した選択は解除する');
  assert(saved.timer.mode === 'work' && saved.timer.cycle === 0, 'O: タイマーの進行状態も丸める');

  // 保存し直しても内容が変わらない(冪等)。崩れると無編集の保存でディスクが揺れる。
  await page.evaluate(s => window.api.saveData(s), saved);
  await page.waitForTimeout(200);
  assert(JSON.stringify(readData(ud)) === JSON.stringify(saved), 'O: 正規形を保存し直しても変わらない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== P: 書き出しは main の正本から ===== */
{
  const ud = mkdir();
  const out = path.join(ud, 'export.json');
  const { app, page, errors } = await launch(ud);
  await page.evaluate(() => window.api.saveData({
    tasks: [{ id: 'saved', title: '保存済み', completed: false, createdAt: new Date().toISOString(), completedAt: null }],
    sessions: [], selectedTaskId: null, settings: {}
  }));
  await page.waitForTimeout(200);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, out);
  // レンダラ側だけを書き換え、保存しない。以前は書き出す中身をレンダラが渡していたため、
  // 保存されていない内容(検証も通っていない)がそのまま出力されえた。
  await page.evaluate(() => { data.tasks.push({ id: 'unsaved', title: '未保存' }); });
  const res = await page.evaluate(() => window.api.exportData('json'));
  const body = fs.readFileSync(out, 'utf8');
  console.log('P: res=', JSON.stringify(res), 'errors=', errors);
  assert(errors.length === 0, 'P: コンソール/ページエラーが出ない');
  assert(res && res.saved === true, 'P: 書き出せる');
  assert(/保存済み/.test(body), 'P: 正本の内容を書き出す');
  assert(!/未保存/.test(body), 'P: レンダラの未保存の編集は書き出さない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Q: 書き込み元へは送り返さない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  // 丸ごと置換の保存 API では、保存1の応答が届くまでに編集2が入っていると、
  // 返ってきた古いスナップショットで編集2が画面から消え、次の保存で本当に失われる。
  await page.evaluate(() => {
    globalThis.__snapshots = [];
    window.api.onDataSnapshot(s => globalThis.__snapshots.push(s));
  });
  await page.evaluate(() => window.api.saveData({ tasks: [], sessions: [], selectedTaskId: null, settings: {} }));
  await page.waitForTimeout(500);
  const got = await page.evaluate(() => globalThis.__snapshots.length);
  console.log('Q: snapshots=', got, 'errors=', errors);
  assert(errors.length === 0, 'Q: コンソール/ページエラーが出ない');
  assert(got === 0, 'Q: 自分の保存のスナップショットは返ってこない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== R: レンダラは受け取ったものを表示するだけ ===== */
{
  const ud = mkdir();
  // main が正規化して渡すので、レンダラ側に検証が無くても壊れた保存データで落ちない。
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [{ id: 't1', title: '生き残るタスク', completed: false, createdAt: 'こわれた' }],
    sessions: [{ id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: '不明' }],
    settings: { workMin: 9999 }, selectedTaskId: null
  }));
  const { app, page, errors } = await launch(ud);
  const view = await page.evaluate(() => ({
    workMin: data.settings.workMin,
    created: data.tasks[0].createdAt,
    started: data.sessions[0].startedAt,
    tasks: document.querySelectorAll('#taskList .task-item').length,
    timerText: document.querySelector('#timeDisplay').textContent
  }));
  console.log('R: view=', JSON.stringify(view), 'errors=', errors);
  assert(errors.length === 0, 'R: 壊れた保存データでもレンダラは落ちない');
  assert(view.workMin === 120, 'R: レンダラが受け取る時点で設定は丸まっている');
  assert(view.created === null, 'R: レンダラが受け取る時点で不正な日付は落ちている');
  assert(Number.isFinite(Date.parse(view.started)), 'R: セッションの日付も有効な値で届く');
  assert(view.tasks === 1, 'R: タスクは描画される');
  assert(!/NaN/.test(view.timerText), 'R: タイマー表示が NaN にならない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke23: FAILED' : '\nsmoke23: OK');
