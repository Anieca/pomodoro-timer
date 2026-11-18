// 保存データの形。時刻はすべて epoch ミリ秒。
// 記録が持つ事実は「区間の列」だけで、開始・終了・実働・タスク別の時間はそこから導く。

export type Kind = 'focus' | 'short' | 'long';
export const KINDS: readonly Kind[] = ['focus', 'short', 'long'];
export const KIND_LABEL: Record<Kind, string> = { focus: 'フォーカス', short: '小休憩', long: '長休憩' };

/** 実際に動いていた一続きの時間。taskId はそのとき向き合っていたタスク(休憩は常に null)。 */
export interface Span {
  start: number;
  end: number;
  taskId: string | null;
}

export interface Session {
  id: string;
  kind: Kind;
  /** 予定していた長さ(延長を含む) */
  plannedSec: number;
  /** 予定の長さを最後までやり切ったか */
  completed: boolean;
  /** 時刻順・重なりなし・1件以上 */
  spans: Span[];
}

export interface Task {
  id: string;
  title: string;
  createdAt: number;
  doneAt: number | null;
  /** 削除は印だけ。記録はタスクを指したまま残り、取り消しは印を外すだけで済む。 */
  deletedAt: number | null;
}

export interface SoundSettings {
  on: boolean;
  /** フォーカス中の音源(ファイル名) */
  focus: string;
  /** 休憩中の音源(ファイル名) */
  rest: string;
  volume: number;
}

export interface Settings {
  focusMin: number;
  shortMin: number;
  longMin: number;
  longEvery: number;
  autoBreak: boolean;
  autoFocus: boolean;
  chime: boolean;
  sound: SoundSettings;
}

/** 進行中のセッション。終了予定時刻は持たない(経過 = 区間の合計)。 */
export interface Run {
  id: string;
  kind: Kind;
  plannedMs: number;
  /** 閉じた区間 */
  spans: Span[];
  /** 開いている区間。null なら一時停止中。 */
  open: { start: number; taskId: string | null } | null;
  /** 最後に動いているのを確かめた時刻(強制終了からの復旧用) */
  seenAt: number;
}

export interface Data {
  version: 2;
  tasks: Task[];
  sessions: Session[];
  settings: Settings;
  /** いま向き合っているタスク(未完了・未削除のものだけ) */
  activeTaskId: string | null;
  /** 次に始まるもの */
  next: Kind;
  /** 完走したフォーカスの通算(長休憩の位置を決める) */
  streak: number;
  run: Run | null;
}

export const DEFAULT_SETTINGS: Settings = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoBreak: true,
  autoFocus: false,
  chime: true,
  sound: { on: true, focus: 'brown-noise.wav', rest: 'pink-noise.wav', volume: 40 }
};

/** 数値設定の許容範囲。検証と設定画面の両方がこれを使う。 */
export const LIMITS = {
  focusMin: [1, 180],
  shortMin: [1, 60],
  longMin: [1, 120],
  longEvery: [2, 12]
} as const;

export const TITLE_MAX = 200;
/** これより短い実働しかないセッションは記録しない */
export const MIN_RECORD_MS = 60_000;
/** 延長を含めた予定の上限 */
export const MAX_PLANNED_MS = 4 * 60 * 60_000;

export const emptyData = (): Data => ({
  version: 2,
  tasks: [],
  sessions: [],
  settings: structuredClone(DEFAULT_SETTINGS),
  activeTaskId: null,
  next: 'focus',
  streak: 0,
  run: null
});

export const plannedMsFor = (settings: Settings, kind: Kind): number =>
  (kind === 'focus' ? settings.focusMin : kind === 'short' ? settings.shortMin : settings.longMin) * 60_000;

export const isOpenTask = (t: Task): boolean => t.doneAt === null && t.deletedAt === null;

export const spansMs = (spans: readonly Span[]): number => spans.reduce((n, s) => n + (s.end - s.start), 0);

/** 進行中セッションの実働(一時停止・スリープを含まない) */
export const elapsedMs = (run: Run, now: number): number =>
  spansMs(run.spans) + (run.open ? Math.max(0, now - run.open.start) : 0);
