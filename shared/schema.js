'use strict';
// 保存データのスキーマと正規化。正本を持つのは main なので、検証もここに集約する。
// main は読み込み時と書き込み時の両方でこれを通し、レンダラへは正規化済みの
// スナップショットだけを配る。レンダラは自分では正規化しない(できない)。
//
// electron に依存しない純粋なモジュールにしてある。main からも preload からも
// require でき、ディスク I/O やウィンドウの状態とは切り離してテストできる。

const DEFAULT_SETTINGS = {
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoStartBreak: false,
  autoStartWork: false,
  // file=フォーカス中の音源, breakFile=休憩中の音源(enabled/volume は共有)
  whiteNoise: { enabled: true, file: 'white-noise.wav', breakFile: 'white-noise.wav', volume: 50 }
};

const MODES = ['work', 'short', 'long'];

// id を失った記録を捨てずに復旧するための採番。レンダラ側の uid() とは
// 目的が違う(あちらは新規作成、こちらは破損データの修復)。
const repairId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 日付を検証して ISO 文字列に揃える(数値に対する clampInt の日付版)。
// 真偽値チェックだけでは "不明" のような壊れた値が素通りし、
// new Date(NaN).toISOString() が RangeError を投げたり表示が "NaN:NaN" になる。
// 読み込んだ日付はすべてここを通してから使う。数値は epoch ミリ秒として扱う。
function parseIso(v, fallback) {
  // Date.parse は引数を ToString するため、{"toString": null} のようなオブジェクトでは
  // NaN ではなく TypeError を投げる(= 起動そのものが止まる)。プリミティブだけ受ける。
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  // Date の表現範囲(±8.64e15ms)を超えると Invalid Date になり toISOString が throw する
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : fallback;
}

// 数値を安全な範囲へ丸める(破損値や巨大値で DOM 大量生成・NaN 表示・不正 ratio に陥らせない)
function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function clampSettings(s) {
  const d = DEFAULT_SETTINGS;
  const src = s && typeof s === 'object' ? s : {};
  const wn = src.whiteNoise && typeof src.whiteNoise === 'object' ? src.whiteNoise : {};
  return {
    ...d,
    ...src,
    workMin: clampInt(src.workMin, 1, 120, d.workMin),
    shortMin: clampInt(src.shortMin, 1, 60, d.shortMin),
    longMin: clampInt(src.longMin, 1, 90, d.longMin),
    longEvery: clampInt(src.longEvery, 1, 12, d.longEvery),
    autoStartBreak: !!src.autoStartBreak,
    autoStartWork: !!src.autoStartWork,
    whiteNoise: {
      ...d.whiteNoise,
      ...wn,
      enabled: 'enabled' in wn ? !!wn.enabled : d.whiteNoise.enabled,
      volume: clampInt(wn.volume, 0, 100, d.whiteNoise.volume)
    }
  };
}

