"""声音包（VOICE_PIPELINE.md 第一步）：从真人录音里挑出同一音色、干（没回声）、干净、有起伏的片段，拼成一段主参考，
统一响度、去噪，写出参考音和清单。每个声音做一次，所有集共用；做完要用校准稿试配、用户盲听认可再填进 voice.json。
用法：.venv-mlx/bin/python build_voice.py <输出目录>   （真人录音取 voice.json 的 real）
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from mlx_audio.stt import load as load_stt
from mlx_audio.tts.utils import load_model
from mlx_audio.sts.models.deepfilternet.model import DeepFilterNetModel

from voice import HERE, load_voice, embedding, echo_ms, voiced_flatness, pitch_range_st, pitch_median_hz, active_level_db
from dereverb import wpe

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
voice = load_voice()
P = {"minSim": 0.975, "maxEcho": 90, "maxFlat": 0.08, "minRange": 8.0, "minF0": 280, "minSec": 1.0, "maxSec": 4.0, "targetSec": 10.0, "gap": 0.35,
     **voice.get("packSelect", {})}
SR = 48000


def segments(x, sr):
    """按 ≥0.3 秒的停顿切段（比最响处低 30dB 算停顿），每段至少 0.8 秒"""
    h = int(0.01 * sr); e = np.array([20 * np.log10(np.sqrt((x[i:i + h] ** 2).mean()) + 1e-9) for i in range(0, len(x) - h, h)])
    on = e > np.percentile(e, 90) - 30; out, st, q = [], None, 0
    for k, v in enumerate(on):
        if v:
            st = k if st is None else st; q = 0
        elif st is not None:
            q += 1
            if q >= 30:
                end = k - q
                if end - st >= 80:
                    out.append((max(0, st - 5) * h, (end + 5) * h))
                st, q = None, 0
    return out


def pauses(y, sr):
    e = np.array([20 * np.log10(np.sqrt((y[i:i + 240] ** 2).mean()) + 1e-9) for i in range(0, len(y) - 240, 240)])
    a = e > e.max() - 30
    return [i * 240 / sr for i in range(1, len(a)) if a[i - 1] and not a[i]]


tts = load_model(str(HERE / "models/Qwen3-TTS-12Hz-1.7B-Base"))
asr = load_stt(str(HERE / "models/Qwen3-ASR-0.6B"))
real = [embedding(tts, *sf.read(str(HERE / p), dtype="float32")) for p in voice["real"]]
cen = np.mean(real, 0); cen /= np.linalg.norm(cen)
rows = []
# 只从原始录音里挑（ref_ 开头的是以前从原始录音里截出来的片段，再挑一遍会重复）
for p in [q for q in voice["real"] if not Path(q).name.startswith("ref_")]:
    x, sr = sf.read(str(HERE / p), dtype="float32"); x = x.mean(1) if x.ndim > 1 else x
    for k, (a, b) in enumerate(segments(x, sr)):
        # 先逐段去混响（WPE，整段过两遍只留第二遍），再量、再挑：有起伏的片段多半录在有回声的房间（v1），去掉回声才用得上。
        # 噪声上限放到 0.08：拼好后还要 DeepFilterNet 去噪
        y0 = x[a:b]; y = wpe(np.concatenate([y0, y0]).astype(np.float64), sr, taps=30, delay=2, iters=4)[len(y0):]
        tmp = OUT / "_seg.wav"; sf.write(tmp, y0, sr)
        r = {"src": p, "start": round(a / sr, 2), "end": round(b / sr, 2), "sec": round((b - a) / sr, 2),
             "sim": round(float(embedding(tts, y, sr) @ cen), 3), "echo": round(echo_ms(y, sr, pauses(y, sr))),
             "flat": round(voiced_flatness(y, sr), 3), "range": round(pitch_range_st(y, sr) or 0, 1), "f0": round(pitch_median_hz(y, sr) or 0),
             "text": asr.generate(str(tmp)).text.strip()}
        # minF0：只要孩子自己说的话。家庭视频里大人也会出声（「Draw a tree.」中位 250Hz，像大人在提示；孩子平时 300Hz 以上），
        # 音色相似度拦不住——真人录音的质心本身就混着大人的声音
        r["ok"] = (r["sim"] >= P["minSim"] and r["echo"] <= P["maxEcho"] and r["flat"] <= P["maxFlat"] and r["range"] >= P["minRange"] and r["f0"] >= P["minF0"]
                   and P["minSec"] <= r["sec"] <= P["maxSec"] and bool(r["text"]))
        rows.append(r)
(OUT / "_seg.wav").unlink(missing_ok=True)
pick, tot = [], 0.0
for r in sorted([r for r in rows if r["ok"]], key=lambda r: (-r["range"], r["echo"])):  # 起伏大的优先，再看回声短
    if tot >= P["targetSec"]:
        break
    if any(q["text"].lower() == r["text"].lower() for q in pick):  # 同一句话只要一段，参考音里内容多样一点
        continue
    pick.append(r); tot += r["sec"]
if not pick:
    raise SystemExit("没有一段同时满足音色、回声、噪声、起伏的要求，放宽 packSelect 或换真人录音")
parts = []
for r in pick:
    x, sr = sf.read(str(HERE / r["src"]), dtype="float32"); x = x.mean(1) if x.ndim > 1 else x
    y0 = x[int(r["start"] * sr):int(r["end"] * sr)].astype(np.float64)
    y = resample_poly(wpe(np.concatenate([y0, y0]), sr, taps=30, delay=2, iters=4)[len(y0):], SR, sr).astype(np.float32)
    y *= np.float32(10 ** ((-26 - active_level_db(y, SR)) / 20))  # 各段统一到同一基础响度
    parts += [y, np.zeros(int(P["gap"] * SR), np.float32)]
x = np.concatenate(parts[:-1])
dfn = DeepFilterNetModel.from_pretrained(str(HERE / "models/denoise/dfn3"), subfolder=None)
y = np.asarray(dfn.enhance_array(np.concatenate([x, x])), dtype=np.float32)[len(x):]  # 整段过两遍只留第二遍（开头不被当噪声压掉）
sf.write(OUT / "main.wav", y, SR)
(OUT / "main.txt").write_text(" ".join(r["text"] for r in pick), encoding="utf-8")
json.dump({"select": P, "picked": pick, "segments": rows, "seconds": round(len(y) / SR, 2),
           "main": {"echo": round(echo_ms(y, SR, pauses(y, SR))), "flat": round(voiced_flatness(y, SR), 3), "sim": round(float(embedding(tts, y, SR) @ cen), 3)}},
          open(OUT / "pack.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"选了 {len(pick)} 段，共 {tot:.1f} 秒：" + " / ".join(f"{r['text']}（{r['src'].rsplit('/', 1)[-1]} 回声 {r['echo']}ms 起伏 {r['range']}）" for r in pick))
print(f"主参考 {OUT / 'main.wav'}：{len(y) / SR:.1f}s；清单 {OUT / 'pack.json'}")
