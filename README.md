# Pomodoro Atelier

タスク管理と集中タイマーを組み合わせたポモドーロタイマーアプリ。Electron 製のデスクトップアプリで、タスク管理・集中タイマー・ホワイトノイズ再生・履歴のエクスポートをひとつにまとめています。

## 特徴

- **ポモドーロタイマー** — フォーカス / 小休憩 / 長休憩のモード切り替え。長休憩の間隔や自動開始も設定可能。
- **タスク管理** — サイドバーでタスクを追加・完了管理。集中対象のタスクと連動。
- **ホワイトノイズ** — フォーカス中にホワイト / ピンク / ブラウンノイズを再生。音源・音量を設定でき、設定画面の「音源フォルダを開く」から音源ファイル（mp3 / wav / ogg など）を追加可能（配布版でも利用可）。
- **統計** — 直近 7 / 30 / 90 日の集中時間・完了ポモドーロ・完走率・連続日数と、日別の推移・時間帯の分布・タスク別の内訳を表示。
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
| `npm test` | 単体テストと Playwright スモークテスト一式を実行(ディスプレイの無い Linux では `xvfb-run -a npm test`) |
| `node scripts/smoke-<名前>.mjs` | 個別のスモークテストを実行(例: `node scripts/smoke-timeline.mjs`) |
| `node scripts/shots.mjs [出力先]` | 主な画面のスクリーンショットを撮る(テストではない。既定の出力先は OS の一時ディレクトリの `pomodoro-shots/`) |
| `node scripts/generate-noise.mjs` | ホワイト/ピンク/ブラウンノイズ音源を生成 |

テストは `scripts/` にあります。

- 単体テスト(Electron を起動しない): `schema-test.mjs`(検証と正規化)/ `actions-test.mjs`(意図の適用)/ `stats-test.mjs`(統計の集計)
- スモークテスト(Electron を起動する): `smoke-tasks`(タスク操作の基本)/ `smoke-sessions`(記録・休憩・一時停止区間)/ `smoke-overrun-delete`(超過時の実時間・実行中のタスク削除)/ `smoke-sleep`(スリープを実働から除く)/ `smoke-timeline`・`smoke-timeline-midnight`(タイムテーブルと日付またぎ)/ `smoke-stats`(統計ビュー)/ `smoke-noise-*`(ホワイトノイズの切替・後方互換・読み込み失敗)/ `smoke-corrupt-data`・`smoke-unreadable-data`(壊れた・読めない保存データ)/ `smoke-main-authority`(保存データの正本を main が持つこと)

スモークテストは `scripts/test-env.mjs` の `launchApp({ seed })` で起動します。一時的な userData を作り(`seed` を渡すとそれを保存データとして置く)、`init()` の完了(`html[data-ready="true"]`)まで待ち、コンソールエラーを `errors` に集めます。新しく足したテストは `scripts/run-tests.mjs` の `TESTS` に加えてください。

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
main.js            メインプロセスの入口
main/              メインプロセスの各機能
  windows.js         メイン / ミニウィンドウの生成と IPC 発信元の検証
  tray.js            Tray・Dock・ミニへのタイマー状態の反映
  store.js           保存データの正本と永続化（アトミック書き込み・破損退避）
  ipc.js             レンダラーとの IPC の受け口（preload.js と一対一）
  export.js          JSON / CSV 書き出し
  sounds.js          音源の一覧・読み込み
  power.js           システムスリープの検知
  paths.js           保存データ・音源・アイコンの場所
preload.js         レンダラーへの API 公開（contextBridge）
shared/            main・レンダラ・テストで共有する純粋モジュール（schema.js / actions.js / stats.js）
renderer/          UI（index.html / styles.css / app.js、ミニタイマーは mini.html / mini.js）
assets/sounds/     ノイズ音源
scripts/           音源生成・スモークテスト用スクリプト
```

保存データの正本を持つのはメインプロセスで、レンダラーは「何をしたいか」（意図）
だけを送ります。画面に出すのは、最後に受け取った正本に応答待ちの意図を同じ reducer で
当てた見込みで、応答が来るたびに正本を差し替えて当て直します（失敗した意図は外れて
正本に戻る）。意図の適用は `shared/actions.js`、検証と正規化は `shared/schema.js` に
集約してあり、main とレンダラーの両方が同じものを使います。どちらも Electron に
依存しないので、`npm test` の単体テスト（`scripts/actions-test.mjs` /
`scripts/schema-test.mjs`）だけで確かめられます。

## ライセンス

[MIT](LICENSE)
