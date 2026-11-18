// すべての変更の入口。reduce(data, command, now) は純粋で、時計も乱数も持たない。
// タイマーも記録もタスクもここを通るので、権威は一つ(main がこれを回す)。
//
// 終了予定時刻は持たない。経過は実働区間の合計で、動いていなかった時間
// (スリープ・プロセス停止)は timer/gap で区間から切り取るだけで済む。
import { cleanTitle, decodeSession, decodeSettings } from './codec.ts';
import {
  MAX_PLANNED_MS, MIN_RECORD_MS, elapsedMs, isOpenTask, plannedMsFor, spansMs,
  type Data, type Kind, type Run, type Session, type Span
} from './model.ts';

export type Command =
  | { type: 'timer/start' }
  | { type: 'timer/pause' }
  | { type: 'timer/resume' }
  | { type: 'timer/toggle' }
  /** フォーカスなら中断、休憩なら切り上げ。待機中の休憩は飛ばす。 */
  | { type: 'timer/stop' }
  | { type: 'timer/extend'; minutes: number }
  /** 完了の判定と生存の記録 */
  | { type: 'timer/tick' }
  /** from〜to の間は動いていなかった(スリープなど) */
  | { type: 'timer/gap'; from: number; to: number }
  /** 起動時。前回の実行が残していった進行中セッションを片付ける */
  | { type: 'timer/recover' }
  | { type: 'task/add'; id: string; title: string }
  | { type: 'task/rename'; id: string; title: string }
  | { type: 'task/setDone'; id: string; done: boolean }
  | { type: 'task/delete'; id: string }
  | { type: 'task/restore'; id: string }
  /** before の手前へ動かす(null は末尾) */
  | { type: 'task/move'; id: string; before: string | null }
  | { type: 'task/activate'; id: string | null }
  | { type: 'session/assign'; id: string; taskId: string | null }
  | { type: 'session/delete'; id: string }
  | { type: 'session/put'; session: unknown }
  | { type: 'settings/update'; patch: unknown };

export type Effect = {
  type: 'ended';
  kind: Kind;
  /** 次に来るもの */
  next: Kind;
  /** 次がすでに始まっているか */
  autoStarted: boolean;
  taskTitle: string | null;
};

export interface Result {
  data: Data;
  effects: Effect[];
}

const HEARTBEAT_MS = 15_000;
/** 一時停止のまま放置されたセッションを、次の起動で打ち切るまでの長さ */
const STALE_MS = 30 * 60_000;
/** これより短い区間は記録しない(連打で生まれる屑) */
const MIN_SPAN_MS = 1000;

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

function pushSpan(spans: Span[], span: Span): Span[] {
  if (span.end - span.start < MIN_SPAN_MS) return spans;
  const prev = spans[spans.length - 1];
  if (prev && prev.end === span.start && prev.taskId === span.taskId) {
    return [...spans.slice(0, -1), { ...prev, end: span.end }];
  }
  return [...spans, span];
}

/** 開いている区間を at で閉じる(= 一時停止の状態にする) */
function closeOpen(run: Run, at: number): Run {
  if (!run.open) return run;
  return { ...run, spans: pushSpan(run.spans, { ...run.open, end: Math.max(run.open.start, at) }), open: null, seenAt: at };
}

function startRun(data: Data, kind: Kind, now: number): Data {
  const run: Run = {
    id: `${kind[0]}${now.toString(36)}`,
    kind,
    plannedMs: plannedMsFor(data.settings, kind),
    spans: [],
    open: { start: now, taskId: kind === 'focus' ? data.activeTaskId : null },
    seenAt: now
  };
  return { ...data, run };
}

/** 進行中のセッションを記録へ移す(短すぎるものは捨てる)。run は閉じてあること。 */
function record(data: Data, run: Run, completed: boolean): Data {
  const worked = spansMs(run.spans);
  if (run.spans.length === 0 || (!completed && worked < MIN_RECORD_MS)) return { ...data, run: null };
  const session: Session = {
    id: run.id,
    kind: run.kind,
    plannedSec: Math.round(run.plannedMs / 1000),
    completed,
    spans: run.spans
  };
  return { ...data, run: null, sessions: [...data.sessions.filter(s => s.id !== run.id), session] };
}

function stop(data: Data, now: number): Data {
  const run = data.run;
  if (!run) return data.next === 'focus' ? data : { ...data, next: 'focus' };
  const out = record(data, closeOpen(run, now), false);
  // 休憩を切り上げたら次はフォーカス。フォーカスの中断はやり直しなので次もフォーカス。
  return { ...out, next: 'focus' };
}

