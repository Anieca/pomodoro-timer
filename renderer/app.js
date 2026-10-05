const $ = sel => document.querySelector(sel);

// 保存データの正本は main が持つ。committed は main から最後に受け取った正本、
// pending は送ったがまだ応答の無い意図(送った順)。画面が読む data は、正本に
// pending を main と同じ reducer(shared/actions.js)で順に当てて正規化した「見込み」。
// main は意図を受け取った順に適用するので、応答が来るたびに正本を差し替えて残りを
// 当て直せば、応答待ちの間も main がこれから作る状態を描ける。失敗した意図は外れる
// ので、見込みはそのまま正本へ戻る。完了・選択・削除・設定などを機能ごとに
// 「要求中の値」で持つ必要はなく、どれも data を読めばよい。
// 読み込みが返るまでの仮表示。contextBridge 越しの既定値は凍結されているため複製する。
let committed = {
  tasks: [], sessions: [], selectedTaskId: null,
  settings: structuredClone(window.api.defaultSettings),
  timer: { mode: 'work', cycle: 0 }
};
let data = committed;
const pending = [];                 // { seq, action, local, durable, inFlight, failed }
const unsettled = new Set();        // まだ一度も応答の無い意図の seq
let seq = 0;
let soundsCache = [];

// timer.current: 実行中セッション
//   { id, mode, startedAt, intervals: [{startedAt,endedAt}], intStartAt, segments, segTaskId, segStartMs, segSeq }
// intervals は一時停止で区切られた実働区間。タイムブロックへの plot 用に壁時計の絶対時刻を保持する。
const timer = {
  mode: 'work',          // 'work' | 'short' | 'long'
  status: 'idle',        // 'idle' | 'running' | 'paused'
  totalMs: 0,
  endAt: 0,
  remainMs: 0,
  intervalId: null,
  cycle: 0,              // 長休憩までの完了ポモドーロ数
  current: null,
  sleeping: false,       // システムスリープ中(復帰の補正が届くまで完了判定を止める)
  lastTickAt: 0          // 最後に tick が走った時刻(眠りに落ちた時刻の代用)
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const SAVE_FAILED = '保存に失敗しました。ディスクの空き容量や権限を確認してください';
const failed = res => !res || res.ok === false;
const focusTaskId = () => data.selectedTaskId || null;

// 見込みを作り直して描く。フォーカスの見込みが動いたら、実行中の付け先も合わせる。
function project() {
  let s = committed;
  for (const p of pending) s = applyAction(s, p.local) || s;
  data = pending.length ? normalizeData(s) : committed;
  switchSegment(focusTaskId());
  renderAll();
}

// 変更は「何をしたいか」だけ送る。
// - local: 見込みに当てる意図(既定は送るものと同じ)。main だけが中身を知る意図
//   (task/undelete)は、手元で分かる範囲の近似を当てる。
// - durable: 失敗しても捨てず、次に保存が通ったときと終了時に送り直す意図の鍵。
//   記録(session/add)と進行状態(flow/set)は送った直後に手元から消えるので、
//   捨てるとどこにも残らない。同じ鍵の古いものは新しいものに置き換わる。
function mutate(action, { local = action, durable } = {}) {
  if (durable) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].durable === durable && pending[i].failed) pending.splice(i, 1);
    }
  }
  const entry = { seq: ++seq, action, local, durable, inFlight: false, failed: false };
  pending.push(entry);
  project();
  return send(entry);
}

function send(entry) {
  entry.inFlight = true;
  unsettled.add(entry.seq);
  return window.api.mutate(entry.action).then(res => res, () => null).then(res => settle(entry, res));
}

// 応答の共通処理。成功でも失敗でも main が添えてきた正本を採る。失敗時に手元の
// 見込みを残すと、保存されていない内容が画面に居座り、次の操作でその上に
// 積み上がってしまう(ディスクの正史と画面が静かにずれる)。
function settle(entry, res) {
  entry.inFlight = false;
  if (res && res.snapshot) committed = res.snapshot;
  const ok = !failed(res);
  const superseded = entry.durable && pending.some(p => p !== entry && p.durable === entry.durable && p.seq > entry.seq);
  if (ok || !entry.durable || superseded) pending.splice(pending.indexOf(entry), 1);
  else entry.failed = true;
  // この意図が最後の見込みだった間に付けた内訳を、決着後の正本の選択に付け直す。
  if (unsettled.delete(entry.seq)) settleSegments(entry.seq, committed.selectedTaskId);
  project();
  flushHeldRecords();
  if (!res) toast(SAVE_FAILED);
  else if (!ok) toast(res.error ? `保存に失敗しました: ${res.error}` : SAVE_FAILED);
  else {
    if (res.preserved) toast(`読み込めなかった元のデータファイルを ${res.preserved} に退避しました`);
    retryDurable();                 // 書けるようになったら、書けていない分を送り直す
  }
  return res;
}

function retryDurable() {
  for (const p of pending.filter(p => p.failed && !p.inFlight)) {
    p.failed = false;
    // main ではこれから適用されるので、見込みでも最後に並べ直す。
    pending.splice(pending.indexOf(p), 1);
    pending.push(p);
    send(p);
  }
}

