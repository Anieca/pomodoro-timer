// core の単体テスト(Electron を起動しない)。`node --test` でそのまま走る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, parseImport } from './codec.ts';
import { reduce, type Command } from './engine.ts';
import { dayBlocks, dayTotals, wallHours, sessionMs, sessionsCsv, summarize, taskTotals, tasksCsv, timerView, cyclePosition } from './derive.ts';
import { emptyData, type Data } from './model.ts';

const MIN = 60_000;
const T0 = new Date(2026, 10, 16, 9, 0, 0).getTime();

/** 命令を時刻つきで順に流す */
function play(data: Data, steps: [number, Command][]): { data: Data; ended: number } {
  let ended = 0;
  for (const [at, cmd] of steps) {
    const r = reduce(data, cmd, at);
    data = r.data;
    ended += r.effects.length;
  }
  return { data, ended };
}

const withTasks = (...titles: string[]): Data =>
  play(emptyData(), titles.map((title, i) => [T0 - 1000 + i, { type: 'task/add', id: `t${i + 1}`, title }])).data;

test('フォーカスを完走すると記録され、休憩が続く', () => {
  const { data, ended } = play(withTasks('設計'), [
    [T0, { type: 'timer/start' }],
    [T0 + 25 * MIN + 400, { type: 'timer/tick' }]
  ]);
  assert.equal(ended, 1);
  assert.equal(data.sessions.length, 1);
  const s = data.sessions[0];
  assert.equal(s.completed, true);
  assert.equal(sessionMs(s), 25 * MIN, '超過ぶんは実働に入らない');
  assert.equal(s.spans[0].taskId, 't1');
  assert.equal(data.streak, 1);
  assert.equal(data.run?.kind, 'short', '既定では休憩が自動で始まる');
});

test('自動開始を切ると次は待機する。4回目のあとは長休憩', () => {
  let data = reduce(emptyData(), { type: 'settings/update', patch: { autoBreak: false } }, T0).data;
  let t = T0;
  for (let i = 0; i < 4; i++) {
    data = play(data, [[t, { type: 'timer/start' }], [t + 25 * MIN, { type: 'timer/tick' }]]).data;
    assert.equal(data.run, null);
    assert.equal(data.next, i === 3 ? 'long' : 'short');
    if (i === 3) assert.deepEqual(cyclePosition(data), { done: 4, every: 4 });
    data = reduce(data, { type: 'timer/stop' }, t + 26 * MIN).data; // 休憩を飛ばす
    assert.equal(data.next, 'focus');
    t += 30 * MIN;
  }
  assert.equal(data.sessions.length, 4);
});

test('一時停止の時間は実働に入らず、残り時間も減らない', () => {
  const { data } = play(emptyData(), [
    [T0, { type: 'timer/start' }],
    [T0 + 10 * MIN, { type: 'timer/pause' }],
    [T0 + 40 * MIN, { type: 'timer/tick' }]
  ]);
  assert.equal(timerView(data, T0 + 40 * MIN).status, 'paused');
  assert.equal(timerView(data, T0 + 40 * MIN).remainingMs, 15 * MIN);
  const done = play(data, [
    [T0 + 40 * MIN, { type: 'timer/resume' }],
    [T0 + 55 * MIN, { type: 'timer/tick' }]
  ]).data;
  assert.equal(done.sessions[0].spans.length, 2);
  assert.equal(sessionMs(done.sessions[0]), 25 * MIN);
});

test('スリープはフォーカスの実働から切り取られる(蓋を閉じた3時間は集中ではない)', () => {
  const { data, ended } = play(emptyData(), [
    [T0, { type: 'timer/start' }],
    [T0 + 3 * 60 * MIN, { type: 'timer/gap', from: T0 + 10 * MIN, to: T0 + 3 * 60 * MIN }],
    [T0 + 3 * 60 * MIN, { type: 'timer/tick' }]
  ]);
  assert.equal(ended, 0, '完了していない');
  assert.equal(timerView(data, T0 + 3 * 60 * MIN).remainingMs, 15 * MIN);
  assert.deepEqual(data.run?.spans, [{ start: T0, end: T0 + 10 * MIN, taskId: null }]);
});

test('休憩は席を離れていても進む(スリープ明けには終わっている)', () => {
  let data = play(emptyData(), [[T0, { type: 'timer/start' }], [T0 + 25 * MIN, { type: 'timer/tick' }]]).data;
  assert.equal(data.run?.kind, 'short');
  const r = reduce(data, { type: 'timer/gap', from: T0 + 26 * MIN, to: T0 + 90 * MIN }, T0 + 90 * MIN);
  assert.equal(r.effects.length, 1);
  data = r.data;
  assert.equal(data.run, null);
  assert.equal(data.next, 'focus');
  assert.equal(sessionMs(data.sessions[1]), 5 * MIN);
});

