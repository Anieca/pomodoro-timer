import { launchApp, assert, tempUserData, dataFile } from './test-env.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 保存データの権威が main にあることの検証。レンダラは正本を持たず、「何をしたいか」
// (意図)だけを送り、返ってきた正本を表示する:
//  O) レンダラが範囲外・型違いを送ってきても、ディスクに出るのは正規形
//  P) 書き出しは main が持つ正本。レンダラの未保存の編集は混ざらない
//  Q) 書き込み元も正規化後の正本を受け取る(画面とディスクが食い違わない)
//  R) 壊れた保存データでも、レンダラは受け取ったスナップショットを落ちずに描く
//  S) 応答待ちの間に入った編集が消えない(丸ごと置換をやめた理由そのもの)
//  T) 未知の意図は保存を通さない
// 応答待ちの間(レンダラは正本に応答待ちの意図を当てた見込みを描く):
//  U) 応答待ちの意図はすぐ画面に出て、失敗したら正本に戻る
//  V) 見込みで付けた実働は、意図の決着後の正本の選択に付け直す(失敗・正規化)
//  W) 書けなかった記録と進行状態は、書けるようになったら送り直す
//  X) 応答を待つ間に終了しても、記録は正しい付け先で終了時に書かれる
//  Y) 削除の取り消しは main の控えで戻す(応答待ちの編集も、その間の記録も失わない)
//  Z) 取り消しは応答を待たずに送られ、失敗したらもう一度出る
//  AA) 取り消しのボタンは、あとから来た保存失敗の通知で消えない
// 正規化の規則そのもの(どう丸め、どう復元するか)は schema-test.mjs で見る。
// ここで見るのは「main がその正規化を通している」ことと「描画が壊れない」ことだけ。

const mkdir = tempUserData;
const readData = ud => JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));
const task = (id, title) => ({ id, title, completed: false, createdAt: new Date().toISOString(), completedAt: null });

// 各ケースは起動前に userData へファイルを仕込み、終わったら自分で消す。
// launchApp は init() の完了まで待つ。壊れたデータで init が途中で投げれば errors に入って落ちる。
const launch = userData => launchApp({ userData });

const stubSaveDialog = (app, filePath) => app.evaluate(({ dialog }, fp) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
}, filePath);