// 他のウィンドウの変更で正本が動いたとき。
function applySnapshot(snapshot) {
  if (!snapshot) return;
  committed = snapshot;
  project();
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const RING_LEN = 2 * Math.PI * 132;

// セッションの実働区間(区間を持たない古い記録だけ span をフォールバック)。
// 正規化済みなら必ず配列を持つので、空配列は「区間が不正で捨てられた」の意。
// それを span に化かすと実働していない時間まで実働として扱われるため区別する。
const sessionIntervals = s => (Array.isArray(s.intervals) ? s.intervals : [{ startedAt: s.startedAt, endedAt: s.endedAt }]);
// Date → "HH:MM"
const fmtClock = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function modeDurationMs(mode) {
  const s = data.settings;
  const min = mode === 'work' ? s.workMin : mode === 'short' ? s.shortMin : s.longMin;
  return min * 60 * 1000;
}


/* ============ 初期化 ============ */
async function init() {
  // Tray / ミニウィンドウからの操作を本体タイマーに反映する。
  // await より前(同期実行部)で登録し、起動直後やウィンドウ再生成直後の
  // 操作要求(did-finish-load 後に main が送る)を取りこぼさない。
  window.api.onTimerCommand(cmd => {
    if (cmd === 'toggle') startPauseResume();
    else if (cmd === 'skip') { if (timer.mode !== 'work' && timer.status !== 'idle') skipBreak(); }
    else if (cmd === 'stop') stopEarly();
  });
  // スリープ前後の通知。取りこぼすと睡眠時間が実働として記録に残るため、
  // タイマー操作と同じく await より前に登録する。
  window.api.onPowerSuspend(beginSleep);
  window.api.onPowerResume(applySleep);

  // 他のウィンドウの変更で正本が動いたときのスナップショット(自分が出した変更は
  // mutate の戻り値で受け取る)。進行中のタイマー(timer)はレンダラ側の状態なので
  // ここでは触らない。
  window.api.onDataSnapshot(applySnapshot);

  // 検証は main の責務。ここへ来るのは正規化済みのスナップショットだけ。
  committed = data = await window.api.loadData();
  // モード手動選択を撤去したので、自動サイクルの進行(次フェーズ・長休憩までの
  // カウント)を再起動後も維持する。
  timer.mode = data.timer.mode;
  timer.cycle = data.timer.cycle;
  soundsCache = await window.api.listSounds();
  timer.remainMs = modeDurationMs(timer.mode);
  timer.totalMs = timer.remainMs;
  renderAll();
  if (Notification.permission === 'default') Notification.requestPermission();

  // 読み込み時の警告(破損退避・回復・権限エラー)があればトーストで知らせる。
  const loadWarning = await window.api.consumeLoadWarning();
  if (loadWarning) toast(loadWarning);
}

function renderAll() {
  renderTasks();
  renderTimer();
  renderFocusTask();
  renderCycleDots();
  renderTodayCount();
  // 開いている間に記録・削除・名前の変更が入っても古い集計を見せない
  if (!$('#statsModal').hidden) renderStats();
}

/* ============ タスク ============ */
function taskStats(taskId) {
  let pomos = 0, sec = 0;
  for (const p of data.sessions) {
    if (p.mode !== 'work') continue;
    if (p.completed && p.taskIds.includes(taskId)) pomos++;
    // 内訳を持たない旧データも統計のタスク別と同じ決まりで積む(stats.js)
    for (const tt of taskTimesOf(p)) if (tt.taskId === taskId) sec += tt.durationSec;
  }
  // 進行中のポモドーロの時間もリアルタイムに反映
  if (timer.current && timer.current.mode === 'work') {
    for (const s of timer.current.segments) if (s.taskId === taskId) sec += s.durationSec;
    if (timer.current.segTaskId === taskId) {
      sec += Math.max(0, (pomoElapsedMs() - timer.current.segStartMs) / 1000);
    }
  }
  return { pomos, minutes: Math.round(sec / 60) };
}

function renderTasks() {
  // 名前を編集している間は組み直さない。意図の反映は全体の再描画で来るので、
  // 守らないと編集中に別の変更(セッションの記録など)が入っただけで入力が消える。
  if ($('.task-rename')) return;
  const open = data.tasks.filter(t => !t.completed);
  const done = data.tasks.filter(t => t.completed);
  const list = $('#taskList');
  const doneList = $('#doneList');
  list.textContent = '';
  doneList.textContent = '';

  if (open.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'タスクはありません';
    list.appendChild(li);
  }
  for (const t of open) list.appendChild(taskItem(t));
  for (const t of done) doneList.appendChild(taskItem(t));
}

function taskItem(t) {
  const li = document.createElement('li');
  li.className = 'task-item' + (t.completed ? ' done' : '');
  const isSelected = data.selectedTaskId === t.id;
  if (isSelected) li.classList.add('selected');

  if (!t.completed) {
    // 次の値はクリック時点のフォーカスから決める。描画時の isSelected を使うと、
    // 応答前に二度押したとき両方が同じ要求を送り、打ち消し合わない。
    const toggleFocus = () => selectTask(focusTaskId() === t.id ? null : t.id);
    li.title = isSelected ? 'クリックでセット解除' : 'クリックでフォーカス対象にセット';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', String(isSelected));
    li.addEventListener('click', e => {
      if (e.target.closest('button, input')) return;
      toggleFocus();
    });
    li.addEventListener('keydown', e => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        toggleFocus();
      }
    });
  }

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'task-check';
  check.checked = t.completed;
  check.title = t.completed ? '未完了に戻す' : '完了にする';
  check.addEventListener('change', () => toggleTaskDone(t.id, check.checked));

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = t.title;

  const meta = document.createElement('span');
  meta.className = 'task-meta';
  const st = taskStats(t.id);
  meta.textContent = (st.pomos > 0 || st.minutes > 0) ? `🍅${st.pomos} · ${st.minutes}分` : '';

  li.append(check, title, meta);

  if (!t.completed) {
    const edit = document.createElement('button');
    edit.className = 'task-btn';
    edit.textContent = '✎';
    edit.title = '名前を変更';
    edit.addEventListener('click', () => beginRename(t, title));
    li.appendChild(edit);
  }

  const del = document.createElement('button');
  del.className = 'task-btn';
  del.textContent = '×';
  del.title = '削除';
  del.addEventListener('click', () => deleteTask(t.id));
  li.appendChild(del);

  return li;
}

function beginRename(t, titleEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-rename';
  input.maxLength = 120;
  input.value = t.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  // 先に入力欄を外してから組み直す(renderTasks は編集中を検出すると何もしない)。
  const close = () => {
    input.remove();
    renderTasks();
    renderFocusTask();
  };
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    // 畳むのは意図の結果を待たない(待つと入力欄が残ったまま一瞬止まる)。
    if (v && v !== t.title) mutate({ type: 'task/rename', id: t.id, title: v });
    close();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      done = true;
      close();
    }
  });
  input.addEventListener('blur', commit);
}

