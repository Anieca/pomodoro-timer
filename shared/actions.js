'use strict';
// 正本に対する「意図」を適用する reducer。書き手は main だけなので、レンダラは
// 「何を書くか(データ丸ごと)」ではなく「何をしたいか」をここへ送る。
//
// 丸ごと置換をやめた理由: 置換では、保存1の応答が届くまでに編集2が入っていると
// 古い内容で上書きされて編集2が失われる。意図なら main が受け取った順に正本へ
// 適用するので、同時に走った編集同士が消し合わない。
//
// schema.js と同じく electron に依存しない純粋なモジュールにしてある。レンダラも
// 同じものを <script> で読み、応答待ちの意図を正本に当てた見込みを描くのに使う。
// 受け取った state は書き換えず、新しいオブジェクトを返す。
//
// 範囲・型の検証はここではしない。適用結果は main が必ず normalizeData に通すので、
// ここは意図の適用だけを担う(検証を二箇所に置くと食い違う)。

const asArray = v => (Array.isArray(v) ? v : []);
const asObject = v => (v && typeof v === 'object' ? v : {});

// 削除されたタスクのIDを履歴から外す。記録そのものは消さず、内訳を「(未割当)」に
// 落とす(そのポモドーロで実際に働いた時間は、タスクが消えても事実として残る)。
function detachTask(sessions, id) {
  return sessions.map(s => {
    const taskIds = asArray(s.taskIds);
    const taskTimes = asArray(s.taskTimes);
    if (!taskIds.includes(id) && !taskTimes.some(tt => asObject(tt).taskId === id)) return s;
    return {
      ...s,
      taskIds: taskIds.filter(tid => tid !== id),
      taskTimes: taskTimes.map(tt => (asObject(tt).taskId === id ? { ...tt, taskId: null } : tt))
    };
  });
}

// 削除の取り消し。どの記録のどの内訳がそのタスクのものだったかは detachTask で
// 消えているため、削除前のスナップショットを見ていた呼び出し元が位置を添えて送る。
// 位置で戻すので、同じタスクに複数の内訳がある記録でも取りこぼさない。
function attachTask(sessions, id, patches) {
  const byId = new Map();
  for (const p of asArray(patches)) {
    const o = asObject(p);
    if (typeof o.sessionId === 'string') byId.set(o.sessionId, asArray(o.indexes));
  }
  if (byId.size === 0) return sessions;
  return sessions.map(s => {
    const indexes = byId.get(s.id);
    if (!indexes || indexes.length === 0) return s;
    const taskTimes = asArray(s.taskTimes).map((tt, i) => (indexes.includes(i) ? { ...tt, taskId: id } : tt));
    const taskIds = asArray(s.taskIds);
    return {
      ...s,
      taskTimes,
      taskIds: taskIds.includes(id) ? taskIds : [...taskIds, id]
    };
  });
}

// 記録が正本に無いタスクを指していたら外す。レンダラは記録を組んだ時点の手元で
// 内訳を付けるので、その間に削除されたタスクや、戻すつもりで付け直したが戻せな
// かったタスクを指しうる。外した内訳は削除と同じく、その位置のまま「タスクなし」に
// する(合算しない)。位置が残っていれば、あとで削除を取り消したとき task/restore が
// 位置で付け直せる。
function keepKnownTasks(session, tasks) {
  const known = new Set(tasks.map(t => asObject(t).id));
  const taskTimes = asArray(session.taskTimes);
  if (taskTimes.every(tt => { const id = asObject(tt).taskId; return id == null || known.has(id); })) return session;
  return {
    ...session,
    taskIds: asArray(session.taskIds).filter(id => known.has(id)),
    taskTimes: taskTimes.map(tt => {
      const id = asObject(tt).taskId;
      return id == null || known.has(id) ? tt : { ...tt, taskId: null };
    })
  };
}

const replaceTask = (tasks, id, patch) => tasks.map(t => (asObject(t).id === id ? { ...t, ...patch } : t));

