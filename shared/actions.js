'use strict';
// 正本に対する「意図」を適用する reducer。書き手は main だけなので、レンダラは
// 「何を書くか(データ丸ごと)」ではなく「何をしたいか」をここへ送る。
//
// 丸ごと置換をやめた理由: 置換では、保存1の応答が届くまでに編集2が入っていると
// 古い内容で上書きされて編集2が失われる。意図なら main が受け取った順に正本へ
// 適用するので、同時に走った編集同士が消し合わない。
//
// schema.js と同じく electron に依存しない純粋なモジュールにしてある。
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

    case 'session/add':
      return { ...s, sessions: [...sessions, asObject(a.session)] };

    default:
      return null;
  }
}

module.exports = { applyAction };
