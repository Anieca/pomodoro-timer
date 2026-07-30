import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// システムスリープを実働から除く仕組みの検証。
//
// 従来は復帰時の tick が予定終了の超過を検知してセッションを完了させ、実働区間は
// endAt でクリップされていた。実時間が数時間に膨らむことは防げていたが、逆に
// 「予定していた25分ぶんを丸ごと実働として計上する」ことになっていた
// (蓋を閉じて3時間後に開けても25分集中したことになる)。
//
//  S) main が suspend / resume を観測してレンダラへ両端の時刻を渡す
//  T) 実行中にスリープ → 区間が分割され、睡眠分は実働に入らない
//  U) タスク別の時間(segments)にも睡眠が入らない
//  V) 眠る前に既に予定終了を過ぎていたなら先延ばしにしない
//  W) 一時停止中・アイドル中の復帰では何もしない
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const app = await electron.launch({
  executablePath: EXE, args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: ud }, timeout: 30000
});
const page = await app.firstWindow();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForFunction(() => typeof applySleep === 'function', { timeout: 15000 });

const H3 = 3 * 60 * 60 * 1000;
const MIN = 60 * 1000;
// 眠っていた区間をレンダラへ直接渡す(実機を眠らせる代わり)。
const sleep = (suspendAt, resumeAt) => page.evaluate(s => applySleep(s), { suspendAt, resumeAt });

/* ===== S: main が suspend / resume を観測して渡す ===== */
{
  // powerMonitor は EventEmitter なので、実際のスリープの代わりにイベントを流して
  // main 側の配線(観測 → レンダラへ送る)だけを確かめる。
  await page.evaluate(() => {
    globalThis.__spans = [];
    window.api.onPowerResume(s => globalThis.__spans.push(s));
  });
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); });
  await page.waitForTimeout(60);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
  await page.waitForTimeout(300);
  const spans = await page.evaluate(() => globalThis.__spans);
  console.log('S: spans=', JSON.stringify(spans));
  assert(spans.length === 1, 'S: 復帰を1回だけ通知する');
  assert(spans[0] && spans[0].resumeAt > spans[0].suspendAt, 'S: 眠っていた両端の時刻を渡す');

  // suspend を観測していない復帰では何も送らない(睡眠時間が分からないため)
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => globalThis.__spans.length);
  assert(after === 1, 'S: suspend を観測していない復帰では補正を要求しない');
}

/* ===== T: 実行中のスリープは実働に入らない ===== */
let tGot;                                   // U でも同じセッションの値を使う
{
  const got = tGot = await page.evaluate(H => {
    const now = Date.now();
    startPauseResume();                       // work 開始
    timer.totalMs = 25 * 60 * 1000;
    // 開始5分後に眠り、3時間後に復帰したことにする
    timer.current.startedAt = new Date(now - 5 * 60 * 1000).toISOString();
    timer.current.intStartAt = now - 5 * 60 * 1000;
    timer.endAt = now - 5 * 60 * 1000 + 25 * 60 * 1000;
    const endAtBefore = timer.endAt;
    applySleep({ suspendAt: now, resumeAt: now + H });
    return {
      intervals: timer.current.intervals.map(iv => (new Date(iv.endedAt) - new Date(iv.startedAt)) / 60000),
      shiftedMin: (timer.endAt - endAtBefore) / 60000,
      remainMin: (timer.endAt - (now + H)) / 60000,
      // segments の元になる経過時間。実際の時計は進められないので、復帰時刻での
      // 値を pomoElapsedMs() と同じ式(totalMs -(endAt - now))で求める。
      elapsedAtResumeMin: (timer.totalMs - (timer.endAt - (now + H))) / 60000
    };
  }, H3);
  console.log('T:', JSON.stringify(got));
  assert(got.intervals.length === 1 && Math.abs(got.intervals[0] - 5) < 0.1, 'T: 眠りに落ちた時刻で区間を閉じる(実働は5分)');
  assert(Math.abs(got.shiftedMin - 180) < 0.1, 'T: 眠っていた分だけ予定終了を後ろへずらす');
  assert(Math.abs(got.remainMin - 20) < 0.1, 'T: 残り時間は眠る前のまま(20分)');
}