/* ===== Q / O / P: 書き込みと書き出しの経路(同じアプリで順に見る) ===== */
// 3つとも新しい正本から始める必要はないので、起動を1回にまとめる。
// Q は設定だけを、O は O 自身が入れたものだけを、P は書き出しの中身だけを見る。
{
  const ud = mkdir();
  const out = path.join(ud, 'export.json');
  const { app, page, errors } = await launch(ud);

  // Q: 書き込み元も正規化後の正本を受け取る
  // 丸ごと置換だった頃は、送り返すと取りこぼしが起きるため書き込み元にだけは
  // 正本を渡せなかった。その結果、main が丸めた値が画面に反映されず、次の保存で
  // 古い値がまた送られてくる(画面とディスクが静かにずれる)。意図にした今は
  // 応答に正本が入るので、書き手も必ず正規化後の内容を見る。
  const got = await page.evaluate(async () => {
    const res = await mutate({ type: 'settings/update', patch: { workMin: 9999 } });
    return { fromResponse: res.snapshot.settings.workMin, onScreen: data.settings.workMin };
  });
  console.log('Q: got=', JSON.stringify(got));
  assert(got.fromResponse === 120, 'Q: 応答に正規化後の正本が入る');
  assert(got.onScreen === 120, 'Q: 書き手の画面にも丸めた値が反映される');
  assert(readData(ud).settings.workMin === 120, 'Q: ディスクと画面が一致する');

  // O: レンダラが何を送ってもディスクは正規形
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
  console.log('O: res.ok=', res && res.ok, 'settings=', JSON.stringify(saved.settings));
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

  // P: 書き出しは main の正本から
  await page.evaluate(t => window.api.mutate({ type: 'task/add', task: t }), task('saved', '保存済み'));
  await page.waitForTimeout(200);
  await stubSaveDialog(app, out);
  // レンダラ側の手元だけを書き換える(レンダラのバグを想定)。以前は書き出す中身を
  // レンダラが渡していたため、保存されていない内容がそのまま出力されえた。
  await page.evaluate(() => { data.tasks.push({ id: 'unsaved', title: '未保存' }); });
  const exp = await page.evaluate(() => window.api.exportData('json'));
  const body = fs.readFileSync(out, 'utf8');
  console.log('P: res=', JSON.stringify(exp));
  assert(exp && exp.saved === true, 'P: 書き出せる');
  assert(/保存済み/.test(body), 'P: 正本の内容を書き出す');
  assert(!/未保存/.test(body), 'P: レンダラの手元の編集は書き出さない');

  assert(errors.length === 0, 'Q/O/P: コンソール/ページエラーが出ない');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== R: 壊れた保存データでも落ちずに描く ===== */
{
  const ud = mkdir();
  const at = (dayOffset, h, m) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const today = (h, m = 0) => at(0, h, m);
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [
      { id: 't1', title: '生き残るタスク', completed: false, createdAt: 'こわれた', completedAt: null },
      { id: 't2', title: '壊れた完了日', completed: true, createdAt: today(9), completedAt: {} },
      // ToString で TypeError を投げる値(Date.parse は引数を ToString するため、
      // NaN ではなく例外になり init ごと止まっていた)
      { id: 't3', title: '文字列化できない日付', completed: false, createdAt: { toString: null }, completedAt: null }
    ],
    sessions: [
      // 開始が壊れていて終了も無い。旧コードは RangeError で init ごと停止していた。
      { id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: '不明' },
      // 終了だけ壊れている。旧コードは "NaN:NaN" を表示していた。
      { id: 's2', mode: 'work', durationSec: 600, completed: true, startedAt: today(9), endedAt: 'garbage' },
      // 不正・逆転・0長の区間が混ざっている(正常な1区間だけ描く)
      {
        id: 's3', mode: 'work', durationSec: 600, completed: true, startedAt: today(10), endedAt: today(10, 40),
        intervals: [
          { startedAt: 'まだ', endedAt: today(10, 10) },
          { startedAt: today(10, 30), endedAt: today(10, 20) },
          { startedAt: today(10, 35), endedAt: today(10, 35) },
          { startedAt: today(10), endedAt: today(10, 10) }
        ]
      },
      // 区間が全部不正(描かない)
      { id: 's4', mode: 'work', durationSec: 1500, completed: true, startedAt: today(11), endedAt: today(11, 40), intervals: [{ startedAt: 'x', endedAt: 'y' }] },
      // taskTimes / taskIds / intervals を持たない旧形式(旧コードは taskStats や履歴描画で落ちた)
      { id: 's5', mode: 'work', durationSec: 1500, completed: true, startedAt: today(12), endedAt: today(12, 25) },
      // 開始だけ壊れた昨日の記録(今日の集計に混ざらない)
      { id: 's6', mode: 'work', durationSec: 1500, completed: true, startedAt: null, endedAt: at(-1, 15, 25) },
      // 型違いだらけ
      { id: 's7', mode: 'bogus', durationSec: 'oops', completed: false, startedAt: today(13), endedAt: today(13), taskTimes: [{ taskId: 't1' }] }
    ],
    settings: { workMin: 'x', longEvery: 1000000000, whiteNoise: { volume: 500 } },
    selectedTaskId: null
  }));

  const { app, page, errors } = await launch(ud);
  const view = await page.evaluate(() => ({
    tasks: document.querySelectorAll('#taskList .task-item').length,
    dots: document.querySelectorAll('#cycleDots i').length,
    timerText: document.querySelector('#timeDisplay').textContent,
    todayCount: document.querySelector('#todayCount').textContent,
    statOk: (() => { try { return typeof taskStats('t1').minutes === 'number'; } catch { return false; } })()
  }));

  await page.evaluate(() => document.querySelector('#historyBtn').click());
  await page.waitForTimeout(300);
  const history = await page.evaluate(() => ({
    open: !document.querySelector('#historyModal').hidden,
    items: document.querySelectorAll('#historyList .history-item').length,
    text: document.querySelector('#historyList').textContent
  }));
  await page.evaluate(() => document.querySelector('#historyClose').click());

  await page.evaluate(() => openTimeline());
  await page.waitForTimeout(300);
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll('#timelineBody .timeline-block')].map(el => el.style.top + '/' + el.style.height));

  const csv = path.join(ud, 'tasks.csv');
  await stubSaveDialog(app, csv);
  const exp = await page.evaluate(() => window.api.exportData('csv-tasks'));
  const csvBody = fs.readFileSync(csv, 'utf8');

  console.log('R: view=', JSON.stringify(view), 'history=', history.items, 'blocks=', geometry, 'csv=', JSON.stringify(csvBody), 'errors=', errors);
  assert(errors.length === 0, 'R: 壊れた保存データでもコンソール/ページエラーが出ない');
  assert(view.tasks === 2, 'R: 未完了のタスクは描画される');
  assert(view.dots === 12, 'R: cycle dots は丸めた後の個数で描く');
  assert(/^\d\d:\d\d$/.test(view.timerText), 'R: タイマー表示が NaN にならない');
  // s1〜s5 の5件。昨日の s6 と未完了の s7 は数えない
  assert(view.todayCount === '5', 'R: 昨日の記録が今日の集計に混ざらない');
  assert(view.statOk, 'R: 旧形式のセッションでも taskStats が回る');
  assert(history.open && history.items === 7, 'R: 壊れた記録も含め全件を履歴に出す');
  assert(!/NaN|Invalid/.test(history.text), 'R: 履歴に NaN / Invalid Date を表示しない');
  // s1(開始=現在) / s2 / s3 の正常な区間 / s5。s4 は区間が全部不正、s7 は0長
  assert(geometry.length === 4, 'R: タイムテーブルには有効な区間だけ描く');
  assert(!geometry.some(g => /NaN/.test(g)), 'R: ブロックの座標に NaN が入らない');
  assert(exp && exp.saved === true, 'R: CSV を書き出せる');
  assert(!/NaN/.test(csvBody), 'R: CSV に NaN を書き出さない');
  assert(/^t1,生き残るタスク,未完了,,,/m.test(csvBody), 'R: 分からない作成日は空欄にする(今日として捏造しない)');
  assert(/文字列化できない日付/.test(csvBody), 'R: ToString で例外になる日付のタスクも書き出す');

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

