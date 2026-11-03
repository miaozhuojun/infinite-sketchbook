"""生成演示分镜（data/demo.beats.json）用的配音和逐字时间：程序合成的提示音，不是人声。
CI 和没有配音模型的环境都用它跑编译、铅笔和安全区检查；仓库里不放任何录音。
每个字一段 0.24 秒的谐波音，字间留 0.04 秒，句与句之间留 0.5 秒静音（编译器只在静音处切旁白）。
用法（在 engine 目录下）：python qa/fixtures/demo/make_demo.py
输出：public/audio/demo.wav、qa/fixtures/demo/out/demo.timing.json
"""
import json
import re
from pathlib import Path

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
