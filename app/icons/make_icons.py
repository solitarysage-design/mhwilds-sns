"""ホーム画面用のアイコンを作る (単色の背景に文字だけ。ゲームの画像は使わない)。

使い方 (リポのどこからでも):
    PYTHONIOENCODING=utf-8 python app/icons/make_icons.py

出力 (このファイルと同じフォルダ):
    apple-touch-icon.png  180px  iPhone の「ホーム画面に追加」用
    icon-192.png          192px  manifest 用
    icon-512.png          512px  manifest 用
    icon-maskable-512.png 512px  manifest の maskable 用 (文字を中央 80% の安全域に収める)

PIL (Pillow) が要る。フォントは Windows の游ゴシック Bold を優先し、無ければ Noto Sans JP・メイリオ。
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # PIL が無い環境では何もしない
    print("Pillow が無いのでアイコンを作れません: pip install pillow", file=sys.stderr)
    sys.exit(1)

OUT = Path(__file__).resolve().parent

# 背景色 (manifest の theme_color と合わせる) と文字色
BG = (31, 92, 112)      # #1f5c70 深い青緑
FG = (255, 255, 255)
SUB = (205, 229, 236)   # 小さい文字は少し淡く

FONT_CANDIDATES = [
    "C:/Windows/Fonts/YuGothB.ttc",
    "C:/Windows/Fonts/NotoSansJP-VF.ttf",
    "C:/Windows/Fonts/meiryob.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit("日本語フォントが見つからない (FONT_CANDIDATES を直す)")


def draw_centered(draw: ImageDraw.ImageDraw, text: str, font, cx: float, cy: float, fill) -> None:
    # 文字の外接矩形の中心を (cx, cy) に合わせる
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    w, h = right - left, bottom - top
    draw.text((cx - w / 2 - left, cy - h / 2 - top), text, font=font, fill=fill)


def make(size: int, scale: float = 1.0) -> Image.Image:
    """size 角の正方形。scale<1 で文字を小さくする (maskable の安全域用)。"""
    # 4 倍で描いて縮める (文字の縁をなめらかに)
    k = 4
    big = size * k
    img = Image.new("RGB", (big, big), BG)
    d = ImageDraw.Draw(img)
    main = load_font(int(big * 0.27 * scale))
    sub = load_font(int(big * 0.13 * scale))
    draw_centered(d, "片手剣", main, big / 2, big * (0.5 - 0.08 * scale), FG)
    draw_centered(d, "ビルド", sub, big / 2, big * (0.5 + 0.20 * scale), SUB)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    outputs = {
        "apple-touch-icon.png": make(180),
        "icon-192.png": make(192),
        "icon-512.png": make(512),
        "icon-maskable-512.png": make(512, scale=0.82),
    }
    for name, img in outputs.items():
        path = OUT / name
        img.save(path, optimize=True)
        print(f"{path.name}: {img.size[0]}px")


if __name__ == "__main__":
    main()
