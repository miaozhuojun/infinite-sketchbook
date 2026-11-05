"""按帧号精确抽帧做联系表（每格标帧号和时间），给审片用。避免 fps 滤镜带来的时间偏差。
用法：../.venv-qa/bin/python qa/contact_sheet.py <video.mp4> <outdir> [每隔几帧，默认 30]
"""
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw

from cjk_font import cjk_font

video, out = sys.argv[1], Path(sys.argv[2])
every = int(sys.argv[3]) if len(sys.argv) > 3 else 30
out.mkdir(parents=True, exist_ok=True)
tmp = out / "_frames"
tmp.mkdir(exist_ok=True)
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", video, "-vf", f"select='not(mod(n\\,{every}))',scale=-2:480",
                "-fps_mode", "passthrough", str(tmp / "f_%04d.png")], check=True)
files = sorted(tmp.glob("f_*.png"))
font = cjk_font(18)
w, h = Image.open(files[0]).size
cols = 6 if w < h else 4
per = cols * 2
stem = Path(video).stem
# 先清掉这个画幅上一轮的联系表：片子变短时，多出来的旧表会混在审片目录里（审片 v9：sheet_46–47 还是上一轮的整句口号）
for old in out.glob(f"{stem}_sheet_*.png"):
    old.unlink()
for k in range(0, len(files), per):
    sheet = Image.new("RGB", (cols * w, 2 * h), "white")
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(files[k:k + per]):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(Image.open(f), (x, y))
        n = (k + i) * every
        d.rectangle([x, y + h - 30, x + 220, y + h], fill="black")
        d.text((x + 8, y + h - 27), f"帧 {n}  {n / 60:.2f}s", fill="white", font=font)
    sheet.save(out / f"{stem}_sheet_{k // per + 1:02d}.png")
for f in files:
    f.unlink()
tmp.rmdir()
print(f"联系表：{out}/{stem}_sheet_*.png（每 {every} 帧一格，共 {len(files)} 格）")