function addTask(title) {
  const task = {
    id: uid(),
    title,
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  // id と作成時刻はここで採番して意図に添える(main の reducer を時計に依存させない)。
  mutate({ type: 'task/add', task });
  return task;
}

// ポモドーロ内の経過時間(一時停止中の時間は含まない)
function pomoElapsedMs() {
  if (timer.status === 'running') return timer.totalMs - Math.max(0, timer.endAt - Date.now());
  return timer.totalMs - timer.remainMs;
}

// 実働区間を開く/閉じる(一時停止・再開・終了の境界で壁時計の絶対時刻を記録)
function openInterval() {
  if (timer.current) timer.current.intStartAt = Date.now();
  // 最初の tick(250ms 後)より前に眠った場合の代用値。前の区間の値が残っていると
  // wakeIfSleeping が「区間より前」の時刻を渡してしまい、補正が捨てられる。
  timer.lastTickAt = Date.now();
}
function closeInterval() {
  const c = timer.current;
  if (!c || !c.intStartAt) return;
  // 実働区間の終端は予定終了時刻(endAt)を超えない。スリープや background
  // throttling で tick が遅れ、復帰時の now が endAt を大幅に超えても、実時間を
  // 予定終了でクリップして durationSec / 今日の合計 / タイムライン / CSV が
  // 数時間に膨らむのを防ぐ(segments 側は endAt 基準の pomoElapsedMs で既に正しい)。
  const endMs = Math.max(c.intStartAt, Math.min(Date.now(), timer.endAt));
  c.intervals.push({
    startedAt: new Date(c.intStartAt).toISOString(),
    endedAt: new Date(endMs).toISOString()
  });
  c.intStartAt = null;
}

// tick の間隔(250ms)がこれ以上飛んだら、プロセスごと止まっていた(= 実働ではない)と
// みなす。GC や重い描画で数秒詰まることはありうるので、それと確実に区別できる長さにする。
// スリープは通常もっと長く、これより短い眠りは通知を取り逃しても実害が小さい
// (従来どおり endAt でクリップされる)。
const TICK_GAP_MS = 60 * 1000;

// 眠りに落ちる直前(main が powerMonitor の suspend で知らせてくる)。復帰後の tick が
// 補正より先に走って「予定終了を過ぎた」と判定するのを防ぐため、完了判定を止めておく。
function beginSleep() {
  timer.sleeping = true;
}

// 補正が届く前に操作が来た場合の逃げ道。最後に tick が走った時刻を眠りに落ちた時刻と
// みなして先に補正する(tick は 250ms 間隔なので誤差はその範囲に収まる)。
// suspend の通知ごと取り逃していることもあるので、旗が立っていなくても tick が大きく
// 飛んでいれば止まっていたと分かる。
function wakeIfSleeping() {
  if (timer.sleeping || Date.now() - timer.lastTickAt > TICK_GAP_MS) {
    applySleep({ suspendAt: timer.lastTickAt, resumeAt: Date.now() });
  }
  timer.sleeping = false;                         // lastTickAt が無くても止まったままにしない
  timer.lastTickAt = Date.now();
}

// システムスリープからの復帰。眠っていた間は作業していないので、実働区間を
// 眠りに落ちた時刻で閉じ、復帰時刻から開き直す。あわせて眠っていた分だけ予定終了を
// 後ろへずらす(= スリープを一時停止と同じ扱いにする)。
//
// ずらすのは残り時間を保つためだけではない。タスク別の時間(segments)は
// pomoElapsedMs() = totalMs -(endAt - now)から出るので、endAt を睡眠分ずらすと
// 復帰直後の経過時間が眠りに落ちた時点と一致し、セグメント側も自動的に睡眠を含まない。
//
// 補正しない場合、蓋を閉じて3時間後に開けると「25分集中した」ことになってしまう
// (復帰時の tick が予定終了超過を検知して完了扱いにし、区間は endAt でクリップされる)。
function applySleep(span) {
  timer.sleeping = false;                         // 補正が届いた/届かないと分かった時点で解除
  const c = timer.current;
  if (timer.status !== 'running' || !c) return;   // 一時停止・アイドル中は残り時間が凍結済み
  const { suspendAt, resumeAt } = span || {};
  if (!Number.isFinite(suspendAt) || !Number.isFinite(resumeAt) || resumeAt <= suspendAt) return;
  // 補正してよいのは眠る前から動き続けていた実働区間だけ。復帰後に自動開始や手動操作で
  // 始まった/再開されたものへ睡眠分を足すと、25分のタイマーが3時間25分になってしまう
  // (開始・再開の時点で endAt は引き直されているので、そもそも補正は要らない)。
  if (!c.intStartAt || c.intStartAt > suspendAt) return;

  // 眠る前に既に予定終了を過ぎていたなら、そのまま完了させる(先延ばしにしない)
  const overdue = suspendAt >= timer.endAt;
  // 眠りに落ちた時刻で区間を閉じる。予定終了より後に眠ったなら実働は endAt 止まり。
  const endMs = Math.min(suspendAt, timer.endAt);
  if (endMs > c.intStartAt) {
    c.intervals.push({
      startedAt: new Date(c.intStartAt).toISOString(),
      endedAt: new Date(endMs).toISOString()
    });
  }
  // 区間ごと睡眠に飲まれていた場合(endMs <= intStartAt)は実働ゼロなので積まない。
  // 既に予定終了を過ぎているなら開き直さない(復帰時刻の0長区間が記録の endedAt に
  // なり、終了時刻が数時間ずれてしまう)。
  c.intStartAt = overdue ? null : resumeAt;
  if (!overdue) timer.endAt += resumeAt - suspendAt;
  renderTimer();
}

// 現在のセグメントを確定して segments に積む
function closeSegment() {
  // セグメントは経過時間(= endAt 基準)から出るので、睡眠分を endAt へ反映する前に
  // 区切ると残り時間まるごとが直前のタスクに付いてしまう。あとから applySleep が
  // 届いても確定済みの segments は直せないため、ここで先に補正しておく。
  wakeIfSleeping();
  const c = timer.current;
  if (!c) return;
  const durMs = pomoElapsedMs() - c.segStartMs;
  if (durMs >= 1000) c.segments.push({ taskId: c.segTaskId, durationSec: Math.round(durMs / 1000), seq: c.segSeq });
}

// 見込みの付け先が、応答待ちのどの意図までを前提にしているか(最後の意図の seq)。
// その意図が決着したら、印の付いた内訳を決着後の正本の選択に付け直す。選択が
// 失敗したり、応答待ちの間の完了・削除で正規化に外されたりしても、その間の
// 実働が選べなかったタスクに残らない。
const lastPendingSeq = () => (pending.length ? pending[pending.length - 1].seq : undefined);

// タスク切り替え地点でセグメントを区切る(タイマーは止めない)
function switchSegment(taskId) {
  const c = timer.current;
  if (!c || c.mode !== 'work' || c.segTaskId === (taskId || null)) return;
  closeSegment();
  c.segTaskId = taskId || null;
  c.segStartMs = pomoElapsedMs();
  c.segSeq = lastPendingSeq();
}

function settleSegments(seqDone, actual) {
  const fix = c => {
    for (const s of c.segments) if (s.seq === seqDone) { s.taskId = actual || null; s.seq = undefined; }
    if (c.segSeq === seqDone) { c.segTaskId = actual || null; c.segSeq = undefined; }
  };
  if (timer.current) fix(timer.current);
  for (const r of heldRecords) fix(r.c);
}

// フォーカス対象タスクの選択(アイドル中=次のポモドーロ用、実行中=即時切り替え)。
// 完了したタスクは選べない(main でも正規化で外れる)。
function selectTask(taskId) {
  const t = taskId && data.tasks.find(t => t.id === taskId);
  if (taskId && (!t || t.completed)) return;
  return mutate({ type: 'task/select', id: taskId || null });
}

// completed は操作した部品の状態から受け取る(省略時は見込みを反転)。
// 完了したら選択は外れる(reducer が外し、見込みの付け先もそれに従う)。
function toggleTaskDone(id, completed) {
  const t = data.tasks.find(t => t.id === id);
  if (!t) return;
  if (completed === undefined) completed = !t.completed;
  if (completed && focusTaskId() === id) toast(`「${t.title}」を完了しました 🎉`);
  mutate({ type: 'task/setDone', id, completed, at: completed ? new Date().toISOString() : null });
}

// 削除は見込みからすぐ消える(行も残らないので、応答待ちの間に重ねて操作されない)。
// 実行中セッションの内訳は削除済みのタスクを指したまま持ち、記録が届いた時点で
// main の session/add が外す。そのとき外した位置は main が取り消しの控えに足すので、
// 取り消せばその記録も戻る。
function deleteTask(id) {
  const index = data.tasks.findIndex(t => t.id === id);
  if (index === -1) return;
  const t = data.tasks[index];
  const wasSelected = focusTaskId() === id;
  mutate({ type: 'task/delete', id });
  // 取り消しは削除の応答を待たずにその場で送る。控えは main が削除の直前の正本から
  // 作って持っており、main は受け取った順に適用するので必ず削除のあとに当たる
  // (削除が失敗していれば何もしない)。見込みには手元の控えで近似を当てる。
  // 保存に失敗したら(main は控えを持ったまま)、取り消しをもう一度出す。
  let undoing = false;
  const offer = msg => toast(msg, { label: '元に戻す', fn: undo });
  const undo = () => {
    if (undoing) return;
    undoing = true;
    const local = { type: 'task/restore', task: t, index, patches: [], select: wasSelected && !t.completed };
    mutate({ type: 'task/undelete', id }, { local }).then(res => {
      undoing = false;
      if (failed(res)) offer(`「${t.title}」を元に戻せませんでした`);
    });
  };
  offer(`「${t.title}」を削除しました`);
}

/* ============ タイマー ============ */
function renderTimer() {
  const ms = timer.status === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remainMs;
  const totalSec = Math.ceil(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  $('#timeDisplay').textContent = `${mm}:${ss}`;
  document.title = timer.status === 'running' ? `${mm}:${ss} — ${MODE_LABEL[timer.mode]}` : 'Pomodoro Atelier';

  const ratio = timer.totalMs > 0 ? ms / timer.totalMs : 1;
  $('#ringFg').style.strokeDashoffset = String(RING_LEN * (1 - ratio));

  $('.dial').classList.toggle('break', timer.mode !== 'work');
  // モードはユーザーが選べず自動サイクルで進むため、待機中は次に始まる
  // フェーズ(休憩なら種別)をラベルで示す。
  $('#phaseLabel').textContent =
    timer.status === 'running' ? MODE_LABEL[timer.mode] + '中' :
    timer.status === 'paused' ? MODE_LABEL[timer.mode] + '一時停止中' :
    timer.mode === 'work' ? '準備完了' : MODE_LABEL[timer.mode];

  $('#startBtn').textContent =
    timer.status === 'running' ? '一時停止' :
    timer.status === 'paused' ? '再開' : '開始';
  $('#stopBtn').hidden = timer.status === 'idle';
  $('#skipBtn').hidden = timer.mode === 'work';

  document.body.classList.toggle('focusing', timer.status === 'running' && timer.mode === 'work');

  // Tray / Dock / ミニウィンドウ用に現在状態を main へ通知する。
  window.api.pushTimerState({
    status: timer.status,
    mode: timer.mode,
    mm, ss,
    ratio,
    remainSec: totalSec
  });
}

function renderCycleDots() {
  const wrap = $('#cycleDots');
  wrap.textContent = '';
  const every = data.settings.longEvery;
  // 長休憩の「間」だけ全点灯にする。長休憩が終わって次のフォーカスへ戻ると
  // cycle は every の倍数のままなので、mode を条件に含めないと次サイクル開始時も
  // 4/4 のまま表示されてしまう(長休憩後は 0/4 が自然)。
  const full = timer.cycle > 0 && timer.cycle % every === 0 && timer.mode === 'long';
  for (let i = 0; i < every; i++) {
    const dot = document.createElement('i');
    if (i < timer.cycle % every || full) dot.classList.add('on');
    wrap.appendChild(dot);
  }
}

function renderTodayCount() {
  const today = new Date().toDateString();
  const work = data.sessions.filter(p => p.mode === 'work' && new Date(p.startedAt).toDateString() === today);
  let sec = work.reduce((s, p) => s + p.durationSec, 0);
  if (timer.current && timer.current.mode === 'work') sec += pomoElapsedMs() / 1000;
  $('#todayCount').textContent = String(work.filter(p => p.completed).length);
  $('#todayMin').textContent = String(Math.round(sec / 60));
}

function startPauseResume() {
  // 手動操作が来たということは目が覚めている。残り時間を眠る前の endAt から計算して
  // しまう前に補正を済ませる(通常は先に applySleep が届いている)。
  wakeIfSleeping();
  if (timer.status === 'idle') {
    timer.totalMs = modeDurationMs(timer.mode);
    timer.endAt = Date.now() + timer.totalMs;
    timer.status = 'running';
    timer.current = {
      id: uid(),
      mode: timer.mode,
      startedAt: new Date().toISOString(),
      intervals: [],
      intStartAt: Date.now(),
      segments: [],
      segTaskId: timer.mode === 'work' ? focusTaskId() : null,
      segSeq: timer.mode === 'work' ? lastPendingSeq() : undefined,   // 見込みで付けたなら印を持つ
      segStartMs: 0
    };
    timer.lastTickAt = Date.now();
    timer.intervalId = setInterval(tick, 250);
  } else if (timer.status === 'running') {
    timer.remainMs = Math.max(0, timer.endAt - Date.now());
    timer.status = 'paused';
    clearInterval(timer.intervalId);
    closeInterval();
  } else {
    timer.endAt = Date.now() + timer.remainMs;
    timer.status = 'running';
    openInterval();
    timer.intervalId = setInterval(tick, 250);
  }
  renderTimer();
  renderTasks();
  renderFocusTask();
  updateNoise();
}

function tick() {
  // スリープ中(と復帰直後の補正待ち)は壁時計が飛んでいるので完了判定に使えない
  if (timer.sleeping) return;
  const now = Date.now();
  const gap = now - timer.lastTickAt;
  timer.lastTickAt = now;
  // power:suspend を処理し切る前に凍結された場合、復帰後の tick が補正より先に走る。
  // 完了判定に進む前に、飛んだぶんを眠っていた区間として自力で補正しておく
  // (あとから届く power:resume は区間より前の時刻になるので applySleep が捨てる)。
  if (gap > TICK_GAP_MS) applySleep({ suspendAt: now - gap, resumeAt: now });
  if (Date.now() >= timer.endAt) {
    finishSession(true);
    return;
  }
  renderTimer();
  // 1分ごとにタスク統計・今日の合計を更新
  const min = Math.floor(pomoElapsedMs() / 60000);
  if (min !== timer.lastStatsMin) {
    timer.lastStatsMin = min;
    renderTasks();
    renderTodayCount();
  }
}

function stopEarly() {
  if (timer.status === 'idle') return;
  wakeIfSleeping();                               // 睡眠を実働として記録に残さない
  finishSession(false);
}

// 自動サイクルの進行(次フェーズ・長休憩までのカウント)を永続化する
// 実行中セッション(フォーカス/休憩)を記録に積む(1分未満の中断は記録しない)
// sync=true は終了時(beforeunload)専用。レンダラが破棄される前に書き込みを終える
// 必要があり、応答は使えない(失敗と原本の退避は main がダイアログで知らせる)。
function recordSession(completed, sync) {
  // 記録に落とす前に補正を済ませる。beforeunload からは直接呼ばれるため、ここで
  // 効かせないと closeInterval が睡眠込みの区間を確定してしまい、あとから
  // applySleep が届いても intStartAt が消えていて直せない。
  wakeIfSleeping();
  const c = timer.current;
  if (!c) return;
  closeInterval();
  const activeMs = c.intervals.reduce((s, iv) => s + (new Date(iv.endedAt) - new Date(iv.startedAt)), 0);
  const elapsedSec = Math.round(activeMs / 1000);
  if (!completed && elapsedSec < 60) return;

  if (c.mode === 'work') closeSegment();
  const rec = { c, completed, elapsedSec, endedAt: c.intervals.length ? c.intervals[c.intervals.length - 1].endedAt : new Date().toISOString() };
  // 見込みで付けた内訳がまだ決着していなければ、決着まで送らずに持つ(送ってから
  // では直せない)。終了時(sync)は待てないので、beforeunload が正本で付け直してから呼ぶ。
  if (sync) window.api.mutateSync(sessionAction(rec));
  else if (isHeld(rec)) heldRecords.push(rec);
  else sendSession(rec);
}

const heldRecords = [];
const isHeld = rec => rec.c.segments.some(s => unsettled.has(s.seq));
function flushHeldRecords() {
  for (const rec of heldRecords.filter(r => !isHeld(r))) {
    heldRecords.splice(heldRecords.indexOf(rec), 1);
    sendSession(rec);
  }
}
const sendSession = rec => mutate(sessionAction(rec), { durable: 'session:' + rec.c.id });

// 自動サイクルの進行(フェーズとサイクル)。常に手元の最新値を送る。
function persistFlow() {
  mutate({ type: 'flow/set', mode: timer.mode, cycle: timer.cycle }, { durable: 'flow' });
}

function sessionAction({ c, completed, elapsedSec, endedAt }) {
  let taskTimes = [], taskIds = [];
  if (c.mode === 'work') {
    // セグメントをタスク別に集計
    const byTask = new Map();
    for (const s of c.segments) byTask.set(s.taskId, (byTask.get(s.taskId) || 0) + s.durationSec);
    taskTimes = [...byTask.entries()].map(([taskId, durationSec]) => ({ taskId, durationSec }));
    taskIds = taskTimes.filter(tt => tt.taskId).map(tt => tt.taskId);
  }
  return {
    type: 'session/add',
    session: {
      id: c.id,
      mode: c.mode,
      startedAt: c.startedAt,
      endedAt,
      durationSec: elapsedSec,
      completed,
      intervals: c.intervals,
      taskIds,
      taskTimes
    }
  };
}

function finishSession(completed) {
  clearInterval(timer.intervalId);
  const wasWork = timer.mode === 'work';

  if (timer.current) {
    recordSession(completed);
    if (wasWork && completed) timer.cycle++;
  }

  timer.current = null;
  timer.status = 'idle';

  if (completed) {
    chime();
    notify(wasWork ? 'フォーカス完了!' : '休憩終了!',
           wasWork ? 'おつかれさまです。休憩しましょう。' : '次のフォーカスを始めましょう。');
    timer.mode = wasWork
      ? (timer.cycle % data.settings.longEvery === 0 ? 'long' : 'short')
      : 'work';
  }

  timer.remainMs = modeDurationMs(timer.mode);
  timer.totalMs = timer.remainMs;
  persistFlow();
  renderAll();
  updateNoise();

  // 自動開始(設定で有効な場合)
  if (completed) {
    const s = data.settings;
    if ((timer.mode !== 'work' && s.autoStartBreak) || (timer.mode === 'work' && s.autoStartWork)) {
      setTimeout(() => { if (timer.status === 'idle') startPauseResume(); }, 800);
    }
  }
}

// 休憩を飛ばしてフォーカスに戻る
function skipBreak() {
  if (timer.mode === 'work') return;
  wakeIfSleeping();                               // 睡眠を休憩の実時間として記録に残さない
  clearInterval(timer.intervalId);
  // スキップ時点までの休憩は実時間として記録(1分未満は破棄)
  if (timer.current) recordSession(false);
  timer.current = null;
  timer.status = 'idle';
  timer.mode = 'work';
  timer.remainMs = modeDurationMs('work');
  timer.totalMs = timer.remainMs;
  persistFlow();
  renderAll();
  updateNoise();
}

function notify(title, body) {
  window.api.requestAttention();
  if (Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, silent: true });
  n.onclick = () => window.api.focusWindow();
}

function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.18, 0.36].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain).connect(ctx.destination);
      osc.frequency.value = [659, 784, 988][i];
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.5);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.55);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}

