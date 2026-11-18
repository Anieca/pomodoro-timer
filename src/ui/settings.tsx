// 設定。保存ボタンは無く、変えたそばから反映する。
import { useEffect, useState } from 'preact/hooks';
import { clampInt } from '../core/codec.ts';
import { LIMITS, type Data, type Settings as SettingsData } from '../core/model.ts';
import type { ExportFormat, SoundInfo, TransferResult } from '../shared/api.ts';
import { forgetSounds, previewSound } from './audio.ts';
import { send, soundLabel, toast } from './store.ts';

type NumberKey = keyof typeof LIMITS;

const update = (patch: Partial<Omit<SettingsData, 'sound'>> & { sound?: Partial<SettingsData['sound']> }): void =>
  send({ type: 'settings/update', patch });

function report(result: TransferResult): void {
  if (result.ok) toast(result.message);
  else if (!result.canceled) toast(result.error);
}

export function Settings({ data, onClose }: { data: Data; onClose(): void }) {
  const s = data.settings;
  const [sounds, setSounds] = useState<SoundInfo[]>([]);

  const refreshSounds = (): void => {
    forgetSounds();
    void window.api.listSounds().then(setSounds);
  };
  useEffect(refreshSounds, []);

  const number = (key: NumberKey, label: string, unit: string) => (
    <label class="field">
      <span>{label}</span>
      <span class="field-input">
        <input
          type="number"
          id={`set-${key}`}
          min={LIMITS[key][0]}
          max={LIMITS[key][1]}
          value={s[key]}
          onChange={e => {
            // 範囲の外は丸める。丸めた結果を欄にも戻す。
            const value = clampInt(e.currentTarget.value, LIMITS[key], s[key]);
            e.currentTarget.value = String(value);
            update({ [key]: value });
          }}
        />
        {unit}
      </span>
    </label>
  );

  const soundSelect = (key: 'focus' | 'rest', label: string) => {
    const names = sounds.map(x => x.name);
    return (
      <label class="field">
        <span>{label}</span>
        <span class="field-input">
          <select id={`set-sound-${key}`} value={s.sound[key]} onChange={e => update({ sound: { [key]: e.currentTarget.value } })}>
            {!names.includes(s.sound[key]) && <option value={s.sound[key]}>{s.sound[key]}(見つかりません)</option>}
            {sounds.map(x => <option value={x.name} key={x.name}>{soundLabel(x.name)}{x.source === 'user' ? '(追加)' : ''}</option>)}
          </select>
          <button type="button" class="quiet" onClick={() => void previewSound(s.sound[key], s.sound.volume)}>試聴</button>
        </span>
      </label>
    );
  };

  const exportAs = (format: ExportFormat) => () => void window.api.exportData(format).then(report);

  return (
    <div class="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="sheet" role="dialog" aria-label="設定" id="settings">
        <div class="sheet-head">
          <h2>設定</h2>
          <button class="quiet" id="closeSettings" onClick={onClose}>閉じる</button>
        </div>

        <h3>長さ</h3>
        {number('focusMin', 'フォーカス', '分')}
        {number('shortMin', '小休憩', '分')}
        {number('longMin', '長休憩', '分')}
        {number('longEvery', '長休憩までのフォーカス', '回')}
        <p class="note">進行中のセッションの長さは変わりません。次に始めるものから反映されます。</p>

        <h3>流れ</h3>
        <label class="switch"><input type="checkbox" id="set-autoBreak" checked={s.autoBreak} onChange={e => update({ autoBreak: e.currentTarget.checked })} />フォーカスが終わったら休憩を始める</label>
        <label class="switch"><input type="checkbox" id="set-autoFocus" checked={s.autoFocus} onChange={e => update({ autoFocus: e.currentTarget.checked })} />休憩が終わったらフォーカスを始める</label>

        <h3>音</h3>
        <label class="switch"><input type="checkbox" id="set-chime" checked={s.chime} onChange={e => update({ chime: e.currentTarget.checked })} />終わりをチャイムで知らせる</label>
        <label class="switch"><input type="checkbox" id="set-sound-on" checked={s.sound.on} onChange={e => update({ sound: { on: e.currentTarget.checked } })} />タイマーが動いている間、環境音を流す</label>
        {soundSelect('focus', 'フォーカス中')}
        {soundSelect('rest', '休憩中')}
        <label class="field">
          <span>音量</span>
          <span class="field-input">
            <input type="range" id="set-volume" min={0} max={100} value={s.sound.volume} onInput={e => update({ sound: { volume: Number(e.currentTarget.value) } })} />
            <span class="num volume">{s.sound.volume}</span>
          </span>
        </label>
        <p class="note">
          音源フォルダに mp3 や wav を置くと選べるようになります。
          <button type="button" class="link" onClick={() => window.api.openSoundsDir()}>音源フォルダを開く</button>
          <button type="button" class="link" onClick={refreshSounds}>一覧を更新</button>
        </p>

        <h3>データ</h3>
        <div class="data-actions">
          <button class="secondary" id="exportJson" onClick={exportAs('json')}>すべてを書き出す(JSON)</button>
          <button class="secondary" onClick={exportAs('csv-sessions')}>記録を書き出す(CSV)</button>
          <button class="secondary" onClick={exportAs('csv-tasks')}>タスクを書き出す(CSV)</button>
          <button class="secondary" id="importJson" onClick={() => void window.api.importData().then(report)}>JSON から読み込む</button>
        </div>
        <p class="note">読み込むと、いまのデータはそのファイルの内容に置き換わります。置き換える前のデータは控えとして残します。</p>
      </div>
    </div>
  );
}
