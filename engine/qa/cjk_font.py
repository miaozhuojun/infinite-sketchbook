"""预览图、联系表上标注文字用的中文字体：按常见系统路径找一个带中文的，也可以用环境变量 QA_FONT 指定。
都找不到时退回 Pillow 自带字体，中文会显示成方块；只影响标注好不好认，不影响任何检查结论。
"""
import os
from pathlib import Path

from PIL import ImageFont

CANDIDATES = [
    os.environ.get("QA_FONT", ""),
    "/System/Library/Fonts/Hiragino Sans GB.ttc",  # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  # Debian / Ubuntu：fonts-noto-cjk
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",  # Arch / Fedora
    "C:/Windows/Fonts/msyh.ttc",  # Windows
]
PATH = next((p for p in CANDIDATES if p and Path(p).exists()), None)


def cjk_font(size):
    return ImageFont.truetype(PATH, size) if PATH else ImageFont.load_default(size)
