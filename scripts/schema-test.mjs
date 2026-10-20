// shared/schema.js の単体テスト。electron に依存しないので Electron を起動せず走る。
// ここで見たいのは「正本の形」そのもの:
//  - 冪等性(読み込み時と書き込み時の両方で通すため、通すたびに値が変わってはいけない)
//  - 範囲外・型違いの入力を安全な形に落とすこと
//  - 壊れた入力で例外を投げないこと(投げると起動そのものが止まる)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeData, parseImport, DEFAULT_SETTINGS } = require('../shared/schema.js');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`}`);

const iso = h => { const d = new Date(2026, 0, 15, h, 0, 0, 0); return d.toISOString(); };

/* ===== 冪等性: 二度通しても変わらない ===== */
{
  // 「読み込みで正規化 → 保存でもう一度正規化」が起きるため、ここが崩れると
  // 何も編集していないのに保存のたびにディスクの内容が変わる。
  const inputs = {
    '空': null,
    '型違いだらけ': { tasks: 'x', sessions: 3, settings: 7, selectedTaskId: {}, timer: 'q' },
    '通常': {
      tasks: [{ id: 't1', title: 'あ', completed: false, createdAt: iso(9), completedAt: null }],
      sessions: [{ id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(9), endedAt: iso(10), intervals: [{ startedAt: iso(9), endedAt: iso(10) }] }],
      selectedTaskId: 't1', settings: { workMin: 30 }, timer: { mode: 'short', cycle: 2 }
    },
    // 区間を持たない旧データ。1区間に畳んだ結果をもう一度通しても畳み直されないこと。
    '旧データ': { sessions: [{ id: 's1', mode: 'work', durationSec: 1500, startedAt: iso(9), endedAt: iso(10) }] },
    // 畳むと 0 長になる旧データ。畳んでしまうと次に通したとき落とされて空になる。
    '0長の旧データ': { sessions: [{ id: 's1', mode: 'work', durationSec: 0, startedAt: iso(9), endedAt: iso(9) }] },
    '区間が全部不正': { sessions: [{ id: 's1', mode: 'work', durationSec: 1500, startedAt: iso(9), endedAt: iso(10), intervals: [{ startedAt: 'x', endedAt: 'y' }] }] },
    '壊れた日付': { tasks: [{ id: 't1', createdAt: 'いつか', completedAt: { toString: null } }], sessions: [{ id: 's1', startedAt: '不明' }] }
  };
  for (const [name, input] of Object.entries(inputs)) {
    const once = normalizeData(input);
    const twice = normalizeData(once);
    eq(twice, once, `冪等: ${name}`);
  }
}

/* ===== 範囲外・型違いを安全な形に落とす ===== */
{
  const d = normalizeData({
    settings: { workMin: 9999, shortMin: -5, longEvery: 'x', whiteNoise: { volume: 500, enabled: 'yes' } },
    timer: { mode: 'いつか', cycle: -3 },
    tasks: [
      { id: 'ok', title: 123, completed: 'yes' },
      { title: 'id なしは捨てる' },
      null
    ],
    selectedTaskId: '存在しないid'
  });
  assert(d.settings.workMin === 120, '設定: 上限で頭打ちにする');
  assert(d.settings.shortMin === 1, '設定: 下限で止める');
  assert(d.settings.longEvery === DEFAULT_SETTINGS.longEvery, '設定: 数値にならない値は既定値へ');
  assert(d.settings.whiteNoise.volume === 100, '設定: 音量も範囲内へ');
  assert(d.settings.whiteNoise.enabled === true, '設定: 真偽値へ丸める');
  assert(d.timer.mode === 'work', 'タイマー: 未知のモードは work へ');
  assert(d.timer.cycle === 0, 'タイマー: 負のサイクルは 0 へ');
  assert(d.tasks.length === 1 && d.tasks[0].title === '123', 'タスク: id 無し/非オブジェクトを捨て、title は文字列へ');
  assert(d.tasks[0].completed === true, 'タスク: completed は真偽値へ');
  // 消えたタスクを指したままだと、フォーカス表示と実際の計測先がずれる
  assert(d.selectedTaskId === null, '存在しないタスクを指した選択は解除する');
}

