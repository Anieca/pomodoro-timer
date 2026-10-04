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
//  U) 応答前に完了を二度切り替えても、最後の操作どおりに保存される
//  V) 選択を続けて変えたとき、先の応答で後の選択の保留を消さない
//  W) 完了の保存に失敗したら、区切った実働の付け先を元に戻す
//  X) 選択中のタスクの完了・削除の応答待ちに開始しても、そのタスクに付かない
//  Y) 削除の保存に失敗したら、匿名化した内訳と付け先を戻す
//  Z) 元に戻すの保存に失敗したら、記録は削除済みのタスクを指さない
//  AA) 応答前に二度押したノイズの切り替えは元に戻る
//  AB) 応答前に二度押したタスク行の選択は元に戻る
//  AC) 実行中の選択の保存に失敗したら、付け先を正本の選択に戻す
//  AD) 元に戻すの応答待ちにセッションが終わっても、戻せたなら実働はそのタスクに付く
//  AE) 選択が成功しても正規化で外れたら、付け先もそれに合わせる
//  AF) 選択中だったタスクを元に戻す応答待ちの間も、実働はそのタスクに付く(失敗なら外す)
//  AG) 完了を送ったタスクの行を応答前に押しても、付け先にならない
//  AH) 保存できなかった記録は捨てず、書けるようになったら送り直す
//  AI) 削除の応答待ちにセッションが終わり、その削除が失敗しても帰属は残る
//  AJ) 応答待ちの編集のあとに削除しても、取り消しはその編集を巻き戻さない
//  AK) 応答前に削除を二度押しても、取り消しが効く
//  AL) 削除してから取り消すまでに終わった記録も、取り消しでそのタスクに戻る
//  AM) 取り消しで選択も戻すかは、実際に削除された正本で決める
//  AN) 削除の応答待ちの行は隠れて操作を受けず、削除が失敗したら戻る
//  AO) 書けなかったタイマーの進行状態は、書けるようになったら送り直す
//  AP) 記録の失敗の応答を待つ間に終了しても、記録は終了時に書かれる
//  AQ) 設定を閉じてすぐ開始しても、変えた長さで始まる
//  AR) 書けていない記録が削除のあとに書かれても、取り消しでそのタスクに戻る
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

// main の書き込みを遅らせる/失敗させる。main は同期で書くので、ここで止めている間に
// レンダラは次の操作ができる(応答待ちの競合を決定的に再現できる)。
const slowWrites = (app, ms) => app.evaluate((_, ms) => {
  const fs = process.mainModule.require('fs');
  const orig = fs.writeFileSync;
  fs.writeFileSync = (...a) => { const end = Date.now() + ms; while (Date.now() < end); return orig(...a); };
}, ms);
const slowThenFailNextWrite = (app, ms) => app.evaluate((_, ms) => {
  const fs = process.mainModule.require('fs');
  const orig = fs.writeFileSync;
  fs.writeFileSync = () => {
    fs.writeFileSync = orig;
    const end = Date.now() + ms; while (Date.now() < end);
    throw new Error('EIO: テスト用の遅い書き込み失敗');
  };
}, ms);
// 戻すまで書き込みを失敗させ続ける(ディスクが一時的に書けない状態)。
const setWritesFailing = (app, on) => app.evaluate((_, on) => {
  const fs = process.mainModule.require('fs');
  if (on && !globalThis.__origWrite) {
    globalThis.__origWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('EACCES: テスト用の書き込み失敗'); };
  } else if (!on && globalThis.__origWrite) {
    fs.writeFileSync = globalThis.__origWrite;
    globalThis.__origWrite = null;
  }
}, on);
const failNextWrite = app => app.evaluate(() => {
  const fs = process.mainModule.require('fs');
  const orig = fs.writeFileSync;
  fs.writeFileSync = () => { fs.writeFileSync = orig; throw new Error('ENOSPC: テスト用の書き込み失敗'); };
});

