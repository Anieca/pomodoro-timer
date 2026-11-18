// 環境音の音源。同梱のものと利用者が足したものを合わせて扱い、同名は利用者のものを優先する。
import { shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SoundInfo } from '../shared/api.ts';
import { BUNDLED_SOUNDS_DIR, USER_SOUNDS_DIR } from './paths.ts';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const isAudio = (name: string): boolean => AUDIO_EXTS.has(path.extname(name).toLowerCase());

const sources = (): [string, SoundInfo['source']][] => [[USER_SOUNDS_DIR(), 'user'], [BUNDLED_SOUNDS_DIR, 'bundled']];

export function ensureUserDir(): string {
  const dir = USER_SOUNDS_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function listSounds(): SoundInfo[] {
  const seen = new Set<string>();
  const out: SoundInfo[] = [];
  for (const [dir, source] of sources()) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(isAudio).sort(); } catch {}
    for (const name of files) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source });
    }
  }
  return out;
}

/** 名前だけを受け取り、音源フォルダの外は読ませない。 */
export function readSound(name: unknown): Buffer | null {
  if (typeof name !== 'string') return null;
  const base = path.basename(name);
  if (!isAudio(base)) return null;
  for (const [dir] of sources()) {
    try { return fs.readFileSync(path.join(dir, base)); } catch {}
  }
  return null;
}

export const openUserDir = (): void => { void shell.openPath(ensureUserDir()); };
