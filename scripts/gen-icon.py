#!/usr/bin/env python3
"""鲸鲸阅读器占位图标生成脚本（Task 17）。

用途：生成 src/Host/app.ico（多尺寸 16/32/48/256），供 csproj 的 <ApplicationIcon> 使用。
风格：蓝底圆角方块 + 白色鲸鱼剪影 + 水花/波浪，纯几何形状（不依赖任何系统字体），
因此在任何装了 Pillow 的机器上都能得到逐像素一致的结果。

注意：这是 v1 的占位图标（spec §13：M5 前替换为正式鲸鱼图形），不是最终设计。
依赖：Python 3 + Pillow。
用法：
  python scripts/gen-icon.py
  python scripts/gen-icon.py --output src/Host/app.ico
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Windows 控制台默认代码页可能不是 UTF-8：显式改 stdout，避免中文路径/日志乱码（脚本仍可复现）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

# 主画布 1024×1024：先在高分辨率下绘制再降采样，16px 下也能保留清晰轮廓。
CANVAS = 1024
SIZES = [(16, 16), (32, 32), (48, 48), (256, 256)]

BACKGROUND_TOP = (58, 140, 226, 255)  # #3A8CE2
BACKGROUND_BOTTOM = (11, 74, 143, 255)  # #0B4A8F
WHALE_WHITE = (255, 255, 255, 255)
DEEP_BLUE = (9, 58, 112, 255)
WAVE_BLUE = (157, 211, 255, 255)


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int, int], bottom: tuple[int, int, int, int]) -> Image.Image:
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(4))
        draw.line((0, y, size, y), fill=color)
    return gradient


def draw_whale(draw: ImageDraw.ImageDraw) -> None:
    """在 1024 画布上画白色鲸鱼（头朝右、尾在左）与水花。"""
    # 尾鳍：贴着身体左侧的鲸尾，两块三角合成 V 形。
    draw.polygon([(300, 500), (120, 392), (186, 566)], fill=WHALE_WHITE)
    draw.polygon([(300, 636), (120, 744), (186, 570)], fill=WHALE_WHITE)

    # 身体：横向椭圆（头在右）。
    draw.ellipse((236, 430, 830, 760), fill=WHALE_WHITE)

    # 胸鳍：从身体下方伸出的鳍，增加鲸鱼辨识度。
    draw.polygon([(470, 690), (418, 828), (612, 746)], fill=WHALE_WHITE)

    # 腹部纹理：两条浅蓝弧线（不画到身体外）。
    draw.arc((392, 592, 728, 748), start=20, end=160, fill=WAVE_BLUE, width=18)
    draw.arc((444, 642, 682, 758), start=20, end=160, fill=WAVE_BLUE, width=14)

    # 眼睛与嘴：深蓝色，16px 下眼睛仍是一个可见的点。
    draw.ellipse((656, 520, 704, 568), fill=DEEP_BLUE)
    draw.arc((656, 596, 768, 690), start=20, end=110, fill=DEEP_BLUE, width=18)

    # 水花：头顶三颗水珠 + 一道向上喷出的细水柱。
    draw.line((646, 448, 620, 342), fill=WAVE_BLUE, width=16)
    draw.ellipse((586, 286, 646, 346), fill=WAVE_BLUE)
    draw.ellipse((660, 250, 720, 310), fill=WAVE_BLUE)
    draw.ellipse((732, 306, 784, 358), fill=WAVE_BLUE)

    # 底部波浪：两条白色细弧（与主体之间留出蓝色缝隙）。
    draw.arc((180, 806, 640, 960), start=200, end=340, fill=WAVE_BLUE, width=20)
    draw.arc((520, 806, 900, 946), start=200, end=330, fill=WAVE_BLUE, width=20)


def build_icon() -> Image.Image:
    base = vertical_gradient(CANVAS, BACKGROUND_TOP, BACKGROUND_BOTTOM)

    # 顶部一圈高光，让纯色底不显得死板（大尺寸可见，小尺寸不影响识别）。
    highlight = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(highlight).ellipse((-260, -520, 1284, 660), fill=(255, 255, 255, 34))
    base = Image.alpha_composite(base, highlight)

    draw = ImageDraw.Draw(base)
    draw_whale(draw)

    mask = rounded_rect_mask(CANVAS, 184)
    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)
    return icon


def main() -> int:
    parser = argparse.ArgumentParser(description="生成鲸鲸阅读器占位图标 app.ico")
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent.parent / "src" / "Host" / "app.ico"),
        help="输出 ico 路径（默认 src/Host/app.ico）",
    )
    args = parser.parse_args()

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(output, format="ICO", sizes=SIZES)
    print(f"已生成 {output}（尺寸：{'/'.join(str(width) for width, _ in SIZES)}，{output.stat().st_size} B）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