/* ===== U: 応答前に二度切り替えた完了は最後の操作どおり ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('u1', '切り替えるタスク'));
  await page.waitForTimeout(200);
  await slowWrites(app, 400);
  // 正本を反転して送ると、二度とも同じ(未完了の)正本を見て「完了」を二回送ってしまう。
  await page.evaluate(() => {
    const check = document.querySelector('#taskList .task-check');
    check.click();
    check.click();
  });
  await page.waitForTimeout(1500);
  const saved = readData(ud).tasks.find(t => t.id === 'u1');
  const onScreen = await page.evaluate(() => data.tasks.find(t => t.id === 'u1').completed);
  console.log('U: saved.completed=', saved.completed, 'onScreen=', onScreen, 'errors=', errors);
  assert(errors.length === 0, 'U: コンソール/ページエラーが出ない');
  assert(saved.completed === false, 'U: 二度切り替えたら未完了で保存される');
  assert(onScreen === false, 'U: 画面も未完了');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== V: 先に返った選択の応答で後の選択の保留を消さない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
  }, [task('va', 'A'), task('vb', 'B')]);
  await slowWrites(app, 400);
  // A の応答だけが届いた間(正本は A、B はまだ保存中)のフォーカス対象を見る。
  // ここで開始されたセッションの付け先になる値。main が書き込みで止まっている間は
  // 外からの問い合わせも滞るので、ページ内で見張る。
  const between = await page.evaluate(() => new Promise((resolve, reject) => {
    const seen = new Set();
    const iv = setInterval(() => {
      if (data.selectedTaskId === 'va') seen.add(focusTaskId());
      if (data.selectedTaskId === 'vb') { clearInterval(iv); resolve([...seen]); }
    }, 10);
    setTimeout(() => { clearInterval(iv); reject(new Error('B の応答が届かない')); }, 5000);
    selectTask('va');
    selectTask('vb');
  }));
  console.log('V: focus between responses=', JSON.stringify(between), 'errors=', errors);
  assert(errors.length === 0, 'V: コンソール/ページエラーが出ない');
  assert(between.length > 0 && between.every(id => id === 'vb'), 'V: A の応答が先に届いても、フォーカス対象は後に選んだ B のまま');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== W: 完了の保存に失敗したら実働の付け先を戻す ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('w1', '作業中のタスク'));
  await failNextWrite(app);
  const after = await page.evaluate(async () => {
    toggleTaskDone('w1', true);
    await new Promise(r => setTimeout(r, 500));
    return { seg: timer.current && timer.current.segTaskId, selected: data.selectedTaskId,
             completed: data.tasks.find(t => t.id === 'w1').completed };
  });
  console.log('W: after failed completion=', JSON.stringify(after), 'errors=', errors);
  assert(after.selected === 'w1' && after.completed === false, 'W: 正本では選択中・未完了のまま');
  assert(after.seg === 'w1', 'W: 実働の付け先も元のタスクに戻る');
  await page.evaluate(() => clearInterval(timer.intervalId));
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== X: 完了・削除の応答待ちに開始したセッションは外れるタスクに付かない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'x1' });
  }, [task('x1', '完了するタスク'), task('x2', '削除するタスク')]);
  await slowWrites(app, 400);
  // アイドル中は区切る対象のセッションがない。応答前に開始すると、選択が残って見える。
  const afterDone = await page.evaluate(async () => {
    toggleTaskDone('x1', true);
    startPauseResume();
    const seg = timer.current.segTaskId;
    stopEarly();
    await new Promise(r => setTimeout(r, 1500));
    await mutate({ type: 'task/select', id: 'x2' });
    return seg;
  });
  const afterDelete = await page.evaluate(async () => {
    deleteTask('x2');
    startPauseResume();
    const seg = timer.current.segTaskId;
    stopEarly();
    await new Promise(r => setTimeout(r, 1500));
    return seg;
  });
  console.log('X: seg after complete=', afterDone, 'after delete=', afterDelete, 'errors=', errors);
  assert(errors.length === 0, 'X: コンソール/ページエラーが出ない');
  assert(afterDone === null, 'X: 完了の応答待ちに開始しても完了するタスクに付かない');
  assert(afterDelete === null, 'X: 削除の応答待ちに開始しても削除するタスクに付かない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Y: 削除の保存に失敗したら内訳と付け先を戻す ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('y1', '消せないタスク'));
  await page.waitForTimeout(1200);           // 1 秒以上の区間でないと内訳に積まれない
  await failNextWrite(app);
  const after = await page.evaluate(async () => {
    deleteTask('y1');
    await new Promise(r => setTimeout(r, 500));
    return { seg: timer.current.segTaskId, segs: timer.current.segments.map(s => s.taskId),
             kept: data.tasks.some(t => t.id === 'y1'), selected: data.selectedTaskId };
  });
  console.log('Y: after failed delete=', JSON.stringify(after));
  assert(after.kept && after.selected === 'y1', 'Y: 正本ではタスクも選択も残っている');
  assert(after.seg === 'y1', 'Y: 実働の付け先も元のタスクに戻る');
  assert(after.segs.length > 0 && after.segs.every(id => id === 'y1'), 'Y: 匿名化した内訳も元のタスクに戻る');
  await page.evaluate(() => clearInterval(timer.intervalId));
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Z: 元に戻すの保存に失敗したら記録は削除済みのタスクを指さない ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('z1', '消したタスク'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => deleteTask('z1'));
  await page.waitForTimeout(300);
  await failNextWrite(app);
  const after = await page.evaluate(async () => {
    document.querySelector('#toast .toast-action').click();
    await new Promise(r => setTimeout(r, 500));
    const r = { seg: timer.current.segTaskId, kept: data.tasks.some(t => t.id === 'z1') };
    finishSession(true);
    return r;
  });
  await page.waitForTimeout(500);
  const rec = readData(ud).sessions.at(-1);
  console.log('Z: after failed restore=', JSON.stringify(after), 'record=', JSON.stringify(rec.taskTimes));
  assert(!after.kept, 'Z: 正本ではタスクは削除されたまま');
  assert(after.seg === null, 'Z: 付け先も削除済みのタスクに戻らない');
  assert(!rec.taskIds.includes('z1') && rec.taskTimes.every(tt => tt.taskId !== 'z1'), 'Z: 記録は削除済みのタスクを指さない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AA: 応答前の二度押しでノイズは元に戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  const before = await page.evaluate(() => data.settings.whiteNoise.enabled);
  await slowWrites(app, 400);
  await page.evaluate(() => {
    document.querySelector('#noiseIndicator').click();
    document.querySelector('#noiseIndicator').click();
  });
  await page.waitForTimeout(1500);
  const onScreen = await page.evaluate(() => data.settings.whiteNoise.enabled);
  const saved = readData(ud).settings.whiteNoise.enabled;
  console.log('AA: before=', before, 'saved=', saved, 'onScreen=', onScreen, 'errors=', errors);
  assert(errors.length === 0, 'AA: コンソール/ページエラーが出ない');
  assert(saved === before && onScreen === before, 'AA: 二度切り替えたら元の設定に戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AB: 応答前の二度押しでタスクの選択は元に戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('ab1', '選ぶタスク'));
  await page.waitForTimeout(200);
  await slowWrites(app, 400);
  // 行は応答まで描き直されないので、二度目のクリックも同じ行(描画時は未選択)に届く。
  await page.evaluate(() => {
    const row = document.querySelector('#taskList .task-item');
    row.click();
    row.click();
  });
  await page.waitForTimeout(1500);
  const onScreen = await page.evaluate(() => ({ selected: data.selectedTaskId, focus: focusTaskId() }));
  const saved = readData(ud).selectedTaskId;
  console.log('AB: saved=', saved, 'onScreen=', JSON.stringify(onScreen), 'errors=', errors);
  assert(errors.length === 0, 'AB: コンソール/ページエラーが出ない');
  assert(saved === null && onScreen.selected === null && onScreen.focus === null, 'AB: 二度押したら未選択に戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AC: 実行中の選択の保存に失敗したら付け先を戻す ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'ac1' });
    startPauseResume();
  }, [task('ac1', '元のタスク'), task('ac2', '選び直すタスク')]);
  await failNextWrite(app);
  const after = await page.evaluate(async () => {
    selectTask('ac2');
    await new Promise(r => setTimeout(r, 500));
    return { seg: timer.current.segTaskId, selected: data.selectedTaskId, focus: focusTaskId() };
  });
  console.log('AC: after failed select=', JSON.stringify(after), 'errors=', errors);
  assert(after.selected === 'ac1' && after.focus === 'ac1', 'AC: 正本の選択は元のまま');
  assert(after.seg === 'ac1', 'AC: 実働の付け先も元のタスクに戻る');
  await page.evaluate(() => clearInterval(timer.intervalId));
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AD: 元に戻すの応答待ちにセッションが終わっても実働を失わない ===== */
for (const fail of [false, true]) {
  const label = fail ? 'AD(失敗)' : 'AD';
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('ad1', '戻すタスク'));
  await page.waitForTimeout(1200);           // 1 秒以上の区間でないと内訳に積まれない
  await page.evaluate(() => deleteTask('ad1'));
  await page.waitForTimeout(300);
  if (fail) await failNextWrite(app); else await slowWrites(app, 400);
  // 取り消しの応答が届く前にセッションを完了させる。
  await page.evaluate(() => {
    document.querySelector('#toast .toast-action').click();
    finishSession(true);
  });
  await page.waitForTimeout(1500);
  const saved = readData(ud);
  const rec = saved.sessions[saved.sessions.length - 1];
  console.log(`${label}: tasks=`, JSON.stringify(saved.tasks.map(t => t.id)), 'record=', JSON.stringify({ taskIds: rec.taskIds, taskTimes: rec.taskTimes }));
  if (!fail) {
    assert(saved.tasks.some(t => t.id === 'ad1'), 'AD: タスクは戻る');
    assert(rec.taskIds.includes('ad1') && rec.taskTimes.some(tt => tt.taskId === 'ad1'), 'AD: 応答待ちに終わった記録もそのタスクに付く');
  } else {
    assert(!saved.tasks.some(t => t.id === 'ad1'), 'AD(失敗): タスクは削除されたまま');
    assert(!rec.taskIds.includes('ad1') && rec.taskTimes.every(tt => tt.taskId !== 'ad1'), 'AD(失敗): 記録は削除済みのタスクを指さない');
  }
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AE: 選択が正規化で外れたら付け先も合わせる ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'ae1' });
    startPauseResume();
  }, [task('ae1', '作業中のタスク'), task('ae2', '別の窓で完了されるタスク')]);
  await slowWrites(app, 400);
  // ae2 の完了が先に main に届き、その後に届いた選択は正規化で外れる(保存自体は成功)。
  const after = await page.evaluate(async () => {
    window.api.mutate({ type: 'task/setDone', id: 'ae2', completed: true, at: new Date().toISOString() });
    selectTask('ae2');
    await new Promise(r => setTimeout(r, 1500));
    return { seg: timer.current.segTaskId, selected: data.selectedTaskId, focus: focusTaskId() };
  });
  console.log('AE: after normalized select=', JSON.stringify(after), 'errors=', errors);
  assert(errors.length === 0, 'AE: コンソール/ページエラーが出ない');
  assert(after.selected === null && after.focus === null, 'AE: 完了したタスクは選択されない');
  assert(after.seg === null, 'AE: 付け先も完了したタスクに残らない');
  await page.evaluate(() => clearInterval(timer.intervalId));
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AF: 選択中だったタスクの取り消し待ちの間も実働はそのタスクに付く ===== */
for (const fail of [false, true]) {
  const label = fail ? 'AF(失敗)' : 'AF';
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('af1', '戻すタスク'));
  await page.waitForTimeout(300);
  await page.evaluate(() => deleteTask('af1'));
  await page.waitForTimeout(300);
  if (fail) await failNextWrite(app); else await slowWrites(app, 1500);
  const pending = await page.evaluate(() => {
    document.querySelector('#toast .toast-action').click();
    return { focus: focusTaskId(), seg: timer.current.segTaskId };
  });
  await page.waitForTimeout(1200);           // 応答待ちの区間を 1 秒以上にする(内訳に積まれる長さ)
  // 応答前にセッションを完了させる(成功時)。失敗時は応答後の内訳を見る。
  const after = await page.evaluate(async fail => {
    const r = fail ? { seg: timer.current.segTaskId } : null;
    finishSession(true);
    return r;
  }, fail);
  await page.waitForTimeout(800);
  const saved = readData(ud);
  const rec = saved.sessions[saved.sessions.length - 1];
  if (!fail) {
    console.log(`${label}: pending=`, JSON.stringify(pending), 'record=', JSON.stringify(rec.taskTimes));
    assert(pending.focus === 'af1' && pending.seg === 'af1', 'AF: 応答待ちの間もフォーカスと付け先は戻したタスク');
    assert(rec.taskTimes.every(tt => tt.taskId === 'af1'), 'AF: 応答待ちの間の実働もそのタスクに付く');
  } else {
    console.log(`${label}: after=`, JSON.stringify(after), 'record=', JSON.stringify(rec.taskTimes));
    assert(after.seg === null, 'AF(失敗): 付け先は外れる');
    assert(!rec.taskIds.includes('af1') && rec.taskTimes.every(tt => tt.taskId !== 'af1'), 'AF(失敗): 記録は削除済みのタスクを指さない');
  }
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AG: 完了を送ったタスクの行を押しても付け先にならない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'ag1' });
    startPauseResume();
  }, [task('ag1', '作業中のタスク'), task('ag2', '完了するタスク')]);
  await slowWrites(app, 2500);
  const pending = await page.evaluate(async () => {
    toggleTaskDone('ag2', true);
    // 行は応答まで未完了のまま描かれている。
    [...document.querySelectorAll('#taskList .task-item')].find(li => li.textContent.includes('完了するタスク')).click();
    const r = { focus: focusTaskId(), seg: timer.current.segTaskId };
    await new Promise(r => setTimeout(r, 1200));   // 内訳に積まれる長さ(1 秒以上)にする
    finishSession(true);                    // 応答前に記録を送る
    return r;
  });
  await page.waitForTimeout(6000);
  const saved = readData(ud);
  const rec = saved.sessions[saved.sessions.length - 1];
  console.log('AG: pending=', JSON.stringify(pending), 'record taskIds=', JSON.stringify(rec.taskIds), 'errors=', errors);
  assert(errors.length === 0, 'AG: コンソール/ページエラーが出ない');
  assert(pending.focus === 'ag1' && pending.seg === 'ag1', 'AG: 完了を送ったタスクは選べない');
  assert(!rec.taskIds.includes('ag2'), 'AG: 記録は完了したタスクに付かない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AH: 保存できなかった記録は書けるようになったら送り直す ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('ah1', '作業中のタスク'));
  await page.waitForTimeout(1200);
  await setWritesFailing(app, true);
  await page.evaluate(() => finishSession(true));
  await page.waitForTimeout(500);
  const lost = readData(ud).sessions.length;
  await setWritesFailing(app, false);
  // 次の操作で書けたら、取りこぼした記録も一緒に乗る。
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('ah2', '次の操作'));
  await page.waitForTimeout(800);
  const saved = readData(ud).sessions;
  console.log('AH: sessions after failure=', lost, 'after retry=', JSON.stringify(saved.map(x => x.taskIds)));
  assert(lost === 0, 'AH: 失敗した時点では記録は書かれていない');
  assert(saved.length === 1 && saved[0].taskIds.includes('ah1'), 'AH: 次に書けたとき記録を送り直す(二重にならない)');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AI: 削除の応答待ちに終わったセッションは、削除が失敗すれば帰属を保つ ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('ai1', '消せないタスク'));
  await page.waitForTimeout(1200);
  await slowThenFailNextWrite(app, 600);
  await page.evaluate(() => { deleteTask('ai1'); finishSession(true); });
  await page.waitForTimeout(1500);
  const saved = readData(ud);
  const rec = saved.sessions.at(-1);
  console.log('AI: tasks=', JSON.stringify(saved.tasks.map(t => t.id)), 'record=', JSON.stringify(rec && rec.taskTimes));
  assert(saved.tasks.some(t => t.id === 'ai1'), 'AI: 削除は失敗してタスクは残る');
  assert(rec && rec.taskIds.includes('ai1'), 'AI: 応答待ちに終わった記録もそのタスクに付いたまま');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AJ: 応答待ちの編集のあとに削除しても、取り消しは編集を巻き戻さない ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('aj1', '元の名前'));
  await page.waitForTimeout(200);
  await slowWrites(app, 400);
  // 完了と名前の変更が main に届く前に、まだ古い内容で描かれている行を削除して取り消す。
  await page.evaluate(() => {
    mutate({ type: 'task/rename', id: 'aj1', title: '変えた名前' });
    toggleTaskDone('aj1', true);
    deleteTask('aj1');
    document.querySelector('#toast .toast-action').click();
  });
  await page.waitForTimeout(3000);
  const saved = readData(ud).tasks.find(t => t.id === 'aj1');
  console.log('AJ: restored=', JSON.stringify(saved && { title: saved.title, completed: saved.completed }), 'errors=', errors);
  assert(errors.length === 0, 'AJ: コンソール/ページエラーが出ない');
  assert(saved && saved.completed === true, 'AJ: 取り消しで完了が巻き戻らない');
  assert(saved && saved.title === '変えた名前', 'AJ: 取り消しで名前の変更が巻き戻らない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AK: 応答前に削除を二度押しても取り消しが効く ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('ak1', '二度消すタスク'));
  await page.waitForTimeout(200);
  await slowWrites(app, 400);
  await page.evaluate(() => {
    deleteTask('ak1');
    deleteTask('ak1');
    document.querySelector('#toast .toast-action').click();
  });
  await page.waitForTimeout(2500);
  const saved = readData(ud);
  console.log('AK: tasks=', JSON.stringify(saved.tasks.map(t => t.id)), 'errors=', errors);
  assert(errors.length === 0, 'AK: コンソール/ページエラーが出ない');
  assert(saved.tasks.filter(t => t.id === 'ak1').length === 1, 'AK: 取り消しでタスクが戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AL: 削除から取り消しまでに終わった記録も戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('al1', '消してから戻すタスク'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => deleteTask('al1'));
  await page.waitForTimeout(300);           // 削除は通っている
  await page.evaluate(() => finishSession(true));
  await page.waitForTimeout(300);
  const stripped = readData(ud).sessions.at(-1);
  await page.evaluate(() => document.querySelector('#toast .toast-action').click());
  await page.waitForTimeout(500);
  const saved = readData(ud);
  const rec = saved.sessions.at(-1);
  console.log('AL: stripped=', JSON.stringify(stripped.taskTimes), 'restored=', JSON.stringify(rec.taskTimes), 'errors=', errors);
  assert(errors.length === 0, 'AL: コンソール/ページエラーが出ない');
  assert(!stripped.taskIds.includes('al1'), 'AL: 削除中に届いた記録は削除済みのタスクを指さない');
  assert(saved.tasks.some(t => t.id === 'al1'), 'AL: 取り消しでタスクが戻る');
  assert(rec.taskIds.includes('al1') && rec.taskTimes.some(tt => tt.taskId === 'al1'), 'AL: その間の記録もそのタスクに戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AM: 取り消しで選択を戻すかは削除された正本で決める ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
  }, task('am1', '選択中のタスク'));
  await failNextWrite(app);
  // 完了(=フォーカスを外す要求)は失敗し、続く削除は通る。main では選択中のまま削除される。
  // 完了の失敗トーストが削除のトーストを上書きするので、取り消しはトーストに渡された
  // 操作を控えておいて呼ぶ。
  await page.evaluate(() => {
    const orig = toast;
    toast = (msg, action) => { if (action) window.__undo = action.fn; return orig(msg, action); };
    toggleTaskDone('am1', true);
    deleteTask('am1');
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__undo());
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ kept: data.tasks.some(t => t.id === 'am1'), selected: data.selectedTaskId }));
  console.log('AM: after undo=', JSON.stringify(after), 'errors=', errors.filter(e => !/保存/.test(e)));
  assert(after.kept, 'AM: 取り消しでタスクが戻る');
  assert(after.selected === 'am1', 'AM: 削除されたとき選択中だったので選択も戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AN: 削除の応答待ちの行は隠れ、失敗したら戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('an1', '消えかけのタスク'));
  await page.waitForTimeout(200);
  await slowThenFailNextWrite(app, 800);
  const during = await page.evaluate(() => {
    deleteTask('an1');
    const rows = [...document.querySelectorAll('#taskList .task-item')].filter(li => li.textContent.includes('消えかけのタスク')).length;
    toggleTaskDone('an1', true);            // 応答待ちの間の操作は重ねない
    return rows;
  });
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#taskList .task-item')].filter(li => li.textContent.includes('消えかけのタスク')).length,
    completed: data.tasks.find(t => t.id === 'an1').completed
  }));
  console.log('AN: rows during=', during, 'after=', JSON.stringify(after), 'errors=', errors);
  assert(during === 0, 'AN: 削除の応答待ちの間は行を隠す');
  assert(after.rows === 1, 'AN: 削除が失敗したら行が戻る');
  assert(after.completed === false, 'AN: 応答待ちの間の完了は送られない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AO: 書けなかった進行状態は書けるようになったら送り直す ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(() => startPauseResume());
  await setWritesFailing(app, true);
  const live = await page.evaluate(() => { finishSession(true); return { mode: timer.mode, cycle: timer.cycle }; });
  await page.waitForTimeout(500);
  await setWritesFailing(app, false);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('ao1', '次の操作'));
  await page.waitForTimeout(800);
  const saved = readData(ud).timer;
  console.log('AO: live=', JSON.stringify(live), 'saved=', JSON.stringify(saved));
  assert(live.mode !== 'work', 'AO: 手元のタイマーは次のフェーズへ進んでいる');
  assert(saved.mode === live.mode && saved.cycle === live.cycle, 'AO: 次に書けたとき進行状態も送り直す');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AP: 記録の失敗を待つ間に終了しても記録は残る ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('ap1', '作業中のタスク'));
  await page.waitForTimeout(1200);
  await slowThenFailNextWrite(app, 800);
  // 記録を送った直後(失敗の応答が届く前)に終了処理を走らせ、そのままレンダラを
  // 止める(破棄されたのと同じく、以降の応答は処理されない)。止まっている間に
  // ディスクを見れば、終了時の同期送信で書けたかだけが分かる。
  const busy = page.evaluate(() => {
    finishSession(true);
    window.dispatchEvent(new Event('beforeunload'));
    const end = Date.now() + 2500; while (Date.now() < end);
  });
  await new Promise(r => setTimeout(r, 1500));
  const saved = readData(ud).sessions;
  await busy;
  console.log('AP: sessions=', JSON.stringify(saved.map(x => x.taskIds)));
  assert(saved.length === 1 && saved[0].taskIds.includes('ap1'), 'AP: 終了時の同期送信で記録が書かれる(二重にならない)');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AQ: 設定を閉じてすぐ開始しても変えた長さで始まる ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(300);
  await slowWrites(app, 800);
  const totalMin = await page.evaluate(() => {
    document.querySelector('#setWork').value = '50';
    saveSettings();                         // 応答を待たずに
    startPauseResume();
    return timer.totalMs / 60000;
  });
  await page.waitForTimeout(1500);
  const saved = readData(ud).settings.workMin;
  console.log('AQ: started with', totalMin, 'min, saved workMin=', saved, 'errors=', errors);
  assert(errors.length === 0, 'AQ: コンソール/ページエラーが出ない');
  assert(totalMin === 50 && saved === 50, 'AQ: 応答前に開始しても新しい作業時間(50分)で始まる');
  await page.evaluate(() => clearInterval(timer.intervalId));
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AR: 送り直し待ちの記録も取り消しで戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('ar1', '記録が書けなかったタスク'));
  await page.waitForTimeout(1200);
  await setWritesFailing(app, true);
  await page.evaluate(() => finishSession(true));   // 記録は送り直し待ちに残る
  await page.waitForTimeout(500);
  await setWritesFailing(app, false);
  // 削除が通ると、その応答で送り直された記録は削除済みのタスクを指さない形で書かれる。
  await page.evaluate(() => deleteTask('ar1'));
  await page.waitForTimeout(800);
  const stripped = readData(ud).sessions.at(-1);
  await page.evaluate(() => document.querySelector('#toast .toast-action').click());
  await page.waitForTimeout(500);
  const rec = readData(ud).sessions.at(-1);
  console.log('AR: stripped=', JSON.stringify(stripped && stripped.taskTimes), 'restored=', JSON.stringify(rec && rec.taskTimes), 'errors=', errors.filter(e => !/保存/.test(e)));
  assert(stripped && !stripped.taskIds.includes('ar1'), 'AR: 削除のあとに書かれた記録は削除済みのタスクを指さない');
  assert(rec && rec.taskIds.includes('ar1') && rec.taskTimes.some(tt => tt.taskId === 'ar1'), 'AR: 取り消しでその記録もタスクに戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke23: FAILED' : '\nsmoke23: OK');