const rowOf = (page, title) => page.evaluate(t => !![...document.querySelectorAll('.task-item')].find(li => li.textContent.includes(t)), title);

/* ===== U: 応答待ちの意図はすぐ画面に出て、失敗したら正本に戻る ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async ts => { for (const t of ts) await mutate({ type: 'task/add', task: t }); },
    [task('u1', '切り替えるタスク'), task('u2', '消すタスク')]);
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(300);
  await slowWrites(app, 400);
  // 完了を二度切り替える(一度目で行は完了側へ描き直されるので、そのとき見えている
  // チェックを押す)。正本を反転して送ると二回とも「完了」になる。
  // 設定を閉じてすぐ開始する。正本はまだ古い長さ。
  const started = await page.evaluate(() => {
    const check = () => [...document.querySelectorAll('.task-item')].find(li => li.textContent.includes('切り替えるタスク')).querySelector('.task-check');
    check().click();
    check().click();
    document.querySelector('#setWork').value = '50';
    saveSettings();
    startPauseResume();
    const min = timer.totalMs / 60000;
    stopEarly();
    return min;
  });
  await page.waitForTimeout(2000);
  let saved = readData(ud);
  // 削除は見込みからすぐ消え(行が残ると重ねて操作できてしまう)、失敗したら戻る。
  // (main が書き込みで止まっている間は外からの問い合わせも滞るので、隠れたかは
  // 同じ evaluate の中で見る)
  await slowThenFailNextWrite(app, 800);
  const hidden = await page.evaluate(() => {
    deleteTask('u2');
    return ![...document.querySelectorAll('.task-item')].some(li => li.textContent.includes('消すタスク'));
  });
  await page.waitForTimeout(1500);
  const back = await rowOf(page, '消すタスク');
  console.log('U: completed=', saved.tasks.find(t => t.id === 'u1').completed, 'started(min)=', started,
              'workMin=', saved.settings.workMin, 'hidden=', hidden, 'back=', back, 'errors=', errors.filter(e => !/保存/.test(e)));
  assert(saved.tasks.find(t => t.id === 'u1').completed === false, 'U: 応答前に二度切り替えた完了は元に戻る');
  assert(started === 50 && saved.settings.workMin === 50, 'U: 設定の応答前に開始しても新しい長さで始まる');
  assert(hidden && back, 'U: 削除の応答待ちの行は隠れ、失敗したら戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== V: 見込みで付けた実働は、決着後の正本の選択に付け直す ===== */