test('タスクを切り替えるとタイマーを止めずに区間が区切られる', () => {
  const { data } = play(withTasks('A', 'B'), [
    [T0, { type: 'timer/start' }],
    [T0 + 10 * MIN, { type: 'task/activate', id: 't2' }],
    [T0 + 25 * MIN, { type: 'timer/tick' }]
  ]);
  const s = data.sessions[0];
  assert.deepEqual(s.spans.map(sp => [sp.taskId, (sp.end - sp.start) / MIN]), [['t1', 10], ['t2', 15]]);
  const totals = taskTotals(data.sessions);
  assert.equal(totals.get('t1')?.ms, 10 * MIN);
  assert.deepEqual(totals.get('t2'), { ms: 15 * MIN, pomos: 1 }, '完走は主役のタスクに付く');
});

test('向き合っていたタスクを終えると次の未完了へ移る', () => {
  const { data } = play(withTasks('A', 'B', 'C'), [
    [T0, { type: 'timer/start' }],
    [T0 + 5 * MIN, { type: 'task/setDone', id: 't1', done: true }]
  ]);
  assert.equal(data.activeTaskId, 't2');
  assert.equal(data.run?.open?.taskId, 't2');
  assert.equal(data.run?.spans[0].taskId, 't1');
  assert.equal(reduce(data, { type: 'task/activate', id: 't1' }, T0 + 6 * MIN).data, data, '完了したタスクは選べない');
});

test('削除は印だけ。記録はタスクを指したままで、取り消すと元どおり', () => {
  let { data } = play(withTasks('A'), [[T0, { type: 'timer/start' }], [T0 + 25 * MIN, { type: 'timer/tick' }]]);
  const before = data;
  data = reduce(data, { type: 'task/delete', id: 't1' }, T0 + 26 * MIN).data;
  assert.equal(data.activeTaskId, null);
  assert.equal(data.sessions[0].spans[0].taskId, 't1');
  data = reduce(data, { type: 'task/restore', id: 't1' }, T0 + 27 * MIN).data;
  assert.deepEqual(data.tasks, before.tasks);
});

test('中断は1分以上なら未完走として残り、1分未満は残らない', () => {
  const short = play(emptyData(), [[T0, { type: 'timer/start' }], [T0 + 30_000, { type: 'timer/stop' }]]).data;
  assert.equal(short.sessions.length, 0);
  const long = play(emptyData(), [[T0, { type: 'timer/start' }], [T0 + 5 * MIN, { type: 'timer/stop' }]]).data;
  assert.equal(long.sessions[0].completed, false);
  assert.equal(long.next, 'focus');
  assert.equal(long.streak, 0);
});

test('完了の瞬間に中断が重なっても、完走が先に確定する', () => {
  const r = reduce(play(emptyData(), [[T0, { type: 'timer/start' }]]).data, { type: 'timer/pause' }, T0 + 25 * MIN + 10);
  assert.equal(r.effects.length, 1);
  assert.equal(r.data.sessions[0].completed, true);
});

test('延長すると予定が伸びる', () => {
  const { data, ended } = play(emptyData(), [
    [T0, { type: 'timer/start' }],
    [T0 + 24 * MIN, { type: 'timer/extend', minutes: 5 }],
    [T0 + 26 * MIN, { type: 'timer/tick' }]
  ]);
  assert.equal(ended, 0);
  assert.equal(timerView(data, T0 + 26 * MIN).remainingMs, 4 * MIN);
  const done = reduce(data, { type: 'timer/tick' }, T0 + 30 * MIN).data;
  assert.equal(done.sessions[0].plannedSec, 30 * 60);
});

test('強制終了からの復旧: 最後に生存を確かめた時刻までを実働にして一時停止で戻る', () => {
  const { data } = play(emptyData(), [
    [T0, { type: 'timer/start' }],
    [T0 + 8 * MIN, { type: 'timer/tick' }]
  ]);
  assert.equal(data.run?.seenAt, T0 + 8 * MIN);
  const back = reduce(decode(JSON.parse(JSON.stringify(data))), { type: 'timer/recover' }, T0 + 12 * MIN).data;
  assert.equal(back.run?.open, null);
  assert.equal(timerView(back, T0 + 12 * MIN).remainingMs, 17 * MIN);
  const stale = reduce(data, { type: 'timer/recover' }, T0 + 5 * 60 * MIN).data;
  assert.equal(stale.run, null, '長く放置されていたら打ち切る');
  assert.equal(stale.sessions[0].completed, false);
  assert.equal(sessionMs(stale.sessions[0]), 8 * MIN);
});

