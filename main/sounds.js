'use strict';
// ホワイトノイズの音源。同梱音源とユーザー追加音源を合わせて扱い、
// 同名はユーザー音源を優先する(ユーザーが同名で差し替え可能)。
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { BUNDLED_SOUNDS_DIR, USER_SOUNDS_DIR } = require('./paths');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const isAudio = name => AUDIO_EXTS.has(path.extname(name).toLowerCase());

// 優先順(ユーザー → 同梱)
const sources = () => [[USER_SOUNDS_DIR(), 'user'], [BUNDLED_SOUNDS_DIR, 'bundled']];

function listAudioFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(isAudio);
  } catch {
    return [];
  }
}

// ユーザーが音源を置けるフォルダを用意しておく(配布版でも追加できるように)
function ensureUserDir() {
  const dir = USER_SOUNDS_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function listSounds() {
  const seen = new Set();
  const out = [];
  for (const [dir, source] of sources()) {
    for (const f of listAudioFiles(dir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ name: f, path: path.join(dir, f), source });
    }
  }
  return out;
}

// 名前だけを受け取り、音源フォルダの外は読ませない(basename + 拡張子の許可リスト)。
function readSound(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name);
  if (!isAudio(base)) return null;
  for (const [dir] of sources()) {
    try {
      return fs.readFileSync(path.join(dir, base));
    } catch {}
  }
  return null;
}

const openUserDir = () => shell.openPath(ensureUserDir());

module.exports = { ensureUserDir, listSounds, readSound, openUserDir };