// fail: 選択の保存が遅れて失敗する / normalized: 保存は通るが、先に届いた完了で
// 選択が正規化に外される。どちらも応答前にセッションが終わる(記録は決着を待つ)。
for (const kind of ['fail', 'normalized']) {
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'v1' });
    startPauseResume();
  }, [task('v1', '元のタスク'), task('v2', '選び損ねるタスク')]);
  await page.waitForTimeout(1200);
  if (kind === 'fail') await slowThenFailNextWrite(app, 2500); else await slowWrites(app, 1200);
  await page.evaluate(async kind => {
    // 別の窓からの完了に見立てて、見込みを通さずに送る(先に main へ届く)。
    if (kind === 'normalized') window.api.mutate({ type: 'task/setDone', id: 'v2', completed: true, at: new Date().toISOString() });
    selectTask('v2');
    await new Promise(r => setTimeout(r, 1200));
    finishSession(true);
  }, kind);
  await page.waitForTimeout(4500);
  const rec = readData(ud).sessions.at(-1);
  const want = kind === 'fail' ? 'v1' : null;
  console.log(`V(${kind}): record=`, JSON.stringify(rec && rec.taskTimes));
  assert(rec && rec.taskTimes.every(tt => tt.taskId !== 'v2'), `V(${kind}): 選べなかったタスクに実働が付かない`);
  assert(rec && rec.taskTimes.some(tt => tt.taskId === want), `V(${kind}): その間の実働は正本の選択(${want})に付く`);
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== W: 書けなかった記録と進行状態は、書けるようになったら送り直す ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('w1', '作業中のタスク'));
  await page.waitForTimeout(1200);
  await setWritesFailing(app, true);
  const live = await page.evaluate(() => { finishSession(true); return { mode: timer.mode, cycle: timer.cycle }; });
  await page.waitForTimeout(500);
  const lost = readData(ud);
  await setWritesFailing(app, false);
  await page.evaluate(t => mutate({ type: 'task/add', task: t }), task('w2', '次の操作'));
  await page.waitForTimeout(800);
  const saved = readData(ud);
  console.log('W: sessions', lost.sessions.length, '->', saved.sessions.length, 'flow=', JSON.stringify(saved.timer), 'live=', JSON.stringify(live));
  assert(lost.sessions.length === 0 && lost.timer.mode === 'work', 'W: 書けない間は記録も進行状態も書かれない');
  assert(saved.sessions.length === 1 && saved.sessions[0].taskIds.includes('w1'), 'W: 次に書けたとき記録を一件だけ送り直す');
  assert(saved.timer.mode === live.mode && saved.timer.cycle === live.cycle, 'W: 進行状態も送り直す');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== X: 応答を待つ間に終了しても、記録は正しい付け先で書かれる ===== */