/* ===== U: タスク別の時間にも睡眠が入らない ===== */
{
  // segments は pomoElapsedMs() から出る。実際の時計を3時間進めることはできないので、
  // T で復帰時刻を代入して求めた値(pomoElapsedMs と同じ式)で確かめる。
  console.log('U: elapsedAtResume(min)=', tGot.elapsedAtResumeMin);
  assert(Math.abs(tGot.elapsedAtResumeMin - 5) < 0.1, 'U: 経過時間は眠りに落ちた時点のまま(5分)');
  await page.evaluate(() => stopEarly());
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => window.api.loadData());
  const work = (saved.sessions || []).find(s => s.mode === 'work');
  console.log('U: saved durationSec=', work && work.durationSec);
  assert(work && Math.abs(work.durationSec - 300) < 10, 'U: 記録される実働も5分(3時間の睡眠を含まない)');
}

/* ===== V: 眠る前に予定終了を過ぎていたなら先延ばしにしない ===== */
{
  const got = await page.evaluate(H => {
    const now = Date.now();
    startPauseResume();
    timer.totalMs = 25 * 60 * 1000;
    // 予定終了は既に10分前。その後で眠った(復帰時にそのまま完了させたい)
    timer.current.intStartAt = now - 35 * 60 * 1000;
    timer.endAt = now - 10 * 60 * 1000;
    const before = timer.endAt;
    applySleep({ suspendAt: now, resumeAt: now + H });
    return { shifted: timer.endAt - before, lastIv: timer.current.intervals.at(-1) };
  }, H3);
  console.log('V:', JSON.stringify(got));
  assert(got.shifted === 0, 'V: 眠る前に終わっていたセッションは先延ばしにしない');
  const ivMin = (new Date(got.lastIv.endedAt) - new Date(got.lastIv.startedAt)) / 60000;
  assert(Math.abs(ivMin - 25) < 0.1, 'V: 実働は予定終了まで(25分)で止まる');
  await page.evaluate(() => stopEarly());
  await page.waitForTimeout(300);
}

/* ===== W: 一時停止中・アイドル中は何もしない ===== */
{
  const idle = await page.evaluate(H => {
    const before = { status: timer.status, endAt: timer.endAt, current: timer.current };
    applySleep({ suspendAt: Date.now(), resumeAt: Date.now() + H });
    return { status: timer.status, unchanged: timer.endAt === before.endAt, wasIdle: before.status === 'idle' };
  }, H3);
  console.log('W(idle):', JSON.stringify(idle));
  assert(idle.wasIdle && idle.unchanged, 'W: アイドル中の復帰では何も変えない');

  const paused = await page.evaluate(H => {
    startPauseResume();                       // 開始
    startPauseResume();                       // 一時停止
    const before = { endAt: timer.endAt, remainMs: timer.remainMs, ivs: timer.current.intervals.length };
    applySleep({ suspendAt: Date.now(), resumeAt: Date.now() + H });
    return {
      status: timer.status,
      sameEnd: timer.endAt === before.endAt,
      sameRemain: timer.remainMs === before.remainMs,
      sameIvs: timer.current.intervals.length === before.ivs
    };
  }, H3);
  console.log('W(paused):', JSON.stringify(paused));
  assert(paused.status === 'paused', 'W: 一時停止中のまま');
  assert(paused.sameEnd && paused.sameRemain && paused.sameIvs, 'W: 一時停止中は残り時間が凍結済みなので触らない');
}

/* ===== 不正な span で壊れない ===== */
{
  const ok = await page.evaluate(() => {
    for (const s of [null, undefined, {}, { suspendAt: NaN, resumeAt: 1 }, { suspendAt: 2, resumeAt: 1 }]) applySleep(s);
    return true;
  });
  assert(ok, '不正な span を渡しても投げない');
}

console.log('errors=', errors);
assert(errors.length === 0, 'コンソール/ページエラーが出ない');

await app.close();
fs.rmSync(ud, { recursive: true, force: true });
console.log(process.exitCode ? '\nsmoke24: FAILED' : '\nsmoke24: OK');
