// ミニタイマー。常に手前に置く小さな窓で、残り時間と、いまのタスクだけを見せる。
import { render } from 'preact';
import './mini.css';
import { fmtClock, timerView } from '../core/derive.ts';
import { KIND_LABEL } from '../core/model.ts';
import { send, setSnapshot, useData, useNow } from './store.ts';

function Mini() {
  const data = useData();
  const now = useNow(data.run?.open != null);
  const view = timerView(data, now);
  const active = data.tasks.find(t => t.id === data.activeTaskId);
  const line = view.kind !== 'focus' ? KIND_LABEL[view.kind] : active?.title ?? KIND_LABEL.focus;

  return (
    <div class="mini" data-kind={view.kind} data-status={view.status} onDblClick={() => window.api.showMain()}>
      <div class="mini-fill" style={{ width: `${view.progress * 100}%` }} />
      <div class="mini-text">
        <div class="mini-clock" id="miniClock">{fmtClock(view.remainingMs)}</div>
        <div class="mini-line" id="miniLine">{view.status === 'paused' ? '一時停止中' : line}</div>
      </div>
      <button class="mini-btn" id="miniToggle" onClick={() => send({ type: 'timer/toggle' })} aria-label={view.status === 'running' ? '一時停止' : '始める'}>
        {view.status === 'running' ? '❙❙' : '▶'}
      </button>
      <button class="mini-close" onClick={() => window.api.toggleMini()} aria-label="ミニタイマーを閉じる">×</button>
    </div>
  );
}

void window.api.getState().then(first => {
  setSnapshot(first);
  window.api.onState(setSnapshot);
  render(<Mini />, document.getElementById('root')!);
  document.documentElement.dataset.ready = 'true';
});
