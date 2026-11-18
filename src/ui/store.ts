// 画面が持つのは、main から届いた最新の状態だけ。変更は命令として送り、結果は状態として戻ってくる。
import { useEffect, useState } from 'preact/hooks';
import type { Data } from '../core/model.ts';
import type { Api, Snapshot, UserCommand } from '../shared/api.ts';

declare global {
  interface Window { api: Api }
}

let data: Data | null = null;
/** main の時計 − この画面の時計 */
let offset = 0;
const subscribers = new Set<() => void>();

export function setSnapshot(s: Snapshot): void {
  data = s.data;
  offset = s.now - Date.now();
  for (const cb of subscribers) cb();
}

export const hostNow = (): number => Date.now() + offset;
export const getData = (): Data => data!;
export const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

export function useData(): Data {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump(n => n + 1)), []);
  return data!;
}

/** main の時計での「いま」。active の間だけ刻む。 */
export function useNow(active: boolean, everyMs = 250): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => bump(n => n + 1), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return hostNow();
}

export const send = (cmd: UserCommand): void => window.api.send(cmd);
export const newId = (): string => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const SOUND_NAMES: Record<string, string> = { 'white-noise': 'ホワイトノイズ', 'pink-noise': 'ピンクノイズ', 'brown-noise': 'ブラウンノイズ' };
/** 音源ファイル名を表示用の名前にする */
export function soundLabel(file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  return SOUND_NAMES[base] ?? base;
}

/* ---------- 知らせ(トースト) ---------- */

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run(): void };
}

let toasts: Toast[] = [];
let toastSeq = 0;
const toastSubs = new Set<() => void>();
const emitToasts = (): void => { for (const cb of toastSubs) cb(); };

export function dismissToast(id: number): void {
  toasts = toasts.filter(t => t.id !== id);
  emitToasts();
}

export function toast(message: string, action?: Toast['action']): void {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-2), { id, message, action }];
  emitToasts();
  setTimeout(() => dismissToast(id), action ? 7000 : 4500);
}

export function useToasts(): Toast[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const cb = (): void => bump(n => n + 1);
    toastSubs.add(cb);
    cb(); // 購読が始まる前に出た知らせを取りこぼさない
    return () => { toastSubs.delete(cb); };
  }, []);
  return toasts;
}
