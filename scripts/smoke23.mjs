import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 保存データの権威が main にあることの検証。レンダラは正本を持たず、「何をしたいか」
// (意図)だけを送り、返ってきた正本を表示する:
//  O) レンダラが範囲外・型違いを送ってきても、ディスクに出るのは正規形
//  P) 書き出しは main が持つ正本。レンダラの未保存の編集は混ざらない
//  Q) 書き込み元も正規化後の正本を受け取る(画面とディスクが食い違わない)
//  R) レンダラは受け取ったスナップショットをそのまま表示する(自分では正規化しない)
//  S) 応答待ちの間に入った編集が消えない(丸ごと置換をやめた理由そのもの)
//  T) 未知の意図は保存を通さない
const APP_DIR = path.resolve(import.meta.dirname, '..');
// 既定は macOS 版のバイナリ。POMODORO_ELECTRON を渡せば他 OS の Electron でも走る。
const EXE = process.env.POMODORO_ELECTRON || path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const dataFile = ud => path.join(ud, 'pomodoro-data.json');
const readData = ud => JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));
const task = (id, title) => ({ id, title, completed: false, createdAt: new Date().toISOString(), completedAt: null });

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
  // レンダラのバグや設定ダイアログの範囲外入力を想定した、検証を通っていない意図。
  // 意図の側では丸めないので(検証を二箇所に置かない)、ディスクに出る前に
  // main の正規化が全部直しているかを見る。
  const res = await page.evaluate(async () => {
    await window.api.mutate({ type: 'task/add', task: { title: 'id 無し' } });
    await window.api.mutate({ type: 'task/add', task: { id: 'keep', title: 42, completed: 'yes', createdAt: 'いつか' } });
    await window.api.mutate({ type: 'session/add', session: { id: 's1', mode: 'まだ', durationSec: -5, startedAt: '不明', taskIds: 'x' } });
    await window.api.mutate({ type: 'task/select', id: '存在しない' });
    await window.api.mutate({ type: 'flow/set', mode: 'zzz', cycle: -1 });
    return window.api.mutate({ type: 'settings/update', patch: { workMin: 9999, whiteNoise: { volume: -20 } } });
  });
  const saved = readData(ud);
  console.log('O: res.ok=', res && res.ok, 'settings=', JSON.stringify(saved.settings), 'errors=', errors);
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

  // 何も変わらない意図を通してもディスクが揺れない(冪等)。崩れると、触っていない
  // のに保存のたびに内容が変わる。
  await page.evaluate(() => window.api.mutate({ type: 'task/select', id: null }));
  await page.waitForTimeout(200);
  assert(JSON.stringify(readData(ud)) === JSON.stringify(saved), 'O: 実質変化の無い意図を通しても内容が変わらない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== P: 書き出しは main の正本から ===== */
{
  const ud = mkdir();
  const out = path.join(ud, 'export.json');
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => window.api.mutate({ type: 'task/add', task: t }), task('saved', '保存済み'));
  await page.waitForTimeout(200);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, out);
  // レンダラ側の手元だけを書き換える(レンダラのバグを想定)。以前は書き出す中身を
  // レンダラが渡していたため、保存されていない内容がそのまま出力されえた。
  await page.evaluate(() => { data.tasks.push({ id: 'unsaved', title: '未保存' }); });
  const res = await page.evaluate(() => window.api.exportData('json'));
  const body = fs.readFileSync(out, 'utf8');
  console.log('P: res=', JSON.stringify(res), 'errors=', errors);
  assert(errors.length === 0, 'P: コンソール/ページエラーが出ない');
  assert(res && res.saved === true, 'P: 書き出せる');
  assert(/保存済み/.test(body), 'P: 正本の内容を書き出す');
  assert(!/未保存/.test(body), 'P: レンダラの手元の編集は書き出さない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Q: 書き込み元も正規化後の正本を受け取る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  // 丸ごと置換だった頃は、送り返すと取りこぼしが起きるため書き込み元にだけは
  // 正本を渡せなかった。その結果、main が丸めた値が画面に反映されず、次の保存で
  // 古い値がまた送られてくる(画面とディスクが静かにずれる)。意図にした今は
  // 応答に正本が入るので、書き手も必ず正規化後の内容を見る。
  const got = await page.evaluate(async () => {
    const res = await mutate({ type: 'settings/update', patch: { workMin: 9999 } });
    return { fromResponse: res.snapshot.settings.workMin, onScreen: data.settings.workMin };
  });
  console.log('Q: got=', JSON.stringify(got), 'errors=', errors);
  assert(errors.length === 0, 'Q: コンソール/ページエラーが出ない');
  assert(got.fromResponse === 120, 'Q: 応答に正規化後の正本が入る');
  assert(got.onScreen === 120, 'Q: 書き手の画面にも丸めた値が反映される');
  assert(readData(ud).settings.workMin === 120, 'Q: ディスクと画面が一致する');

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

/* ===== S: 応答待ちの間に入った編集が消えない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  // 丸ごと置換では、保存1の応答が届く前に編集2が入ると、編集2は保存1と同じ
  // 古い手元から組み立てられて上書きされ、失われていた。意図なら main が
  // 受け取った順に正本へ適用するので、どちらも残る。
  // アプリ自身の送信経路(mutate)を使う。応答ごとに正本を描き直すので、最後に
  // 届いた応答の内容が画面に残る。
  await page.evaluate(async ts => {
    await Promise.all(ts.map(t => mutate({ type: 'task/add', task: t })));
  }, [task('a', '一つ目'), task('b', '二つ目'), task('c', '三つ目')]);
  await page.waitForTimeout(200);
  const saved = readData(ud);
  const ids = saved.tasks.map(t => t.id).sort();
  const onScreen = await page.evaluate(() => data.tasks.length);
  console.log('S: ids=', JSON.stringify(ids), 'onScreen=', onScreen, 'errors=', errors);
  assert(errors.length === 0, 'S: コンソール/ページエラーが出ない');
  assert(ids.join(',') === 'a,b,c', 'S: 同時に出した編集がどれも消えない');
  assert(onScreen === 3, 'S: 画面にも全部残る');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== T: 未知の意図は保存を通さない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => window.api.mutate({ type: 'task/add', task: t }), task('t1', '残るタスク'));
  await page.waitForTimeout(200);
  const before = fs.readFileSync(dataFile(ud), 'utf8');
  // 黙って素通りさせると、届いていないのにレンダラは適用されたつもりで先へ進み、
  // 次の起動で消えていることに気づく。
  const res = await page.evaluate(() => window.api.mutate({ type: 'task/nuke', id: 't1' }));
  console.log('T: res=', JSON.stringify(res && { ok: res.ok, error: res.error }), 'errors=', errors);
  assert(errors.length === 0, 'T: コンソール/ページエラーが出ない');
  assert(res && res.ok === false && /未知の操作/.test(res.error), 'T: 失敗として返す');
  assert(fs.readFileSync(dataFile(ud), 'utf8') === before, 'T: ディスクは触らない');
  assert(res.snapshot && res.snapshot.tasks.length === 1, 'T: 失敗時も正本を添えて返す');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke23: FAILED' : '\nsmoke23: OK');
