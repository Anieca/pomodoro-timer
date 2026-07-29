import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 日付バリデーション(parseIso)の検証。壊れた保存データや手編集で不正な日付が
// 混ざっても、起動が落ちず・表示に NaN が出ず・不正区間が黙って化けないこと:
//  H) 不正な startedAt/endedAt → RangeError で init が止まらず、履歴も NaN にならない
//  I) intervals の不正日付・逆転区間 → 落として、正常な区間だけタイムテーブルに出す
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