/* ===== 完了したタスクは選択から外す ===== */
{
  const d = normalizeData({ tasks: [{ id: 't1', completed: true }], selectedTaskId: 't1' });
  assert(d.selectedTaskId === null, '完了したタスクは選択から外す');
}

/* ===== 壊れた入力で投げない ===== */
{
  const nasty = [
    undefined, null, 0, 'string', [], { sessions: [undefined, 1, 'x'] },
    { tasks: [{ id: 'a', createdAt: { toString: null } }] },          // ToString で TypeError
    { sessions: [{ id: 's', startedAt: 8.7e15 }] },                    // Date の表現範囲外
    { sessions: [{ id: 's', durationSec: Number.MAX_VALUE, startedAt: iso(9) }] }
  ];
  let threw = null;
  for (const v of nasty) {
    try { JSON.stringify(normalizeData(v)); } catch (err) { threw = `${JSON.stringify(v)}: ${err}`; break; }
  }
  assert(!threw, `どんな入力でも投げず JSON 化できる${threw ? ' — ' + threw : ''}`);
}

/* ===== 旧 pomodoros からの取り込み ===== */
{
  // taskTimes も intervals も mode も持たない最古の形式。旧コードでは taskStats や
  // 履歴描画が p.taskTimes を舐めてクラッシュしていた。
  const d = normalizeData({
    pomodoros: [
      { id: 'p1', startedAt: '2026-06-09T01:00:00Z', endedAt: '2026-06-09T01:25:00Z', durationSec: 1500, completed: true, taskIds: ['t1'] },
      { id: 'p2', startedAt: '2026-06-09T02:00:00Z', endedAt: '2026-06-09T02:10:00Z', durationSec: 600, completed: false }
    ]
  });
  const ivSec = s => s.intervals.reduce((a, iv) => a + (Date.parse(iv.endedAt) - Date.parse(iv.startedAt)) / 1000, 0);
  assert(d.sessions.length === 2, '旧 data.pomodoros も sessions として取り込む');
  assert(d.sessions.every(s => s.mode === 'work'), '旧データ: mode は work を補う');
  assert(d.sessions.every(s => Array.isArray(s.taskTimes) && Array.isArray(s.taskIds)), '旧データ: taskTimes / taskIds を配列にする');
  assert(d.sessions.every(s => s.intervals.length === 1), '旧データ: 1件につき1区間を合成する');
  assert(d.sessions.every(s => ivSec(s) === s.durationSec), '旧データ: 合成した区間の長さは durationSec と一致する(過大計上しない)');
}

/* ===== 壊れたセッションの型を直す ===== */
{
  const [a, b] = normalizeData({
    sessions: [
      { id: 's1', mode: 'work', startedAt: iso(9), durationSec: 'oops' },
      { id: 's2', mode: 'bogus', startedAt: iso(9), endedAt: iso(10), taskTimes: [{ taskId: 't1' }, null] }
    ]
  }).sessions;
  assert(a.durationSec === 0, 'セッション: 数値でない durationSec は 0 へ');
  assert(b.mode === 'work', 'セッション: 未知のモードは work へ');
  assert(b.taskTimes.length === 0, 'セッション: durationSec を持たない taskTimes の要素は捨てる');
}

