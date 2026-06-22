#!/usr/bin/env python3
"""assets/logo.png から macOS 風の角丸アイコン build/icon.png(1024px)を生成する。

macOS は iOS と違いアプリアイコンを自動で角丸マスクしないため、Dock で
ネイティブアプリと揃うよう、角丸スクワークル＋余白を素材側に焼き込む。
ロゴを差し替えたら `python3 scripts/make-icon.py` で再生成する。
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo.png"
OUT = ROOT / "build" / "icon.png"

CANVAS = 1024            # 出力サイズ
TILE = 824              # 角丸タイルの一辺(Apple のアイコングリッド準拠)
RADIUS = 185            # 角丸半径
MARGIN = (CANVAS - TILE) // 2

def main():
    logo = Image.open(SRC).convert("RGBA")
    # タイルサイズへ高品質リサンプル(元 512px の拡大ジャギを軽減)
    tile = logo.resize((TILE, TILE), Image.LANCZOS)

    # 角丸マスク
    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=RADIUS, fill=255)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(tile, (MARGIN, MARGIN), mask)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print(f"wrote {OUT} ({CANVAS}x{CANVAS}, tile={TILE}, radius={RADIUS})")

if __name__ == "__main__":
    main()
