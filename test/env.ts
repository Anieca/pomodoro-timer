// スモークテストの実行環境。一時的な userData でアプリを起動し、main の時計を進める口を渡す。
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import electronPath from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Data } from '../src/core/model.ts';
import type {} from '../src/ui/store.ts'; // window.api の型

const APP_DIR = path.resolve(import.meta.dirname, '..');
export const MIN = 60_000;

export const tempUserData = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-test-'));
export const dataFile = (userData: string): string => path.join(userData, 'atelier-data.json');
export const legacyFile = (userData: string): string => path.join(userData, 'pomodoro-data.json');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** コンソールエラーとページの例外 */
  errors: string[];
  userData: string;
  /** main の時計を進める(その間も動いていたものとして) */
  advance(ms: number): Promise<void>;
  /** main の時計だけが飛ぶ(スリープ) */
  sleep(ms: number): Promise<void>;
  /** main が持っている状態 */
  data(): Promise<Data>;
  /** ディスクに保存されている内容 */
  saved(): Data;
  close(): Promise<void>;
}

interface Options {
  /** 保存ファイルに置く中身(文字列はそのまま書く) */
  seed?: unknown;
  /** v1 の保存ファイルに置く中身 */
  legacy?: unknown;
  /** 既存のディレクトリを使う(後片付けは呼び出し側) */
  userData?: string;
  /** ウィンドウを待つ前に main 側を差し替える(ネイティブダイアログなど) */
  beforeWindow?(app: ElectronApplication): Promise<void>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export async function launchApp({ seed, legacy, userData, beforeWindow }: Options = {}): Promise<Launched> {
  const ud = userData ?? tempUserData();
  if (seed !== undefined) fs.writeFileSync(dataFile(ud), text(seed));
  if (legacy !== undefined) fs.writeFileSync(legacyFile(ud), text(legacy));
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: ud, POMODORO_TEST: '1' },
    timeout: 30_000
  });
  if (beforeWindow) await beforeWindow(app);
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached', timeout: 15_000 });
  type G = { __host: { advance(ms: number): void; jump(ms: number): void; snapshot(): { data: Data } } };
  // 画面の操作(ipcRenderer.send)と、テストが時計を動かす操作(app.evaluate)は別の経路で
  // main に届くので、そのままでは順序が保証されない(押した開始より先に時計が進みうる)。
  // 同じ画面からの IPC は送った順に届くので、往復の問い合わせを一度挟めば、
  // それより前に押した操作は main に届いている。
  const flush = (): Promise<unknown> => page.evaluate(() => window.api.getState());
  return {
    app, page, errors, userData: ud,
    advance: async ms => { await flush(); await app.evaluate((_e, n) => (globalThis as unknown as G).__host.advance(n), ms); },
    sleep: async ms => { await flush(); await app.evaluate((_e, n) => (globalThis as unknown as G).__host.jump(n), ms); },
    data: async () => { await flush(); return app.evaluate(() => (globalThis as unknown as G).__host.snapshot().data); },
    saved: () => JSON.parse(fs.readFileSync(dataFile(ud), 'utf8')) as Data,
    close: async () => {
      await app.close();
      if (!userData) fs.rmSync(ud, { recursive: true, force: true });
    }
  };
}