test('記録の付け替え・削除・取り消し', () => {
  let { data } = play(withTasks('A', 'B'), [[T0, { type: 'timer/start' }], [T0 + 25 * MIN, { type: 'timer/tick' }]]);
  const id = data.sessions[0].id;
  data = reduce(data, { type: 'session/assign', id, taskId: 't2' }, T0).data;
  assert.equal(data.sessions[0].spans[0].taskId, 't2');
  const kept = data.sessions[0];
  data = reduce(data, { type: 'session/delete', id }, T0).data;
  assert.equal(data.sessions.length, 0);
  data = reduce(data, { type: 'session/put', session: kept }, T0).data;
  assert.deepEqual(data.sessions, [kept]);
  assert.equal(reduce(data, { type: 'session/put', session: { id: 'x', kind: 'focus', spans: [] } }, T0).data, data);
});

test('並べ替えと、意味のない命令は同じ参照を返す', () => {
  const data = withTasks('A', 'B', 'C');
  const moved = reduce(data, { type: 'task/move', id: 't3', before: 't1' }, T0).data;
  assert.deepEqual(moved.tasks.map(t => t.id), ['t3', 't1', 't2']);
  assert.equal(reduce(data, { type: 'task/move', id: 't3', before: null }, T0).data, data);
  assert.equal(reduce(data, { type: 'timer/pause' }, T0).data, data);
  assert.equal(reduce(data, { type: 'nope' } as unknown as Command, T0).data, data);
  assert.equal(reduce(data, { type: 'task/add', id: 't9', title: '   ' }, T0).data, data);
});

test('設定は差分で受け、範囲に丸める', () => {
  const data = reduce(emptyData(), { type: 'settings/update', patch: { focusMin: 999, sound: { volume: -5 } } }, T0).data;
  assert.equal(data.settings.focusMin, 180);
  assert.equal(data.settings.sound.volume, 0);
  assert.equal(data.settings.sound.focus, 'brown-noise.wav');
});

test('decode は何を渡しても投げず、冪等', () => {
  for (const junk of [null, 1, 'x', [], {}, { tasks: 'no', sessions: [null, 3, {}], run: { id: 1 } },
    { version: 2, tasks: [{ id: 'a' }, { id: 'a' }, {}], sessions: [{ id: 's', kind: 'focus', spans: [{ start: 5, end: 1 }] }] }]) {
    const once = decode(junk);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(once))), once);
  }
  const d = decode({ version: 2, tasks: [{ id: 'a', title: ' x ', doneAt: 5 }], activeTaskId: 'a',
    sessions: [{ id: 's', kind: 'focus', spans: [{ start: 100, end: 300, taskId: 'gone' }, { start: 200, end: 400, taskId: 'a' }] }] });
  assert.equal(d.activeTaskId, null, '完了したタスクは選ばれない');
  assert.deepEqual(d.sessions[0].spans, [{ start: 100, end: 300, taskId: null }, { start: 300, end: 400, taskId: 'a' }]);
});

test('v1 のデータを区間の列へ組み直す', () => {
  const iso = (t: number) => new Date(t).toISOString();
  const d = decode({
    tasks: [{ id: 'a', title: 'A', completed: false, createdAt: iso(T0) }, { id: 'b', title: 'B', completed: true, createdAt: iso(T0), completedAt: iso(T0 + MIN) }],
    selectedTaskId: 'a',
    settings: { workMin: 50, shortMin: 10, longMin: 15, longEvery: 4, autoStartBreak: false, autoStartWork: true,
      whiteNoise: { enabled: false, file: 'x.wav', breakFile: 'y.wav', volume: 70 } },
    timer: { mode: 'short', cycle: 3 },
    sessions: [
      { id: 's1', mode: 'work', startedAt: iso(T0), endedAt: iso(T0 + 30 * MIN), durationSec: 1500, completed: true,
        intervals: [{ startedAt: iso(T0), endedAt: iso(T0 + 10 * MIN) }, { startedAt: iso(T0 + 15 * MIN), endedAt: iso(T0 + 30 * MIN) }],
        taskIds: ['a', 'b'], taskTimes: [{ taskId: 'a', durationSec: 900 }, { taskId: 'b', durationSec: 600 }] },
      { id: 's2', mode: 'short', startedAt: iso(T0 + 30 * MIN), endedAt: iso(T0 + 35 * MIN), durationSec: 300, completed: true },
      { mode: 'work', startedAt: 'こわれた', durationSec: 0 }
    ]
  });
  assert.equal(d.version, 2);
  assert.deepEqual([d.settings.focusMin, d.settings.autoBreak, d.settings.autoFocus, d.settings.sound], [50, false, true, { on: false, focus: 'x.wav', rest: 'y.wav', volume: 70 }]);
  assert.deepEqual([d.next, d.streak, d.activeTaskId], ['short', 3, 'a']);
  assert.equal(d.tasks[1].doneAt, T0 + MIN);
  assert.equal(d.sessions.length, 2);
  assert.deepEqual(d.sessions[0].spans, [
    { start: T0, end: T0 + 10 * MIN, taskId: 'a' },
    { start: T0 + 15 * MIN, end: T0 + 20 * MIN, taskId: 'a' },
    { start: T0 + 20 * MIN, end: T0 + 30 * MIN, taskId: 'b' }
  ]);
  assert.equal(d.sessions[1].kind, 'short');
  assert.deepEqual(decode(JSON.parse(JSON.stringify(d))), d);
  // 旧 pomodoros 形式(区間も内訳も無い)
  const old = decode({ pomodoros: [{ id: 'p', startedAt: iso(T0), durationSec: 1500, completed: true, taskIds: ['a'] }], tasks: [{ id: 'a', title: 'A' }] });
  assert.deepEqual(old.sessions[0].spans, [{ start: T0, end: T0 + 25 * MIN, taskId: 'a' }]);
});