/* ===== 日付の検証と復元(parseIso / normalizeSession / normalizeTask) ===== */
// 日付をまたぐケースがあるので、時刻は固定日のローカル時刻で作る
const at = (day, h, m = 0) => new Date(2026, 0, 15 + day, h, m, 0, 0);
const valid = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
{
  // 不正な startedAt で endedAt も無い記録。旧コードは new Date(NaN).toISOString() の
  // RangeError で init ごと停止していた。endedAt だけ壊れた記録は "NaN:NaN" を表示していた。
  const ss = normalizeData({
    sessions: [
      { id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: '不明' },
      { id: 's2', mode: 'work', durationSec: 600, completed: true, startedAt: iso(9), endedAt: 'garbage' },
      { id: 's3', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(10), endedAt: iso(11) }
    ]
  }).sessions;
  assert(ss.length === 3, '日付: 不正な日付の記録も捨てない');
  assert(ss.every(s => valid(s.startedAt) && valid(s.endedAt)), '日付: 正規化後の startedAt / endedAt は必ず有効な日付');
  assert(Date.parse(ss[1].endedAt) - Date.parse(ss[1].startedAt) === 600 * 1000, '日付: 壊れた終了は開始 + durationSec から復元する');
}
{
  // 不正・逆転・0長の区間はタイムテーブルで潰れて消えるだけなので落とす
  const s = normalizeData({
    sessions: [{
      id: 's1', mode: 'work', durationSec: 1500, completed: true,
      startedAt: at(0, 9).toISOString(), endedAt: at(0, 9, 40).toISOString(),
      intervals: [
        { startedAt: 'まだ', endedAt: at(0, 9, 10).toISOString() },
        { startedAt: at(0, 9, 30).toISOString(), endedAt: at(0, 9, 20).toISOString() },
        { startedAt: at(0, 9, 35).toISOString(), endedAt: at(0, 9, 35).toISOString() },
        { startedAt: at(0, 9).toISOString(), endedAt: at(0, 9, 10).toISOString() }
      ]
    }]
  }).sessions[0];
  assert(s.intervals.length === 1 && s.intervals[0].startedAt === at(0, 9).toISOString(), '区間: 不正・逆転・0長を落とし、正常な区間だけ残す');
}
{
  // 区間を持っていたが全部不正だった記録を span に畳むと、一時停止していた時間まで
  // 実働として描かれ、次の保存でその捏造が正史になる。区間の無い旧データとは区別する。
  const [broken, legacy] = normalizeData({
    sessions: [
      { id: 's1', mode: 'work', durationSec: 1500, startedAt: iso(9), endedAt: iso(10), intervals: [{ startedAt: 'こわれた', endedAt: 'こわれた' }] },
      { id: 's2', mode: 'work', durationSec: 1500, startedAt: iso(11), endedAt: iso(12) }
    ]
  }).sessions;
  assert(broken.intervals.length === 0, '区間: 全部不正だった区間は空のまま(span に化かさない)');
  assert(legacy.intervals.length === 1, '区間: 区間を持たない旧データは1区間に畳む');
}
{
  // 片方だけ壊れた日付を現在時刻で埋めると、昨日の記録が今日の集計に混ざり、
  // 開始 > 終了の逆転でタイムテーブルからも消える。
  const yesterdayEnd = at(-1, 15, 25);
  const [s1, s2] = normalizeData({
    sessions: [
      { id: 's1', mode: 'work', durationSec: 1500, startedAt: null, endedAt: yesterdayEnd.toISOString() },
      { id: 's2', mode: 'work', durationSec: 600, startedAt: at(0, 14).toISOString(), endedAt: at(0, 13).toISOString() }
    ]
  }).sessions;
  assert(Date.parse(s1.startedAt) === yesterdayEnd.getTime() - 1500 * 1000, '日付: 壊れた開始は終了 - durationSec から復元する(今日へ飛ばさない)');
  assert(Date.parse(s2.endedAt) - Date.parse(s2.startedAt) === 600 * 1000, '日付: 逆転していたら durationSec から引き直す');
}
{
  // 昨日 23:30〜23:40 作業 → 中断 → 今日 00:10〜00:20 作業。実働は20分だが壁時計の
  // span は50分。durationSec で引き直すと開始が今日 00:00 になり、昨日の区間がはみ出す。
  const ivA = [at(-1, 23, 30), at(-1, 23, 40)].map(d => d.toISOString());
  const ivB = [at(0, 0, 10), at(0, 0, 20)].map(d => d.toISOString());
  const iv = ([startedAt, endedAt]) => ({ startedAt, endedAt });
  const [s1, s2] = normalizeData({
    sessions: [
      // 開始だけ壊れている。区間は時系列順に並んでいない(min/max で取らないと取り違える)
      { id: 's1', mode: 'work', durationSec: 1200, startedAt: 'こわれた', endedAt: ivB[1], intervals: [iv(ivB), iv(ivA)] },
      { id: 's2', mode: 'work', durationSec: 1200, startedAt: ivA[0], endedAt: null, intervals: [iv(ivA), iv(ivB)] }
    ]
  }).sessions;
  assert(s1.intervals.length === 2 && s2.intervals.length === 2, '日付: 正常な区間は残す');
  assert(s1.startedAt === ivA[0], '日付: 壊れた開始は最も早い区間の開始から復元する');
  assert(s2.endedAt === ivB[1], '日付: 壊れた終了は最も遅い区間の終了から復元する');
}
{
  const tasks = normalizeData({
    tasks: [
      { id: 't1', completed: true, createdAt: 0, completedAt: 0 },
      { id: 't2', completed: false, createdAt: iso(9), completedAt: null },
      { id: 't3', completed: true, createdAt: 'いつか', completedAt: {} },
      { id: 't4', createdAt: { toString: null } }
    ]
  }).tasks;
  // truthy 判定にすると epoch ミリ秒の 0 という有効な日付を未完了に化かす
  assert(tasks[0].createdAt === new Date(0).toISOString() && tasks[0].completedAt === new Date(0).toISOString(), 'タスク: 日付の 0 は epoch として保つ');
  assert(tasks[1].completedAt === null, 'タスク: 未完了の completedAt は null のまま');
  // 現在時刻で埋めると CSV が「今日作った」と偽り、保存するまで起動ごとに値が変わる
  assert(tasks[2].createdAt === null && tasks[2].completedAt === null, 'タスク: 不正な日付は捏造せず null にする');
  assert(tasks[3].createdAt === null, 'タスク: ToString で例外になる値も null にする');
}

