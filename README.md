# Pomodoro Atelier

タスク管理と集中タイマーを組み合わせたポモドーロタイマーアプリ。Electron 製のデスクトップアプリで、タスク管理・集中タイマー・ホワイトノイズ再生・履歴のエクスポートをひとつにまとめています。

## 特徴

- **ポモドーロタイマー** — フォーカス / 小休憩 / 長休憩のモード切り替え。長休憩の間隔や自動開始も設定可能。
- **タスク管理** — サイドバーでタスクを追加・完了管理。集中対象のタスクと連動。
- **ホワイトノイズ** — フォーカス中にホワイト / ピンク / ブラウンノイズを再生。音源・音量を設定でき、設定画面の「音源フォルダを開く」から音源ファイル（mp3 / wav / ogg など）を追加可能（配布版でも利用可）。
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

## 配布ビルド

[electron-builder](https://www.electron.build/) で各 OS 向けのインストーラを生成します。生成物は `dist/` に出力されます。

| スクリプト | 内容 |
| --- | --- |
| `npm run pack` | 署名なしでアプリ本体のみ生成（動作確認用・インストーラなし） |
| `npm run dist` | 実行中の OS 向けインストーラを生成 |
| `npm run dist:mac` | macOS 向け（`.dmg` / `.zip`、x64 + arm64） |
| `npm run dist:win` | Windows 向け（`.exe` インストーラ、x64） |
| `npm run dist:linux` | Linux 向け（`AppImage`、x64） |

> ローカルビルドでは macOS のコード署名はスキップされます（`Developer ID` 証明書がある場合のみ署名）。アイコンは `build/icon.png`（1024px）から各 OS 形式へ自動変換されます。
>
> 各 OS のインストーラは原則その OS 上でビルドします（クロスビルドには追加ツールが必要）。

### 音源の追加（配布版）

ユーザーが追加した音源は `userData/sounds`（macOS は `~/Library/Application Support/pomodoro-timer/sounds`）に置かれ、同梱音源と合わせて選択肢に表示されます。設定画面の「音源フォルダを開く」から該当フォルダを開けます。

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
