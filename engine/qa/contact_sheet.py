"""按帧号精确抽帧做联系表（每格标帧号和时间），给审片用。避免 fps 滤镜带来的时间偏差。
用法：../.venv-qa/bin/python qa/contact_sheet.py <video.mp4> <outdir> [每隔几帧，默认 30] [--fps 60] [--ranges 30-60,90-120 --prefix changed]
--ranges：只抽这几段（秒）里的帧，联系表叫 <名>_<prefix>_sheet_NN.png。分段渲染后，流水线拿这次新渲的段做一份，增量审片只看它
"""
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw

from cjk_font import cjk_font

args = sys.argv[1:]
def opt(k, d=None):
    if k in args:
        i = args.index(k); v = args[i + 1]; del args[i:i + 2]; return v
    return d
fps = float(opt("--fps", 60))
ranges = [tuple(float(x) for x in r.split("-")) for r in opt("--ranges", "").split(",") if r]
prefix = opt("--prefix")
video, out = args[0], Path(args[1])
every = int(args[2]) if len(args) > 2 else 30
out.mkdir(parents=True, exist_ok=True)
tmp = out / f"_frames{'_' + prefix if prefix else ''}"
tmp.mkdir(exist_ok=True)
sel = f"not(mod(n\\,{every}))"
if ranges:
    sel += "*(" + "+".join(f"between(n\\,{round(a * fps)}\\,{round(b * fps) - 1})" for a, b in ranges) + ")"
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", video, "-vf", f"select='{sel}',scale=-2:480",
                "-fps_mode", "passthrough", str(tmp / "f_%04d.png")], check=True)
files = sorted(tmp.glob("f_*.png"))
stem = Path(video).stem + (f"_{prefix}" if prefix else "")
# 先清掉这个画幅上一轮的联系表：片子变短时，多出来的旧表会混在审片目录里（审片 v9：sheet_46–47 还是上一轮的整句口号）
for old in out.glob(f"{stem}_sheet_*.png"):
    old.unlink()
if not files:
    tmp.rmdir()
    print(f"联系表：没有要抽的帧（{'范围 ' + str(ranges) if ranges else video}）")
    sys.exit(0)
# 每格的帧号：和 select 的条件一样算出来（只抽某几段时帧号不连续）
top = max(round(b * fps) for a, b in ranges) if ranges else len(files) * every
nums = [n for n in range(0, top, every) if not ranges or any(round(a * fps) <= n <= round(b * fps) - 1 for a, b in ranges)][:len(files)]
font = cjk_font(18)
w, h = Image.open(files[0]).size
cols = 6 if w < h else 4
per = cols * 2
for k in range(0, len(files), per):
    sheet = Image.new("RGB", (cols * w, 2 * h), "white")
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(files[k:k + per]):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(Image.open(f), (x, y))
        n = nums[k + i]
        d.rectangle([x, y + h - 30, x + 220, y + h], fill="black")
        d.text((x + 8, y + h - 27), f"帧 {n}  {n / fps:.2f}s", fill="white", font=font)
    sheet.save(out / f"{stem}_sheet_{k // per + 1:02d}.png")
for f in files:
    f.unlink()
tmp.rmdir()
print(f"联系表：{out}/{stem}_sheet_*.png（每 {every} 帧一格，共 {len(files)} 格{'，只含 ' + '、'.join(f'{a:.0f}–{b:.0f}s' for a, b in ranges) if ranges else ''}）")