/* ============ フォーカス対象(サークル下) ============ */
function renderFocusTask() {
  const wrap = $('#focusTask');
  wrap.textContent = '';
  const t = data.tasks.find(t => t.id === data.selectedTaskId);

  if (t) {
    const card = document.createElement('div');
    card.className = 'focus-card';

    const check = document.createElement('button');
    check.className = 'focus-check';
    check.title = 'タスクを完了にする';
    check.addEventListener('click', () => toggleTaskDone(t.id, true));

    const title = document.createElement('span');
    title.className = 'focus-title';
    title.textContent = t.title;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'focus-clear-btn';
    clearBtn.textContent = '×';
    clearBtn.title = 'セット解除';
    clearBtn.addEventListener('click', () => selectTask(null));

    card.append(check, title, clearBtn);
    wrap.appendChild(card);
  } else {
    const form = document.createElement('form');
    form.className = 'focus-quick-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.placeholder = '何に集中する?タスク名を入力…';
    const list = document.createElement('ul');
    list.className = 'suggest-list';
    list.hidden = true;
    form.append(input, list);
    wrap.appendChild(form);

    let items = [];
    let active = 0;

    // 選ぶと見込みが描き直されて欄は消える。消えた欄に残った二度目の確定は無視する
    // (同じタスクをもう一つ作らない)。
    const choose = it => {
      if (!form.isConnected) return;
      if (it.type === 'task') selectTask(it.task.id);
      else selectTask(addTask(it.title).id);
    };

    const buildItems = () => {
      const q = input.value.trim();
      const ql = q.toLowerCase();
      const open = data.tasks.filter(t => !t.completed);
      const matches = (ql ? open.filter(t => t.title.toLowerCase().includes(ql)) : open).slice(0, 5);
      items = matches.map(t => ({ type: 'task', task: t }));
      if (q && !open.some(t => t.title.toLowerCase() === ql)) items.push({ type: 'create', title: q });
    };

    const renderList = () => {
      list.textContent = '';
      list.hidden = items.length === 0;
      items.forEach((it, i) => {
        const li = document.createElement('li');
        if (i === active) li.classList.add('active');
        if (it.type === 'task') {
          const stats = taskStats(it.task.id);
          const title = document.createElement('span');
          title.textContent = it.task.title;
          const meta = document.createElement('span');
          meta.className = 'suggest-meta';
          meta.textContent = `${stats.pomos}🍅 · ${stats.minutes}分`;
          li.append(title, meta);
        } else {
          li.classList.add('create');
          li.textContent = `＋「${it.title}」を作成してセット`;
        }
        // blur より先に確定させるため mousedown を使う
        li.addEventListener('mousedown', e => { e.preventDefault(); choose(it); });
        list.appendChild(li);
      });
    };

    const refresh = () => { buildItems(); active = 0; renderList(); };

    input.addEventListener('input', refresh);
    input.addEventListener('focus', refresh);
    input.addEventListener('blur', () => { list.hidden = true; });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { refresh(); return; }
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        renderList();
      } else if (e.key === 'Escape' && !list.hidden) {
        list.hidden = true;
        e.stopPropagation();
      }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!list.hidden && items.length) {
        choose(items[active]);
        return;
      }
      const v = input.value.trim();
      if (!v) return;
      const exist = data.tasks.find(t => !t.completed && t.title.toLowerCase() === v.toLowerCase());
      choose(exist ? { type: 'task', task: exist } : { type: 'create', title: v });
    });
  }
}

