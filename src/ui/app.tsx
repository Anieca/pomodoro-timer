import { useEffect, useState } from 'preact/hooks';
import { startOfDay } from '../core/derive.ts';
import { DayRail, Stage, TaskPane } from './now.tsx';
import { Review } from './review.tsx';
import { Settings } from './settings.tsx';
import { dismissToast, hostNow, send, useData, useToasts } from './store.ts';

type View = 'now' | 'review';

const isTyping = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function App() {
  const data = useData();
  const [view, setView] = useState<View>('now');
  const [reviewDay, setReviewDay] = useState(() => startOfDay(hostNow()));
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ポインタもキーも動かないまま数秒たったら、主役以外を消す(動かせば戻る)
  const [still, setStill] = useState(false);
  useEffect(() => {
    let timer = 0;
    const wake = (): void => {
      setStill(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setStill(true), 2600);
    };
    wake();
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const ev of events) window.addEventListener(ev, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, wake);
    };
  }, []);

  const openReview = (day: number): void => { setReviewDay(startOfDay(day)); setView('review'); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false);
        else if (isTyping(e.target)) (e.target as HTMLElement).blur();
        return;
      }
      if (mod && e.key === '1') { setView('now'); e.preventDefault(); return; }
      if (mod && e.key === '2') { openReview(hostNow()); e.preventDefault(); return; }
      if (mod && e.key === ',') { setSettingsOpen(v => !v); e.preventDefault(); return; }
      if (mod || e.altKey || isTyping(e.target) || settingsOpen) return;
      if (e.key === ' ') {
        // ボタンにフォーカスがあるときの Space は、そのボタンのもの
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        send({ type: 'timer/toggle' });
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setView('now');
        requestAnimationFrame(() => document.getElementById('newTask')?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  return (
    <div
      class="shell"
      data-view={view}
      data-kind={data.run?.kind ?? data.next}
      data-status={!data.run ? 'idle' : data.run.open ? 'running' : 'paused'}
      // 動いている間は空間ごと沈み、主役以外は退く(「いま」の画面だけ)
      data-immersed={view === 'now' && !settingsOpen && data.run?.open ? (data.run.kind === 'focus' ? 'focus' : 'rest') : undefined}
      data-still={still || undefined}
    >
      <header class="bar recede">
        <nav class="views" aria-label="表示">
          <button class="view-tab" aria-pressed={view === 'now'} onClick={() => setView('now')}>いま</button>
          <button class="view-tab" aria-pressed={view === 'review'} onClick={() => openReview(hostNow())}>ふりかえり</button>
        </nav>
        <button class="quiet" onClick={() => setSettingsOpen(true)} id="openSettings">設定</button>
      </header>

      {view === 'now' ? (
        <div class="now">
          <TaskPane data={data} />
          <Stage data={data} />
          <DayRail data={data} />
        </div>
      ) : (
        <Review data={data} day={reviewDay} onDay={setReviewDay} />
      )}

      {settingsOpen && <Settings data={data} onClose={() => setSettingsOpen(false)} />}
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div class="toast" key={t.id}>
          <span>{t.message}</span>
          {t.action && (
            <button class="toast-action" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
