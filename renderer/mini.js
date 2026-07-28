const $ = sel => document.querySelector(sel);
const RING_LEN = 2 * Math.PI * 42;
const MODE_LABEL = { work: 'フォーカス', short: '小休憩', long: '長休憩' };

function render(s) {
  $('#time').textContent = `${s.mm}:${s.ss}`;
  document.body.classList.toggle('break', s.mode !== 'work');

  const ratio = typeof s.ratio === 'number' ? s.ratio : 1;
  $('#ringFg').style.strokeDashoffset = String(RING_LEN * (1 - ratio));
  $('#ringFg').style.strokeDasharray = String(RING_LEN);

  $('#phase').textContent =
    s.status === 'running' ? MODE_LABEL[s.mode] + '中' :
    s.status === 'paused' ? '一時停止中' :
    s.mode === 'work' ? '準備完了' : MODE_LABEL[s.mode];

  $('#startBtn').textContent = s.status === 'running' ? '⏸' : '▶';
  $('#skipBtn').disabled = s.mode === 'work' || s.status === 'idle';
  $('#stopBtn').disabled = s.status === 'idle';
}

window.api.onTimerState(render);

$('#startBtn').addEventListener('click', () => window.api.sendUiCommand('toggle'));
$('#skipBtn').addEventListener('click', () => window.api.sendUiCommand('skip'));
$('#stopBtn').addEventListener('click', () => window.api.sendUiCommand('stop'));