/** 予定の長さに達していたら完了させる。達した瞬間で区間を閉じる(超過ぶんは実働にしない)。 */
function completeIfDue(data: Data, now: number): Result {
  const run = data.run;
  if (!run || !run.open) return { data, effects: [] };
  const over = elapsedMs(run, now) - run.plannedMs;
  if (over < 0) return { data, effects: [] };
  const endAt = Math.max(run.open.start, now - over);
  let out = record(data, closeOpen(run, endAt), true);
  const title = run.kind === 'focus'
    ? data.tasks.find(t => t.id === run.open!.taskId)?.title ?? null
    : null;
  if (run.kind === 'focus') {
    const streak = data.streak + 1;
    out = { ...out, streak, next: streak % data.settings.longEvery === 0 ? 'long' : 'short' };
  } else {
    out = { ...out, next: 'focus' };
  }
  const auto = run.kind === 'focus' ? data.settings.autoBreak : data.settings.autoFocus;
  if (auto) out = startRun(out, out.next, now);
  return { data: out, effects: [{ type: 'ended', kind: run.kind, next: out.next, autoStarted: auto, taskTitle: title }] };
}

/** 向き合うタスクを替える(存在する未完了のタスクか、無しだけ)。 */
function activate(data: Data, taskId: string | null, now: number): Data {
  if (taskId !== null) {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task || !isOpenTask(task)) return data;
  }
  return data.activeTaskId === taskId ? data : retarget(data, taskId, now);
}

function gap(data: Data, from: number, to: number): Data {
  const run = data.run;
  // 休憩は席を離れていても進むので切り取らない
  if (!run || !run.open || run.kind !== 'focus') return data;
  if (!(to > from) || to <= run.open.start) return data;
  const taskId = run.open.taskId;
  const closed = closeOpen(run, Math.max(run.open.start, from));
  return { ...data, run: { ...closed, open: { start: to, taskId }, seenAt: to } };
}

function recover(data: Data, now: number): Data {
  let run = data.run;
  if (!run) return data;
  // 終了の手続きを踏めずに止まった。最後に生存を確かめた時刻までを実働とする。
  if (run.open) run = closeOpen(run, Math.min(Math.max(run.seenAt, run.open.start), now));
  const last = run.spans.length ? run.spans[run.spans.length - 1].end : run.seenAt;
  // 休憩は持ち越さない。フォーカスも長く放置されていたら打ち切って記録に回す。
  if (run.kind !== 'focus' || now - last > STALE_MS) return { ...record(data, run, false), next: 'focus' };
  return { ...data, run };
}

