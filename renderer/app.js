const $ = sel => document.querySelector(sel);

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

let data = { tasks: [], sessions: [], settings: { ...DEFAULT_SETTINGS }, selectedTaskId: null };
let soundsCache = [];

// timer.current: 実行中セッション
//   { id, mode, startedAt, intervals: [{startedAt,endedAt}], intStartAt, segments, segTaskId, segStartMs }
// intervals は一時停止で区切られた実働区間。タイムブロックへの plot 用に壁時計の絶対時刻を保持する。
const timer = {
  mode: 'work',          // 'work' | 'short' | 'long'
  status: 'idle',        // 'idle' | 'running' | 'paused'
  totalMs: 0,
  endAt: 0,
  remainMs: 0,
  intervalId: null,
  cycle: 0,              // 長休憩までの完了ポモドーロ数
  current: null
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const save = () => window.api.saveData(data);

const MODE_LABEL = { work: 'フォーカス', short: '小休憩', long: '長休憩' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const RING_LEN = 2 * Math.PI * 132;

// セッションの実働区間(古い記録は span をフォールバック)
const sessionIntervals = s => (s.intervals && s.intervals.length ? s.intervals : [{ startedAt: s.startedAt, endedAt: s.endedAt }]);
// Date → "HH:MM"
const fmtClock = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function modeDurationMs(mode) {
  const s = data.settings;
  const min = mode === 'work' ? s.workMin : mode === 'short' ? s.shortMin : s.longMin;
  return min * 60 * 1000;
}

// 旧 data.pomodoros(フォーカスのみ・区間情報なし)を sessions 形式へ移行
function migrateSessions(loaded) {
  if (Array.isArray(loaded.sessions)) return loaded.sessions;
  return (loaded.pomodoros || []).map(p => ({
    ...p,
    mode: p.mode || 'work',
    taskIds: p.taskIds || [],
    taskTimes: p.taskTimes || [],
    // 旧データは一時停止構造が復元不能。実働区間を durationSec 長に揃え、
    // sum(intervals) === durationSec を保つ(plot で実働を過大計上しない)。
    intervals: p.intervals && p.intervals.length
      ? p.intervals
      : [{
          startedAt: p.startedAt,
          endedAt: new Date(new Date(p.startedAt).getTime() + (p.durationSec || 0) * 1000).toISOString()
        }]
  }));
}

/* ============ 初期化 ============ */
async function init() {
  const loaded = await window.api.loadData();
  if (loaded) {
    data = {
      tasks: loaded.tasks || [],
      sessions: migrateSessions(loaded),
      selectedTaskId: loaded.selectedTaskId || null,
      settings: {
        ...DEFAULT_SETTINGS,
        ...loaded.settings,
        whiteNoise: { ...DEFAULT_SETTINGS.whiteNoise, ...(loaded.settings || {}).whiteNoise }
      }
    };
    const sel = data.tasks.find(t => t.id === data.selectedTaskId);
    if (!sel || sel.completed) data.selectedTaskId = null;
  }
  soundsCache = await window.api.listSounds();
  timer.remainMs = modeDurationMs(timer.mode);
  timer.totalMs = timer.remainMs;
  renderAll();
  if (Notification.permission === 'default') Notification.requestPermission();
}

function renderAll() {
  renderTasks();
  renderTimer();
  renderFocusTask();
  renderCycleDots();
  renderTodayCount();
}

/* ============ タスク ============ */
function taskStats(taskId) {
  let pomos = 0, sec = 0;
  for (const p of data.sessions) {
    if (p.completed && p.taskIds.includes(taskId)) pomos++;
    for (const tt of p.taskTimes) if (tt.taskId === taskId) sec += tt.durationSec;
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
    li.title = isSelected ? 'クリックでセット解除' : 'クリックでフォーカス対象にセット';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', String(isSelected));
    li.addEventListener('click', e => {
      if (e.target.closest('button, input')) return;
      selectTask(isSelected ? null : t.id);
    });
    li.addEventListener('keydown', e => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        selectTask(isSelected ? null : t.id);
      }
    });
  }

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'task-check';
  check.checked = t.completed;
  check.title = t.completed ? '未完了に戻す' : '完了にする';
  check.addEventListener('change', () => toggleTaskDone(t.id));

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
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== t.title) {
      t.title = v;
      save();
    }
    renderTasks();
    renderFocusTask();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      done = true;
      renderTasks();
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
  data.tasks.unshift(task);
  save();
  renderTasks();
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
}
function closeInterval() {
  const c = timer.current;
  if (!c || !c.intStartAt) return;
  c.intervals.push({
    startedAt: new Date(c.intStartAt).toISOString(),
    endedAt: new Date().toISOString()
  });
  c.intStartAt = null;
}

