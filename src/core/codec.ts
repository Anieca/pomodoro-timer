// 外から来たもの(保存ファイル・インポート)を、妥当な Data に読み解く唯一の入口。
// v2 はそのまま検め、v1(sessions / pomodoros 形式)は区間の列へ組み直す。
// 何を渡しても投げず、冪等(decode(decode(x)) は decode(x) と同じ)。
import {
  DEFAULT_SETTINGS, KINDS, LIMITS, TITLE_MAX, emptyData, isOpenTask,
  type Data, type Kind, type Run, type Session, type Settings, type Span, type Task
} from './model.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX_TIME = 8.64e15;

/** 有効な時刻(epoch ms)か。数値と ISO 文字列を受ける。 */
export function time(v: unknown): number | null {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && Math.abs(t) <= MAX_TIME ? Math.round(t) : null;
}

export function clampInt(v: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const kind = (v: unknown): Kind | null => (KINDS.includes(v as Kind) ? (v as Kind) : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const soundName = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length <= 255 ? v : fallback);

export const cleanTitle = (v: unknown): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

export function decodeSettings(raw: unknown): Settings {
  const o = obj(raw);
  const d = DEFAULT_SETTINGS;
  const s = obj(o.sound);
  return {
    focusMin: clampInt(o.focusMin, LIMITS.focusMin, d.focusMin),
    shortMin: clampInt(o.shortMin, LIMITS.shortMin, d.shortMin),
    longMin: clampInt(o.longMin, LIMITS.longMin, d.longMin),
    longEvery: clampInt(o.longEvery, LIMITS.longEvery, d.longEvery),
    autoBreak: bool(o.autoBreak, d.autoBreak),
    autoFocus: bool(o.autoFocus, d.autoFocus),
    chime: bool(o.chime, d.chime),
    sound: {
      on: bool(s.on, d.sound.on),
      focus: soundName(s.focus, d.sound.focus),
      rest: soundName(s.rest, d.sound.rest),
      volume: clampInt(s.volume, [0, 100], d.sound.volume)
    }
  };
}

/** 区間の列を、時刻順・重なりなし・正の長さに揃える。 */
export function decodeSpans(raw: unknown, knownTask: (id: string) => boolean): Span[] {
  const spans: Span[] = [];
  for (const v of arr(raw)) {
    const o = obj(v);
    const start = time(o.start);
    const end = time(o.end);
    if (start === null || end === null || end <= start) continue;
    const taskId = id(o.taskId);
    spans.push({ start, end, taskId: taskId && knownTask(taskId) ? taskId : null });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    const start = prev ? Math.max(s.start, prev.end) : s.start;
    if (s.end <= start) continue;
    if (prev && prev.end === start && prev.taskId === s.taskId) prev.end = s.end;
    else out.push({ ...s, start });
  }
  return out;
}

export function decodeSession(raw: unknown, knownTask: (id: string) => boolean): Session | null {
  const o = obj(raw);
  const sid = id(o.id);
  const k = kind(o.kind);
  if (!sid || !k) return null;
  const spans = decodeSpans(o.spans, k === 'focus' ? knownTask : () => false);
  if (spans.length === 0) return null;
  const worked = Math.round(spans.reduce((n, s) => n + s.end - s.start, 0) / 1000);
  return {
    id: sid,
    kind: k,
    plannedSec: clampInt(o.plannedSec, [1, 24 * 3600], Math.max(1, worked)),
    completed: bool(o.completed, false),
    spans
  };
}

function decodeTask(raw: unknown): Task | null {
  const o = obj(raw);
  const tid = id(o.id);
  if (!tid) return null;
  return {
    id: tid,
    title: cleanTitle(o.title),
    createdAt: time(o.createdAt) ?? 0,
    doneAt: o.doneAt == null ? null : time(o.doneAt),
    deletedAt: o.deletedAt == null ? null : time(o.deletedAt)
  };
}

function decodeRun(raw: unknown, knownTask: (id: string) => boolean): Run | null {
  if (raw == null) return null;
  const o = obj(raw);
  const rid = id(o.id);
  const k = kind(o.kind);
  if (!rid || !k) return null;
  const known = k === 'focus' ? knownTask : () => false;
  const spans = decodeSpans(o.spans, known);
  const last = spans.length ? spans[spans.length - 1].end : null;
  const op = o.open == null ? null : obj(o.open);
  const openStart = op ? time(op.start) : null;
  const openTask = op ? id(op.taskId) : null;
  const open = openStart !== null && (last === null || openStart >= last)
    ? { start: openStart, taskId: openTask && known(openTask) ? openTask : null }
    : null;
  return {
    id: rid,
    kind: k,
    plannedMs: clampInt(o.plannedMs, [1000, 24 * 3600_000], 25 * 60_000),
    spans,
    open,
    seenAt: time(o.seenAt) ?? open?.start ?? last ?? 0
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function decodeV2(o: Obj): Data {
  const tasks = uniqueById(arr(o.tasks).map(decodeTask).filter((t): t is Task => t !== null));
  const ids = new Set(tasks.map(t => t.id));
  const known = (tid: string) => ids.has(tid);
  const sessions = uniqueById(
    arr(o.sessions).map(s => decodeSession(s, known)).filter((s): s is Session => s !== null)
  ).sort((a, b) => a.spans[0].start - b.spans[0].start);
  const active = tasks.find(t => t.id === o.activeTaskId);
  return {
    version: 2,
    tasks,
    sessions,
    settings: decodeSettings(o.settings),
    activeTaskId: active && isOpenTask(active) ? active.id : null,
    next: kind(o.next) ?? 'focus',
    streak: clampInt(o.streak, [0, 1e9], 0),
    run: decodeRun(o.run, known)
  };
}

/* ---------- v1 ---------- */

const V1_KIND: Record<string, Kind> = { work: 'focus', short: 'short', long: 'long' };

/** v1 の区間(壁時計)にタスク別の時間(秒の列)を順に割り当てて、区間の列にする。 */
function v1Spans(s: Obj, knownTask: (id: string) => boolean): Span[] {
  const start = time(s.startedAt);
  const end = time(s.endedAt);
  const durMs = typeof s.durationSec === 'number' && Number.isFinite(s.durationSec) && s.durationSec > 0
    ? s.durationSec * 1000 : 0;
  let ivs = arr(s.intervals)
    .map(v => ({ start: time(obj(v).startedAt), end: time(obj(v).endedAt) }))
    .filter((v): v is { start: number; end: number } => v.start !== null && v.end !== null && v.end > v.start)
    .sort((a, b) => a.start - b.start);
  if (ivs.length === 0) {
    // 区間を持たない旧記録。一時停止は分からないので、実働の長さぶんを一続きに置く。
    const from = start ?? (end !== null ? end - durMs : null);
    if (from === null || durMs <= 0) return [];
    ivs = [{ start: from, end: from + durMs }];
  }
  const taskIds = arr(s.taskIds).map(id).filter((v): v is string => v !== null);
  let parts = arr(s.taskTimes)
    .map(v => ({ taskId: id(obj(v).taskId), ms: Number(obj(v).durationSec) * 1000 }))
    .filter(p => Number.isFinite(p.ms) && p.ms > 0);
  if (parts.length === 0) parts = [{ taskId: taskIds.length === 1 ? taskIds[0] : null, ms: Infinity }];
  // 最後の内訳は残り全部を受ける(丸め誤差で末尾が宙に浮かないように)
  parts[parts.length - 1].ms = Infinity;

  const out: Span[] = [];
  let pi = 0;
  let left = parts[0].ms;
  for (const iv of ivs) {
    let cur = iv.start;
    while (cur < iv.end) {
      const take = Math.min(iv.end - cur, left);
      const stop = Math.round(cur + take);
      const taskId = parts[pi].taskId;
      if (stop > cur) out.push({ start: cur, end: stop, taskId: taskId && knownTask(taskId) ? taskId : null });
      cur = stop;
      left -= take;
      if (left <= 0.5 && pi < parts.length - 1) { pi++; left = parts[pi].ms; }
    }
  }
  return decodeSpans(out, knownTask);
}

function decodeV1(o: Obj): Data {
  const tasks = uniqueById(arr(o.tasks).map((v): Task | null => {
    const t = obj(v);
    const tid = id(t.id);
    if (!tid) return null;
    const createdAt = time(t.createdAt) ?? 0;
    return {
      id: tid,
      title: cleanTitle(t.title),
      createdAt,
      doneAt: t.completed ? time(t.completedAt) ?? createdAt : null,
      deletedAt: null
    };
  }).filter((t): t is Task => t !== null));
  const ids = new Set(tasks.map(t => t.id));
  const known = (tid: string) => ids.has(tid);

  const st = obj(o.settings);
  const wn = obj(st.whiteNoise);
  const settings = decodeSettings({
    focusMin: st.workMin, shortMin: st.shortMin, longMin: st.longMin, longEvery: st.longEvery,
    autoBreak: !!st.autoStartBreak, autoFocus: !!st.autoStartWork,
    sound: { on: 'enabled' in wn ? !!wn.enabled : undefined, focus: wn.file, rest: wn.breakFile, volume: wn.volume }
  });

  const rawSessions = Array.isArray(o.sessions) ? o.sessions : arr(o.pomodoros);
  const sessions: Session[] = [];
  rawSessions.forEach((v, i) => {
    const s = obj(v);
    const k = V1_KIND[String(s.mode ?? 'work')] ?? 'focus';
    const spans = v1Spans(s, k === 'focus' ? known : () => false);
    if (spans.length === 0) return;
    const worked = Math.round(spans.reduce((n, sp) => n + sp.end - sp.start, 0) / 1000);
    const completed = !!s.completed;
    const setting = (k === 'focus' ? settings.focusMin : k === 'short' ? settings.shortMin : settings.longMin) * 60;
    sessions.push({
      id: id(s.id) ?? `v1-${i}-${spans[0].start.toString(36)}`,
      kind: k,
      plannedSec: Math.max(1, completed ? worked : Math.max(worked, setting)),
      completed,
      spans
    });
  });

  const timer = obj(o.timer);
  return decodeV2({
    version: 2,
    tasks,
    sessions,
    settings,
    activeTaskId: o.selectedTaskId,
    next: V1_KIND[String(timer.mode)] ?? 'focus',
    streak: timer.cycle,
    run: null
  });
}

const isV1 = (o: Obj): boolean =>
  o.version !== 2 && (Array.isArray(o.pomodoros) || 'selectedTaskId' in o || 'timer' in o ||
    arr(o.sessions).some(s => 'mode' in obj(s)) || arr(o.tasks).some(t => 'completed' in obj(t)) ||
    'workMin' in obj(o.settings));

/** 何でも受けて妥当な Data を返す。 */
export function decode(raw: unknown): Data {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyData();
  const o = raw as Obj;
  return isV1(o) ? decodeV1(o) : decodeV2(o);
}

export type ImportResult =
  | { ok: true; data: Data; counts: { tasks: number; sessions: number } }
  | { ok: false; error: string };

/** インポートするファイルの中身。このアプリのデータと分かる形だけを通す(`{}` で空に置き換えない)。 */
export function parseImport(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: 'JSON として読み込めませんでした' };
  }
  const o = obj(raw);
  const looksLikeData = ['tasks', 'sessions', 'pomodoros'].some(k => Array.isArray(o[k]));
  if (!looksLikeData) return { ok: false, error: 'このアプリのデータではありません(タスクや記録が見つかりません)' };
  // 進行中のセッションは持ち込まない(書き出した時点のもので、いまの時計と合わない)
  const data = { ...decode(raw), run: null };
  return {
    ok: true,
    data,
    counts: { tasks: data.tasks.filter(t => t.deletedAt === null).length, sessions: data.sessions.length }
  };
}
