"""生成演示分镜（data/demo.beats.json）用的配音和逐字时间：程序合成的提示音，不是人声。
CI 和没有配音模型的环境都用它跑编译、铅笔和安全区检查；仓库里不放任何录音。
每个字一段 0.24 秒的谐波音，字间留 0.04 秒，句与句之间留 0.5 秒静音（编译器只在静音处切旁白）。
另生成演示分镜贴的一小段片子（贴视频 clip 的示例）：程序画的示意动画（两颗红珠子、两颗蓝珠子滑到一排，数出四颗），不是实拍，也不进仓库。
用法（在 engine 目录下）：python qa/fixtures/demo/make_demo.py
输出：public/audio/demo.wav、qa/fixtures/demo/out/demo.timing.json、public/clips/demo-beads.mp4
"""
import json
import re
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import soundfile as sf

SR = 24000
ENGINE = Path(__file__).resolve().parents[3]
beats = json.loads((ENGINE / "data" / "demo.beats.json").read_text(encoding="utf-8"))
script = beats["narration"]["script"]

rng = np.random.default_rng(7)
audio, words, t = [np.zeros(int(0.4 * SR))], [], 0.4
for k, sent in enumerate(re.findall(r"[^。？！]+[。？！]?", script)):
    for ch in re.sub(r"[，。；：！？、\s]", "", sent):
        n = int(0.24 * SR)
        x = np.arange(n) / SR
        f0 = 170 + 30 * rng.random()
        tone = sum(np.sin(2 * np.pi * f0 * h * x) / h for h in range(1, 6))
        audio += [0.25 * tone * np.hanning(n), np.zeros(int(0.04 * SR))]
        words.append({"text": ch, "start": round(t, 3), "end": round(t + 0.24, 3)})
        t += 0.28
    audio.append(np.zeros(int(0.5 * SR)))
    t += 0.5
audio.append(np.zeros(int(0.6 * SR)))

out_audio = ENGINE / "public" / beats["narration"]["audio"]
out_timing = (ENGINE / "data" / beats["narration"]["timing"]).resolve()
out_audio.parent.mkdir(parents=True, exist_ok=True)
out_timing.parent.mkdir(parents=True, exist_ok=True)
sf.write(out_audio, np.concatenate(audio).astype(np.float32), SR)
out_timing.write_text(json.dumps({"source": "synthetic demo tones", "text": script, "words": words}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"演示配音：{out_audio.relative_to(ENGINE)}（{t + 0.6:.1f}s），逐字时间：{out_timing.relative_to(ENGINE)}（{len(words)} 字）")


# 演示片子：3 秒、30 帧/秒、480×270。木色桌面上两颗红珠子从左、两颗蓝珠子从右滑进来排成一排，最后四颗一起轻轻一跳
def beads_clip(out, w=480, h=270, fps=30, sec=3.0):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    table = np.stack([206 + 10 * np.sin(xx / 37) * np.cos(yy / 53), 176 + 8 * np.sin(xx / 41), 138 + 6 * np.cos(yy / 29)], -1)  # 木纹似的桌面
    red, blue = np.array([196, 67, 47], np.float32), np.array([43, 95, 128], np.float32)
    slot = [w * (0.5 + (k - 1.5) * 0.15) for k in range(4)]
    ease = lambda u: 0.5 - 0.5 * np.cos(np.pi * min(1.0, max(0.0, u)))
    frames = []
    for f in range(int(sec * fps)):
        t = f / fps
        img = table.copy()
        hop = 14 * max(0.0, np.sin(np.pi * (t - 2.2) / 0.5)) if 2.2 < t < 2.7 else 0.0
        for k in range(4):
            start = -60 if k < 2 else w + 60
            u = ease((t - 0.2 - 0.25 * (k % 2)) / 1.2)
            cx, cy, r = start + (slot[k] - start) * u, h * 0.55 - hop, 30
            d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
            a = np.clip(r - d + 0.5, 0, 1)[..., None]  # 抗锯齿的边
            shade = np.clip(1.15 - 0.45 * ((xx - cx + 10) ** 2 + (yy - cy + 10) ** 2) / r**2, 0.55, 1.2)[..., None]
            img = img * (1 - a) + np.clip((red if k < 2 else blue) * shade, 0, 255) * a
        frames.append(np.clip(img, 0, 255).astype(np.uint8))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part.mp4")
    gen = imageio_ffmpeg.write_frames(str(tmp), (w, h), fps=fps, codec="libx264", pix_fmt_in="rgb24", pix_fmt_out="yuv420p", quality=None,
                                      output_params=["-crf", "20", "-preset", "medium", "-movflags", "+faststart"], macro_block_size=1)
    gen.send(None)
    for fr in frames:
        gen.send(fr.tobytes())
    gen.close()
    tmp.replace(out)
    print(f"演示片子：{out.relative_to(ENGINE)}（{sec:.0f}s，{w}×{h}，程序画的示意动画）")


beads_clip(ENGINE / "public" / "clips" / "demo-beads.mp4")