// 現在のセグメントを確定して segments に積む
function closeSegment() {
  const c = timer.current;
  if (!c) return;
  const durMs = pomoElapsedMs() - c.segStartMs;
  if (durMs >= 1000) c.segments.push({ taskId: c.segTaskId, durationSec: Math.round(durMs / 1000) });
}

// タスク切り替え地点でセグメントを区切る(タイマーは止めない)
function switchSegment(taskId) {
  const c = timer.current;
  if (!c || c.mode !== 'work' || c.segTaskId === (taskId || null)) return;
  closeSegment();
  c.segTaskId = taskId || null;
  c.segStartMs = pomoElapsedMs();
}

// フォーカス対象タスクの選択(アイドル中=次のポモドーロ用、実行中=即時切り替え)
function selectTask(taskId) {
  data.selectedTaskId = taskId;
  switchSegment(taskId);
  save();
  renderTasks();
  renderFocusTask();
}

function toggleTaskDone(id) {
  const t = data.tasks.find(t => t.id === id);
  if (!t) return;
  t.completed = !t.completed;
  t.completedAt = t.completed ? new Date().toISOString() : null;
  // 完了したら選択解除(完了までの時間はセグメントとして記録済み)
  if (t.completed && data.selectedTaskId === id) {
    data.selectedTaskId = null;
    switchSegment(null);
    toast(`「${t.title}」を完了しました 🎉`);
  }
  save();
  renderTasks();
  renderFocusTask();
}

function deleteTask(id) {
  const idx = data.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const t = data.tasks[idx];
  const undo = {
    task: t,
    index: idx,
    wasSelected: data.selectedTaskId === id,
    pomoPatches: [],
    segPatches: []
  };
  data.tasks.splice(idx, 1);
  for (const p of data.sessions) {
    p.taskIds = p.taskIds.filter(tid => tid !== id);
    (p.taskTimes || []).forEach((tt, i) => {
      if (tt.taskId === id) {
        tt.taskId = null;
        undo.pomoPatches.push({ p, i });
      }
    });
  }
  if (timer.current) {
    for (const s of timer.current.segments) {
      if (s.taskId === id) {
        s.taskId = null;
        undo.segPatches.push(s);
      }
    }
    if (timer.current.segTaskId === id) switchSegment(null);
  }
  if (data.selectedTaskId === id) data.selectedTaskId = null;
  save();
  renderTasks();
  renderFocusTask();
  toast(`「${t.title}」を削除しました`, { label: '元に戻す', fn: () => restoreTask(undo) });
}

function restoreTask(u) {
  data.tasks.splice(Math.min(u.index, data.tasks.length), 0, u.task);
  for (const { p, i } of u.pomoPatches) {
    p.taskTimes[i].taskId = u.task.id;
    if (!p.taskIds.includes(u.task.id)) p.taskIds.push(u.task.id);
  }
  for (const s of u.segPatches) s.taskId = u.task.id;
  if (u.wasSelected && !u.task.completed) data.selectedTaskId = u.task.id;
  if (u.wasSelected) switchSegment(data.selectedTaskId);
  save();
  renderTasks();
  renderFocusTask();
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
  $('#phaseLabel').textContent =
    timer.status === 'running' ? MODE_LABEL[timer.mode] + '中' :
    timer.status === 'paused' ? '一時停止中' : '準備完了';

  $('#startBtn').textContent =
    timer.status === 'running' ? '一時停止' :
    timer.status === 'paused' ? '再開' : '開始';
  $('#stopBtn').hidden = timer.status === 'idle';
  $('#skipBtn').hidden = timer.mode === 'work';

  document.querySelectorAll('#modeTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === timer.mode);
    b.disabled = timer.status !== 'idle';
  });

  document.body.classList.toggle('focusing', timer.status === 'running' && timer.mode === 'work');
}

function renderCycleDots() {
  const wrap = $('#cycleDots');
  wrap.textContent = '';
  const every = data.settings.longEvery;
  for (let i = 0; i < every; i++) {
    const dot = document.createElement('i');
    if (i < timer.cycle % every || (timer.cycle > 0 && timer.cycle % every === 0)) dot.classList.add('on');
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
      segTaskId: timer.mode === 'work' ? (data.selectedTaskId || null) : null,
      segStartMs: 0
    };
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
  finishSession(false);
}