/* ============ ホワイトノイズ ============ */
// <audio loop> はループ境界で無音が入るため、サンプル精度でループする Web Audio を使う。
// 各音源は専用の GainNode を持つ(noiseGain = 現在の音源の gain)。これにより切替時に
// 旧音源を独立してフェードアウトでき、共有 gain による重なり(旧音源が新音量で鳴る)を防ぐ。
let noiseCtx = null;
let noiseGain = null;      // 現在再生中の音源の gain
let noiseSrc = null;       // 現在再生中の音源
let noisePlayingName = null;
let noiseToken = 0;
const noiseBuffers = new Map();

function ensureNoiseCtx() {
  if (!noiseCtx) noiseCtx = new AudioContext();
  if (noiseCtx.state === 'suspended') noiseCtx.resume();
}

// 指定の音源を自前の gain でフェードアウトして停止する(他の音源には影響しない)
function fadeOutAndStop(src, gain) {
  const t = noiseCtx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + 0.15);
  src.stop(t + 0.18);
}

async function noiseBuffer(name) {
  if (!noiseBuffers.has(name)) {
    const bytes = await window.api.readSound(name);
    if (!bytes) return null;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    noiseBuffers.set(name, await noiseCtx.decodeAudioData(ab));
  }
  return noiseBuffers.get(name);
}

function rampGain(target, sec) {
  if (!noiseGain) return;
  const t = noiseCtx.currentTime;
  noiseGain.gain.cancelScheduledValues(t);
  noiseGain.gain.setValueAtTime(noiseGain.gain.value, t);
  noiseGain.gain.linearRampToValueAtTime(target, t + sec);
}

function stopNoise() {
  noiseToken++;
  if (!noiseSrc) return;
  fadeOutAndStop(noiseSrc, noiseGain);
  noiseSrc = null;
  noiseGain = null;
  noisePlayingName = null;
}

async function startNoise(name, volume) {
  ensureNoiseCtx();
  const token = ++noiseToken;
  // 切替開始時に旧音源を先にフェードアウトする。decode 待ちや読み込み失敗時でも
  // 旧音源が鳴り続けない。キャッシュ済みなら直後の decode は即時でギャップは出ない。
  if (noiseSrc) {
    fadeOutAndStop(noiseSrc, noiseGain);
    noiseSrc = null;
    noiseGain = null;
    noisePlayingName = null;
  }
  const buf = await noiseBuffer(name).catch(() => null);
  if (token !== noiseToken) return;
  if (!buf) return;
  const gain = noiseCtx.createGain();
  gain.gain.value = 0;
  gain.connect(noiseCtx.destination);
  const src = noiseCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(gain);
  const t = noiseCtx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.15);
  src.start();
  noiseSrc = src;
  noiseGain = gain;
  noisePlayingName = name;
}

// 現在のモードで鳴らす音源ファイル名(work=フォーカス音源, 休憩=休憩音源)
function noiseFileFor(mode) {
  const wn = data.settings.whiteNoise;
  return mode === 'work' ? wn.file : wn.breakFile;
}

function updateNoise() {
  const wn = data.settings.whiteNoise;
  const sound = soundsCache.find(s => s.name === noiseFileFor(timer.mode));
  const active = timer.status === 'running' && sound;
  const shouldPlay = active && wn.enabled;
  const ind = $('#noiseIndicator');
  ind.hidden = !active;
  ind.textContent = wn.enabled ? '♪ ホワイトノイズ' : '♪ オフ';
  ind.classList.toggle('off', !wn.enabled);
  if (!shouldPlay) {
    if (noiseCtx) stopNoise();
    return;
  }
  if (noiseSrc && noisePlayingName === sound.name) {
    rampGain(wn.volume / 100, 0.05);
  } else {
    // 別音源へ切替。startNoise が旧音源を専用 gain で独立フェードアウトしつつ
    // 新音源をフェードインする(短いクロスフェード。旧音源が新音量で混ざらない)。
    startNoise(sound.name, wn.volume / 100);
  }
}

/* ============ 設定 ============ */
// 設定の数値入力欄。範囲はスキーマの許容範囲から引く(HTML と二重管理しない)。
const SETTING_INPUTS = { workMin: '#setWork', shortMin: '#setShort', longMin: '#setLong', longEvery: '#setEvery' };
for (const [key, sel] of Object.entries(SETTING_INPUTS)) {
  const [min, max] = SETTING_LIMITS[key];
  Object.assign($(sel), { min, max });
}

async function openSettings() {
  const s = data.settings;
  $('#setWork').value = s.workMin;
  $('#setShort').value = s.shortMin;
  $('#setLong').value = s.longMin;
  $('#setEvery').value = s.longEvery;
  $('#setAutoBreak').checked = s.autoStartBreak;
  $('#setAutoWork').checked = s.autoStartWork;
  $('#setNoiseOn').checked = s.whiteNoise.enabled;
  $('#setNoiseVol').value = s.whiteNoise.volume;
  $('#volLabel').textContent = `${s.whiteNoise.volume}%`;

  await refreshSounds();
  populateSoundSelect($('#setNoiseFile'), s.whiteNoise.file);
  populateSoundSelect($('#setNoiseBreakFile'), s.whiteNoise.breakFile);
  $('#settingsModal').hidden = false;
}

// 音源一覧を取り直す。デコード済みバッファは名前キーのため、同名で差し替えた
// ユーザー音源が古いバッファのまま鳴らないよう、ここで破棄して再デコードさせる。
async function refreshSounds() {
  soundsCache = await window.api.listSounds();
  noiseBuffers.clear();
}

