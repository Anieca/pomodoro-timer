# Pomodoro Atelier

タスク管理と集中タイマーを組み合わせたポモドーロタイマーアプリ。Electron 製のデスクトップアプリで、タスク管理・集中タイマー・ホワイトノイズ再生・履歴のエクスポートをひとつにまとめています。

## 特徴

- **ポモドーロタイマー** — フォーカス / 小休憩 / 長休憩のモード切り替え。長休憩の間隔や自動開始も設定可能。
- **タスク管理** — サイドバーでタスクを追加・完了管理。集中対象のタスクと連動。
- **ホワイトノイズ** — フォーカス中にホワイト / ピンク / ブラウンノイズを再生。音源・音量を設定でき、`assets/sounds/` に音源ファイル（mp3 / wav / ogg など）を追加可能。
- **履歴とエクスポート** — ポモドーロ履歴を閲覧し、JSON（全データ）/ CSV（ポモドーロ履歴・タスク）でエクスポート。
- **ローカル保存** — データはローカルにアトミックに保存（クラッシュ時の破損を防止）。

## 必要環境

- [Node.js](https://nodejs.org/)
- macOS / Windows / Linux（Electron 対応プラットフォーム）

## セットアップ

```bash
npm install
npm start
```

## 開発

| スクリプト | 内容 |
| --- | --- |
| `npm start` | アプリを起動（`electron .`） |
| `node scripts/generate-noise.mjs` | ホワイト/ピンク/ブラウンノイズ音源を生成 |
| `node scripts/smoke.mjs` | Playwright によるスモークテスト |

## プロジェクト構成

```
main.js            メインプロセス（ウィンドウ生成・IPC・データ保存・エクスポート）
preload.js         レンダラーへの API 公開（contextBridge）
renderer/          UI（index.html / styles.css / app.js）
assets/sounds/     ノイズ音源
scripts/           音源生成・スモークテスト用スクリプト
```

## ライセンス

[MIT](LICENSE)
