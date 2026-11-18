import { render } from 'preact';
import './styles.css';
import { App } from './app.tsx';
import { chime, syncAmbience } from './audio.ts';
import { getData, setSnapshot, subscribe, toast } from './store.ts';

async function boot(): Promise<void> {
  const first = await window.api.getState();
  setSnapshot(first);
  window.api.onState(setSnapshot);
  window.api.onNotice(toast);
  window.api.onEffect(effect => {
    if (getData().settings.chime) chime(effect.kind === 'focus');
  });
  subscribe(() => syncAmbience(getData()));
  syncAmbience(getData());

  document.documentElement.dataset.platform = window.api.platform;
  render(<App />, document.getElementById('root')!);
  for (const notice of first.notices) toast(notice);
}

// 準備が済んだ印(スモークテストはこれを待つ)。失敗しても付けて、原因はコンソールに残す。
boot()
  .catch(err => console.error(err))
  .finally(() => { document.documentElement.dataset.ready = 'true'; });
