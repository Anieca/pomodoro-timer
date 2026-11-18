// main と画面のあいだの約束(preload が window.api として公開する)。
import type { Command, Effect } from '../core/engine.ts';
import type { Data } from '../core/model.ts';

/** 画面から送れる命令。時計の訂正や復旧など、main だけが出す命令は含めない。 */
export const USER_COMMANDS = [
  'timer/start', 'timer/pause', 'timer/resume', 'timer/toggle', 'timer/stop', 'timer/extend',
  'task/add', 'task/rename', 'task/setDone', 'task/delete', 'task/restore', 'task/move', 'task/activate',
  'session/assign', 'session/delete', 'session/put', 'settings/update'
] as const satisfies readonly Command['type'][];

export type UserCommand = Extract<Command, { type: (typeof USER_COMMANDS)[number] }>;

export interface Snapshot {
  data: Data;
  /** main の時計。画面は自分の時計との差を覚えて、残り時間を同じ基準で描く。 */
  now: number;
}

export interface SoundInfo {
  name: string;
  source: 'user' | 'bundled';
}

export type ExportFormat = 'json' | 'csv-sessions' | 'csv-tasks';

export type TransferResult =
  | { ok: true; message: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string };

export interface Api {
  platform: string;
  getState(): Promise<Snapshot & { notices: string[] }>;
  onState(cb: (s: Snapshot) => void): void;
  onEffect(cb: (e: Effect) => void): void;
  /** 保存の失敗など、main からの知らせ */
  onNotice(cb: (message: string) => void): void;
  send(cmd: UserCommand): void;
  exportData(format: ExportFormat): Promise<TransferResult>;
  importData(): Promise<TransferResult>;
  listSounds(): Promise<SoundInfo[]>;
  readSound(name: string): Promise<Uint8Array | null>;
  openSoundsDir(): void;
  toggleMini(): void;
  showMain(): void;
}
