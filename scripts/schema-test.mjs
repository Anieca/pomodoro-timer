// shared/schema.js の単体テスト。electron に依存しないので Electron を起動せず走る。
// ここで見たいのは「正本の形」そのもの:
//  - 冪等性(読み込み時と書き込み時の両方で通すため、通すたびに値が変わってはいけない)
//  - 範囲外・型違いの入力を安全な形に落とすこと
//  - 壊れた入力で例外を投げないこと(投げると起動そのものが止まる)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeData, DEFAULT_SETTINGS } = require('../shared/schema.js');

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
  const d = normalizeData({ pomodoros: [{ id: 'p1', mode: 'work', durationSec: 1500, startedAt: iso(9), endedAt: iso(10) }] });
  assert(d.sessions.length === 1, '旧 data.pomodoros も sessions として取り込む');
}

console.log(process.exitCode ? '\nschema-test: FAILED' : '\nschema-test: OK');
