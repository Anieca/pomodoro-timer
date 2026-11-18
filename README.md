# Pomodoro Atelier

ひとつのことに集中するための、タスクとタイマーのデスクトップアプリ(Electron)。
タスクを選んで始めると、フォーカスと休憩のリズムが回り、実際に使った時間が区間として残ります。

何を残して何を作り直したかは [docs/CONCEPT.md](docs/CONCEPT.md)、画面の一つひとつがなぜその姿なのかは [docs/DESIGN.md](docs/DESIGN.md) にあります。

## できること

- **いま** — 向き合うタスク、残り時間と経過の線、今日の帯(どの時間に何をしていたか)を一画面に。
  - 始めると空間が深い色に沈み、周りが退く。手を止めると、タスク名と残り時間と経過だけが残る。止めると元に戻る
  - タイマーを止めずにタスクを切り替えられ、時間はタスクごとに正しく付く
  - 終えたタスクにチェックを入れると、次の未完了へ移る
  - 乗っているときは「5分のばす」。一時停止・スリープ・終了していた時間は実働に数えない(休憩は離席中も進む)
- **ふりかえり** — 一日の帯と記録、直近 7 / 30 / 90 日の傾向(フォーカス時間・完走・完走率・日ごと・時間帯・タスクごと)。記録のタスクの付け替えと削除ができる。
- **手元に無くても** — メニューバーに残り時間(左クリックで開始/一時停止、右クリックでメニューとタスクの切り替え)、常に手前のミニタイマー(メニューバーから開く)、終わりの通知とチャイム。
- **環境音** — タイマーが動いている間だけ、フォーカス用・休憩用の音源を継ぎ目なく流す。自分の音源(mp3 / wav など)も足せる。
- **データ** — ローカルに保存。JSON(全データ)/ CSV(記録・タスク)で書き出し、JSON から読み込み(置き換える前のデータは控えとして残す)。

キーボード: `Space` 開始/一時停止、`N` タスクを足す、`⌘1` いま、`⌘2` ふりかえり、`⌘,` 設定。

## インストール

macOS と Linux は、次の一行で最新版を入れられます(入れ直しも同じ)。

```bash
curl -fsSL https://raw.githubusercontent.com/Anieca/pomodoro-timer/main/scripts/install.sh | bash
```

- macOS: この Mac の CPU 向けのアプリを `/Applications` に置いて起動します。署名していないアプリなので、ダウンロードの印を外して開けるようにしています。起動中なら終了させてから入れ替えます。データには触れません。
- Linux: AppImage を `~/.local/bin/pomodoro-atelier` に置きます。
- 版を指定するときは `| bash -s -- v2.0.0`。
- Windows は [リリースページ](https://github.com/Anieca/pomodoro-timer/releases/latest) のインストーラ(.exe)を使ってください。

以前のバージョン(1.x)のデータは、初回起動で引き継がれます。

## 開発環境のセットアップ

```bash
npm install
npm start
```

## 開発

| スクリプト | 内容 |
| --- | --- |
| `npm start` | ビルドして起動 |
| `npm run dev` | 変更を見張ってビルドし直す(別の端末で `npx electron .`) |
| `npm test` | 型検査 → 単体テスト → スモークテスト |
| `npm run test:unit` | 単体テストだけ(Electron を起動しない) |
| `npm run test:e2e` | スモークテストだけ(ディスプレイの無い Linux では `xvfb-run -a`) |
| `node test/shots.ts [出力先] [light\|dark]` | 主な画面のスクリーンショットを撮る |
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
scripts/       ビルド、音源・アイコンの生成
```

### 仕組み

- **権威は一つ。** タイマーも記録もタスクも、main の `Host` が `reduce` で進めます。画面(メイン・ミニ)と Tray は同じ状態を受け取って描き、操作は命令として送るだけです。ウィンドウを閉じてもタイマーは止まりません。
- **終了時刻を持たない。** 進行中のセッションが持つのは実働の区間だけで、経過はその合計です。スリープや鼓動の飛びは「その間は動いていなかった」として区間から切り取ります。強制終了しても、最後に生存を確かめた時刻までが実働として残り、次の起動で一時停止から続けられます。
- **記録は区間の列。** `Session.spans` の `{ start, end, taskId }` だけが事実で、開始・終了・実働・タスク別の時間・一日の帯・統計はすべてそこから導きます。
- **削除は印。** タスクの削除は `deletedAt` を付けるだけなので、記録はタスクを指したまま残り、取り消しは印を外すだけです。

### テスト

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

### リリース

`package.json` のバージョンを上げて main にマージするだけです(`npm version <版> --no-git-tag-version`)。

マージすると `.github/workflows/release.yml` が `v<版>`(例: `v2.0.0`)のリリースを下書きで作り、macOS(`.dmg` / `.zip`)・Windows(`.exe`)・Linux(`AppImage`)のインストーラ(署名なし)をすべて添付してから公開します。リリースノートはマージした PR から自動で作られます。

- ビルドが失敗したときはリリースが下書きのまま残ります。直してから Actions の「Release」を手動で実行すると、下書きを作り直して公開します
- そのバージョンのリリースが既に公開されていれば何もしません
- GitHub の画面から手でリリースを公開した場合も、そのリリースにインストーラを添付します(タグと `package.json` のバージョンが一致しないときは失敗します)

## ライセンス

[MIT](LICENSE)
