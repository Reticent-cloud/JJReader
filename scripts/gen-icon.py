#!/usr/bin/env python3
"""鲸鲸阅读器原创图标 / 吉祥物生成脚本（界面美化波）。

用途：
  1. src/Host/app.ico：16 / 32 / 48 / 256 四尺寸应用图标（csproj <ApplicationIcon>）；
  2. src/Host/AboutMascot.png：256×256 透明背景吉祥物（关于面板 WPF <Image> 显示）。

形象：原创「鲸鱼女仆娘」——深蓝鲸鱼身体（DeepSeek 蓝 #4D6BFE / #1B2A6B）、鲸尾、
白色荷叶边女仆头饰、深蓝发丝与呆毛、腮红、气泡与浪花；不是任何网络同人图，全部由本脚本的
几何图形（椭圆/贝塞尔填充/圆弧）现场绘制。

可辨识性：16 / 32 px 使用专门的「剪影版」——白色圆头 + 荷叶边轮廓 + 鲸尾双叶，
在深蓝圆角底上高对比可辨；48 / 256 px 使用细节版（浅色圆盘 + 彩色吉祥物）。

可重复运行：不读取任何外部素材、不使用随机数；相同 Pillow 版本输出逐字节一致。
依赖：Python 3 + Pillow。用法：
  python scripts/gen-icon.py
  python scripts/gen-icon.py --output src/Host/app.ico --mascot-output src/Host/AboutMascot.png
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Windows 控制台默认代码页可能不是 UTF-8：显式改 stdout，避免中文路径/日志乱码。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ICO = ROOT / "src" / "Host" / "app.ico"
DEFAULT_MASCOT = ROOT / "src" / "Host" / "AboutMascot.png"
ICON_SIZES = [16, 32, 48, 256]

# ── 配色（DeepSeek 蓝系） ────────────────────────────────────────────────────
BG_TOP = (77, 107, 254, 255)      # #4D6BFE
BG_BOTTOM = (27, 42, 107, 255)    # #1B2A6B
BODY = (77, 107, 254, 255)        # #4D6BFE 鲸鱼身体
BODY_LIGHT = (111, 134, 255, 255)  # 头顶受光
HAIR = (21, 37, 94, 255)          # #15255E 发丝
TAIL = (42, 68, 184, 255)         # #2A44B8 鲸尾
BELLY = (220, 231, 255, 255)      # #DCE7FF 腹部
BELLY_LINE = (175, 197, 255, 255)  # 腹部纹理
WHITE = (255, 255, 255, 255)
HEADD_FILL = (226, 236, 255, 255)  # 冰蓝白：白色底与浅色圆盘上都能看出荷叶边
HEADD_LINE = (150, 176, 232, 255)  # 头饰描边（浅蓝）
RIBBON = (255, 158, 181, 255)     # #FF9EB5
RIBBON_DARK = (255, 127, 168, 255)
EYE = (14, 27, 69, 255)           # #0E1B45
BLUSH = (255, 180, 200, 255)
BUBBLE = (155, 216, 255, 255)     # #9BD8FF
SKY = (143, 211, 255, 255)        # #8FD3FF
DISC = (243, 247, 255, 255)
DISC_EDGE = (198, 214, 255, 255)

# 鲸尾轮廓（宽叶 + 中央凹口，像经典鲸尾；细节版与剪影版共用同一形状）
TAIL_START = (0.700, 0.632)
TAIL_CURVES = [
    ((0.790, 0.580), (0.880, 0.500), (0.950, 0.380)),
    ((0.990, 0.410), (0.985, 0.470), (0.945, 0.510)),
    ((0.900, 0.550), (0.850, 0.575), (0.810, 0.595)),
    ((0.785, 0.620), (0.790, 0.650), (0.825, 0.665)),
    ((0.875, 0.680), (0.925, 0.720), (0.950, 0.780)),
    ((0.990, 0.840), (0.975, 0.895), (0.925, 0.885)),
    ((0.850, 0.870), (0.770, 0.765), (0.700, 0.655)),
]


def vertical_gradient(size: int, top: tuple[int, int, int, int], bottom: tuple[int, int, int, int]) -> Image.Image:
    """竖向渐变（逐行插值），返回不透明 RGBA 图。"""
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(4))
        draw.line((0, y, size, y), fill=color)
    return gradient


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def _cubic(start, control1, control2, end, steps=26):
    points = []
    for index in range(1, steps + 1):
        t = index / steps
        mt = 1.0 - t
        x = (mt ** 3) * start[0] + 3 * mt * mt * t * control1[0] + 3 * mt * t * t * control2[0] + (t ** 3) * end[0]
        y = (mt ** 3) * start[1] + 3 * mt * mt * t * control1[1] + 3 * mt * t * t * control2[1] + (t ** 3) * end[1]
        points.append((x, y))
    return points


class Painter:
    """把 0–1 归一化坐标映射到像素的绘图助手（支持整体缩放/平移，便于图标内缩）。"""

    def __init__(self, draw: ImageDraw.ImageDraw, size: int, scale: float = 1.0, dx: float = 0.0, dy: float = 0.0):
        self.draw = draw
        self.size = size
        self.scale = scale
        self.dx = dx
        self.dy = dy

    def point(self, x: float, y: float) -> tuple[float, float]:
        return (
            (0.5 + (x - 0.5) * self.scale + self.dx) * self.size,
            (0.5 + (y - 0.5) * self.scale + self.dy) * self.size,
        )

    def width(self, value: float) -> int:
        return max(1, round(value * self.size * self.scale))

    def ellipse(self, cx, cy, rx, ry, fill, outline=None, width=0.0):
        x, y = self.point(cx, cy)
        box = (
            x - rx * self.size * self.scale,
            y - ry * self.size * self.scale,
            x + rx * self.size * self.scale,
            y + ry * self.size * self.scale,
        )
        self.draw.ellipse(box, fill=fill, outline=outline, width=self.width(width) if outline else 0)

    def circle(self, cx, cy, radius, fill, outline=None, width=0.0):
        self.ellipse(cx, cy, radius, radius, fill, outline=outline, width=width)

    def polygon(self, points, fill):
        self.draw.polygon([self.point(x, y) for x, y in points], fill=fill)

    def arc(self, cx, cy, rx, ry, start, end, fill, width=0.006):
        x, y = self.point(cx, cy)
        box = (
            x - rx * self.size * self.scale,
            y - ry * self.size * self.scale,
            x + rx * self.size * self.scale,
            y + ry * self.size * self.scale,
        )
        self.draw.arc(box, start=start, end=end, fill=fill, width=self.width(width))

    def path(self, start, curves, fill, outline=None, width=0.0):
        """用三次贝塞尔曲线段围成的闭合路径（起点 + 若干 (c1,c2,end) 段）。"""
        raw = [start]
        for control1, control2, end in curves:
            raw.extend(_cubic(raw[-1], control1, control2, end))
        points = [self.point(x, y) for x, y in raw]
        self.draw.polygon(points, fill=fill, outline=outline)
        if outline and width > 0:
            self.draw.line(points + [points[0]], fill=outline, width=self.width(width), joint="curve")

    def mirror_path(self, start, curves, fill, outline=None, width=0.0):
        """左右镜像路径（x → 1-x）。"""
        mirrored = [(1.0 - start[0], start[1])]
        mirrored += [((1.0 - c1[0], c1[1]), (1.0 - c2[0], c2[1]), (1.0 - end[0], end[1])) for c1, c2, end in curves]
        self.path(mirrored[0], mirrored[1:], fill, outline=outline, width=width)

    def stroke(self, start, curves, fill, width=0.01):
        raw = [start]
        for control1, control2, end in curves:
            raw.extend(_cubic(raw[-1], control1, control2, end))
        points = [self.point(x, y) for x, y in raw]
        self.draw.line(points, fill=fill, width=self.width(width), joint="curve")


def draw_tail(p: Painter):
    """鲸尾：一整片宽叶形尾鳍（中央凹口 + 上下圆钝尾尖），比细长双线更像鲸尾。"""
    p.stroke((0.640, 0.642), [((0.690, 0.648), (0.735, 0.644), (0.780, 0.636))], TAIL, 0.080)
    p.path(TAIL_START, TAIL_CURVES, TAIL)
    # 尾鳍高光（浅色细线，增强小尺寸下的层次）
    p.stroke((0.800, 0.575), [((0.860, 0.515), (0.905, 0.455), (0.930, 0.415))], (143, 180, 255, 255), 0.010)
    p.stroke((0.805, 0.715), [((0.865, 0.775), (0.910, 0.830), (0.930, 0.860))], (143, 180, 255, 255), 0.008)


def draw_detailed_mascot(draw: ImageDraw.ImageDraw, size: int, scale: float = 1.0, dx: float = 0.0, dy: float = 0.0):
    p = Painter(draw, size, scale=scale, dx=dx, dy=dy)

    draw_tail(p)

    # 后发 → 鲸鱼身体 → 头顶受光 → 腹部
    p.ellipse(0.50, 0.545, 0.315, 0.300, HAIR)
    p.ellipse(0.50, 0.550, 0.265, 0.255, BODY)
    p.ellipse(0.415, 0.430, 0.105, 0.065, BODY_LIGHT)
    p.ellipse(0.50, 0.685, 0.165, 0.112, BELLY)
    p.arc(0.50, 0.685, 0.110, 0.045, 20, 160, BELLY_LINE, width=0.007)
    p.arc(0.50, 0.710, 0.085, 0.038, 20, 160, BELLY_LINE, width=0.006)

    # 两侧发丝
    p.path(
        (0.265, 0.435),
        [
            ((0.205, 0.525), (0.205, 0.665), (0.255, 0.755)),
            ((0.285, 0.785), (0.315, 0.765), (0.325, 0.725)),
            ((0.295, 0.650), (0.288, 0.525), (0.315, 0.450)),
            ((0.298, 0.442), (0.280, 0.437), (0.265, 0.435)),
        ],
        HAIR,
    )
    p.mirror_path(
        (0.265, 0.435),
        [
            ((0.205, 0.525), (0.205, 0.665), (0.255, 0.755)),
            ((0.285, 0.785), (0.315, 0.765), (0.325, 0.725)),
            ((0.295, 0.650), (0.288, 0.525), (0.315, 0.450)),
            ((0.298, 0.442), (0.280, 0.437), (0.265, 0.435)),
        ],
        HAIR,
    )

    # 刘海（波状下缘）
    p.path(
        (0.270, 0.452),
        [
            ((0.310, 0.345), (0.400, 0.300), (0.500, 0.300)),
            ((0.600, 0.300), (0.690, 0.345), (0.730, 0.452)),
            ((0.690, 0.470), (0.650, 0.452), (0.618, 0.412)),
            ((0.580, 0.460), (0.530, 0.478), (0.492, 0.430)),
            ((0.452, 0.478), (0.395, 0.478), (0.360, 0.430)),
            ((0.330, 0.462), (0.298, 0.462), (0.270, 0.452)),
        ],
        HAIR,
    )

    # 呆毛
    p.stroke((0.505, 0.240), [((0.500, 0.165), (0.545, 0.100), (0.610, 0.105))], HAIR, 0.018)
    p.stroke((0.610, 0.105), [((0.585, 0.115), (0.565, 0.135), (0.558, 0.160))], HAIR, 0.014)

    # 白色荷叶边女仆头饰：一条弧形发带（不遮住刘海），外缘一圈荷叶边
    p.path(
        (0.235, 0.338),
        [
            ((0.255, 0.225), (0.365, 0.158), (0.500, 0.158)),
            ((0.635, 0.158), (0.745, 0.225), (0.765, 0.338)),
            ((0.722, 0.300), (0.682, 0.288), (0.645, 0.320)),
            ((0.600, 0.268), (0.548, 0.250), (0.500, 0.268)),
            ((0.452, 0.250), (0.400, 0.268), (0.355, 0.320)),
            ((0.318, 0.288), (0.278, 0.300), (0.235, 0.338)),
        ],
        HEADD_FILL,
        outline=HEADD_LINE,
        width=0.007,
    )
    for cx, cy, radius in [
        (0.270, 0.238, 0.030),
        (0.350, 0.192, 0.029),
        (0.440, 0.168, 0.028),
        (0.560, 0.168, 0.028),
        (0.650, 0.192, 0.029),
        (0.730, 0.238, 0.030),
    ]:
        p.circle(cx, cy, radius, HEADD_FILL, outline=HEADD_LINE, width=0.003)

    # 头饰右侧小蝴蝶结
    p.polygon([(0.722, 0.245), (0.665, 0.213), (0.676, 0.277)], RIBBON)
    p.polygon([(0.722, 0.245), (0.779, 0.213), (0.768, 0.277)], RIBBON)
    p.circle(0.722, 0.245, 0.015, RIBBON_DARK)

    # 眼睛 / 腮红 / 嘴
    p.ellipse(0.400, 0.545, 0.030, 0.043, EYE)
    p.circle(0.410, 0.533, 0.009, WHITE)
    p.ellipse(0.600, 0.545, 0.030, 0.043, EYE)
    p.circle(0.610, 0.533, 0.009, WHITE)
    p.stroke((0.355, 0.512), [((0.378, 0.503), (0.420, 0.503), (0.443, 0.515))], EYE, 0.006)
    p.stroke((0.645, 0.512), [((0.622, 0.503), (0.580, 0.503), (0.557, 0.515))], EYE, 0.006)
    p.ellipse(0.325, 0.622, 0.035, 0.018, BLUSH)
    p.ellipse(0.675, 0.622, 0.035, 0.018, BLUSH)
    p.arc(0.500, 0.620, 0.030, 0.022, 20, 160, EYE, width=0.007)

    # 气泡（避开尾鳍，避免在小尺寸下被误读成尾巴的一部分）
    for cx, cy, radius in [(0.150, 0.265, 0.038), (0.118, 0.385, 0.018), (0.855, 0.190, 0.030), (0.135, 0.790, 0.022)]:
        p.circle(cx, cy, radius, BUBBLE)
    p.circle(0.142, 0.255, 0.010, WHITE)
    p.circle(0.846, 0.181, 0.008, WHITE)

    # 底部浪花
    p.stroke(
        (0.090, 0.885),
        [
            ((0.180, 0.845), (0.270, 0.925), (0.360, 0.885)),
            ((0.450, 0.845), (0.540, 0.925), (0.630, 0.885)),
            ((0.720, 0.845), (0.810, 0.925), (0.910, 0.885)),
        ],
        SKY,
        0.010,
    )


def draw_compact_silhouette(draw: ImageDraw.ImageDraw, size: int, small_size: int = 16):
    """16/32 px 专用剪影：偏左的圆头 + 荷叶边轮廓 + 右侧大鲸尾 + 深色眼睛。

    small_size 是最终像素尺寸（size 是超采样画布）：16px 下用更粗的分隔线，避免白形糊成一团。
    圆头略向左移、鲸尾加宽，给右侧鳍形留出 4–5 个像素，16px 下也能看出「鲸鱼 + 头饰」。
    """
    p = Painter(draw, size, scale=0.92, dx=0.0, dy=0.012)

    # 鲸尾：比细节版更宽大的剪影（中央凹口 + 上下圆钝尾尖）
    p.stroke((0.560, 0.640), [((0.620, 0.646), (0.670, 0.642), (0.715, 0.634))], WHITE, 0.080)
    p.path(
        (0.660, 0.620),
        [
            ((0.780, 0.560), (0.900, 0.455), (0.970, 0.325)),
            ((1.010, 0.370), (1.000, 0.440), (0.950, 0.490)),
            ((0.900, 0.535), (0.840, 0.565), (0.800, 0.588)),
            ((0.775, 0.608), (0.790, 0.638), (0.830, 0.654)),
            ((0.890, 0.672), (0.950, 0.725), (0.975, 0.795)),
            ((1.010, 0.858), (0.995, 0.918), (0.945, 0.905)),
            ((0.860, 0.885), (0.760, 0.760), (0.660, 0.648)),
        ],
        WHITE,
    )

    # 圆头 + 荷叶边头饰轮廓（五个圆形凸起并成一条花边）；头部略偏左
    p.circle(0.455, 0.560, 0.245, WHITE)
    p.circle(0.315, 0.330, 0.066, WHITE)
    p.circle(0.385, 0.297, 0.070, WHITE)
    p.circle(0.455, 0.286, 0.074, WHITE)
    p.circle(0.525, 0.297, 0.070, WHITE)
    p.circle(0.595, 0.330, 0.066, WHITE)
    # 头饰与头部之间留一道缝：深蓝弧线勾出荷叶边下缘（太粗会像横杠，取 0.6–0.8px 视觉宽度）
    gap_width = 0.060 if small_size <= 16 else 0.035
    p.stroke(
        (0.270, 0.368),
        [
            ((0.335, 0.333), (0.395, 0.322), (0.455, 0.322)),
            ((0.515, 0.322), (0.575, 0.333), (0.640, 0.368)),
        ],
        # 用底色蓝而不是深蓝：在剪影里看起来像头饰与头部之间的一条缝，而不是黑横杠
        BODY,
        gap_width,
    )

    # 眼睛：深蓝小点（32px 可见；16px 缩为 1px 轮廓内的暗点）
    p.ellipse(0.390, 0.565, 0.040, 0.054, EYE)
    p.ellipse(0.520, 0.565, 0.040, 0.054, EYE)


def build_icon_base(size: int) -> Image.Image:
    """图标底：深蓝渐变圆角方块 + 顶部柔光 + 浅色圆盘（细节版）。"""
    base = vertical_gradient(size, BG_TOP, BG_BOTTOM)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (-0.28 * size, -0.52 * size, 1.28 * size, 0.62 * size),
        fill=(255, 255, 255, 30),
    )
    base = Image.alpha_composite(base, glow)
    return base


def render_icon(size: int) -> Image.Image:
    """单个尺寸的图标（含透明圆角）。"""
    supersample = 8 if size <= 64 else 4
    canvas = size * supersample
    base = build_icon_base(canvas)

    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    if size <= 32:
        draw_compact_silhouette(draw, canvas, small_size=size)
    else:
        # 浅色圆盘：让深蓝吉祥物在深蓝底上有足够对比
        disc = ImageDraw.Draw(layer)
        disc.ellipse(
            (0.5 * canvas - 0.385 * canvas, 0.525 * canvas - 0.385 * canvas,
             0.5 * canvas + 0.385 * canvas, 0.525 * canvas + 0.385 * canvas),
            fill=DISC,
            outline=DISC_EDGE,
            width=max(1, round(0.008 * canvas)),
        )
        draw_detailed_mascot(draw, canvas, scale=0.86, dx=-0.02, dy=0.035)

    base = Image.alpha_composite(base, layer)
    icon = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(canvas, round(canvas * 0.18)))
    return icon.resize((size, size), Image.Resampling.LANCZOS)


def render_mascot_png(size: int = 256) -> Image.Image:
    """透明背景吉祥物（细节版，4× 超采样后降采样）。"""
    supersample = 4
    canvas = size * supersample
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw_detailed_mascot(ImageDraw.Draw(layer), canvas)
    return layer.resize((size, size), Image.Resampling.LANCZOS)


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """写多尺寸 ICO（每个尺寸嵌入 PNG 帧，Vista+ 支持；16/32/48/256 各自独立绘制而非缩放）。"""
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
        entries.extend(
            struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), offset)
        )
        offset += len(data)

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(header)
        handle.write(entries)
        for data in frames:
            handle.write(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成鲸鲸阅读器原创图标与鲸鱼女仆娘吉祥物")
    parser.add_argument("--output", default=str(DEFAULT_ICO), help="输出 ico 路径（默认 src/Host/app.ico）")
    parser.add_argument(
        "--mascot-output",
        default=str(DEFAULT_MASCOT),
        help="输出吉祥物 PNG 路径（默认 src/Host/AboutMascot.png）",
    )
    args = parser.parse_args()

    ico_path = Path(args.output).resolve()
    mascot_path = Path(args.mascot_output).resolve()

    icons = [render_icon(size) for size in ICON_SIZES]
    write_ico(ico_path, icons)

    mascot = render_mascot_png(256)
    mascot_path.parent.mkdir(parents=True, exist_ok=True)
    mascot.save(mascot_path, format="PNG", optimize=True)

    print(
        f"已生成 {ico_path}（尺寸：{'/'.join(str(size) for size in ICON_SIZES)}，{ico_path.stat().st_size} B）"
    )
    print(f"已生成 {mascot_path}（256×256 透明背景，{mascot_path.stat().st_size} B）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
