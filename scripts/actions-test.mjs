// shared/actions.js の単体テスト。electron に依存しないので Electron を起動せず走る。
// ここで見たいのは「意図の適用」そのもの:
//  - 受け取った状態を書き換えないこと(main の正本が途中まで変わった状態にならない)
//  - 削除と取り消しが往復すること(履歴の内訳を取りこぼさない)
//  - 差分で来た設定が他の設定を巻き戻さないこと
//  - 未知の意図を黙って素通りさせないこと
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyAction, deletionUndo } = require('../shared/actions.js');
const { normalizeData } = require('../shared/schema.js');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n  got: ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`}`);

const iso = h => new Date(2026, 0, 15, h, 0, 0, 0).toISOString();
const base = () => ({
  tasks: [
    { id: 't1', title: 'いち', completed: false, createdAt: iso(9), completedAt: null },
    { id: 't2', title: 'に', completed: false, createdAt: iso(9), completedAt: null }
  ],
  sessions: [{
    id: 's1', mode: 'work', startedAt: iso(9), endedAt: iso(10), durationSec: 1500, completed: true,
    intervals: [{ startedAt: iso(9), endedAt: iso(10) }],
    taskIds: ['t1', 't2'],
    // 同じ記録の中で t1 に戻ったケース。位置で戻さないと片方を取りこぼす。
    taskTimes: [{ taskId: 't1', durationSec: 600 }, { taskId: 't2', durationSec: 300 }, { taskId: 't1', durationSec: 600 }]
  }],
  selectedTaskId: 't1',
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4, autoStartBreak: false, autoStartWork: false, whiteNoise: { enabled: true, file: 'a.wav', breakFile: 'b.wav', volume: 50 } },
  timer: { mode: 'work', cycle: 0 }
});

/* ===== 受け取った状態は書き換えない ===== */
{
  // main は applyAction の戻り値を書き込めてから正本に入れる。ここで元を触ると、
  // 書き込みが失敗して保存を中止した後も正本が変わったままになる。
  const before = base();
  const snapshot = JSON.stringify(before);
  for (const action of [
    { type: 'task/add', task: { id: 't3', title: 'さん' } },
    { type: 'task/rename', id: 't1', title: '変更' },
    { type: 'task/setDone', id: 't1', completed: true, at: iso(11) },
    { type: 'task/delete', id: 't1' },
    { type: 'task/select', id: 't2' },
    { type: 'settings/update', patch: { workMin: 50 } },
    { type: 'flow/set', mode: 'short', cycle: 2 },
    { type: 'session/add', session: { id: 's2' } }
  ]) {
    applyAction(before, action);
    assert(JSON.stringify(before) === snapshot, `${action.type}: 元の状態を書き換えない`);
  }
}

/* ===== タスク ===== */
{
  const s = applyAction(base(), { type: 'task/add', task: { id: 't3', title: 'さん', completed: false, createdAt: iso(9), completedAt: null } });
  eq(s.tasks.map(t => t.id), ['t3', 't1', 't2'], 'task/add: 先頭に積む');

  const r = applyAction(base(), { type: 'task/rename', id: 't2', title: '改名' });
  eq(r.tasks.map(t => t.title), ['いち', '改名'], 'task/rename: 対象だけ変える');

  const d = applyAction(base(), { type: 'task/setDone', id: 't1', completed: true, at: iso(11) });
  assert(d.tasks[0].completed === true && d.tasks[0].completedAt === iso(11), 'task/setDone: 完了時刻を入れる');
  assert(d.selectedTaskId === null, 'task/setDone: 完了したタスクの選択は外す');
  const u = applyAction(d, { type: 'task/setDone', id: 't1', completed: false, at: null });
  assert(u.tasks[0].completed === false && u.tasks[0].completedAt === null, 'task/setDone: 未完了に戻すと完了時刻を消す');
  // 反転ではなく値で受けるので、同じ意図が二度届いても結果は変わらない
  const twice = applyAction(applyAction(base(), { type: 'task/setDone', id: 't2', completed: true, at: iso(11) }), { type: 'task/setDone', id: 't2', completed: true, at: iso(11) });
  assert(twice.tasks[1].completed === true, 'task/setDone: 同じ意図が重なっても打ち消し合わない');

  const sel = applyAction(base(), { type: 'task/select', id: 't2' });
  assert(sel.selectedTaskId === 't2', 'task/select: 選択を差し替える');
  assert(applyAction(base(), { type: 'task/select', id: null }).selectedTaskId === null, 'task/select: 選択解除できる');
}