// record: 記録の保存が遅れて失敗する / focus: 選択の保存が遅れて失敗する(実行中の
// 記録は終了時に書かれるが、選べなかったタスクに付けてはいけない)。
for (const kind of ['record', 'focus']) {
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async ts => {
    for (const t of ts) await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: 'x1' });
    startPauseResume();
  }, [task('x1', '作業中のタスク'), task('x2', '選び損ねるタスク')]);
  await page.waitForTimeout(1200);
  // 失敗の応答は、終了処理が走ったあとに届くよう遅らせる。
  await slowThenFailNextWrite(app, kind === 'record' ? 800 : 2500);
  // 送った直後(失敗の応答が届く前)に終了処理を走らせ、そのままレンダラを止める
  // (破棄されたのと同じく、以降の応答は処理されない)。止まっている間にディスクを
  // 見れば、終了時の同期送信で何が書けたかだけが分かる。
  const busy = page.evaluate(async kind => {
    if (kind === 'record') finishSession(true);
    else {
      selectTask('x2');
      await new Promise(r => setTimeout(r, 1100));
      timer.current.intStartAt -= 61000;   // 終了時に記録されるのは 1 分以上の中断だけ
    }
    window.dispatchEvent(new Event('beforeunload'));
    const end = Date.now() + 3000; while (Date.now() < end);
  }, kind);
  await new Promise(r => setTimeout(r, kind === 'record' ? 1500 : 3000));
  const saved = readData(ud).sessions;
  await busy;
  console.log(`X(${kind}): sessions=`, JSON.stringify(saved.map(x => x.taskTimes)));
  assert(saved.length === 1 && saved[0].taskIds.includes('x1'), `X(${kind}): 終了時の同期送信で記録が書かれる(二重にならない)`);
  assert(saved.length === 1 && saved[0].taskTimes.every(tt => tt.taskId !== 'x2'), `X(${kind}): 選べなかったタスクには付かない`);
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Y: 削除の取り消しは main の控えで戻す ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);
  await page.evaluate(async t => {
    await mutate({ type: 'task/add', task: t });
    await mutate({ type: 'task/select', id: t.id });
    startPauseResume();
  }, task('y1', '元の名前'));
  await page.waitForTimeout(1200);
  // 名前の変更が main に届く前に削除する(控えを手元で作ると古い名前で戻ってしまう)。
  await slowWrites(app, 300);
  await page.evaluate(() => { mutate({ type: 'task/rename', id: 'y1', title: '変えた名前' }); deleteTask('y1'); });
  await page.waitForTimeout(1000);
  // 削除のあと、取り消す前にセッションが終わる。記録の参照は main で外れる。
  await page.evaluate(() => finishSession(true));
  await page.waitForTimeout(800);
  const stripped = readData(ud).sessions.at(-1);
  await page.evaluate(() => document.querySelector('#toast .toast-action').click());
  await page.waitForTimeout(1000);
  const saved = readData(ud);
  const t = saved.tasks.find(t => t.id === 'y1');
  const rec = saved.sessions.at(-1);
  console.log('Y: restored=', JSON.stringify(t && { title: t.title, selected: saved.selectedTaskId === 'y1' }),
              'record', JSON.stringify(stripped.taskIds), '->', JSON.stringify(rec.taskIds), 'errors=', errors);
  assert(errors.length === 0, 'Y: コンソール/ページエラーが出ない');
  assert(!stripped.taskIds.includes('y1'), 'Y: 削除中に届いた記録は削除済みのタスクを指さない');
  assert(t && t.title === '変えた名前', 'Y: 取り消しは応答待ちだった編集を巻き戻さない');
  assert(saved.selectedTaskId === 'y1', 'Y: 選択も戻る');
  assert(rec.taskIds.includes('y1'), 'Y: 削除から取り消しまでに終わった記録もそのタスクに戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== Z: 取り消しは応答を待たずに送られ、失敗したらもう一度出る ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async ts => { for (const t of ts) await mutate({ type: 'task/add', task: t }); },
    [task('z1', 'すぐ戻すタスク'), task('z2', '戻し直すタスク')]);
  await page.waitForTimeout(200);
  // 削除の応答前に取り消し、直後にレンダラを止める(閉じたのと同じ)。
  await slowWrites(app, 800);
  const busy = page.evaluate(() => {
    deleteTask('z1');
    document.querySelector('#toast .toast-action').click();
    const end = Date.now() + 3500; while (Date.now() < end);
  });
  await new Promise(r => setTimeout(r, 2500));
  const kept = readData(ud).tasks.some(t => t.id === 'z1');
  await busy;
  await page.waitForTimeout(500);
  await app.evaluate(() => { const fs = process.mainModule.require('fs'); fs.writeFileSync = globalThis.__origWrite || fs.writeFileSync; });
  // 取り消しの保存が失敗したら、取り消しがもう一度出て、押せば戻る。
  await page.evaluate(() => deleteTask('z2'));
  await page.waitForTimeout(800);
  await setWritesFailing(app, true);
  await page.evaluate(() => document.querySelector('#toast .toast-action').click());
  await page.waitForTimeout(500);
  const offered = await page.evaluate(() => /元に戻せませんでした/.test(document.querySelector('#toast').textContent) && !!document.querySelector('#toast .toast-action'));
  await setWritesFailing(app, false);
  await page.evaluate(() => document.querySelector('#toast .toast-action').click());
  await page.waitForTimeout(500);
  const retried = readData(ud).tasks.some(t => t.id === 'z2');
  console.log('Z: kept while stalled=', kept, 're-offered=', offered, 'retried=', retried);
  assert(kept, 'Z: 応答を待たずに送った取り消しは、直後に閉じても効く');
  assert(offered && retried, 'Z: 取り消しの保存に失敗したら、もう一度出て戻せる');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== AA: 取り消しのボタンは保存失敗の通知で消えない ===== */
{
  const ud = mkdir();
  const { app, page } = await launch(ud);
  await page.evaluate(async ts => { for (const t of ts) await mutate({ type: 'task/add', task: t }); },
    [task('aa1', '名前を変えるタスク'), task('aa2', '消すタスク')]);
  await page.waitForTimeout(200);
  await slowThenFailNextWrite(app, 600);
  await page.evaluate(() => {
    mutate({ type: 'task/rename', id: 'aa1', title: '新しい名前' });   // 遅れて失敗する
    deleteTask('aa2');                                                 // その後ろで通る
  });
  await page.waitForTimeout(1500);
  const toastNow = await page.evaluate(() => {
    const el = document.querySelector('#toast');
    return { hidden: el.hidden, text: el.textContent, hasAction: !!el.querySelector('.toast-action') };
  });
  await page.evaluate(() => { const b = document.querySelector('#toast .toast-action'); if (b) b.click(); });
  await page.waitForTimeout(500);
  const kept = readData(ud).tasks.some(t => t.id === 'aa2');
  console.log('AA: toast=', JSON.stringify(toastNow), 'restored=', kept);
  assert(!toastNow.hidden && /保存に失敗/.test(toastNow.text), 'AA: 保存失敗は通知される');
  assert(toastNow.hasAction && kept, 'AA: 取り消しのボタンは残り、押せば戻る');
  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