// soundsCache から <option> を組み立てて選択状態を反映する
function populateSoundSelect(select, selectedName) {
  select.textContent = '';
  if (soundsCache.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '音源がありません';
    select.appendChild(opt);
    return;
  }
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(未選択)';
  select.appendChild(none);
  for (const snd of soundsCache) {
    const opt = document.createElement('option');
    opt.value = snd.name;
    opt.textContent = snd.name;
    if (snd.name === selectedName) opt.selected = true;
    select.appendChild(opt);
  }
}

// 開いていた画面の項目だけを差分として送る。全体を送り返すと、その間に他所で
// 変わった設定まで古い値で巻き戻してしまう。
async function saveSettings() {
  // 範囲はスキーマの許容範囲(SETTING_LIMITS)に丸め、読めない入力は今の値のまま
  const num = (sel, key, fallback) => {
    const [min, max] = SETTING_LIMITS[key];
    const v = parseInt($(sel).value, 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const s = data.settings;
  const patch = {
    workMin: num('#setWork', 'workMin', s.workMin),
    shortMin: num('#setShort', 'shortMin', s.shortMin),
    longMin: num('#setLong', 'longMin', s.longMin),
    longEvery: num('#setEvery', 'longEvery', s.longEvery),
    autoStartBreak: $('#setAutoBreak').checked,
    autoStartWork: $('#setAutoWork').checked,
    whiteNoise: {
      enabled: $('#setNoiseOn').checked,
      file: $('#setNoiseFile').value,
      breakFile: $('#setNoiseBreakFile').value,
      volume: parseInt($('#setNoiseVol').value, 10) || 0
    }
  };
  $('#settingsModal').hidden = true;
  const sent = mutate({ type: 'settings/update', patch });
  // 待機中の表示とノイズは要求中の値ですぐ合わせる(閉じてすぐ開始しても新しい長さで始まる)。
  const resync = () => {
    if (timer.status === 'idle') {
      timer.remainMs = modeDurationMs(timer.mode);
      timer.totalMs = timer.remainMs;
    }
    renderAll();
    updateNoise();
  };
  resync();
  await sent;
  // 反映後の正本から引き直す。main が丸めた値(範囲外の入力など)や、失敗して戻った値が効く。
  resync();
}

/* ============ 履歴 ============ */
function renderHistory() {
  const list = $('#historyList');
  list.textContent = '';
  const items = [...data.sessions].reverse();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'まだ記録がありません';
    list.appendChild(li);
    return;
  }
  const fmtTime = iso => fmtClock(new Date(iso));
  const fmtDay = iso => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
  };
  const sumMin = arr => Math.round(arr.reduce((s, x) => s + x.durationSec, 0) / 60);
  let curDay = null;
  for (const p of items) {
    const day = new Date(p.startedAt).toDateString();
    if (day !== curDay) {
      curDay = day;
      const sameDay = items.filter(x => new Date(x.startedAt).toDateString() === day);
      const work = sameDay.filter(x => x.mode === 'work');
      const breaks = sameDay.filter(x => x.mode !== 'work');
      const h = document.createElement('li');
      h.className = 'history-day';
      h.textContent = `${fmtDay(p.startedAt)} — ${work.filter(x => x.completed).length}🍅 · 集中${sumMin(work)}分 · 休憩${sumMin(breaks)}分`;
      list.appendChild(h);
    }
    const isWork = p.mode === 'work';
    const li = document.createElement('li');
    li.className = 'history-item' + (isWork ? '' : ' break');

    const head = document.createElement('div');
    head.className = 'history-head';
    const when = document.createElement('span');
    when.className = 'history-when';
    const tag = document.createElement('span');
    tag.className = 'history-mode';
    tag.textContent = MODE_LABEL[p.mode] || p.mode;
    when.append(tag, document.createTextNode(`${fmtTime(p.startedAt)} → ${fmtTime(p.endedAt)}`));
    const pauses = (p.intervals ? p.intervals.length : 1) - 1;
    if (pauses > 0) {
      const pz = document.createElement('span');
      pz.className = 'history-pause';
      pz.textContent = `⏸${pauses}`;
      pz.title = `一時停止 ${pauses}回`;
      when.appendChild(pz);
    }
    const dur = document.createElement('span');
    dur.className = 'history-dur';
    const min = Math.round(p.durationSec / 60);
    dur.innerHTML = `${min}分 <span class="${p.completed ? 'ok' : 'ng'}">${p.completed ? '完走' : '中断'}</span>`;
    head.append(when, dur);
    li.appendChild(head);

    const fmtMin = sec => { const m = Math.round(sec / 60); return m > 0 ? `${m}分` : '1分未満'; };
    if (isWork) {
      const tasksRow = document.createElement('div');
      tasksRow.className = 'history-tasks';
      for (const tt of p.taskTimes) {
        const chip = document.createElement('span');
        if (tt.taskId === null) {
          chip.className = 'chip empty';
          chip.textContent = `タスクなし · ${fmtMin(tt.durationSec)}`;
        } else {
          chip.className = 'chip';
          const t = data.tasks.find(t => t.id === tt.taskId);
          chip.textContent = `${t ? t.title : '(削除済み)'} · ${fmtMin(tt.durationSec)}`;
        }
        tasksRow.appendChild(chip);
      }
      li.appendChild(tasksRow);
    }
    list.appendChild(li);
  }
}

/* ============ タイムテーブル(1日ビュー) ============ */
const TL_PX_PER_MIN = 0.7;            // 1時間 ≈ 42px(現実的に1時間あたり約2.5ポモドーロ)。
                                     // 25分のフォーカスブロックは ≈17.5px となりラベル表示閾値(16px)を超える。
let timelineDay = startOfDay(new Date());

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// セッションの主タスク名(最も長く充てたタスク)。休憩はモード名。
function sessionLabel(s) {
  if (s.mode !== 'work') return MODE_LABEL[s.mode] || s.mode;
  const tt = (s.taskTimes || []).filter(x => x.taskId).sort((a, b) => b.durationSec - a.durationSec)[0];
  if (!tt) return 'フォーカス';
  const t = data.tasks.find(t => t.id === tt.taskId);
  return t ? t.title : '(削除済み)';
}

// 指定日に重なる実働区間を、その日の枠[0:00, 翌0:00)にクリップして列挙する。
// startMin/endMin は当日0:00からの分。日をまたぐ区間も正しく扱える。
// 注: タイムテーブルは「0:00〜翌0:00 の壁時計軸」を前提とする。本アプリの対象である
// JST など DST の無いタイムゾーンでは厳密に正しい。DST 切替日(23/25時間)は対象外。
function dayBlocks(day) {
  const dayStart = day.getTime();
  const next = new Date(day);
  next.setDate(next.getDate() + 1);                      // ローカル日付の翌0:00
  const dayEnd = next.getTime();
  const wallMin = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
  const out = [];
  for (const s of data.sessions) {
    for (const iv of sessionIntervals(s)) {
      const st = new Date(iv.startedAt).getTime();
      const en = new Date(iv.endedAt).getTime();
      if (!(st < dayEnd && en > dayStart)) continue;     // 当日に重ならない
      const cs = Math.max(st, dayStart);                 // 当日枠にクリップ
      const ce = Math.min(en, dayEnd);
      if (ce <= cs) continue;                            // 0分/不正区間は除外
      out.push({
        session: s,
        startMin: cs === dayStart ? 0 : wallMin(cs),
        endMin: ce === dayEnd ? 1440 : wallMin(ce),
        trueStart: new Date(st),
        trueEnd: new Date(en),
        spansIn: st < dayStart,                          // 前日から継続
        spansOut: en > dayEnd                            // 翌日へ継続
      });
    }
  }
  return out;
}

