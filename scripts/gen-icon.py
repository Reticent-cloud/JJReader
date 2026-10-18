#!/usr/bin/env python3
"""鲸鲸阅读器图标 / 吉祥物生成脚本。

素材：assets/mascot-source.jpg —— 用户提供的「鲸鱼女仆娘看书」插画（1536×1536）。
本脚本只做确定性的后处理，不联网、不使用随机数：
  1. src/Host/app.ico        16/32/48/256 应用图标（16/32 用脸部特写保证可辨，48/256 用整幅圆形插画）；
  2. src/Host/AboutMascot.png 512×512 透明背景吉祥物（关于面板 / 空白页 WPF/前端显示）；
  3. web/src/mascot-photo.js  384×384 WebP（base64 data URI，供前端空状态插画使用）。
圆形裁切时按「与中心同色的圆」掩掉圆外区域，因此右下角的水印（豆包AI生成）不会被带进图标。

依赖：Python 3 + Pillow。用法：
  python scripts/gen-icon.py
  python scripts/gen-icon.py --source assets/mascot-source.jpg
"""

from __future__ import annotations

import argparse
import base64
import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "assets" / "mascot-source.jpg"
DEFAULT_ICO = ROOT / "src" / "Host" / "app.ico"
DEFAULT_MASCOT = ROOT / "src" / "Host" / "AboutMascot.png"
DEFAULT_WEB_PHOTO = ROOT / "web" / "src" / "mascot-photo.js"
ICON_SIZES = [16, 32, 48, 256]
FACE_SIZES = {16, 32}
WEB_SIZE = 384


def _is_background(pixel: tuple[int, int, int]) -> bool:
    return pixel[0] >= 238 and pixel[1] >= 238 and pixel[2] >= 238


def load_circle_master(source: Path) -> Image.Image:
    """读取插画，按中心十字线扫描出圆形边界，裁成正方形并掩掉圆外区域（顺带裁掉角上的水印）。"""
    image = Image.open(source).convert("RGB")
    width, height = image.size
    pixels = image.load()
    center_x, center_y = width // 2, height // 2

    left = next((x for x in range(width) if not _is_background(pixels[x, center_y])), 0)
    right = next((x for x in range(width - 1, -1, -1) if not _is_background(pixels[x, center_y])), width - 1)
    top = next((y for y in range(height) if not _is_background(pixels[center_x, y])), 0)
    bottom = next((y for y in range(height - 1, -1, -1) if not _is_background(pixels[center_x, y])), height - 1)

    center_x = (left + right) / 2.0
    center_y = (top + bottom) / 2.0
    radius = max(right - left, bottom - top) / 2.0 + 2.0

    box = (
        max(0, round(center_x - radius)),
        max(0, round(center_y - radius)),
        min(width, round(center_x + radius)),
        min(height, round(center_y + radius)),
    )
    square = image.crop(box).convert("RGBA")
    size = square.width

    # 圆外透明：先画 4× 超采样掩膜再缩小，边缘带抗锯齿。
    supersample = 4
    mask = Image.new("L", (size * supersample, size * supersample), 0)
    ImageDraw.Draw(mask).ellipse(
        (0, 0, size * supersample - 1, size * supersample - 1),
        fill=255,
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    square.putalpha(mask)

    # 深蓝底插画贴到纯白背景上时圆边不应出现白圈：保持透明即可，显示端自行铺底。
    return square


def circle_icon(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.Resampling.LANCZOS)


def face_icon(master: Image.Image, size: int) -> Image.Image:
    """小尺寸图标用脸部特写（头发/头饰/眼睛），16px 时也能看出是「蓝发少女」。"""
    side = round(master.width * 0.62)
    ratio = 0.44  # 脸部中心在插画里的相对位置（略高于几何中心）
    left = round(master.width * 0.5 - side / 2)
    top = round(master.height * ratio - side / 2)
    left = max(0, min(left, master.width - side))
    top = max(0, min(top, master.height - side))
    crop = master.crop((left, top, left + side, top + side))
    icon = crop.resize((size, size), Image.Resampling.LANCZOS)
    # 小尺寸再补一圈圆角掩膜，避免方块感
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * 4 - 1, size * 4 - 1), radius=round(size * 4 * 0.22), fill=255
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask)
    return out


def write_ico(path: Path, images: list[Image.Image]) -> None:
    frames: list[bytes] = []
    for image in images:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        frames.append(buffer.getvalue())

    header = struct.pack("<HHH", 0, 1, len(frames))
    entries = bytearray()
    offset = 6 + 16 * len(frames)
    for image, data in zip(images, frames):
        width = 0 if image.width >= 256 else image.width
        height = 0 if image.height >= 256 else image.height
        entries.extend(struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), offset))
        offset += len(data)

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(header)
        handle.write(entries)
        for data in frames:
            handle.write(data)


def web_data_uri(master: Image.Image, size: int) -> str:
    """生成前端用的内联 data URI：优先 WebP（体积小），失败回退 JPEG。"""
    photo = master.resize((size, size), Image.Resampling.LANCZOS)
    for fmt, mime in (("WEBP", "image/webp"), ("JPEG", "image/jpeg")):
        buffer = io.BytesIO()
        try:
            photo.save(buffer, format=fmt, quality=78, method=6)
        except (OSError, ValueError):
            continue
        data = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:{mime};base64,{data}"
    raise RuntimeError("无法生成 WebP/JPEG 数据")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成鲸鲸阅读器图标与吉祥物（基于 mascot-source.jpg）")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="插画源文件（默认 assets/mascot-source.jpg）")
    parser.add_argument("--output", default=str(DEFAULT_ICO), help="输出 ico（默认 src/Host/app.ico）")
    parser.add_argument("--mascot-output", default=str(DEFAULT_MASCOT), help="输出吉祥物 PNG（默认 src/Host/AboutMascot.png）")
    parser.add_argument("--web-output", default=str(DEFAULT_WEB_PHOTO), help="输出前端 data URI 模块（默认 web/src/mascot-photo.js）")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if not source.is_file():
        print(f"未找到插画素材：{source}")
        return 1

    master = load_circle_master(source)
    icons = [face_icon(master, size) if size in FACE_SIZES else circle_icon(master, size) for size in ICON_SIZES]

    ico_path = Path(args.output).resolve()
    write_ico(ico_path, icons)

    mascot_path = Path(args.mascot_output).resolve()
    mascot_path.parent.mkdir(parents=True, exist_ok=True)
    circle_icon(master, 512).save(mascot_path, format="PNG", optimize=True)

    web_path = Path(args.web_output).resolve()
    data_uri = web_data_uri(master, WEB_SIZE)
    web_path.parent.mkdir(parents=True, exist_ok=True)
    web_path.write_text(
        "// 由 scripts/gen-icon.py 生成：鲸鱼女仆娘看书插画的压缩 data URI（空状态圆形插画）。\n"
        f"export const MASCOT_PHOTO = \"{data_uri}\";\n",
        encoding="utf-8",
    )

    print(f"已生成 {ico_path}（尺寸：{'/'.join(str(size) for size in ICON_SIZES)}，{ico_path.stat().st_size} B）")
    print(f"已生成 {mascot_path}（512×512 透明背景，{mascot_path.stat().st_size} B）")
    print(f"已生成 {web_path}（{WEB_SIZE}px 内联图，{web_path.stat().st_size} B）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