// 実行中セッション(フォーカス/休憩)を記録に積む(1分未満の中断は記録しない)
function recordSession(completed) {
  const c = timer.current;
  if (!c) return;
  closeInterval();
  const activeMs = c.intervals.reduce((s, iv) => s + (new Date(iv.endedAt) - new Date(iv.startedAt)), 0);
  const elapsedSec = Math.round(activeMs / 1000);
  if (!completed && elapsedSec < 60) return;

  let taskTimes = [], taskIds = [];
  if (c.mode === 'work') {
    closeSegment();
    // セグメントをタスク別に集計
    const byTask = new Map();
    for (const s of c.segments) byTask.set(s.taskId, (byTask.get(s.taskId) || 0) + s.durationSec);
    taskTimes = [...byTask.entries()].map(([taskId, durationSec]) => ({ taskId, durationSec }));
    taskIds = taskTimes.filter(tt => tt.taskId).map(tt => tt.taskId);
  }
  data.sessions.push({
    id: c.id,
    mode: c.mode,
    startedAt: c.startedAt,
    endedAt: c.intervals.length ? c.intervals[c.intervals.length - 1].endedAt : new Date().toISOString(),
    durationSec: elapsedSec,
    completed,
    intervals: c.intervals,
    taskIds,
    taskTimes
  });
  save();
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
  clearInterval(timer.intervalId);
  // スキップ時点までの休憩は実時間として記録(1分未満は破棄)
  if (timer.current) recordSession(false);
  timer.current = null;
  timer.status = 'idle';
  timer.mode = 'work';
  timer.remainMs = modeDurationMs('work');
  timer.totalMs = timer.remainMs;
  renderAll();
  updateNoise();
}

function setMode(mode) {
  if (timer.status !== 'idle') return;
  timer.mode = mode;
  timer.remainMs = modeDurationMs(mode);
  timer.totalMs = timer.remainMs;
  renderTimer();
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
    check.addEventListener('click', () => toggleTaskDone(t.id));

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

    const choose = it => {
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

  soundsCache = await window.api.listSounds();
  populateSoundSelect($('#setNoiseFile'), s.whiteNoise.file);
  populateSoundSelect($('#setNoiseBreakFile'), s.whiteNoise.breakFile);
  $('#settingsModal').hidden = false;
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

function saveSettings() {
  const num = (sel, min, max, fallback) => {
    const v = parseInt($(sel).value, 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const s = data.settings;
  s.workMin = num('#setWork', 1, 120, s.workMin);
  s.shortMin = num('#setShort', 1, 60, s.shortMin);
  s.longMin = num('#setLong', 1, 90, s.longMin);
  s.longEvery = num('#setEvery', 1, 12, s.longEvery);
  s.autoStartBreak = $('#setAutoBreak').checked;
  s.autoStartWork = $('#setAutoWork').checked;
  s.whiteNoise.enabled = $('#setNoiseOn').checked;
  s.whiteNoise.file = $('#setNoiseFile').value;
  s.whiteNoise.breakFile = $('#setNoiseBreakFile').value;
  s.whiteNoise.volume = parseInt($('#setNoiseVol').value, 10) || 0;
  save();
  if (timer.status === 'idle') {
    timer.remainMs = modeDurationMs(timer.mode);
    timer.totalMs = timer.remainMs;
  }
  $('#settingsModal').hidden = true;
  renderAll();
  updateNoise();
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
const TL_PX_PER_MIN = 1.4;            // 1時間 ≈ 84px
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
  if (blocks.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'この日の記録はありません';
    body.appendChild(note);
    return;
  }

  let lo = Infinity, hi = -Infinity;
  for (const b of blocks) { lo = Math.min(lo, b.startMin); hi = Math.max(hi, b.endMin); }
  const startHour = Math.floor(lo / 60);
  const endHour = Math.min(24, Math.ceil(hi / 60));
  const rangeStartMin = startHour * 60;
  const totalMin = Math.max(60, (endHour - startHour) * 60);

  const grid = document.createElement('div');
  grid.className = 'timeline-grid';
  grid.style.height = (totalMin * TL_PX_PER_MIN) + 'px';

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
}

function openTimeline() {
  timelineDay = startOfDay(new Date());
  renderTimeline();
  $('#timelineModal').hidden = false;
}

function shiftTimelineDay(days) {
  const d = new Date(timelineDay);
  d.setDate(d.getDate() + days);                         // ローカル日付で前後(月跨ぎも安全)
  timelineDay = startOfDay(d);
  renderTimeline();
}

/* ============ トースト ============ */
let toastTimer = null;
function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.hidden = true;
      action.fn();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
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
  const res = await window.api.exportData(format, data);
  if (res.saved) toast(`エクスポートしました: ${res.filePath}`);
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
$('#noiseIndicator').addEventListener('click', () => {
  data.settings.whiteNoise.enabled = !data.settings.whiteNoise.enabled;
  save();
  updateNoise();
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

$('#modeTabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setMode(btn.dataset.mode);
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
  soundsCache = await window.api.listSounds();
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

// アプリ終了・リロード時、実行中のセッションを中断として記録(1分以上のもの)
window.addEventListener('beforeunload', () => {
  if (timer.current) recordSession(false);
});

init();
