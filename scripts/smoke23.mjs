import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 保存データの権威が main にあることの検証。レンダラは正本を持たず、受け取った
// スナップショットを表示するだけ:
//  Q) 書き込み元へはスナップショットを送り返さない(丸ごと置換での取りこぼし防止)
//  O) レンダラが範囲外・型違いを送ってきても、ディスクに出るのは正規形
//  P) 書き出しは main が持つ正本。レンダラの未保存の編集は混ざらない
//  R) 壊れた保存データでも、レンダラは受け取ったスナップショットを落ちずに描く
//
// 正規化の規則そのもの(どう丸め、どう復元するか)は schema-test.mjs で見る。
// ここで見るのは「main がその正規化を通している」ことと「描画が壊れない」ことだけ。
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
  // init() が最後まで到達したことの確認を兼ねる(途中で throw すると定義されない)
  await page.waitForFunction(() => typeof openTimeline === 'function', { timeout: 15000 });
  await page.waitForTimeout(300);
  return { app, page, errors };
}

const stubSaveDialog = (app, filePath) => app.evaluate(({ dialog }, fp) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
}, filePath);

/* ===== Q / O / P: 保存と書き出しの経路(同じアプリで順に見る) ===== */
{
  const ud = mkdir();
  const { app, page, errors } = await launch(ud);

  // Q: 丸ごと置換の保存 API では、保存1の応答が届くまでに編集2が入っていると、
  // 返ってきた古いスナップショットで編集2が画面から消え、次の保存で本当に失われる。
  await page.evaluate(() => {
    globalThis.__snapshots = [];
    window.api.onDataSnapshot(s => globalThis.__snapshots.push(s));
  });
  await page.evaluate(() => window.api.saveData({ tasks: [], sessions: [], selectedTaskId: null, settings: {} }));
  await page.waitForTimeout(500);
  const snapshots = await page.evaluate(() => globalThis.__snapshots.length);
  console.log('Q: snapshots=', snapshots);
  assert(snapshots === 0, 'Q: 自分の保存のスナップショットは返ってこない');

  // O: レンダラのバグや設定ダイアログの範囲外入力を想定した、検証を通っていない内容。
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
  console.log('O: res=', JSON.stringify(res), 'settings=', JSON.stringify(saved.settings));
  assert(res && res.ok === true, 'O: 保存自体は成功する(拒否ではなく正規化)');
  assert(saved.settings.workMin === 120 && saved.settings.whiteNoise.volume === 0, 'O: 範囲外の設定はディスクに出る前に丸める');
  assert(saved.tasks.length === 1 && saved.tasks[0].createdAt === null, 'O: タスクも正規化してから書く');
  assert(saved.sessions[0].mode === 'work' && Array.isArray(saved.sessions[0].taskIds), 'O: セッションも正規化してから書く');
  assert(saved.timer.mode === 'work' && saved.timer.cycle === 0, 'O: タイマーの進行状態も丸める');
  // 保存し直しても内容が変わらない(冪等)。崩れると無編集の保存でディスクが揺れる。
  await page.evaluate(s => window.api.saveData(s), saved);
  await page.waitForTimeout(200);
  assert(JSON.stringify(readData(ud)) === JSON.stringify(saved), 'O: 正規形を保存し直しても変わらない');

  // P: 以前は書き出す中身をレンダラが渡していたため、保存されていない内容
  // (検証も通っていない)がそのまま出力されえた。
  const out = path.join(ud, 'export.json');
  await page.evaluate(() => window.api.saveData({
    tasks: [{ id: 'saved', title: '保存済み', completed: false, createdAt: new Date().toISOString(), completedAt: null }],
    sessions: [], selectedTaskId: null, settings: {}
  }));
  await page.waitForTimeout(200);
  await stubSaveDialog(app, out);
  // レンダラ側だけを書き換え、保存しない
  await page.evaluate(() => { data.tasks.push({ id: 'unsaved', title: '未保存' }); });
  const exp = await page.evaluate(() => window.api.exportData('json'));
  const body = fs.readFileSync(out, 'utf8');
  console.log('P: res=', JSON.stringify(exp));
  assert(exp && exp.saved === true, 'P: 書き出せる');
  assert(/保存済み/.test(body), 'P: 正本の内容を書き出す');
  assert(!/未保存/.test(body), 'P: レンダラの未保存の編集は書き出さない');

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

console.log(process.exitCode ? '\nsmoke23: FAILED' : '\nsmoke23: OK');
