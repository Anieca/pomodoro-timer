import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 日付バリデーション(parseIso)の検証。壊れた保存データや手編集で不正な日付が
// 混ざっても、起動が落ちず・表示に NaN が出ず・不正区間が黙って化けないこと:
//  H) 不正な startedAt/endedAt → RangeError で init が止まらず、履歴も NaN にならない
//  I) intervals の不正日付・逆転区間 → 落として、正常な区間だけタイムテーブルに出す
//  K) 区間が全部不正 → 空のまま(旧データの畳み込みと区別し、実働を捏造しない)
//  L) 片方だけ壊れた日付 → 生きている側と durationSec から復元し、逆転させない
//  M) 一時停止を挟んだ記録 → 端点は durationSec ではなく生きている区間から復元する
//  N) タスクの completedAt: 0(epoch) → 有効な日付として扱い、未完了に化かさない
//  J) タスクの不正な createdAt → CSV 書き出しが "NaN-NaN-NaN" にならない
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const dataFile = ud => path.join(ud, 'pomodoro-data.json');

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

const iso = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

/* ===== H: 不正な日付でも起動し、履歴に NaN を出さない ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [], selectedTaskId: null, settings: {},
    sessions: [
      // startedAt がパース不能。endedAt が無いので旧コードは
      // new Date(NaN).toISOString() で RangeError を投げ、init ごと停止していた。
      { id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: '不明' },
      // endedAt だけ壊れているケース(旧コードは素通りさせて "NaN:NaN" を表示)
      { id: 's2', mode: 'work', durationSec: 600, completed: true, startedAt: iso(9, 0), endedAt: 'garbage' },
      // 正常な記録が巻き添えで消えないこと
      { id: 's3', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(10, 0), endedAt: iso(10, 25) }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  await page.evaluate(() => document.querySelector('#historyBtn').click());
  await page.waitForTimeout(300);
  const count = await page.evaluate(() => document.querySelectorAll('#historyList .history-item').length);
  const text = await page.evaluate(() => document.querySelector('#historyList').textContent);
  console.log('H: history items=', count, 'errors=', errors);
  assert(errors.length === 0, 'H: 不正な日付でもコンソール/ページエラーが出ない');
  assert(count === 3, 'H: 3件とも履歴に出る(不正な日付でも捨てない)');
  assert(!/NaN|Invalid/.test(text), 'H: 履歴に NaN / Invalid Date を表示しない');

  const dates = await page.evaluate(() =>
    data.sessions.map(s => [Number.isFinite(Date.parse(s.startedAt)), Number.isFinite(Date.parse(s.endedAt))]));
  assert(dates.every(([a, b]) => a && b), 'H: 正規化後の startedAt / endedAt は必ず有効な日付');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== I: 不正な区間は落とし、正常な区間だけ描く ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [], selectedTaskId: null, settings: {},
    sessions: [{
      id: 's1', mode: 'work', durationSec: 1500, completed: true,
      startedAt: iso(9, 0), endedAt: iso(9, 40),
      intervals: [
        { startedAt: 'まだ', endedAt: iso(9, 10) },   // 日付として壊れている
        { startedAt: iso(9, 30), endedAt: iso(9, 20) }, // 終了が開始より前(逆転)
        { startedAt: iso(9, 35), endedAt: iso(9, 35) }, // 0 長
        { startedAt: iso(9, 0), endedAt: iso(9, 10) }   // 正常
      ]
    }]
  }));

  const { app, page, errors } = await launch(ud);
  const kept = await page.evaluate(() => data.sessions[0].intervals.length);
  await page.evaluate(() => openTimeline());
  await page.waitForTimeout(300);
  const blocks = await page.evaluate(() => document.querySelectorAll('#timelineBody .timeline-block').length);
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll('#timelineBody .timeline-block')].map(el => el.style.top + '/' + el.style.height));
  console.log('I: kept=', kept, 'blocks=', blocks, 'geometry=', geometry, 'errors=', errors);
  assert(errors.length === 0, 'I: コンソール/ページエラーが出ない');
  assert(kept === 1, 'I: 不正・逆転・0長の区間を落とし、正常な1件だけ残す');
  assert(blocks === 1, 'I: タイムテーブルに正常な区間だけ描画する');
  assert(!geometry.some(g => /NaN/.test(g)), 'I: ブロックの座標に NaN が入らない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== K: 全部不正だった区間を span に化かさない(旧データの畳み込みとは区別する) ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [], selectedTaskId: null, settings: {},
    sessions: [
      // 区間を持っていたが全部不正。span に畳むと一時停止していた 9:00〜9:40 まで
      // 実働として描かれ、次の保存でその捏造が正史になる。
      {
        id: 's1', mode: 'work', durationSec: 1500, completed: true,
        startedAt: iso(9, 0), endedAt: iso(9, 40),
        intervals: [{ startedAt: 'こわれた', endedAt: 'こわれた' }]
      },
      // 区間の概念が無い旧データ。これは従来どおり1区間に畳んでよい。
      { id: 's2', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(11, 0), endedAt: iso(11, 25) }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  const lens = await page.evaluate(() => data.sessions.map(s => s.intervals.length));
  await page.evaluate(() => openTimeline());
  await page.waitForTimeout(300);
  const blocks = await page.evaluate(() => document.querySelectorAll('#timelineBody .timeline-block').length);
  console.log('K: intervals=', lens, 'blocks=', blocks, 'errors=', errors);
  assert(errors.length === 0, 'K: コンソール/ページエラーが出ない');
  assert(lens[0] === 0, 'K: 全部不正だった区間は空のまま(span に化かさない)');
  assert(lens[1] === 1, 'K: 区間を持たない旧データは従来どおり1区間に畳む');
  assert(blocks === 1, 'K: タイムテーブルに描くのは旧データ由来の1件だけ');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== L: 片方だけ壊れた日付は生きている側から復元する ===== */
{
  const ud = mkdir();
  const yesterdayEnd = new Date(); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1); yesterdayEnd.setHours(15, 25, 0, 0);
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [], selectedTaskId: null, settings: {},
    sessions: [
      // startedAt だけ壊れた昨日の記録。現在時刻で埋めると今日の集計に混ざり、
      // かつ startedAt > endedAt の逆転でタイムテーブルからは消える。
      { id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: null, endedAt: yesterdayEnd.toISOString() },
      // 両方生きているが逆転している場合も durationSec から引き直す
      { id: 's2', mode: 'work', durationSec: 600, completed: true, startedAt: iso(14, 0), endedAt: iso(13, 0) }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  const got = await page.evaluate(() => data.sessions.map(s => ({ st: s.startedAt, en: s.endedAt })));
  const todayCount = await page.evaluate(() => document.querySelector('#todayCount').textContent);
  console.log('L: sessions=', JSON.stringify(got), 'todayCount=', todayCount, 'errors=', errors);
  assert(errors.length === 0, 'L: コンソール/ページエラーが出ない');
  assert(got.every(s => Date.parse(s.en) >= Date.parse(s.st)), 'L: 正規化後は必ず開始 <= 終了');
  assert(Date.parse(got[0].st) === yesterdayEnd.getTime() - 1500 * 1000, 'L: 壊れた開始は終了 - durationSec から復元する');
  assert(new Date(got[0].st).toDateString() === yesterdayEnd.toDateString(), 'L: 復元した開始は昨日のまま(今日へ飛ばさない)');
  // 今日の分は s2 のみ。現在時刻で埋めていた頃は昨日の s1 も数えて 2 になっていた。
  assert(todayCount === '1', 'L: 昨日の記録が今日の集計に混ざらない');
  assert(Date.parse(got[1].en) - Date.parse(got[1].st) === 600 * 1000, 'L: 逆転していたら durationSec から引き直す');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== M: 端点の復元は durationSec より生きている区間を優先する ===== */
{
  const ud = mkdir();
  // 昨日 23:30〜23:40 作業 → 長い中断 → 今日 00:10〜00:20 作業。実働は 20 分だが
  // 壁時計の span は 50 分。durationSec だけで引き直すと開始が今日 00:00 になり、
  // 昨日の区間が自分のセッションの範囲外へはみ出す。
  const at = (dayOffset, h, m) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d; };
  const ivA = [at(-1, 23, 30), at(-1, 23, 40)];
  const ivB = [at(0, 0, 10), at(0, 0, 20)];
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    tasks: [], selectedTaskId: null, settings: {},
    sessions: [
      // 開始だけ壊れている
      {
        id: 's1', mode: 'work', durationSec: 1200, completed: true,
        startedAt: 'こわれた', endedAt: ivB[1].toISOString(),
        // 時系列順に並んでいない(min/max で取らないと端点を取り違える)
        intervals: [
          { startedAt: ivB[0].toISOString(), endedAt: ivB[1].toISOString() },
          { startedAt: ivA[0].toISOString(), endedAt: ivA[1].toISOString() }
        ]
      },
      // 終了だけ壊れている
      {
        id: 's2', mode: 'work', durationSec: 1200, completed: true,
        startedAt: ivA[0].toISOString(), endedAt: null,
        intervals: [
          { startedAt: ivA[0].toISOString(), endedAt: ivA[1].toISOString() },
          { startedAt: ivB[0].toISOString(), endedAt: ivB[1].toISOString() }
        ]
      }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  const got = await page.evaluate(() => data.sessions.map(s => ({ st: s.startedAt, en: s.endedAt, n: s.intervals.length })));
  console.log('M: sessions=', JSON.stringify(got), 'errors=', errors);
  assert(errors.length === 0, 'M: コンソール/ページエラーが出ない');
  assert(got.every(s => s.n === 2), 'M: 正常な区間は2件とも残る');
  // durationSec(1200秒)で引き直していた頃は今日 00:00 になっていた
  assert(Date.parse(got[0].st) === ivA[0].getTime(), 'M: 壊れた開始は最も早い区間の開始から復元する');
  assert(new Date(got[0].st).toDateString() === ivA[0].toDateString(), 'M: 復元した開始は昨日のまま');
  assert(Date.parse(got[1].en) === ivB[1].getTime(), 'M: 壊れた終了は最も遅い区間の終了から復元する');
  assert(got.every(s => Date.parse(s.en) - Date.parse(s.st) === ivB[1] - ivA[0]), 'M: 端点は実働ではなく壁時計の範囲を表す');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== N: completedAt: 0 は有効な日付として扱う ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    sessions: [], selectedTaskId: null, settings: {},
    tasks: [
      // epoch ミリ秒の 0。truthy 判定で弾いていた頃は完了日が消えていた。
      { id: 't1', title: 'epoch に完了', completed: true, createdAt: 0, completedAt: 0 },
      { id: 't2', title: '未完了', completed: false, createdAt: iso(9, 0), completedAt: null }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  const got = await page.evaluate(() => data.tasks.map(t => [t.createdAt, t.completedAt]));
  console.log('N: tasks=', JSON.stringify(got), 'errors=', errors);
  assert(errors.length === 0, 'N: コンソール/ページエラーが出ない');
  assert(got[0][1] === new Date(0).toISOString(), 'N: completedAt: 0 を捨てず epoch として保つ');
  assert(got[0][0] === new Date(0).toISOString(), 'N: createdAt: 0 も epoch として保つ');
  assert(got[1][1] === null, 'N: 未完了タスクの completedAt は null のまま');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== J: タスクの不正な日付が CSV に漏れない ===== */
{
  const ud = mkdir();
  const csv = path.join(ud, 'tasks.csv');
  fs.writeFileSync(dataFile(ud), JSON.stringify({
    sessions: [], selectedTaskId: null, settings: {},
    tasks: [
      { id: 't1', title: '壊れた作成日', completed: false, createdAt: 'いつか', completedAt: null },
      { id: 't2', title: '壊れた完了日', completed: true, createdAt: iso(9, 0), completedAt: {} }
    ]
  }));

  const { app, page, errors } = await launch(ud);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, csv);
  const res = await page.evaluate(() => window.api.exportData('csv-tasks', data));
  const body = fs.readFileSync(csv, 'utf8');
  console.log('J: res=', JSON.stringify(res), 'csv=', JSON.stringify(body));
  assert(errors.length === 0, 'J: コンソール/ページエラーが出ない');
  assert(res && res.saved === true, 'J: CSV を書き出せる');
  assert(!/NaN/.test(body), 'J: CSV に NaN を書き出さない');
  assert(/壊れた作成日/.test(body) && /壊れた完了日/.test(body), 'J: タスク自体は落とさない');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke22: FAILED' : '\nsmoke22: OK');
