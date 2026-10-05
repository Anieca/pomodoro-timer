// スモークテスト共通の実行環境。
import electronPath from 'electron';

// 実行中の OS 向けの Electron バイナリ(macOS の .app 決め打ちだと Linux / Windows で起動できない)
export const ELECTRON = electronPath;

// 外部フォント(Google Fonts)はオフラインやプロキシ環境では読み込めず、そのたびに
// "Failed to load resource" がコンソールに出る。フォールバックのフォントで表示は続くので
// アプリの不具合ではない。この2ホストへの読み込み失敗だけを除き、ローカル資産の
// 読み込み失敗などはこれまでどおりエラーとして数える。
const EXTERNAL_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const isExternalFontFailure = m => {
  try { return EXTERNAL_FONT_HOSTS.has(new URL(m.location().url).hostname); }
  catch { return false; }
};

// テストが失敗として数えるべきコンソールエラーか
export const isAppError = m => m.type() === 'error' && !isExternalFontFailure(m);
