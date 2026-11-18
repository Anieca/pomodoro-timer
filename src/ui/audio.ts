// 環境音とチャイム。<audio loop> は継ぎ目で無音が入るので、Web Audio でサンプル精度のループにする。
// 音源ごとに専用の gain を持たせ、切り替えでは古い方だけを独立にフェードアウトさせる。
import type { Data } from '../core/model.ts';
import { toast } from './store.ts';

const FADE_SEC = 0.8;

let ctx: AudioContext | null = null;
const audio = (): AudioContext => (ctx ??= new AudioContext());

const buffers = new Map<string, Promise<AudioBuffer | null>>();
const failed = new Set<string>();

function load(name: string): Promise<AudioBuffer | null> {
  let p = buffers.get(name);
  if (!p) {
    p = (async () => {
      const bytes = await window.api.readSound(name);
      if (!bytes) return null;
      // decodeAudioData は渡した buffer を切り離すので、複製を渡す
      return audio().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    })().catch(() => null);
    buffers.set(name, p);
  }
  return p;
}

/** 音源を置き換えたあとなど、読み直させる */
export function forgetSounds(): void {
  buffers.clear();
  failed.clear();
}

interface Playing { name: string; src: AudioBufferSourceNode; gain: GainNode }
let playing: Playing | null = null;
/** いま鳴っていてほしい音源(読み込みが済んだとき、まだ望まれているかを確かめる) */
let wanted: string | null = null;

const level = (volume: number): number => (Math.max(0, Math.min(100, volume)) / 100) ** 2;

function fadeOut(p: Playing): void {
  const t = audio().currentTime;
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(p.gain.gain.value, t);
  p.gain.gain.linearRampToValueAtTime(0, t + FADE_SEC);
  p.src.stop(t + FADE_SEC + 0.05);
}

async function setAmbience(name: string | null, volume: number): Promise<void> {
  wanted = name;
  if (playing && playing.name !== name) { fadeOut(playing); playing = null; }
  if (name === null) return;
  if (playing) {
    const t = audio().currentTime;
    playing.gain.gain.cancelScheduledValues(t);
    playing.gain.gain.linearRampToValueAtTime(level(volume), t + 0.15);
    return;
  }
  const buffer = await load(name);
  if (wanted !== name || playing) return; // 読み込みの間に状況が変わった
  if (!buffer) {
    if (!failed.has(name)) { failed.add(name); toast(`音源「${name}」を読み込めませんでした`); }
    return;
  }
  const c = audio();
  void c.resume();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(level(volume), c.currentTime + FADE_SEC);
  src.connect(gain).connect(c.destination);
  src.start();
  playing = { name, src, gain };
}

/** 状態から、鳴らすべき音を決めて合わせる。動いている間だけ鳴る。 */
export function syncAmbience(data: Data): void {
  const { run, settings } = data;
  const on = settings.sound.on && run?.open != null;
  const name = on ? (run!.kind === 'focus' ? settings.sound.focus : settings.sound.rest) : null;
  void setAmbience(name || null, settings.sound.volume);
  document.documentElement.dataset.ambience = name ?? '';
}

/** フォーカスの終わりは上がる二音、休憩の終わりは下がる二音。 */
export function chime(rising: boolean): void {
  const c = audio();
  void c.resume();
  const notes = rising ? [659.25, 987.77] : [987.77, 659.25];
  notes.forEach((freq, i) => {
    const t = c.currentTime + i * 0.22;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 1.5);
  });
}

/** 設定画面の試聴(数秒だけ鳴らす) */
let preview: Playing | null = null;
export async function previewSound(name: string, volume: number): Promise<void> {
  if (preview) { fadeOut(preview); preview = null; }
  const buffer = await load(name);
  if (!buffer) { toast(`音源「${name}」を読み込めませんでした`); return; }
  const c = audio();
  void c.resume();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = c.createGain();
  gain.gain.value = level(volume);
  src.connect(gain).connect(c.destination);
  src.start();
  const mine = (preview = { name, src, gain });
  setTimeout(() => { if (preview === mine) { fadeOut(mine); preview = null; } }, 3000);
}