function reduceData(data: Data, cmd: Command, now: number): Data {
  switch (cmd.type) {
    case 'timer/start':
      return data.run ? data : startRun(data, data.next, now);

    case 'timer/pause':
      return data.run?.open ? { ...data, run: closeOpen(data.run, now) } : data;

    case 'timer/resume': {
      const run = data.run;
      if (!run || run.open) return data;
      return { ...data, run: { ...run, open: { start: now, taskId: run.kind === 'focus' ? data.activeTaskId : null }, seenAt: now } };
    }

    case 'timer/toggle':
      return reduceData(data, { type: !data.run ? 'timer/start' : data.run.open ? 'timer/pause' : 'timer/resume' }, now);

    case 'timer/stop':
      return stop(data, now);

    case 'timer/extend': {
      const run = data.run;
      const add = Math.round(Number(cmd.minutes)) * 60_000;
      if (!run || !Number.isFinite(add) || add <= 0) return data;
      const plannedMs = Math.min(MAX_PLANNED_MS, run.plannedMs + add);
      return plannedMs === run.plannedMs ? data : { ...data, run: { ...run, plannedMs } };
    }

    case 'timer/tick': {
      const run = data.run;
      if (!run?.open || now - run.seenAt < HEARTBEAT_MS) return data;
      return { ...data, run: { ...run, seenAt: now } };
    }

    case 'timer/gap':
      return Number.isFinite(cmd.from) && Number.isFinite(cmd.to) ? gap(data, cmd.from, cmd.to) : data;

    case 'timer/recover':
      return recover(data, now);

    case 'task/add': {
      const title = cleanTitle(cmd.title);
      if (!str(cmd.id) || !title || data.tasks.some(t => t.id === cmd.id)) return data;
      const tasks = [...data.tasks, { id: cmd.id, title, createdAt: now, doneAt: null, deletedAt: null }];
      // 何も選んでいなければ、足したものにそのまま向き合う
      const next = { ...data, tasks };
      return data.activeTaskId === null && !data.run ? activate(next, cmd.id, now) : next;
    }

    case 'task/rename': {
      const title = cleanTitle(cmd.title);
      if (!title) return data;
      return { ...data, tasks: data.tasks.map(t => (t.id === cmd.id ? { ...t, title } : t)) };
    }

    case 'task/setDone': {
      const index = data.tasks.findIndex(t => t.id === cmd.id);
      const task = data.tasks[index];
      if (!task || task.deletedAt !== null || (task.doneAt !== null) === !!cmd.done) return data;
      const tasks = data.tasks.map(t => (t.id === cmd.id ? { ...t, doneAt: cmd.done ? now : null } : t));
      const out = { ...data, tasks };
      if (!cmd.done || data.activeTaskId !== cmd.id) return out;
      // 終えたら次へ。並びの下にある未完了、無ければ先頭の未完了へ移る。
      const after = tasks.slice(index + 1).find(isOpenTask) ?? tasks.find(isOpenTask);
      return retarget(out, after?.id ?? null, now);
    }

    case 'task/delete': {
      const task = data.tasks.find(t => t.id === cmd.id);
      if (!task || task.deletedAt !== null) return data;
      const out = data.activeTaskId === cmd.id ? retarget(data, null, now) : data;
      return { ...out, tasks: out.tasks.map(t => (t.id === cmd.id ? { ...t, deletedAt: now } : t)) };
    }

    case 'task/restore':
      return { ...data, tasks: data.tasks.map(t => (t.id === cmd.id && t.deletedAt !== null ? { ...t, deletedAt: null } : t)) };

    case 'task/move': {
      const task = data.tasks.find(t => t.id === cmd.id);
      if (!task || cmd.before === cmd.id) return data;
      const rest = data.tasks.filter(t => t.id !== cmd.id);
      const at = cmd.before === null ? -1 : rest.findIndex(t => t.id === cmd.before);
      const tasks = at === -1 ? [...rest, task] : [...rest.slice(0, at), task, ...rest.slice(at)];
      return tasks.every((t, i) => t === data.tasks[i]) ? data : { ...data, tasks };
    }

    case 'task/activate':
      return activate(data, cmd.id === null ? null : str(cmd.id) ? cmd.id : data.activeTaskId, now);

    case 'session/assign': {
      const taskId = cmd.taskId === null ? null : data.tasks.some(t => t.id === cmd.taskId) ? cmd.taskId : undefined;
      if (taskId === undefined) return data;
      return {
        ...data,
        sessions: data.sessions.map(s =>
          s.id === cmd.id && s.kind === 'focus' ? { ...s, spans: s.spans.map(sp => ({ ...sp, taskId })) } : s)
      };
    }

    case 'session/delete':
      return data.sessions.some(s => s.id === cmd.id)
        ? { ...data, sessions: data.sessions.filter(s => s.id !== cmd.id) }
        : data;

    // 削除の取り消し。外から来た記録なので検めてから入れる。
    case 'session/put': {
      const session = decodeSession(cmd.session, id => data.tasks.some(t => t.id === id));
      if (!session || data.sessions.some(s => s.id === session.id) || data.run?.id === session.id) return data;
      const sessions = [...data.sessions, session].sort((a, b) => a.spans[0].start - b.spans[0].start);
      return { ...data, sessions };
    }

    case 'settings/update': {
      const patch = cmd.patch !== null && typeof cmd.patch === 'object' ? (cmd.patch as Record<string, unknown>) : {};
      const sound = patch.sound !== null && typeof patch.sound === 'object' ? patch.sound : {};
      return { ...data, settings: decodeSettings({ ...data.settings, ...patch, sound: { ...data.settings.sound, ...sound } }) };
    }

    default:
      return data;
  }
}

/** 付け先を替える。フォーカスが動いていれば、そこで区間を区切る(タイマーは止めない)。 */
function retarget(data: Data, nextId: string | null, now: number): Data {
  let run = data.run;
  if (run && run.kind === 'focus' && run.open) {
    run = { ...closeOpen(run, now), open: { start: now, taskId: nextId } };
  }
  return { ...data, activeTaskId: nextId, run };
}

/**
 * 命令を適用する。未知の命令や意味のない命令では同じ data をそのまま返す
 * (呼び出し側は参照の一致で「変わらなかった」と分かる)。
 */
export function reduce(data: Data, cmd: Command, now: number): Result {
  // どの命令の前にも、予定に達していないかを先に確かめる。完了の瞬間と操作が
  // 重なっても、完了が先に確定する(「完走したのに中断として残る」を避ける)。
  // gap と recover は「その時間は動いていなかった」という訂正なので、先に完了させない。
  const before = cmd.type === 'timer/gap' || cmd.type === 'timer/recover'
    ? { data, effects: [] }
    : completeIfDue(data, now);
  const next = reduceData(before.data, cmd, now);
  const after = cmd.type === 'timer/gap' ? completeIfDue(next, now) : { data: next, effects: [] };
  return { data: after.data, effects: [...before.effects, ...after.effects] };
}
