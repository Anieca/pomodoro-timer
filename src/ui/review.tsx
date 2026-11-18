// 「ふりかえり」: ある一日の帯と記録、そして直近の傾向。記録はここで直せる。
import { useState } from 'preact/hooks';
import {
  addDays, dayBlocks, dayTotals, fmtDay, fmtDur, fmtTime, liveSession, primaryTaskId, sessionEnd, sessionLabel,
  sessionMs, sessionStart, startOfDay, summarize, taskTitle
} from '../core/derive.ts';
import { isOpenTask, type Data, type Session } from '../core/model.ts';
import { DayStrip, hourRange } from './strip.tsx';
import { hostNow, send, toast, useNow } from './store.ts';

interface Props {
  data: Data;
  day: number;
  onDay(day: number): void;
}

export function Review({ data, day, onDay }: Props) {
  const today = startOfDay(hostNow());
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState(7);

  // 進行中のセッションも帯と合計には入れる(「いま」の今日の帯と同じ数字になるように)
  const now = useNow(data.run?.open != null, 5000);
  const live = liveSession(data, now);
  const all = live ? [...data.sessions, live] : data.sessions;
  const blocks = dayBlocks(all, day, live?.id);
  const totals = dayTotals(all, day);
  const dayEnd = addDays(day, 1);
  const sessions = all.filter(s => sessionEnd(s) > day && sessionStart(s) < dayEnd);
  const year = new Date(day).getFullYear();

  const pick = (id: string): void => {
    setSelected(id);
    document.querySelector(`[data-session="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div class="review">
      <section class="review-day" aria-label="一日">
        <div class="day-nav">
          <button class="quiet" id="dayPrev" aria-label="前の日" onClick={() => onDay(addDays(day, -1))}>‹</button>
          <h1 id="dayLabel">{year !== new Date(today).getFullYear() ? `${year}年` : ''}{fmtDay(day)}</h1>
          <button class="quiet" id="dayNext" aria-label="次の日" disabled={day >= today} onClick={() => onDay(addDays(day, 1))}>›</button>
          {day !== today && <button class="quiet" id="dayToday" onClick={() => onDay(today)}>今日へ</button>}
        </div>
        <p class="day-sum" id="daySum">
          {totals.focusMs > 0 ? <>フォーカス <b class="num">{fmtDur(totals.focusMs)}</b>、完走 <b class="num">{totals.pomos}</b> 回</> : 'この日の記録はありません'}
        </p>
        <div class="day-body">
          <div class="day-strip">
            <DayStrip
              blocks={blocks}
              dayStart={day}
              tasks={data.tasks}
              hours={hourRange(blocks, day)}
              now={day === today ? now : undefined}
              hourPx={64}
              selectedId={selected}
              onPick={pick}
            />
          </div>
          <ol class="log" id="log">
            {sessions.map(s => (
              <LogRow key={s.id} data={data} session={s} live={s.id === live?.id} selected={s.id === selected} onSelect={() => setSelected(s.id)} />
            ))}
          </ol>
        </div>
      </section>

      <Trends data={data} sessions={all} liveId={live?.id ?? null} today={today} range={range} onRange={setRange} onDay={onDay} day={day} />
    </div>
  );
}

function LogRow({ data, session: s, live, selected, onSelect }: { data: Data; session: Session; live: boolean; selected: boolean; onSelect(): void }) {
  const primary = primaryTaskId(s);
  const mixed = new Set(s.spans.map(sp => sp.taskId)).size > 1;
  // 付け替え先: 未完了のタスクと、いま付いているタスク(完了・削除済みでも選択肢に残す)
  const options = data.tasks.filter(t => isOpenTask(t) || t.id === primary);

  const remove = (): void => {
    send({ type: 'session/delete', id: s.id });
    toast('記録を削除しました', { label: '元に戻す', run: () => send({ type: 'session/put', session: s }) });
  };

  return (
    <li class="log-row" data-session={s.id} data-kind={s.kind} data-selected={selected || undefined} onClick={onSelect}>
      <span class="log-time num">{fmtTime(sessionStart(s))}–{fmtTime(sessionEnd(s))}</span>
      <span class="log-main">
        {live ? (
          <span class="log-rest">{sessionLabel(data.tasks, s)}</span>
        ) : s.kind === 'focus' ? (
          <select
            class="log-task"
            aria-label="この記録のタスク"
            value={primary ?? ''}
            onChange={e => send({ type: 'session/assign', id: s.id, taskId: e.currentTarget.value || null })}
          >
            <option value="">タスクなし</option>
            {options.map(t => <option value={t.id} key={t.id}>{t.title}</option>)}
          </select>
        ) : (
          <span class="log-rest">{sessionLabel(data.tasks, s)}</span>
        )}
        {mixed && <span class="log-note" title={s.spans.map(sp => `${taskTitle(data.tasks, sp.taskId)} ${fmtDur(sp.end - sp.start)}`).join('\n')}>ほか</span>}
      </span>
      <span class="log-dur num">{fmtDur(sessionMs(s))}</span>
      <span class="log-state">{live ? '進行中' : s.kind !== 'focus' ? '' : s.completed ? '完走' : '中断'}</span>
      {live ? <span /> : <button class="task-remove task-delete" aria-label="この記録を削除" onClick={e => { e.stopPropagation(); remove(); }}>×</button>}
    </li>
  );
}

const RANGES = [7, 30, 90];

function Trends({ data, sessions, liveId, today, range, onRange, onDay, day }: { data: Data; sessions: Session[]; liveId: string | null; today: number; range: number; onRange(n: number): void; onDay(d: number): void; day: number }) {
  const st = summarize(sessions, today, range, liveId);
  const maxDay = Math.max(1, ...st.days.map(d => d.focusMs));
  const maxHour = Math.max(1, ...st.hours);
  const maxTask = Math.max(1, ...st.tasks.map(t => t.ms));

  return (
    <section class="trends" aria-label="傾向">
      <div class="trends-head">
        <h2>直近の傾向</h2>
        <div class="seg" id="range" role="group" aria-label="期間">
          {RANGES.map(n => <button key={n} aria-pressed={range === n} onClick={() => onRange(n)}>{n}日</button>)}
        </div>
      </div>

      <dl class="figures" id="figures">
        <div><dt>フォーカス</dt><dd class="num">{fmtDur(st.focusMs)}</dd></div>
        <div><dt>完走</dt><dd class="num">{st.pomos}<small>回</small></dd></div>
        <div><dt>完走率</dt><dd class="num">{st.completionRate === null ? '–' : <>{Math.round(st.completionRate * 100)}<small>%</small></>}</dd></div>
      </dl>

      <h3>日ごと</h3>
      <div class="bars" id="dayBars" data-dense={range > 30 || undefined}>
        {st.days.map(d => (
          <button
            key={d.start}
            class="bar-col"
            aria-pressed={d.start === day}
            title={`${fmtDay(d.start)}  ${fmtDur(d.focusMs)}、完走 ${d.pomos} 回`}
            onClick={() => onDay(d.start)}
          >
            <i style={{ height: `${(d.focusMs / maxDay) * 100}%` }} />
          </button>
        ))}
      </div>
      <div class="bars-axis num"><span>{fmtDay(st.days[0].start)}</span><span>今日</span></div>

      <h3>時間帯</h3>
      <div class="bars hours" id="hourBars">
        {st.hours.map((ms, h) => (
          <div key={h} class="bar-col" title={`${h}時台  ${fmtDur(ms)}`}><i style={{ height: `${(ms / maxHour) * 100}%` }} /></div>
        ))}
      </div>
      <div class="bars-axis num"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>

      <h3>タスクごと</h3>
      {st.tasks.length === 0 ? (
        <p class="empty">この期間のフォーカスはまだありません。</p>
      ) : (
        <ul class="shares" id="taskShares">
          {st.tasks.slice(0, 8).map(t => (
            <li key={t.taskId ?? ''}>
              <span class="share-name">{taskTitle(data.tasks, t.taskId)}</span>
              <span class="share-bar"><i style={{ width: `${(t.ms / maxTask) * 100}%` }} /></span>
              <span class="share-val num">{fmtDur(t.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
