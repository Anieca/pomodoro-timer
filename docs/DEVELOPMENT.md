# 開発

使い方は [README](../README.md) と [紹介ページ](https://anieca.github.io/pomodoro-timer/)、画面の一つひとつがなぜその姿なのかは [DESIGN.md](DESIGN.md)、何を残して作り直したかは [CONCEPT.md](CONCEPT.md) にあります。

## セットアップ

```bash
npm install
npm start
```

| スクリプト | 内容 |
| --- | --- |
| `npm start` | ビルドして起動 |
| `npm run dev` | 変更を見張ってビルドし直す(別の端末で `npx electron .`) |
| `npm test` | 型検査 → 単体テスト → スモークテスト |
| `npm run test:unit` | 単体テストだけ(Electron を起動しない) |
| `npm run test:e2e` | スモークテストだけ(ディスプレイの無い Linux では `xvfb-run -a`) |
| `node test/shots.ts [出力先] [light\|dark]` | 主な画面のスクリーンショットを撮る(紹介ページの画像もこれで撮る) |
| `node scripts/generate-noise.mjs` | 同梱のノイズ音源を生成 |

## 構成

```
src/
  core/        純粋なロジック(Electron にも DOM にも時計にも依存しない)
    model.ts     保存データの形
    engine.ts    reduce(data, command, now) — すべての変更の入口
    codec.ts     外から来たデータを検めて読み解く(v1 からの移行もここ)
    derive.ts    表示・統計・CSV など、区間の列から導くもの
  main/        メインプロセス
    host.ts      エンジンを回す(状態・時計・保存を一手に持つ)
    store.ts     保存ファイルの読み書き(アトミック書き込み・破損や読めないファイルの退避)
    windows.ts / tray.ts / sounds.ts / transfer.ts / main.ts
  preload.ts   画面へ公開する API
  shared/      main と画面の約束(API の型)
  ui/          画面(Preact)。状態を描き、命令を送るだけ
test/          スモークテストと保存まわりの単体テスト
scripts/       ビルド、インストーラ、音源・アイコンの生成
docs/          紹介ページ(GitHub Pages、main の docs/ を公開)と設計の文書
```

## 仕組み

- **権威は一つ。** タイマーも記録もタスクも、main の `Host` が `reduce` で進めます。画面(メイン・ミニ)と Tray は同じ状態を受け取って描き、操作は命令として送るだけです。ウィンドウを閉じてもタイマーは止まりません。
- **終了時刻を持たない。** 進行中のセッションが持つのは実働の区間だけで、経過はその合計です。スリープや鼓動の飛びは「その間は動いていなかった」として区間から切り取ります。強制終了しても、最後に生存を確かめた時刻までが実働として残り、次の起動で一時停止から続けられます。
- **記録は区間の列。** `Session.spans` の `{ start, end, taskId }` だけが事実で、開始・終了・実働・タスク別の時間・一日の帯・統計はすべてそこから導きます。
- **削除は印。** タスクの削除は `deletedAt` を付けるだけなので、記録はタスクを指したまま残り、取り消しは印を外すだけです。

## テスト

- `src/core/core.test.ts` — エンジン・移行・導出の単体テスト
- `test/store.test.ts` — 保存ファイルの読み書き(破損・読めないファイル・v1 の引き継ぎ)
- `test/e2e.test.ts` — ビルドしたアプリを Electron で起動して操作する。時間は main の時計を進めて作る(`advance` = 動いていた、`sleep` = 止まっていた)。起動は `test/env.ts` の `launchApp()`

## 保存先

`userData`(macOS は `~/Library/Application Support/pomodoro-timer/`)の `atelier-data.json`。
v1 の `pomodoro-data.json` があれば初回起動で引き継ぎます(v1 のファイルには書き込みません)。
追加した音源は同じ場所の `sounds/` に置きます(設定の「音源フォルダを開く」)。

## 配布ビルド

[electron-builder](https://www.electron.build/) で各 OS 向けのインストーラを作ります。出力先は `dist/`。

| スクリプト | 内容 |
| --- | --- |
| `npm run pack` | 署名なしでアプリ本体だけ(動作確認用) |
| `npm run dist` | 実行中の OS 向けインストーラ |
| `npm run dist:mac` / `dist:win` / `dist:linux` | 各 OS 向け |

ローカルビルドでは macOS のコード署名は行いません。アイコンは `build/icon.png` から各 OS の形式へ変換されます。

## リリース

`package.json` のバージョンを上げて main にマージするだけです(`npm version <版> --no-git-tag-version`)。

マージすると `.github/workflows/release.yml` が `v<版>`(例: `v2.0.0`)のリリースを下書きで作り、macOS(`.dmg` / `.zip`)・Windows(`.exe`)・Linux(`AppImage`)のインストーラ(署名なし)をすべて添付してから公開します。リリースノートはマージした PR から自動で作られます。

- ビルドが失敗したときはリリースが下書きのまま残ります。直してから Actions の「Release」を手動で実行すると、下書きを作り直して公開します
- そのバージョンのリリースが既に公開されていれば何もしません
- GitHub の画面から手でリリースを公開した場合も、そのリリースにインストーラを添付します(タグと `package.json` のバージョンが一致しないときは失敗します)

紹介ページ(`docs/index.html`)の画面の画像は、見た目が変わる版を出すときに合わせて更新します。
