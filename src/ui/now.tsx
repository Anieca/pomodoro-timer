// 「いま」の三つの領域: タスク / タイマー / 今日の帯。
import { useRef, useState } from 'preact/hooks';
import { cyclePosition, dayBlocks, dayTotals, fmtClock, fmtDur, liveSession, startOfDay, timerView } from '../core/derive.ts';
import { KIND_LABEL, isOpenTask, type Data, type Task } from '../core/model.ts';
import { DayStrip, hourRange } from './strip.tsx';
import { newId, send, soundLabel, toast, useNow } from './store.ts';

/* ---------- タスク ---------- */

export function TaskPane({ data }: { data: Data }) {
  const [draft, setDraft] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);

  const open = data.tasks.filter(isOpenTask);
  const done = data.tasks.filter(t => t.doneAt !== null && t.deletedAt === null).sort((a, b) => b.doneAt! - a.doneAt!);

  const add = (e: Event): void => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    send({ type: 'task/add', id: newId(), title });
    setDraft('');
  };

  const remove = (t: Task): void => {
    send({ type: 'task/delete', id: t.id });
    toast(`「${t.title}」を削除しました`, { label: '元に戻す', run: () => send({ type: 'task/restore', id: t.id }) });
  };

  // 行の上半分に落とせばその手前、下半分なら次の行の手前(= その行の後ろ)
  const onDragOver = (e: DragEvent, index: number): void => {
    if (!dragId) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    setDropBefore(after ? open[index + 1]?.id ?? null : open[index].id);
  };
  const drop = (): void => {
    if (dragId && dropBefore !== undefined) send({ type: 'task/move', id: dragId, before: dropBefore });
    setDragId(null);
    setDropBefore(undefined);
  };

  return (
    <aside class="tasks recede" aria-label="タスク">
      <form class="task-add" onSubmit={add}>
        <input
          id="newTask"
          value={draft}
          onInput={e => setDraft(e.currentTarget.value)}
          placeholder="タスクを足す"
          title="N"
          maxLength={200}
          autocomplete="off"
          aria-label="新しいタスク"
        />
      </form>

      <div class="task-scroll">
        {open.length === 0 ? (
          <p class="empty">
            向き合うことを一つ書いて Enter。<br />
            タスクを決めずに始めることもできます。<br />
            Space で始め、N でここに戻れます。
          </p>
        ) : (
          <ul class="task-list" id="taskList" onDragOver={e => dragId && e.preventDefault()} onDrop={drop}>
            {open.map((t, i) => (
              <TaskRow
                key={t.id}
                task={t}
                active={t.id === data.activeTaskId}
                dropAbove={dragId !== null && dropBefore === t.id}
                dropBelow={dragId !== null && dropBefore === null && i === open.length - 1}
                onDragStart={() => setDragId(t.id)}
                onDragOver={e => onDragOver(e, i)}
                onDragEnd={() => { setDragId(null); setDropBefore(undefined); }}
                onRemove={() => remove(t)}
              />
            ))}
          </ul>
        )}

        {done.length > 0 && (
          <section class="done">
            <button class="done-toggle" id="toggleDone" aria-expanded={showDone} onClick={() => setShowDone(v => !v)}>
              終えたもの <span class="num">{done.length}</span>
            </button>
            {showDone && (
              <ul class="task-list" id="doneList">
                {done.map(t => (
                  <li class="task" data-done key={t.id}>
                    <input
                      type="checkbox"
                      class="check"
                      checked
                      aria-label={`「${t.title}」を未完了に戻す`}
                      onChange={() => send({ type: 'task/setDone', id: t.id, done: false })}
                    />
                    <span class="task-title">{t.title}</span>
                    <button class="task-remove task-delete" aria-label={`「${t.title}」を削除`} onClick={() => remove(t)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

interface RowProps {
  task: Task;
  active: boolean;
  dropAbove: boolean;
  dropBelow: boolean;
  onDragStart(): void;
  onDragOver(e: DragEvent): void;
  onDragEnd(): void;
  onRemove(): void;
}

function TaskRow({ task, active, dropAbove, dropBelow, onDragStart, onDragOver, onDragEnd, onRemove }: RowProps) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const commit = (): void => {
    const title = input.current?.value.trim();
    if (title && title !== task.title) send({ type: 'task/rename', id: task.id, title });
    setEditing(false);
  };

  return (
    <li
      class="task"
      data-id={task.id}
      data-active={active || undefined}
      data-drop={dropAbove ? 'above' : dropBelow ? 'below' : undefined}
      draggable={!editing}
      onDragStart={e => { e.dataTransfer!.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <input
        type="checkbox"
        class="check"
        aria-label={`「${task.title}」を終える`}
        onChange={() => send({ type: 'task/setDone', id: task.id, done: true })}
      />
      {editing ? (
        <input
          ref={input}
          class="task-edit"
          defaultValue={task.title}
          maxLength={200}
          aria-label="タスク名"
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
          }}
        />
      ) : (
        <button
          class="task-title"
          aria-pressed={active}
          title={active ? 'いま向き合っているタスク(もう一度押すと外す)' : 'このタスクに向き合う'}
          onClick={() => send({ type: 'task/activate', id: active ? null : task.id })}
        >
          {task.title}
        </button>
      )}
      <button
        class="task-remove task-rename"
        aria-label={`「${task.title}」の名前を変える`}
        title="名前を変える"
        onClick={() => { setEditing(true); requestAnimationFrame(() => input.current?.select()); }}
      >✎</button>
      <button class="task-remove task-delete" title="削除" aria-label={`「${task.title}」を削除`} onClick={onRemove}>×</button>
    </li>
  );
}

/* ---------- タイマー ---------- */

const REST_LINE = { short: 'ひと息いれる', long: 'しっかり休む' } as const;

export function Stage({ data }: { data: Data }) {
  const now = useNow(data.run?.open != null);
  const view = timerView(data, now);
  const { status, kind } = view;
  const cycle = cyclePosition(data);
  const active = data.tasks.find(t => t.id === data.activeTaskId);
  const isBreak = kind !== 'focus';
  const sound = data.settings.sound;

  return (
    <main class="stage">
      <div class="stage-inner">
        <div class="stage-top">
          <span class="phase" id="phase">{status === 'paused' ? `${KIND_LABEL[kind]}・一時停止中` : status === 'idle' ? `次は${KIND_LABEL[kind]}` : KIND_LABEL[kind]}</span>
          <span class="pips" id="cycle" title={`長休憩まで ${cycle.done} / ${cycle.every}`} aria-label={`長休憩まで ${cycle.done} / ${cycle.every}`}>
            {Array.from({ length: cycle.every }, (_, i) => <i key={i} data-on={i < cycle.done || undefined} />)}
          </span>
        </div>

        <h1 class="subject" id="subject" data-empty={!isBreak && !active || undefined}>
          {isBreak ? REST_LINE[kind] : active ? active.title : 'タスクを決めずに集中'}
        </h1>

        {/* 数字と、その下で伸びる線を一つの塊にする(線の幅を数字の幅に揃えるため) */}
        <div class="dial">
          <div class="clock num" id="clock" aria-live="off">{fmtClock(view.remainingMs)}</div>
          <div
            class="progress"
            id="progress"
            role="progressbar"
            aria-label="経過"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(view.progress * 100)}
          >
            <i style={{ width: `${view.progress * 100}%` }} />
          </div>
        </div>

        <div class="controls recede-still">
          <button class="primary" id="toggle" title="Space" onClick={() => send({ type: 'timer/toggle' })}>
            {status === 'running' ? '一時停止' : status === 'paused' ? '再開' : isBreak ? '休憩を始める' : '始める'}
          </button>
          {status !== 'idle' && (
            <button class="secondary" id="extend" onClick={() => send({ type: 'timer/extend', minutes: 5 })}>5分のばす</button>
          )}
          {(status !== 'idle' || isBreak) && (
            <button class="secondary" id="stop" onClick={() => send({ type: 'timer/stop' })}>
              {!isBreak ? '中断する' : status === 'idle' ? '休憩を飛ばす' : '休憩を終える'}
            </button>
          )}
        </div>
      </div>

      <div class="stage-foot recede">
        <button
          class="sound-toggle"
          id="soundToggle"
          aria-pressed={sound.on}
          title="タイマーが動いている間だけ鳴ります"
          onClick={() => send({ type: 'settings/update', patch: { sound: { on: !sound.on } } })}
        >
          環境音 {sound.on ? soundLabel(isBreak ? sound.rest : sound.focus) : 'オフ'}
        </button>
      </div>
    </main>
  );
}

/* ---------- 今日の帯 ---------- */

export function DayRail({ data }: { data: Data }) {
  const now = useNow(true, 5000);
  const today = startOfDay(now);
  const live = liveSession(data, now);
  const sessions = live ? [...data.sessions, live] : data.sessions;
  const blocks = dayBlocks(sessions, today, live?.id);
  const totals = dayTotals(sessions, today);

  return (
    <aside class="rail recede" aria-label="今日">
      <div class="rail-head">
        <span class="rail-title">今日</span>
        <span class="rail-total num" id="todayFocus">{fmtDur(totals.focusMs)}</span>
        <span class="rail-sub" id="todayPomos">完走 {totals.pomos} 回</span>
      </div>
      <div class="rail-scroll">
        <DayStrip blocks={blocks} dayStart={today} tasks={data.tasks} hours={hourRange(blocks, today, now)} now={now} hourPx={72} />
      </div>
    </aside>
  );
}