/* ===== 削除と取り消しの往復 ===== */
{
  const before = base();
  const del = applyAction(before, { type: 'task/delete', id: 't1' });
  eq(del.tasks.map(t => t.id), ['t2'], 'task/delete: タスクを消す');
  eq(del.sessions[0].taskIds, ['t2'], 'task/delete: 履歴の taskIds から外す');
  eq(del.sessions[0].taskTimes.map(tt => tt.taskId), [null, 't2', null], 'task/delete: 内訳は消さず未割当にする');
  const total = del.sessions[0].taskTimes.reduce((a, tt) => a + tt.durationSec, 0);
  assert(total === 1500, 'task/delete: 実際に働いた時間は消えない');
  assert(del.selectedTaskId === null, 'task/delete: 選択していたら外す');

  // 削除前のスナップショットから作った控え(レンダラが送る形)
  const patches = [{ sessionId: 's1', indexes: [0, 2] }];
  const back = applyAction(del, { type: 'task/restore', task: before.tasks[0], index: 0, patches, select: true });
  eq(back.tasks.map(t => t.id), ['t1', 't2'], 'task/restore: 元の位置に戻す');
  eq(back.sessions[0].taskTimes.map(tt => tt.taskId), ['t1', 't2', 't1'], 'task/restore: 同じ記録の複数の内訳を取りこぼさない');
  eq([...back.sessions[0].taskIds].sort(), ['t1', 't2'], 'task/restore: taskIds にも戻す');
  assert(back.selectedTaskId === 't1', 'task/restore: 選択も戻す');
  // taskIds は「そのポモドーロに関わったタスク」の集合で順序に意味はないため、
  // 往復で末尾に回ったぶんは揃えてから比べる。
  const sorted = d => ({ ...d, sessions: d.sessions.map(s => ({ ...s, taskIds: [...s.taskIds].sort() })) });
  eq(sorted(normalizeData(back)), sorted(normalizeData(before)), 'task/restore: 削除前と同じ内容に戻る');

  // 位置が範囲外でも落とさない(控えを作った後に他のタスクが減っている場合)
  const clamped = applyAction({ ...del, tasks: [] }, { type: 'task/restore', task: before.tasks[0], index: 9, patches, select: false });
  eq(clamped.tasks.map(t => t.id), ['t1'], 'task/restore: 範囲外の位置は末尾に寄せる');
  // 取り消しの控えは削除直前の正本から作る(main が呼ぶ)。控えで戻せば往復する。
  const u = deletionUndo(before, 't1');
  eq({ task: u.task.id, index: u.index, patches: u.patches }, { task: 't1', index: 0, patches }, 'deletionUndo: 削除直前の正本から位置と内訳を控える');
  assert(u.selected === true && deletionUndo(before, 't2').selected === false, 'deletionUndo: 選択されていたかも正本で控える');
  eq(sorted(normalizeData(applyAction(del, { type: 'task/restore', ...u, select: true }))), sorted(normalizeData(before)), 'deletionUndo: 控えで戻すと削除前と同じ内容になる');
  assert(deletionUndo(before, 'nope') === null, 'deletionUndo: 無いタスクには控えを作らない');
  // 削除が失敗して正本に残っているタスクを戻しても、二重にしない。
  const twice = applyAction(before, { type: 'task/restore', task: before.tasks[0], index: 0, patches, select: true });
  eq(twice.tasks.map(t => t.id), before.tasks.map(t => t.id), 'task/restore: 既にあるタスクは挿入しない');
  eq(twice.sessions, before.sessions, 'task/restore: 既にあるなら内訳も触らない');
}

