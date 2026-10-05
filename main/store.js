'use strict';
// 保存データの正本とその永続化。書き手はここだけで、レンダラからは「意図」
// (shared/actions.js)を受け取って正本に適用し、ディスクに乗せてから配る。
const { BrowserWindow } = require('electron');
const fs = require('fs');
const { normalizeData } = require('../shared/schema');
const { applyAction, deletionUndo } = require('../shared/actions');
const { DATA_FILE } = require('./paths');

const errorMessage = err => String((err && err.message) || err);
const backupPath = (file, kind) => `${file}.${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

// 保存データの正本。main が持ち、正規化を通ったものだけを入れる。レンダラへは
// このスナップショットを配るだけで、レンダラ側では検証しない(できない)。
let store = normalizeData(null);

// 読み込み時の警告(破損退避・回復・権限エラー)。起動をブロックしないよう
// モーダルではなくレンダラのトーストで通知する(consumeLoadWarning で回収)。
let pendingLoadWarning = null;

// 原本を読めないまま起動した状態。null なら通常どおり保存してよい。
// 警告だけではレンダラ(beforeunload の同期保存など)が素通りで上書きしてしまうため、
// 保存を止める権威は main が持つ。詳細は preserveUnreadable() を参照。
let unreadableOriginal = null;

// 削除の取り消し用の控え(id → deletionUndo)。削除を適用する直前の正本から作り、
// 書き込めたら持つ。レンダラは取り消しを「この削除を取り消す」(task/undelete)として
// 送るだけでよく、削除の応答を待たずに送れる。main は意図を受け取った順に適用する
// ので取り消しは必ず削除のあとに当たり、応答前にレンダラが閉じても失われない。
const deletions = new Map();

const snapshot = () => store;

// 正本を差し替えて、書き込み元以外の全ウィンドウへ配る。引数は正規化済みであること。
//
// 書き込み元を外すのは二重配信を避けるためだけ。意図(data:mutate)の応答として
// 同じスナップショットが戻り値で届くので、そちらが書き込み元の反映経路になる。
// 丸ごと置換だった頃と違い、書き込み元も必ず正規化後の正本を受け取る。
function publish(normalized, exceptWc) {
  store = normalized;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== exceptWc) win.webContents.send('data:snapshot', store);
  }
  return store;
}

/* ============ 読み込み ============ */
// 壊れた保存ファイルを退避して原本を保全する(上書きによる損失を防ぐ)。
function quarantineCorrupt(file, raw) {
  const backup = backupPath(file, 'corrupt');
  try { fs.writeFileSync(backup, raw, 'utf8'); } catch {}
  return backup;
}

function readDataFile() {
  const file = DATA_FILE();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 初回起動(ファイル無し)は空データとして扱う。
    if (err && err.code === 'ENOENT') return null;
    // 権限エラー等で読めない場合、空起動→上書きで原本が失われる。書き込みを
    // 保留し、実際に保存が要求された時点で退避してから通す(gateWrite)。
    unreadableOriginal = errorMessage(err);
    pendingLoadWarning = 'セーブファイルを読み込めませんでした。データ保護のため保存前に確認してください: ' + unreadableOriginal;
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {}
  // 破損。まず直近のアトミック書き込み残骸(.tmp)からの回復を試みる。
  try {
    const tmp = file + '.tmp';
    const recovered = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    quarantineCorrupt(file, raw);       // 壊れた本体を退避してから
    try { fs.copyFileSync(tmp, file); } catch {} // 回復データを昇格
    pendingLoadWarning = '保存ファイルが壊れていたため、直前の自動保存から復元しました。';
    return recovered;
  } catch {}
  // 回復不可: 壊れたファイルを退避(原本保全)し、警告して空で継続する。
  const backup = quarantineCorrupt(file, raw);
  console.warn('[data:load] 破損ファイルを退避しました:', backup);
  pendingLoadWarning = '保存ファイルが破損していたため退避し、空の状態で起動しました(元ファイルは .corrupt- として保存)。';
  return null;
}

// ディスクから読み直して正本に入れる。以降レンダラが受け取るのはこの結果だけ。
// 二重に呼ばれても(ウィンドウ再生成など)同じ結果になる。
const load = senderWc => publish(normalizeData(readDataFile()), senderWc);

// 読み込み時警告を一度だけ回収する(レンダラがトースト表示に使う)。
function consumeLoadWarning() {
  const w = pendingLoadWarning;
  pendingLoadWarning = null;
  return w;
}

/* ============ 書き込み ============ */
// 読めなかった原本を、中身を読まずに保全する。rename は対象ファイルの読み取り権限を
// 必要とせず(ディレクトリの書き込み権限だけで済む)、破損退避の writeFileSync と違って
// 内容が取り出せなくても確実に原本を残せる。退避できた時点で上書きは安全になる。
function preserveUnreadable(file) {
  const backup = backupPath(file, 'unreadable');
  fs.renameSync(file, backup);   // 失敗時は呼び出し側で保存自体を中止する
  return backup;
}

// 保存前のゲート。原本を読めていない間は、退避に成功するまで書き込みを通さない。
// 「退避していないバイト列は壊さない」不変条件をここ一箇所で守る。
// 退避したパス(または null)を返し、失敗時は例外を投げて保存を中止させる。
function gateWrite() {
  if (!unreadableOriginal) return null;
  let backup;
  try {
    backup = preserveUnreadable(DATA_FILE());
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      // 退避できない = 上書きすれば原本が失われる。保存を中止する。
      throw new Error('読み込めなかった元データを退避できないため、保存を中止しました: ' + errorMessage(err));
    }
    backup = null;              // 既に消えている場合は保全すべき原本がない
  }
  unreadableOriginal = null;    // 以降は通常の保存に戻る
  if (backup) console.warn('[data:mutate] 読めなかった原本を退避しました:', backup);
  return backup;
}

// クラッシュ時の破損を防ぐためアトミックに書き込む。
// 順序が重要:置き換えデータを .tmp に書き切ってから原本を退避する。先に退避すると、
// 直後の書き込みが失敗(容量不足等)した場合に正本が消え、次回起動が ENOENT =初回起動
// として黙って空で始まってしまう(退避先を誰も知らないまま残る)。
// 受け取った内容を正規化してから書く。レンダラを信用して素通しすると、あちらの
// バグや範囲外の入力(設定ダイアログの数値など)がそのまま正史になり、次回起動の
// 読み込み側正規化で黙って別の値に化ける。ディスクに出るのは常に正規形にする。
function writeData(raw, senderWc) {
  const data = normalizeData(raw);
  const file = DATA_FILE();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  let preserved;
  try {
    preserved = gateWrite();
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}   // 保存を通さない以上、中途半端な .tmp は残さない
    throw err;
  }
  fs.renameSync(tmp, file);
  // ディスクに乗ってから配る。書けなかった内容を正本として配ると、
  // 画面には残っているのに次回起動では無い、という食い違いになる。
  publish(data, senderWc);
  return preserved;
}

// 取り消せる削除のタスクを指す記録が届くと、session/add はその内訳を外す(位置は
// 残る)。削除のあとに終わったセッションは削除時の控えに入っていないので、外す位置を
// 控えに足しておき、取り消しで一緒に付け直す。
function strippedForUndo(session) {
  const s = session && typeof session === 'object' ? session : {};
  if (!Array.isArray(s.taskTimes) || store.sessions.some(x => x.id === s.id)) return [];
  const out = [];
  for (const id of deletions.keys()) {
    if (store.tasks.some(t => t.id === id)) continue;
    const indexes = [];
    s.taskTimes.forEach((tt, i) => { if (tt && tt.taskId === id) indexes.push(i); });
    if (indexes.length) out.push({ id, patch: { sessionId: s.id, indexes } });
  }
  return out;
}

// 削除の取り消し。削除が通っていない(失敗した、取り消し済み)なら戻すものは無い。何も書かない。
function undelete(id, senderWc) {
  const u = deletions.get(id);
  if (!u) return null;
  const preserved = writeData(applyAction(store, {
    type: 'task/restore',
    task: u.task,
    index: u.index,
    // 削除のあと取り消すまでに届いた記録の位置も含む(strippedForUndo が足す)。
    patches: u.patches,
    select: u.selected && !u.task.completed
  }), senderWc);
  deletions.delete(id);
  return preserved;
}

// 意図を正本に適用して保存する。原本を退避した場合はそのパスを返す。
// 未知の意図は保存を通さない(黙って素通りさせると、届いていないのにレンダラは
// 適用されたつもりで先へ進み、次の起動で消えている)。
function commit(action, senderWc) {
  const type = action && action.type;
  if (type === 'task/undelete') return undelete(action.id, senderWc);
  const undo = type === 'task/delete' ? deletionUndo(store, action.id) : null;
  const stripped = type === 'session/add' ? strippedForUndo(action.session) : [];
  const next = applyAction(store, action);
  if (!next) throw new Error('未知の操作です: ' + String(type || action));
  const preserved = writeData(next, senderWc);
  if (undo) deletions.set(action.id, undo);
  for (const { id, patch } of stripped) deletions.get(id).patches.push(patch);
  return preserved;
}

module.exports = { snapshot, load, consumeLoadWarning, commit, errorMessage };