function renderTimeline() {
  const body = $('#timelineBody');
  body.textContent = '';
  $('#tlDate').textContent =
    `${timelineDay.getFullYear()}/${timelineDay.getMonth() + 1}/${timelineDay.getDate()} (${WEEKDAYS[timelineDay.getDay()]})`;

  const blocks = dayBlocks(timelineDay);

  // 1日を常に 0〜24 時で表示する(記録の有無や範囲に依らず固定)
  const startHour = 0;
  const endHour = 24;
  const rangeStartMin = startHour * 60;
  const totalMin = (endHour - startHour) * 60;

  const grid = document.createElement('div');
  grid.className = 'timeline-grid';
  grid.style.height = (totalMin * TL_PX_PER_MIN) + 'px';

  if (blocks.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note timeline-empty';
    note.textContent = 'この日の記録はありません';
    grid.appendChild(note);
  }

  for (let h = startHour; h <= endHour; h++) {
    const line = document.createElement('div');
    line.className = 'timeline-hour';
    line.style.top = ((h * 60 - rangeStartMin) * TL_PX_PER_MIN) + 'px';
    const lab = document.createElement('span');
    lab.className = 'timeline-hour-label';
    lab.textContent = String(h % 24).padStart(2, '0') + ':00';
    line.appendChild(lab);
    grid.appendChild(line);
  }

  for (const b of blocks) {
    const top = (b.startMin - rangeStartMin) * TL_PX_PER_MIN;
    const height = Math.max(3, (b.endMin - b.startMin) * TL_PX_PER_MIN);
    const el = document.createElement('div');
    el.className = 'timeline-block' + (b.session.mode === 'work' ? '' : ' break');
    el.style.top = top + 'px';
    el.style.height = height + 'px';
    // 低すぎるブロックはラベルが潰れるので省略(詳細は title で保持)
    const cont = (b.spansIn ? '↑' : '') + (b.spansOut ? '↓' : '');
    if (height >= 16) el.textContent = (cont ? cont + ' ' : '') + sessionLabel(b.session);
    el.title = `${MODE_LABEL[b.session.mode] || b.session.mode} ${fmtClock(b.trueStart)}–${fmtClock(b.trueEnd)} · ${sessionLabel(b.session)}`;
    grid.appendChild(el);
  }
  body.appendChild(grid);

  // 0〜24 時の全域は縦に長いため、見せたい位置までスクロールする。
  // 記録があれば最初のブロック、無ければグリッド中央(.timeline-empty の位置)に合わせる。
  const focusMin = blocks.length > 0
    ? Math.min(...blocks.map(b => b.startMin))
    : (rangeStartMin + totalMin / 2);
  body.scrollTop = Math.max(0, (focusMin - rangeStartMin) * TL_PX_PER_MIN - 40);
}

function openTimeline() {
  timelineDay = startOfDay(new Date());
  // 先にモーダルを表示してから描画する。display:none のままだと
  // renderTimeline 内の scrollTop 設定が無視され、初回が 0:00 起点になるため。
  $('#timelineModal').hidden = false;
  renderTimeline();
}

function shiftTimelineDay(days) {
  const d = new Date(timelineDay);
  d.setDate(d.getDate() + days);                         // ローカル日付で前後(月跨ぎも安全)
  timelineDay = startOfDay(d);
  renderTimeline();
}

/* ============ 統計 ============ */
// 集計は shared/stats.js(純粋関数)に任せ、ここは描くだけ。
let statsDays = 7;