/* ===== 設定は差分 ===== */
{
  const s = applyAction(base(), { type: 'settings/update', patch: { whiteNoise: { enabled: false } } });
  assert(s.settings.whiteNoise.enabled === false, 'settings/update: 入れ子の項目を変える');
  assert(s.settings.whiteNoise.file === 'a.wav' && s.settings.whiteNoise.volume === 50, 'settings/update: 触っていない入れ子の項目を消さない');
  assert(s.settings.workMin === 25, 'settings/update: 触っていない設定を巻き戻さない');
}

/* ===== 進行状態・記録 ===== */
{
  const f = applyAction(base(), { type: 'flow/set', mode: 'long', cycle: 4 });
  eq(f.timer, { mode: 'long', cycle: 4 }, 'flow/set: 自動サイクルの進行を差し替える');

  const a = applyAction(base(), { type: 'session/add', session: { id: 's2', mode: 'short', durationSec: 300, startedAt: iso(10), endedAt: iso(11) } });
  eq(a.sessions.map(x => x.id), ['s1', 's2'], 'session/add: 末尾に積む');

  // 組んだ時点では在ったが、届いた時点では正本に無いタスク(戻せなかった取り消しなど)。
  const gone = applyAction(base(), { type: 'session/add', session: {
    id: 's3', mode: 'work', durationSec: 900, startedAt: iso(11), endedAt: iso(12),
    taskIds: ['t1', 'gone'],
    taskTimes: [{ taskId: 't1', durationSec: 300 }, { taskId: null, durationSec: 200 }, { taskId: 'gone', durationSec: 400 }]
  } });
  const s3 = gone.sessions[1];
  eq(s3.taskIds, ['t1'], 'session/add: 正本に無いタスクを taskIds から外す');
  eq(s3.taskTimes, [{ taskId: 't1', durationSec: 300 }, { taskId: null, durationSec: 200 }, { taskId: null, durationSec: 400 }], 'session/add: 外した内訳はその位置のまま「タスクなし」にする(取り消しで位置から戻せる)');
  const known = { id: 's4', mode: 'work', taskIds: ['t1'], taskTimes: [{ taskId: 't1', durationSec: 60 }] };
  assert(applyAction(base(), { type: 'session/add', session: known }).sessions[1] === known, 'session/add: 参照が全部正本にあれば手を加えない');
  const again = applyAction(base(), { type: 'session/add', session: { id: 's1', mode: 'work' } });
  eq(again.sessions.map(x => x.id), ['s1'], 'session/add: 同じ id の記録は二重に積まない(送り直しが重なっても)');
}

/* ===== 未知の意図 ===== */
{
  for (const bad of [null, undefined, 42, 'task/add', {}, { type: 'task/nuke' }, { type: '__proto__' }]) {
    assert(applyAction(base(), bad) === null, `未知の意図(${JSON.stringify(bad)})は null を返す`);
  }
}

/* ===== 検証は normalizeData に任せる ===== */
{
  // 意図の側では範囲を見ない。壊れた入力が来ても、正本に入る前に丸まればよい。
  const s = applyAction(base(), { type: 'settings/update', patch: { workMin: 9999, whiteNoise: { volume: -20 } } });
  assert(s.settings.workMin === 9999, 'applyAction 自体は丸めない(検証を二箇所に置かない)');
  const n = normalizeData(s);
  assert(n.settings.workMin === 120 && n.settings.whiteNoise.volume === 0, '適用結果を normalizeData に通せば正規形になる');

  // 壊れたタスク・記録を積んでも、正規化が落とすので正本は壊れない
  const junk = applyAction(applyAction(base(), { type: 'task/add', task: { title: 'id 無し' } }), { type: 'session/add', session: { id: 's2', mode: 'まだ', durationSec: -5, startedAt: '不明' } });
  const nj = normalizeData(junk);
  assert(nj.tasks.length === 2, '正規化が id の無いタスクを落とす');
  assert(nj.sessions[1].mode === 'work' && nj.sessions[1].durationSec === 0, '正規化が壊れた記録を直す');
}

console.log(process.exitCode ? '\nactions-test: FAILED' : '\nactions-test: OK');
