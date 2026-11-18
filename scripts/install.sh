#!/usr/bin/env bash
# Pomodoro Atelier を GitHub のリリースから一発で入れる(入れ直す)。macOS と Linux。
#
#   curl -fsSL https://raw.githubusercontent.com/Anieca/pomodoro-timer/main/scripts/install.sh | bash
#
# 版を指定するとき:  ... | bash -s -- v2.0.0
#
# macOS: この Mac の CPU 向けの .zip を取り、/Applications(書けなければ ~/Applications)に置く。
#        署名していないアプリなので、ダウンロードの印(quarantine)を外して開けるようにする。
#        起動中なら終了させてから入れ替える。データ(~/Library/Application Support)には触れない。
# Linux: .AppImage を ~/.local/bin/pomodoro-atelier に置く。
set -euo pipefail

REPO="Anieca/pomodoro-timer"
APP_NAME="Pomodoro Atelier"
VERSION="${1:-latest}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl が見つかりません"

if [ "$VERSION" = latest ]; then
  api="https://api.github.com/repos/$REPO/releases/latest"
else
  api="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi
release_json="$(curl -fsSL "$api")" || fail "リリース情報を取得できませんでした($VERSION)"
tag="$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
urls="$(printf '%s' "$release_json" | grep '"browser_download_url"' | sed -E 's/.*"(https:[^"]+)".*/\1/')"

pick() { printf '%s\n' "$urls" | grep -E -e "$1" | head -n1 || true; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$(uname -s)" in
  Darwin)
    if [ "$(uname -m)" = arm64 ]; then url="$(pick '-arm64-mac\.zip$')"; else url="$(pick '[0-9]+\.[0-9]+\.[0-9]+-mac\.zip$')"; fi
    [ -n "$url" ] || fail "$tag にこの Mac 向けの配布物がありません"

    say "$APP_NAME $tag を取得しています…"
    curl -fL --progress-bar -o "$work/app.zip" "$url"
    ditto -x -k "$work/app.zip" "$work/unpacked"
    src="$work/unpacked/$APP_NAME.app"
    [ -d "$src" ] || fail "取得した配布物に $APP_NAME.app が見つかりません"

    dest_dir="/Applications"
    if [ ! -w "$dest_dir" ]; then dest_dir="$HOME/Applications"; mkdir -p "$dest_dir"; fi
    dest="$dest_dir/$APP_NAME.app"

    # 起動中なら終わらせる(終了時に進行中のセッションは一時停止として保存される)。
    # macOS はプロセス名を 15 文字で切り詰めるので、名前ではなく実行ファイルのパスで探す。
    running() { pgrep -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" >/dev/null; }
    if running; then
      say "起動中の $APP_NAME を終了します…"
      osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
      # 初めてのときは、macOS がこのスクリプトにアプリの操作を許すか確かめるので長めに待つ
      for _ in $(seq 1 60); do running || break; sleep 0.5; done
      running && fail "$APP_NAME を終了できませんでした。手で終了してからもう一度実行してください"
    fi

    rm -rf "$dest"
    ditto "$src" "$dest"
    xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

    say "$dest に入れました。起動します。"
    open "$dest"
    ;;

  Linux)
    url="$(pick '\.AppImage$')"
    [ -n "$url" ] || fail "$tag に Linux 向けの配布物がありません"
    dest="$HOME/.local/bin/pomodoro-atelier"
    mkdir -p "$(dirname "$dest")"
    say "$APP_NAME $tag を取得しています…"
    curl -fL --progress-bar -o "$work/app.AppImage" "$url"
    install -m 755 "$work/app.AppImage" "$dest"
    say "$dest に入れました。pomodoro-atelier で起動できます。"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "(~/.local/bin が PATH にありません。PATH に足してください)";; esac
    ;;

  *)
    fail "この OS には対応していません。Windows はリリースページのインストーラ(.exe)を使ってください: https://github.com/$REPO/releases/latest"
    ;;
esac
