// 保存してある事実(区間の列)から、画面や書き出しが必要とするものを導く。すべて純粋。
import {
  KIND_LABEL, elapsedMs, plannedMsFor, spansMs,
  type Data, type Kind, type Session, type Span, type Task
} from './model.ts';

/* ---------- 時刻と表記 ---------- */

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ローカル日付で n 日ずらした 0:00(24 時間決め打ちにしない) */
export function addDays(t: number, n: number): number {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * その日の中での、時計の針の位置(0〜24 時)。0 時からの経過時間ではなく、
 * 実際の時計の表示から求める。夏時間の切り替え日(23 / 25 時間)でも、
 * 23:30 は 23.5 の位置になる(経過時間で数えると 24.5 になり、帯がずれる)。
 */
export function wallHours(t: number, dayStart: number): number {
  if (t <= dayStart) return 0;
  if (t >= addDays(dayStart, 1)) return 24;
  const d = new Date(t);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / 3_600_000;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** 残り時間 "24:59"。切り上げるので、0:00 が出るのは本当に尽きたときだけ。 */
export function fmtClock(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${p2(Math.floor(sec / 60))}:${p2(sec % 60)}`;
}

/** 長さ "1時間20分" / "45分" */
export function fmtDur(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}分`;
  return min % 60 === 0 ? `${min / 60}時間` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

export const fmtTime = (t: number): string => {
  const d = new Date(t);
  return `${d.getHours()}:${p2(d.getMinutes())}`;
};

export function fmtStamp(t: number | null): string {
  if (t === null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export function fmtDay(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

/* ---------- タイマー ---------- */

export interface TimerView {
  status: 'idle' | 'running' | 'paused';
  kind: Kind;
  plannedMs: number;
  remainingMs: number;
  /** 経過の割合 0〜1 */
  progress: number;
}

export function timerView(data: Data, now: number): TimerView {
  const run = data.run;
  if (!run) {
    const plannedMs = plannedMsFor(data.settings, data.next);
    return { status: 'idle', kind: data.next, plannedMs, remainingMs: plannedMs, progress: 0 };
  }
  const elapsed = Math.min(run.plannedMs, elapsedMs(run, now));
  return {
    status: run.open ? 'running' : 'paused',
    kind: run.kind,
    plannedMs: run.plannedMs,
    remainingMs: run.plannedMs - elapsed,
    progress: elapsed / run.plannedMs
  };
}

/** 長休憩までの位置(done 個目まで済み。every 個で長休憩)。 */
export function cyclePosition(data: Data): { done: number; every: number } {
  const every = data.settings.longEvery;
  const mod = data.streak % every;
  // ちょうど一巡した直後(長休憩の前〜最中)は満杯で見せる
  const full = mod === 0 && data.streak > 0 && (data.next === 'long' || data.run?.kind === 'long');
  return { done: full ? every : mod, every };
}

/* ---------- 記録 ---------- */

export const sessionStart = (s: Session): number => s.spans[0].start;
export const sessionEnd = (s: Session): number => s.spans[s.spans.length - 1].end;
export const sessionMs = (s: Session): number => spansMs(s.spans);

/** 進行中のセッションを、いま時点までの記録として見る(帯や今日の合計に混ぜるため)。 */
export function liveSession(data: Data, now: number): Session | null {
  const run = data.run;
  if (!run) return null;
  const spans = run.open && now > run.open.start ? [...run.spans, { ...run.open, end: now }] : run.spans;
  if (spans.length === 0) return null;
  return { id: run.id, kind: run.kind, plannedSec: Math.round(run.plannedMs / 1000), completed: false, spans };
}

/** タスクごとの時間(長い順)。 */
export function taskShares(s: Session): { taskId: string | null; ms: number }[] {
  const by = new Map<string | null, number>();
  for (const sp of s.spans) by.set(sp.taskId, (by.get(sp.taskId) ?? 0) + sp.end - sp.start);
  return [...by].map(([taskId, ms]) => ({ taskId, ms })).sort((a, b) => b.ms - a.ms);
}

/** その記録でいちばん長く向き合ったタスク */
export const primaryTaskId = (s: Session): string | null => taskShares(s)[0]?.taskId ?? null;

export function taskTitle(tasks: readonly Task[], id: string | null): string {
  if (id === null) return 'タスクなし';
  return tasks.find(t => t.id === id)?.title || '(無題)';
}

export function sessionLabel(tasks: readonly Task[], s: Session): string {
  return s.kind === 'focus' ? taskTitle(tasks, primaryTaskId(s)) : KIND_LABEL[s.kind];
}

export interface TaskTotal {
  ms: number;
  /** そのタスクが主役だった完走フォーカスの数 */
  pomos: number;
}

export function taskTotals(sessions: readonly Session[]): Map<string, TaskTotal> {
  const out = new Map<string, TaskTotal>();
  const at = (id: string): TaskTotal => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { ms: 0, pomos: 0 }));
    return v;
  };
  for (const s of sessions) {
    if (s.kind !== 'focus') continue;
    for (const sp of s.spans) if (sp.taskId !== null) at(sp.taskId).ms += sp.end - sp.start;
    const primary = primaryTaskId(s);
    if (s.completed && primary !== null) at(primary).pomos++;
  }
  return out;
}

/* ---------- 一日の帯 ---------- */

export interface Block {
  sessionId: string;
  kind: Kind;
  taskId: string | null;
  start: number;
  end: number;
  live: boolean;
}

/** [dayStart, 翌 0:00) に重なる区間を、その日の枠に切って並べる。 */
export function dayBlocks(sessions: readonly Session[], dayStart: number, liveId: string | null = null): Block[] {
  const dayEnd = addDays(dayStart, 1);
  const out: Block[] = [];
  for (const s of sessions) {
    if (sessionEnd(s) <= dayStart || sessionStart(s) >= dayEnd) continue;
    for (const sp of s.spans) {
      const start = Math.max(sp.start, dayStart);
      const end = Math.min(sp.end, dayEnd);
      if (end > start) out.push({ sessionId: s.id, kind: s.kind, taskId: sp.taskId, start, end, live: s.id === liveId });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** その日のフォーカス時間と、その日に始めて完走したポモドーロの数。 */
export function dayTotals(sessions: readonly Session[], dayStart: number): { focusMs: number; pomos: number } {
  const dayEnd = addDays(dayStart, 1);
  let focusMs = 0, pomos = 0;
  for (const s of sessions) {
    if (s.kind !== 'focus') continue;
    for (const sp of s.spans) focusMs += Math.max(0, Math.min(sp.end, dayEnd) - Math.max(sp.start, dayStart));
    const st = sessionStart(s);
    if (s.completed && st >= dayStart && st < dayEnd) pomos++;
  }
  return { focusMs, pomos };
}

/* ---------- 統計 ---------- */

export interface Stats {
  start: number;
  end: number;
  days: { start: number; focusMs: number; pomos: number }[];
  focusMs: number;
  pomos: number;
  /** 始めたフォーカスの数(中断を含む) */
  started: number;
  completionRate: number | null;
  activeDays: number;
  /** 時台ごとのフォーカス時間 */
  hours: number[];
  tasks: { taskId: string | null; ms: number }[];
}

/**
 * end を含む直近 days 日を集計する。時間は区間を日・時台の境目で割って積む。
 * liveId は進行中のセッション。時間には入れるが、完走率の分母(始めた数)には入れない。
 */
export function summarize(sessions: readonly Session[], end: number, days: number, liveId: string | null = null): Stats {
  const n = Math.max(1, Math.floor(days));
  const rangeStart = addDays(end, -(n - 1));
  const rangeEnd = addDays(end, 1);
  const dayList = Array.from({ length: n }, (_, i) => ({ start: addDays(rangeStart, i), focusMs: 0, pomos: 0 }));
  const dayIndex = new Map(dayList.map((d, i) => [d.start, i]));
  const hours = new Array<number>(24).fill(0);
  const taskMs = new Map<string | null, number>();
  let focusMs = 0, pomos = 0, started = 0;

  for (const s of sessions) {
    if (s.kind !== 'focus') continue;
    for (const sp of s.spans) {
      let cur = Math.max(sp.start, rangeStart);
      const stop = Math.min(sp.end, rangeEnd);
      while (cur < stop) {
        const d = new Date(cur);
        d.setMinutes(60, 0, 0); // 次の時台の頭(日付の境目も必ずここを通る)
        const cut = Math.min(d.getTime(), stop);
        const ms = cut - cur;
        hours[new Date(cur).getHours()] += ms;
        const row = dayList[dayIndex.get(startOfDay(cur)) ?? -1];
        if (row) row.focusMs += ms;
        focusMs += ms;
        taskMs.set(sp.taskId, (taskMs.get(sp.taskId) ?? 0) + ms);
        cur = cut;
      }
    }
    const row = dayList[dayIndex.get(startOfDay(sessionStart(s))) ?? -1];
    if (!row || s.id === liveId) continue;
    started++;
    if (s.completed) { pomos++; row.pomos++; }
  }

  return {
    start: rangeStart,
    end: rangeEnd,
    days: dayList,
    focusMs,
    pomos,
    started,
    completionRate: started ? pomos / started : null,
    activeDays: dayList.filter(d => d.focusMs > 0).length,
    hours,
    tasks: [...taskMs].map(([taskId, ms]) => ({ taskId, ms })).filter(t => t.ms > 0).sort((a, b) => b.ms - a.ms)
  };
}

/* ---------- 書き出し ---------- */

function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // 表計算ソフトに数式として解釈されうる先頭文字は、テキストとして扱わせる
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 先頭の BOM は Excel に UTF-8 と認識させるため
const toCsv = (rows: unknown[][]): string => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\n');
const minutes = (ms: number): number => Math.round(ms / 6000) / 10;
const spanText = (sp: Span): string => `${fmtStamp(sp.start)}〜${fmtStamp(sp.end)}`;

export function sessionsCsv(data: Data): string {
  const rows: unknown[][] = [['ID', '種別', '開始', '終了', '実働(分)', '予定(分)', '完走', '中断回数', '実働区間', 'タスク内訳']];
  for (const s of data.sessions) {
    // 途切れ(一時停止・スリープ)の数。タスクの切り替えは途切れではない。
    const breaks = s.spans.filter((sp, i) => i > 0 && sp.start > s.spans[i - 1].end).length;
    rows.push([
      s.id, KIND_LABEL[s.kind], fmtStamp(sessionStart(s)), fmtStamp(sessionEnd(s)),
      minutes(sessionMs(s)), minutes(s.plannedSec * 1000), s.completed ? 'はい' : 'いいえ', breaks,
      s.spans.map(spanText).join('; '),
      s.kind === 'focus' ? taskShares(s).map(t => `${taskTitle(data.tasks, t.taskId)}: ${minutes(t.ms)}分`).join('; ') : ''
    ]);
  }
  return toCsv(rows);
}

export function tasksCsv(data: Data): string {
  const totals = taskTotals(data.sessions);
  const rows: unknown[][] = [['ID', 'タイトル', '状態', '作成日時', '完了日時', 'ポモドーロ数(完走)', '合計フォーカス(分)']];
  for (const t of data.tasks) {
    const total = totals.get(t.id) ?? { ms: 0, pomos: 0 };
    rows.push([
      t.id, t.title, t.deletedAt !== null ? '削除済み' : t.doneAt !== null ? '完了' : '未完了',
      fmtStamp(t.createdAt || null), fmtStamp(t.doneAt), total.pomos, minutes(total.ms)
    ]);
  }
  return toCsv(rows);
}