// 意図を適用した新しい状態を返す。未知の意図では null を返し、呼び出し元
// (main)が保存自体を中止して失敗として返せるようにする。黙って素通りさせると、
// 意図が届いていないのにレンダラは適用されたつもりで先へ進んでしまう。
function applyAction(state, action) {
  const s = asObject(state);
  const a = asObject(action);
  const tasks = asArray(s.tasks);
  const sessions = asArray(s.sessions);

  switch (a.type) {
    // id と作成時刻はレンダラが採番して送る(reducer を時計に依存させないため)。
    case 'task/add':
      // 同じ id は積まない(レンダラの見込みで当て直されても二重にならない)。
      if (tasks.some(t => asObject(t).id === asObject(a.task).id)) return s;
      return { ...s, tasks: [asObject(a.task), ...tasks] };

    case 'task/rename':
      return { ...s, tasks: replaceTask(tasks, a.id, { title: a.title }) };

    // 完了は反転ではなく「こうしたい」値を送る。反転だと、応答待ちの間に押された
    // 2回目が同じ値から反転して打ち消され、押した回数と結果が合わなくなる。
    case 'task/setDone': {
      const completed = !!a.completed;
      return {
        ...s,
        tasks: replaceTask(tasks, a.id, { completed, completedAt: completed ? a.at : null }),
        // 完了したタスクを指したままにしない(normalizeData でも落ちるが、
        // 意図の時点で解除しておく方が、なぜ外れたかが読めば分かる)
        selectedTaskId: completed && s.selectedTaskId === a.id ? null : s.selectedTaskId
      };
    }

    case 'task/delete':
      return {
        ...s,
        tasks: tasks.filter(t => asObject(t).id !== a.id),
        sessions: detachTask(sessions, a.id),
        selectedTaskId: s.selectedTaskId === a.id ? null : s.selectedTaskId
      };

    case 'task/restore': {
      const task = asObject(a.task);
      // 削除の応答前に元に戻すを押し、その削除が失敗していると、タスクは正本に
      // 残ったまま。重ねて挿入すると同じ id が二行になり、正規化でも消えない。
      if (tasks.some(t => asObject(t).id === task.id)) return s;
      const next = tasks.slice();
      const index = Number.isFinite(a.index) ? Math.min(Math.max(0, Math.round(a.index)), next.length) : next.length;
      next.splice(index, 0, task);
      return {
        ...s,
        tasks: next,
        sessions: attachTask(sessions, task.id, a.patches),
        selectedTaskId: a.select ? task.id : s.selectedTaskId
      };
    }

    case 'task/select':
      return { ...s, selectedTaskId: a.id == null ? null : a.id };

    // 設定は全体ではなく差分で受ける。開いていない画面の項目まで送り返させると、
    // 古い値で他の設定を巻き戻してしまう。
    case 'settings/update': {
      const cur = asObject(s.settings);
      const patch = asObject(a.patch);
      return {
        ...s,
        settings: {
          ...cur,
          ...patch,
          whiteNoise: { ...asObject(cur.whiteNoise), ...asObject(patch.whiteNoise) }
        }
      };
    }

    // 自動サイクルの進行(次フェーズ・長休憩までのカウント)。
    case 'flow/set':
      return { ...s, timer: { mode: a.mode, cycle: a.cycle } };

    case 'session/add': {
      const session = asObject(a.session);
      // 保存に失敗した記録はレンダラが送り直す。重なっても二重に積まない。
      if (session.id != null && sessions.some(x => asObject(x).id === session.id)) return s;
      return { ...s, sessions: [...sessions, keepKnownTasks(session, tasks)] };
    }

    default:
      return null;
  }
}

// 削除を取り消すための控え。削除を適用する直前の正本から作る(main が呼ぶ)。
// レンダラの手元から作ると、応答待ちの編集(完了・名前の変更)より古い内容になり、
// 取り消しがそれを黙って巻き戻してしまう。どの記録のどの内訳がこのタスクのもの
// だったかは削除後の正本からは分からない(匿名化されるため)ので、位置で控える。
function deletionUndo(state, id) {
  const s = asObject(state);
  const tasks = asArray(s.tasks);
  const index = tasks.findIndex(t => asObject(t).id === id);
  if (index === -1) return null;
  const patches = [];
  for (const p of asArray(s.sessions)) {
    const indexes = [];
    asArray(asObject(p).taskTimes).forEach((tt, i) => { if (asObject(tt).taskId === id) indexes.push(i); });
    if (indexes.length) patches.push({ sessionId: asObject(p).id, indexes });
  }
  // 選択されていたかも正本で控える。レンダラのフォーカスは応答待ちの要求の値なので、
  // その要求が失敗していると、実際に削除された状態とずれる。
  return { task: tasks[index], index, patches, selected: s.selectedTaskId === id };
}

// レンダラ(<script>)では関数がそのまま global に出る。
if (typeof module !== 'undefined') module.exports = { applyAction, deletionUndo };
