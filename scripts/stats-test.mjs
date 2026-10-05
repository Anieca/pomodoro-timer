// shared/stats.js の単体テスト。electron に依存しないので Electron を起動せず走る。
// 見たいのは「どの記録をどの日・どの時台・どのタスクに数えるか」の決まり:
//  - 日への振り分けは開始時刻のローカル日付(履歴・サイドバーの「今日」と揃える)
//  - 集中時間は durationSec(一時停止を除いた実働)、休憩は別に数える
//  - 時間帯は実働区間を時台の境目で割って積み、範囲外にはみ出た分は数えない
//  - 連続日数は今日まだ完了していなくても昨日までの連なりを保つ
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeData } = require('../shared/schema.js');
const { summarizeStats, currentStreak } = require('../shared/stats.js');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`}`);

// 2026/1/15 を「今日」とする。at(日差, 時, 分) はローカル時刻。
const TODAY = new Date(2026, 0, 15);
const at = (dd, h, m = 0) => new Date(2026, 0, 15 + dd, h, m, 0, 0).toISOString();
const work = (id, dd, h, m, min, { completed = true, taskTimes, intervals } = {}) => ({
  id, mode: 'work', completed,
  startedAt: at(dd, h, m), endedAt: at(dd, h, m + min), durationSec: min * 60,
  taskTimes: taskTimes || [{ taskId: 't1', durationSec: min * 60 }],
  taskIds: completed ? ['t1'] : [],
  intervals: intervals || [{ startedAt: at(dd, h, m), endedAt: at(dd, h, m + min) }]
});
const brk = (id, dd, h, min) => ({
  id, mode: 'short', completed: true, startedAt: at(dd, h), endedAt: at(dd, h, min), durationSec: min * 60
});
// 実データと同じく正規化を通したものを渡す
const sessions = list => normalizeData({ sessions: list }).sessions;

/* ===== 期間と日別 ===== */
{
  const s = sessions([
    work('a', 0, 9, 0, 25),
    work('b', 0, 10, 0, 25, { completed: false }),
    work('c', -6, 14, 0, 25),
    work('old', -7, 14, 0, 25),          // 7日の範囲の1日前 → 入らない
    work('future', 1, 9, 0, 25),         // 明日 → 入らない
    brk('r', 0, 9, 5)
  ]);
  const st = summarizeStats(s, { end: TODAY, days: 7 });
  assert(st.days.length === 7, '日別: 期間の日数だけ並ぶ');
  assert(st.days[0].start === new Date(2026, 0, 9).getTime(), '日別: 先頭は 6日前の 0:00');
  assert(st.days[6].start === TODAY.getTime(), '日別: 末尾は今日');
  eq(st.days.map(d => d.pomos), [1, 0, 0, 0, 0, 0, 1], '日別: 完了ポモドーロを開始日に数える');
  eq(st.days[6].focusSec, 50 * 60, '日別: 中断したフォーカスの実働も集中時間に入る');
  assert(st.focusSec === 75 * 60, '合計: 範囲外の記録は数えない');
  assert(st.breakSec === 5 * 60, '合計: 休憩は集中時間とは別に数える');
  assert(st.pomos === 2 && st.workCount === 3, '合計: 完了数と始めた数');
  assert(Math.abs(st.completionRate - 2 / 3) < 1e-9, '完走率: 完了 / 始めた数');
  assert(st.activeDays === 2, '記録のあった日数');
}

/* ===== 記録が無い ===== */
{
  const st = summarizeStats([], { end: TODAY, days: 30 });
  assert(st.days.length === 30 && st.focusSec === 0, '空: 日は並ぶが 0');
  assert(st.completionRate === null, '空: 完走率は出さない(0% と区別する)');
  eq(st.tasks, [], '空: タスク別も空');
}