test('インポートはこのアプリのデータだけを通し、進行中のセッションは持ち込まない', () => {
  assert.equal(parseImport('{').ok, false);
  assert.equal(parseImport('{}').ok, false);
  assert.equal(parseImport('[1,2]').ok, false);
  const running = play(withTasks('A'), [[T0, { type: 'timer/start' }]]).data;
  const r = parseImport('﻿' + JSON.stringify(running));
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.data.run, null); assert.deepEqual(r.counts, { tasks: 1, sessions: 0 }); }
});

test('一日の帯と合計は日付の境目で切る。統計は区間を日と時台に割る', () => {
  const night = new Date(2026, 10, 15, 23, 50).getTime();
  const { data } = play(withTasks('A'), [[night, { type: 'timer/start' }], [night + 25 * MIN, { type: 'timer/tick' }]]);
  const sessions = data.sessions.filter(s => s.kind === 'focus');
  const d15 = new Date(2026, 10, 15).getTime(), d16 = new Date(2026, 10, 16).getTime();
  assert.deepEqual(dayBlocks(sessions, d16).map(b => [(b.end - b.start) / MIN, b.taskId]), [[15, 't1']]);
  assert.deepEqual(dayTotals(sessions, d15), { focusMs: 10 * MIN, pomos: 1 });
  assert.deepEqual(dayTotals(sessions, d16), { focusMs: 15 * MIN, pomos: 0 });
  const st = summarize(sessions, d16 + 12 * 60 * MIN, 7);
  assert.equal(st.days.length, 7);
  assert.deepEqual(st.days.slice(-2).map(d => [d.focusMs / MIN, d.pomos]), [[10, 1], [15, 0]]);
  assert.deepEqual([st.hours[23] / MIN, st.hours[0] / MIN], [10, 15]);
  assert.deepEqual([st.focusMs / MIN, st.pomos, st.completionRate, st.activeDays], [25, 1, 1, 2]);
  assert.deepEqual(st.tasks, [{ taskId: 't1', ms: 25 * MIN }]);
});

test('CSV は数式として解釈されうるセルを無害化する', () => {
  const { data } = play(emptyData(), [
    [T0 - 1, { type: 'task/add', id: 't1', title: '=SUM(A1), "x"' }],
    [T0, { type: 'timer/start' }],
    [T0 + 25 * MIN, { type: 'timer/tick' }]
  ]);
  assert.match(tasksCsv(data), /"'=SUM\(A1\), ""x"""/);
  const rows = sessionsCsv(data).split('\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1], /フォーカス,2026-11-16 09:00:00,2026-11-16 09:25:00,25,25,はい,0/);
});

test('帯の位置は時計の表示で決める(夏時間の切り替え日でもずれない)', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const day = new Date(2026, 10, 1).getTime(); // 夏時間が終わり、25 時間ある日
    assert.equal(wallHours(new Date(2026, 10, 1, 23, 30).getTime(), day), 23.5);
    assert.equal(wallHours(new Date(2026, 10, 1, 9, 0).getTime(), day), 9);
    assert.equal(wallHours(new Date(2026, 10, 2, 0, 30).getTime(), day), 24, '翌日は端に寄せる');
    assert.equal(wallHours(day - 1, day), 0);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});
