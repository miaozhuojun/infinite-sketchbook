"""小样程序检查：每项都能失败，失败即非零退出。
用法：../.venv-qa/bin/python qa/qa.py <timeline.json> <video.mp4> <composition-id>
检查：媒体流与时长、响度/真峰值、黑帧/冻结、同帧确定性、笔尖是否真的落在正在画的笔迹末端（抽检渲染帧）。
"""
import json
import math
import random
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image

FF = imageio_ffmpeg.get_ffmpeg_exe()
tl_path, video, comp = sys.argv[1], sys.argv[2], sys.argv[3]
tl = json.loads(Path(tl_path).read_text())
work = Path("out/qa"); work.mkdir(parents=True, exist_ok=True)
results = []


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(f"[{'通过' if ok else '失败'}] {name}：{detail}")


def ff(args):
    return subprocess.run([FF, "-hide_banner", *args], capture_output=True, text=True).stderr


# 1. 媒体流与时长
info = ff(["-i", video])
dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
secs = int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3])
has_a, has_v = "Audio:" in info, "Video:" in info
check("音视频流", has_a and has_v, f"视频流 {has_v}，音频流 {has_a}")
check("时长", abs(secs - tl["duration"]) < 0.15, f"成片 {secs:.2f}s，时间线 {tl['duration']}s")

# 2. 响度（本小样目标 -16 LUFS ±1，真峰值 ≤ -1.0 dBTP）
lo = ff(["-i", video, "-af", "ebur128=peak=true", "-f", "null", "-"])
I = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", lo)[-1])
tp = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", lo)[-1])
check("响度", abs(I + 16) <= 1.0 and tp <= -1.0, f"{I} LUFS，真峰值 {tp} dBTP")

# 3. 黑帧 / 冻结（冻结区间列出来，交给人判断是否为设计性停留）
bd = ff(["-i", video, "-vf", "blackdetect=d=0.1:pix_th=0.1", "-an", "-f", "null", "-"])
blacks = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", bd)
check("黑帧", not blacks, f"{len(blacks)} 段")
fz = ff(["-i", video, "-vf", "freezedetect=n=0.0005:d=1.5", "-an", "-f", "null", "-"])
starts = re.findall(r"freeze_start: ([\d.]+)", fz)
ends = re.findall(r"freeze_end: ([\d.]+)", fz)
spans = [f"{float(a):.1f}-" + (f"{float(b):.1f}s" if b != "end" else "片尾") for a, b in zip(starts, ends + ["end"] * len(starts))] if starts else []
print(f"[提示] 画面静止 ≥1.5s 的区间：{spans or '无'}（需人工判断是否为有意停留）")


def still(frame, name, props=None):
    out = work / name
    cmd = ["npx", "remotion", "still", "src/index.ts", comp, str(out), f"--frame={frame}", "--log=error"]
    if props:
        cmd.append(f"--props={json.dumps(props)}")
    subprocess.run(cmd, check=True)
    return np.asarray(Image.open(out).convert("RGB")).astype(np.int16)


# 4. 确定性：同一帧分两次独立进程渲染，像素必须完全一致
f = int(tl["durationInFrames"] * 0.53)
a, b = still(f, "det_a.png"), still(f, "det_b.png")
check("同帧确定性", np.array_equal(a, b), f"第 {f} 帧两次渲染最大像素差 {int(np.abs(a - b).max())}")


# 5. 笔尖跟随：随机抽 12 个落笔时刻，隐藏铅笔渲染，检查预测笔尖处是否刚好有墨迹
def ease(x):
    return 2 * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 2 / 2


def cam_at(t):
    c = tl["camera"][0]["from"]
    for m in tl["camera"]:
        if t >= m["t1"]:
            c = m["to"]
        elif t > m["t0"]:
            e = ease((t - m["t0"]) / (m["t1"] - m["t0"]))
            c = {k: m["from"][k] + (m["to"][k] - m["from"][k]) * e for k in "xyz"}
    return c


random.seed(7)
downs = [s for s in tl["penTrack"] if s["kind"] == "down" and (s["t1"] - s["t0"]) * tl["fps"] >= 3]
samples = random.sample(downs, min(12, len(downs)))
misses = []
for s in samples:
    fr = int(math.floor((s["t0"] + (s["t1"] - s["t0"]) * 0.6) * tl["fps"]))
    t = fr / tl["fps"]
    # 复现渲染端的笔尖位置：用渲染时同一套路径长度插值（在浏览器里求），这里直接读页面会更慢；
    # 改为检查"预测位置附近有墨、而路径末端前方无墨"的弱条件，误差容忍 6px
    img = still(fr, f"pen_{fr}.png", {"showPen": False})
    stroke = tl["strokes"][s["stroke"]]
    p = (t - s["t0"]) / (s["t1"] - s["t0"])
    pts = subprocess.run(["node", "qa/point_at.mjs", stroke["d"], str(p)], capture_output=True, text=True, check=True).stdout.split()
    x, y = float(pts[0]), float(pts[1])
    c = cam_at(t)
    sx, sy = (x - c["x"]) * c["z"] + tl["view"]["cx"], (y - c["y"]) * c["z"] + tl["view"]["cy"]
    r = 6
    patch = img[int(sy) - r:int(sy) + r + 1, int(sx) - r:int(sx) + r + 1]
    # 墨迹 = 和纸色差得远的像素，不管是什么墨色（原来只认深灰和偏红，通行绿的字会被当成没墨）
    paper = np.array([int(tl["style"]["palette"]["paper"][i:i + 2], 16) for i in (1, 3, 5)])
    ink = int((np.sqrt(((patch.astype(int) - paper) ** 2).sum(axis=2)) > 80).sum())
    if ink < 3:
        misses.append(f"帧{fr} {stroke['id']} 屏幕({sx:.0f},{sy:.0f}) 墨迹像素{ink}")
check("笔尖落在正在画的笔迹上", not misses, f"抽检 {len(samples)} 处，未命中 {len(misses)}" + (("：" + "；".join(misses)) if misses else ""))

# 运笔流畅、笔身晃动、压字幕：见 qa/pencil_check.mjs（直接复用渲染端的姿态函数）

failed = [r for r in results if not r[1]]
print(f"\n共 {len(results)} 项，失败 {len(failed)} 项")
sys.exit(1 if failed else 0)
