'use strict';
// 統計ビューの集計。schema.js / actions.js と同じく electron にも DOM にも依存しない
// 純粋なモジュールにしてあり、レンダラは <script> で読み、テストは require で読む。
// 入力は正規化済みの sessions(main が配るスナップショット)を前提とする。
//
// 日への振り分けは、履歴やサイドバーの「今日」と同じく開始時刻(startedAt)の
// ローカル日付で行う。集中時間は durationSec(一時停止・スリープを除いた実働)を使う。
// 時間帯の分布だけは実働区間(intervals)を壁時計の各時台に割り振る。

function startOfLocalDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ローカル日付で n 日ずらした 0:00(DST の切替日でも 24h 決め打ちにしない)
function addLocalDays(t, n) {
  const d = startOfLocalDay(t);
  d.setDate(d.getDate() + n);
  return d;
}

const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// 区間を持たない記録だけ span を使う(schema.js の正規化後は必ず配列を持つ)
const intervalsOf = s => (Array.isArray(s.intervals) ? s.intervals : [{ startedAt: s.startedAt, endedAt: s.endedAt }]);

// end を含む直近 days 日([end の days-1 日前 0:00, end の翌 0:00))を集計する。
function summarizeStats(sessions, { end, days }) {
  const n = Math.max(1, Math.floor(days));
  const rangeStart = addLocalDays(end, -(n - 1));
  const rangeEnd = addLocalDays(end, 1);
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  const dayList = [];
  const byKey = new Map();
  for (let i = 0; i < n; i++) {
    const d = addLocalDays(rangeStart, i);
    const row = { start: d.getTime(), focusSec: 0, pomos: 0 };
    dayList.push(row);
    byKey.set(dayKey(d), row);
  }

  const hours = new Array(24).fill(0);
  const taskSec = new Map();
  let focusSec = 0, breakSec = 0, pomos = 0, workCount = 0;

  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object') continue;
    const isWork = s.mode === 'work';

    // 時間帯: 実働区間を範囲内にクリップし、時台の境目で割って積む
    if (isWork) {
      for (const iv of intervalsOf(s)) {
        let cur = Math.max(Date.parse(iv.startedAt), startMs);
        const en = Math.min(Date.parse(iv.endedAt), endMs);
        if (!Number.isFinite(cur) || !Number.isFinite(en)) continue;
        while (cur < en) {
          const next = new Date(cur);
          next.setMinutes(60, 0, 0);                    // 次の時台の頭
          const stop = Math.min(next.getTime(), en);
          hours[new Date(cur).getHours()] += (stop - cur) / 1000;
          cur = stop;
        }
      }
    }

    const row = byKey.get(dayKey(new Date(s.startedAt)));
    if (!row) continue;                                 // 開始日が範囲外
    const sec = Number.isFinite(s.durationSec) ? s.durationSec : 0;
    if (!isWork) { breakSec += sec; continue; }
    workCount++;
    focusSec += sec;
    row.focusSec += sec;
    if (s.completed) { pomos++; row.pomos++; }
    for (const tt of Array.isArray(s.taskTimes) ? s.taskTimes : []) {
      const id = tt.taskId ?? null;
      taskSec.set(id, (taskSec.get(id) || 0) + tt.durationSec);
    }
  }

  const tasks = [...taskSec]
    .map(([taskId, sec]) => ({ taskId, sec }))
    .filter(t => t.sec > 0)
    .sort((a, b) => b.sec - a.sec);

  return {
    start: startMs,
    end: endMs,
    days: dayList,
    focusSec,
    breakSec,
    pomos,
    workCount,
    // 始めたフォーカスのうち完走した割合(始めていなければ出しようがない)
    completionRate: workCount ? pomos / workCount : null,
    activeDays: dayList.filter(d => d.focusSec > 0).length,
    hours,
    tasks
  };
}

// 今日まで続いている連続日数(完了ポモドーロが1つ以上ある日の連なり)。
// 今日まだ完了していなくても、昨日まで続いていれば途切れたとはみなさない。
function currentStreak(sessions, today) {
  const done = new Set();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && s.mode === 'work' && s.completed) done.add(dayKey(new Date(s.startedAt)));
  }
  let d = startOfLocalDay(today);
  if (!done.has(dayKey(d))) d = addLocalDays(d, -1);
  let n = 0;
  while (done.has(dayKey(d))) {
    n++;
    d = addLocalDays(d, -1);
  }
  return n;
}

// レンダラ(<script>)では関数がそのまま global に出る。
if (typeof module !== 'undefined') module.exports = { summarizeStats, currentStreak, addLocalDays };