/* ===== インポート: このアプリのデータと分かるものだけ通す ===== */
{
  // normalizeData は何でも空のデータとして受け入れるので、検証を挟まないと
  // 取り違えたファイルで正本が黙って空に置き換わる。
  for (const [name, text] of Object.entries({
    '壊れた JSON': '{ tasks: ',
    '空のオブジェクト': '{}',
    '配列': '[{"id":"t1"}]',
    'null': 'null',
    '別のアプリの JSON': '{"name":"pkg","version":"1.0.0"}',
    'tasks が配列でない': '{"tasks":{"id":"t1"}}'
  })) {
    const r = parseImport(text);
    assert(r.ok === false && typeof r.error === 'string', `インポート: ${name} は断る`);
  }

  const exported = normalizeData({
    tasks: [{ id: 't1', title: 'あ', completed: false, createdAt: iso(9), completedAt: null }],
    sessions: [{ id: 's1', mode: 'work', durationSec: 1500, completed: true, startedAt: iso(9), endedAt: iso(10) }],
    selectedTaskId: 't1', settings: { workMin: 30 }, timer: { mode: 'short', cycle: 2 }
  });
  const r = parseImport(JSON.stringify(exported, null, 2));
  assert(r.ok === true, 'インポート: エクスポートした JSON は通す');
  eq(r.data, exported, 'インポート: エクスポートした内容がそのまま戻る');
  eq(r.counts, { tasks: 1, sessions: 1 }, 'インポート: 件数を数える');

  // BOM 付きで保存し直されたファイル(エディタで開いて保存した場合など)
  assert(parseImport('\uFEFF' + JSON.stringify(exported)).ok === true, 'インポート: 先頭の BOM は無視する');
  // 記録だけ・旧形式(pomodoros)だけのデータも、このアプリのものとして受け入れる
  assert(parseImport('{"sessions":[]}').ok === true, 'インポート: 空の記録だけでも通す');
  const old = parseImport(JSON.stringify({ pomodoros: [{ id: 'p1', durationSec: 1500, startedAt: iso(9), endedAt: iso(10) }] }));
  assert(old.ok === true && old.counts.sessions === 1, 'インポート: 旧形式の pomodoros も取り込む');
  // 値の範囲は通常の正規化と同じく丸める(断らない)
  const clamped = parseImport('{"tasks":[],"settings":{"workMin":9999}}');
  assert(clamped.ok === true && clamped.data.settings.workMin === 120, 'インポート: 範囲外の設定は丸めて取り込む');
}

console.log(process.exitCode ? '\nschema-test: FAILED' : '\nschema-test: OK');