// 秒 → "1時間20分" / "45分"
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`;
}

const fmtMonthDay = d => `${d.getMonth() + 1}/${d.getDate()}`;

function statTile(label, value, sub) {
  const el = document.createElement('div');
  el.className = 'stats-kpi';
  const l = document.createElement('span');
  l.className = 'stats-kpi-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'stats-kpi-value';
  // 数字だけを大きく、単位は小さく(「52時間49分」でもタイルに収まるように)
  for (const part of value.match(/\d+(?:\.\d+)?|\D+/g) || []) {
    if (/^\d/.test(part)) v.appendChild(document.createTextNode(part));
    else {
      const u = document.createElement('small');
      u.textContent = part;
      v.appendChild(u);
    }
  }
  el.append(l, v);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'stats-kpi-sub';
    s.textContent = sub;
    el.appendChild(s);
  }
  return el;
}

function renderStats() {
  const today = startOfDay(new Date());
  const cur = summarizeStats(data.sessions, { end: today, days: statsDays });
  const prev = summarizeStats(data.sessions, { end: addLocalDays(today, -statsDays), days: statsDays });

  document.querySelectorAll('#statsRange button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.days) === statsDays);
  });
  const lastDay = new Date(cur.days[cur.days.length - 1].start);
  $('#statsPeriod').textContent = `${fmtMonthDay(new Date(cur.start))} 〜 ${fmtMonthDay(lastDay)}`;

  /* --- KPI --- */
  const kpis = $('#statsKpis');
  kpis.textContent = '';
  const diffMin = Math.round((cur.focusSec - prev.focusSec) / 60);
  const vsPrev = prev.focusSec === 0 ? '前の期間は記録なし'
    : `前の${statsDays}日より ${diffMin >= 0 ? '+' : '−'}${fmtDur(Math.abs(diffMin) * 60)}`;
  const streak = currentStreak(data.sessions, today);
  kpis.append(
    statTile('集中時間', fmtDur(cur.focusSec), vsPrev),
    statTile('完了ポモドーロ', `${cur.pomos}🍅`, `1日平均 ${(cur.pomos / statsDays).toFixed(1)}`),
    statTile('完走率', cur.completionRate === null ? '—' : `${Math.round(cur.completionRate * 100)}%`,
      `${cur.workCount}回中 ${cur.pomos}回`),
    statTile('連続日数', `${streak}日`, `記録のあった日 ${cur.activeDays}/${statsDays}`)
  );

  /* --- 日別の集中時間 --- */
  const bars = $('#statsBars');
  bars.textContent = '';
  bars.classList.toggle('dense', statsDays > 31);
  const maxSec = Math.max(...cur.days.map(d => d.focusSec));
  const todayMs = today.getTime();
  for (const d of cur.days) {
    const day = new Date(d.start);
    const col = document.createElement('div');
    col.className = 'stats-bar-col' + (d.start === todayMs ? ' today' : '');
    col.title = `${fmtMonthDay(day)} (${WEEKDAYS[day.getDay()]}) ${fmtDur(d.focusSec)} · ${d.pomos}🍅`;
    const track = document.createElement('div');
    track.className = 'stats-bar-track';
    const bar = document.createElement('div');
    bar.className = 'stats-bar';
    bar.style.height = maxSec > 0 ? `${(d.focusSec / maxSec) * 100}%` : '0';
    track.appendChild(bar);
    const lab = document.createElement('span');
    lab.className = 'stats-bar-label';
    // 7日は曜日、それ以上は月曜だけ日付を出す(全部出すと詰まって読めない)
    if (statsDays <= 7) lab.textContent = WEEKDAYS[day.getDay()];
    else if (day.getDay() === 1) lab.textContent = fmtMonthDay(day);
    col.append(track, lab);
    bars.appendChild(col);
  }
  if (maxSec === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note stats-empty';
    note.textContent = 'この期間の記録はありません';
    bars.appendChild(note);
  }

  /* --- 時間帯 --- */
  const hoursEl = $('#statsHours');
  hoursEl.textContent = '';
  const maxHour = Math.max(...cur.hours);
  cur.hours.forEach((sec, h) => {
    const cell = document.createElement('div');
    cell.className = 'stats-hour';
    // 0 と僅かな値を見分けられるよう、記録があれば下限の濃さを付ける
    cell.style.setProperty('--level', sec > 0 && maxHour > 0 ? String(0.15 + 0.85 * (sec / maxHour)) : '0');
    cell.title = `${h}時台 ${fmtDur(sec)}`;
    if (h % 6 === 0) {
      const lab = document.createElement('span');
      lab.textContent = String(h);
      cell.appendChild(lab);
    }
    hoursEl.appendChild(cell);
  });

  /* --- タスク別 --- */
  const list = $('#statsTasks');
  list.textContent = '';
  if (cur.tasks.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'この期間の記録はありません';
    list.appendChild(li);
    return;
  }
  const TOP = 6;
  const rows = cur.tasks.slice(0, TOP);
  const rest = cur.tasks.slice(TOP).reduce((s, t) => s + t.sec, 0);
  const total = cur.tasks.reduce((s, t) => s + t.sec, 0);
  const label = id => {
    if (id === null) return 'タスクなし';
    const t = data.tasks.find(t => t.id === id);
    return t ? t.title : '(削除済み)';
  };
  const items = rows.map(r => ({ name: label(r.taskId), sec: r.sec, muted: r.taskId === null }));
  if (rest > 0) items.push({ name: `その他 ${cur.tasks.length - TOP}件`, sec: rest, muted: true });
  // 「その他」は束ねた合計なので先頭より長くなりうる。棒は並んだ中の最大に合わせる
  const maxItem = Math.max(...items.map(it => it.sec));
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'stats-task' + (it.muted ? ' muted' : '');
    const name = document.createElement('span');
    name.className = 'stats-task-name';
    name.textContent = it.name;
    const val = document.createElement('span');
    val.className = 'stats-task-val';
    val.textContent = `${fmtDur(it.sec)} · ${Math.round((it.sec / total) * 100)}%`;
    const track = document.createElement('div');
    track.className = 'stats-task-track';
    const bar = document.createElement('div');
    bar.className = 'stats-task-bar';
    bar.style.width = `${(it.sec / maxItem) * 100}%`;
    track.appendChild(bar);
    li.append(name, val, track);
    list.appendChild(li);
  }
}

function openStats() {
  renderStats();
  $('#statsModal').hidden = false;
}

/* ============ トースト ============ */
let toastTimer = null;
// 表示中の操作付きトースト(取り消しなど)。トーストは一枚なので、その間に届いた
// 通知(保存失敗など)で上書きすると、操作できる唯一のボタンが消える。操作の
// 期限までは、新しい文言に差し替えてもボタンは残す。
let toastAction = null;            // { action, until }
function toast(msg, action) {
  const el = $('#toast');
  const now = Date.now();
  if (!action && toastAction && toastAction.until > now) action = toastAction.action;
  else toastAction = action ? { action, until: now + 6000 } : null;
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.hidden = true;
      toastAction = null;
      action.fn();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  // 操作付きは操作の期限まで出す(通知で差し替えても期限は延ばさない)。
  const ms = toastAction ? Math.max(3000, toastAction.until - now) : 3000;
  toastTimer = setTimeout(() => { el.hidden = true; toastAction = null; }, ms);
}

/* ============ 音源試聴 ============ */
let previewTimer = null;
function previewSound(selectSel) {
  const name = $(selectSel).value;
  const sound = soundsCache.find(s => s.name === name);
  if (!sound) return;
  startNoise(sound.name, (parseInt($('#setNoiseVol').value, 10) || 0) / 100);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => updateNoise(), 3000);
}

/* ============ エクスポート ============ */
async function doExport(format) {
  $('#exportMenu').hidden = true;
  const res = await window.api.exportData(format);   // 中身は main が持つ正本を使う
  if (res.saved) toast(`エクスポートしました: ${res.filePath}`);
  else if (res.error) toast(`エクスポートに失敗しました: ${res.error}`);
}

/* ============ イベント ============ */
$('#taskForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#taskInput').value.trim();
  if (!v) return;
  addTask(v);
  $('#taskInput').value = '';
});

$('#startBtn').addEventListener('click', startPauseResume);
$('#stopBtn').addEventListener('click', stopEarly);
$('#skipBtn').addEventListener('click', skipBreak);
$('#previewBtn').addEventListener('click', () => previewSound('#setNoiseFile'));
$('#previewBreakBtn').addEventListener('click', () => previewSound('#setNoiseBreakFile'));
// 応答待ちの間の切り替えは、最後に確定した正本ではなく要求中の値から反転する
// (正本を反転すると、応答前の二度押しが同じ値を二回送って一回分に潰れる)。
$('#noiseIndicator').addEventListener('click', () => {
  const enabled = !data.settings.whiteNoise.enabled;
  const sent = mutate({ type: 'settings/update', patch: { whiteNoise: { enabled } } });
  updateNoise();
  sent.then(() => updateNoise());
});

// Space: 開始/一時停止、Esc: モーダル・メニューを閉じる
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const openModal = document.querySelector('.modal-backdrop:not([hidden])');
    document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(m => { m.hidden = true; });
    $('#exportMenu').hidden = true;
    if (openModal) updateNoise();
    return;
  }
  if (e.code === 'Space' &&
      !e.target.closest('input, select, textarea, button') &&
      !document.querySelector('.modal-backdrop:not([hidden])')) {
    e.preventDefault();
    startPauseResume();
  }
});

$('#toggleDone').addEventListener('click', () => {
  const list = $('#doneList');
  list.hidden = !list.hidden;
  $('#toggleDone').textContent = list.hidden ? '表示' : '隠す';
});

$('#settingsBtn').addEventListener('click', openSettings);
$('#openSoundsDir').addEventListener('click', async () => {
  await window.api.openSoundsDir();
  // フォルダに追加した音源を即座に選べるよう、一覧を取り直して反映する
  await refreshSounds();
  populateSoundSelect($('#setNoiseFile'), $('#setNoiseFile').value);
  populateSoundSelect($('#setNoiseBreakFile'), $('#setNoiseBreakFile').value);
});
$('#settingsSave').addEventListener('click', saveSettings);
$('#settingsCancel').addEventListener('click', () => {
  $('#settingsModal').hidden = true;
  updateNoise();
});
$('#setNoiseVol').addEventListener('input', e => {
  $('#volLabel').textContent = `${e.target.value}%`;
  // 再生中なら即時反映(キャンセル時は updateNoise で設定値に戻る)
  if (noiseSrc) rampGain((parseInt(e.target.value, 10) || 0) / 100, 0.05);
});

$('#historyBtn').addEventListener('click', () => {
  renderHistory();
  $('#historyModal').hidden = false;
});
$('#historyClose').addEventListener('click', () => { $('#historyModal').hidden = true; });

$('#statsBtn').addEventListener('click', openStats);
$('#statsClose').addEventListener('click', () => { $('#statsModal').hidden = true; });
$('#statsRange').addEventListener('click', e => {
  const btn = e.target.closest('button[data-days]');
  if (!btn) return;
  statsDays = Number(btn.dataset.days);
  renderStats();
});

$('#timelineBtn').addEventListener('click', openTimeline);
$('#timelineClose').addEventListener('click', () => { $('#timelineModal').hidden = true; });
$('#tlPrev').addEventListener('click', () => shiftTimelineDay(-1));
$('#tlNext').addEventListener('click', () => shiftTimelineDay(1));
$('#tlToday').addEventListener('click', openTimeline);

$('#exportBtn').addEventListener('click', () => {
  $('#exportMenu').hidden = !$('#exportMenu').hidden;
});
$('#exportMenu').addEventListener('click', e => {
  const btn = e.target.closest('button[data-format]');
  if (btn) doExport(btn.dataset.format);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.export-wrap')) $('#exportMenu').hidden = true;
});

document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target !== m) return;
    m.hidden = true;
    updateNoise();
  });
});

// アプリ終了・リロード時、実行中のセッションを中断として記録(1分以上のもの)。
// 変更は意図ごとに即ディスクへ乗っているので、ここで丸ごと保存し直す必要はない。
// 残るのはこの打ち切り記録だけで、終了(Tray「終了」/Cmd+Q)でレンダラが破棄される
// 前に書き終えるため同期 IPC でブロッキングする。
window.addEventListener('beforeunload', () => {
  // 書けたと確認できていない記録と進行状態を、送信中のものも含めて送る(失敗の
  // 応答はもう受け取れない。記録の重複は main が弾き、進行状態は最新値で上書き)。
  for (const p of pending) if (p.durable) window.api.mutateSync(p.action);
  // 応答待ちの意図で付けた内訳は、決着を待てないので main の今の正本の選択で付け直す
  // (送った意図はすべて反映済み)。待っていた記録も実行中の記録も、そのあとで送る。
  // 選択を続けて変えていた場合は、どれも最後の正本の選択に寄る。
  if (unsettled.size) {
    const snap = window.api.snapshotSync();
    if (snap) for (const s of unsettled) settleSegments(s, snap.selectedTaskId);
  }
  for (const rec of heldRecords.splice(0)) window.api.mutateSync(sessionAction(rec));
  if (timer.current) recordSession(false, true);
});

// 初期化が済んだ印(スモークテストはこれを待ってから操作する)。失敗しても付けて、
// テストがタイムアウトではなく収集したページエラーで落ちるようにする。
init().finally(() => { document.documentElement.dataset.ready = 'true'; });
