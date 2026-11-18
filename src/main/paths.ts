// アプリが読み書きする場所。userData 配下は app.setPath の上書き(テスト用)が
// 効いたあとに解決したいので、関数で遅延評価する。
import { app } from 'electron';
import * as path from 'node:path';

// バンドル後は out/main.js。その一つ上がアプリの根。
const ROOT = path.join(__dirname, '..');

export const DATA_FILE = (): string => path.join(app.getPath('userData'), 'atelier-data.json');
/** v1 の保存ファイル。読むだけで、書き込まない。 */
export const LEGACY_FILE = (): string => path.join(app.getPath('userData'), 'pomodoro-data.json');
export const BUNDLED_SOUNDS_DIR = path.join(ROOT, 'assets', 'sounds');
export const USER_SOUNDS_DIR = (): string => path.join(app.getPath('userData'), 'sounds');
export const ICON = path.join(ROOT, 'build', 'icon.png');
export const PRELOAD = path.join(__dirname, 'preload.js');
export const page = (name: string): string => path.join(__dirname, 'ui', name);