// 1件のセッションを正規化する。破損・中間バージョン・型不整合のデータでも
// taskStats / 履歴 / 削除処理が undefined.includes 等で落ちないよう、配列・数値・
// mode・日付・区間を必ず補正する。区間が無い旧データは durationSec 長の1区間に畳む。
function normalizeSession(s) {
  const o = s && typeof s === 'object' ? s : {};
  const mode = MODES.includes(o.mode) ? o.mode : 'work';
  const durationSec = Number.isFinite(o.durationSec) && o.durationSec >= 0 ? o.durationSec : 0;
  // 区間を持たない旧データ(null)と、持っていたが全部不正だった(空配列)を区別する
  const rawIntervals = Array.isArray(o.intervals) ? o.intervals : null;
  const intervals = (rawIntervals || [])
    .map(iv => {
      if (!iv || typeof iv !== 'object') return null;
      const st = parseIso(iv.startedAt, null);
      const en = parseIso(iv.endedAt, null);
      // 不正な日付・逆転・0長の区間はタイムテーブルで潰れて消えるだけなので落とす
      return st && en && Date.parse(en) > Date.parse(st) ? { ...iv, startedAt: st, endedAt: en } : null;
    })
    .filter(Boolean);
  // 端点の復元材料。durationSec は実働のみで一時停止を含まないため、それだけで
  // 引き直すと壁時計上の span が実際より短くなり、日付をまたぐ記録が別の日へ
  // ずれる。区間が生きていればそちらが実際の端点なので優先する。
  // 区間は時系列順とは限らないので最小 / 最大で取る。件数が多いと Math.min(...arr) は
  // 引数の上限で RangeError になり復旧経路自体が落ちるため、畳み込みで求める。
  let minMs = Infinity, maxMs = -Infinity;
  for (const iv of intervals) {
    minMs = Math.min(minMs, Date.parse(iv.startedAt));
    maxMs = Math.max(maxMs, Date.parse(iv.endedAt));
  }
  const ivStart = intervals.length ? new Date(minMs).toISOString() : null;
  const ivEnd = intervals.length ? new Date(maxMs).toISOString() : null;
  // 片方だけ壊れている場合は生きている側(区間 → durationSec の順)から復元する。
  // 現在時刻に落とすと、過去の記録が今日の集計に混ざったうえ区間が逆転して
  // タイムテーブルからは消える(履歴には今日として出るのに帯が無い)。
  const rawStart = parseIso(o.startedAt, null);
  const rawEnd = parseIso(o.endedAt, null);
  const startedAt = rawStart || ivStart
    || (rawEnd ? parseIso(Date.parse(rawEnd) - durationSec * 1000, rawEnd) : new Date().toISOString());
  // 終了が開始より前(両方生きていても逆転しうる)なら引き直す。
  // durationSec が巨大で Date の表現範囲を超える場合は 0 長として startedAt に畳む。
  const endedAt = rawEnd && Date.parse(rawEnd) >= Date.parse(startedAt)
    ? rawEnd
    : (ivEnd && Date.parse(ivEnd) >= Date.parse(startedAt) ? ivEnd
      : parseIso(Date.parse(startedAt) + durationSec * 1000, startedAt));
  const taskTimes = (Array.isArray(o.taskTimes) ? o.taskTimes : [])
    .filter(tt => tt && typeof tt === 'object' && Number.isFinite(tt.durationSec));
  return {
    ...o,
    id: o.id || repairId(),
    mode,
    startedAt,
    endedAt,
    durationSec,
    completed: !!o.completed,
    taskIds: Array.isArray(o.taskIds) ? o.taskIds : [],
    taskTimes,
    // 区間情報を持たない旧データだけ durationSec 長の1区間に畳む。区間はあったが
    // 全部不正だった場合は空のままにする。span に化かすと一時停止していた時間まで
    // 実働として描かれ、次の保存でその捏造が正史になってしまう。
    // 0 長になる場合は畳んでも次に通したとき落とされる(= 冪等でなくなる)ので畳まない。
    intervals: rawIntervals ? intervals
      : (Date.parse(endedAt) > Date.parse(startedAt) ? [{ startedAt, endedAt }] : [])
  };
}

function normalizeTask(t) {
  return {
    ...t,
    title: String(t.title ?? ''),
    completed: !!t.completed,
    // CSV 書き出し(main の fmtDate)が "NaN-NaN-NaN" を吐かないよう日付も揃える。
    // 現在時刻で埋めると「今日作った」と偽ったうえ保存まで起動ごとに変わるので、
    // 分からないものは null にする(fmtDate は null を空欄として書き出す)。
    createdAt: parseIso(t.createdAt, null),
    // 未完了(null/undefined)だけを素通しする。truthy 判定にすると
    // epoch ミリ秒の 0 という有効な日付を未完了に化かしてしまう。
    completedAt: t.completedAt == null ? null : parseIso(t.completedAt, null)
  };
}

// 自動サイクルの進行(次フェーズ・長休憩までのカウント)。再起動後も維持するため
// 保存対象だが、タイマーの実行状態そのものではない。
function normalizeTimerCycle(t) {
  const o = t && typeof t === 'object' ? t : {};
  return {
    mode: MODES.includes(o.mode) ? o.mode : 'work',
    cycle: Number.isFinite(o.cycle) && o.cycle >= 0 ? Math.floor(o.cycle) : 0
  };
}

// 保存データ全体を正規化する。読み込み時と書き込み時の両方でこれを通すので、
// 冪等でなければならない(通した結果をもう一度通しても変わらないこと)。
function normalizeData(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const tasks = (Array.isArray(o.tasks) ? o.tasks : [])
    .filter(t => t && typeof t === 'object' && t.id)
    .map(normalizeTask);
  // 旧 data.pomodoros(フォーカスのみ・区間情報なし)も含めて取り込む
  const rawSessions = Array.isArray(o.sessions) ? o.sessions
    : Array.isArray(o.pomodoros) ? o.pomodoros : [];
  const selected = tasks.find(t => t.id === o.selectedTaskId);
  return {
    tasks,
    sessions: rawSessions.map(normalizeSession),
    // 消えた/完了したタスクを指したままだと、フォーカス表示と実際の計測先がずれる
    selectedTaskId: selected && !selected.completed ? selected.id : null,
    settings: clampSettings(o.settings),
    timer: normalizeTimerCycle(o.timer)
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeData,
  normalizeSession,
  clampSettings,
  clampInt,
  parseIso
};