/* ===== 日付をまたぐ記録 ===== */
{
  // 前日 23:50 開始・今日 0:15 終了。日別は開始日(前日)へ、時間帯は実際の時台へ。
  const s = sessions([work('x', -1, 23, 50, 25)]);
  const st = summarizeStats(s, { end: TODAY, days: 1 });
  assert(st.focusSec === 0, '日またぎ: 開始日が範囲外なら日別・合計に数えない');
  assert(Math.round(st.hours[0]) === 15 * 60, '日またぎ: 時間帯は範囲内に入った 15分だけ数える');
  assert(st.hours[23] === 0, '日またぎ: 範囲外(前日)の 23時台は数えない');
  const st2 = summarizeStats(s, { end: TODAY, days: 2 });
  assert(st2.days[0].focusSec === 25 * 60, '日またぎ: 開始日の側に 25分');
  assert(Math.round(st2.hours[23]) === 10 * 60 && Math.round(st2.hours[0]) === 15 * 60, '日またぎ: 時台の境目で割る');
}

/* ===== 時間帯は一時停止を数えない ===== */
{
  // 9:00〜9:10 と 9:50〜10:05 に実働、間の 40分は一時停止
  const s = sessions([work('p', 0, 9, 0, 25, {
    intervals: [{ startedAt: at(0, 9, 0), endedAt: at(0, 9, 10) }, { startedAt: at(0, 9, 50), endedAt: at(0, 10, 5) }]
  })]);
  const st = summarizeStats(s, { end: TODAY, days: 1 });
  assert(Math.round(st.hours[9]) === 20 * 60 && Math.round(st.hours[10]) === 5 * 60, '時間帯: 実働区間だけを時台に積む');
}

/* ===== 時間帯は休憩を数えない ===== */
{
  const st = summarizeStats(sessions([brk('r', 0, 13, 5)]), { end: TODAY, days: 1 });
  assert(st.hours.every(h => h === 0), '時間帯: 休憩は入れない');
}

/* ===== タスク別 ===== */
{
  const s = sessions([
    work('a', 0, 9, 0, 25, { taskTimes: [{ taskId: 't1', durationSec: 600 }, { taskId: 't2', durationSec: 900 }] }),
    work('b', 0, 10, 0, 25, { taskTimes: [{ taskId: null, durationSec: 300 }, { taskId: 't1', durationSec: 600 }] }),
    work('c', 0, 11, 0, 25, { taskTimes: [{ taskId: 't3', durationSec: 0 }] })
  ]);
  const st = summarizeStats(s, { end: TODAY, days: 1 });
  eq(st.tasks, [{ taskId: 't1', sec: 1200 }, { taskId: 't2', sec: 900 }, { taskId: null, sec: 300 }],
    'タスク別: 内訳を合算して多い順、タスクなし(null)も残し、0秒は落とす');
}

/* ===== 連続日数 ===== */
{
  const days = dds => sessions(dds.map((dd, i) => work(`s${i}`, dd, 9, 0, 25)));
  assert(currentStreak(days([0, -1, -2]), TODAY) === 3, '連続: 今日まで3日');
  assert(currentStreak(days([-1, -2]), TODAY) === 2, '連続: 今日まだでも昨日まで続いていれば途切れない');
  assert(currentStreak(days([0, -2]), TODAY) === 1, '連続: 間が空けば今日の1日だけ');
  assert(currentStreak(days([-2]), TODAY) === 0, '連続: 昨日も無ければ 0');
  const halted = sessions([work('h', 0, 9, 0, 25, { completed: false }), work('y', -1, 9, 0, 25)]);
  assert(currentStreak(halted, TODAY) === 1, '連続: 中断だけの日は数えない');
}

/* ===== 月をまたぐ期間 ===== */
{
  const st = summarizeStats([], { end: new Date(2026, 2, 2), days: 7 });
  eq(st.days.map(d => new Date(d.start).getDate()), [24, 25, 26, 27, 28, 1, 2], '月またぎ: ローカル日付で日を進める');
}
