"""参考音去噪：克隆模型会把参考音的声学环境一起学过去——参考音带底噪，配出来的声音就会一开口就沙沙响、说完就没。
先用 DeepFilterNet3 把参考音去噪，再填进 voice.json 的 ref / moods。
用法：.venv-mlx/bin/python denoise_ref.py <参考音.wav> <输出.wav> [--model models/denoise/dfn3]
  同名 .txt（参考音的逐字文本）会一起复制过去。输出 48kHz 单声道。
模型权重不进仓库：DeepFilterNet3（github.com/Rikorose/DeepFilterNet 的 models/DeepFilterNet3.zip，MIT/Apache-2.0），
用 mlx-audio 自带的 sts/models/deepfilternet/scripts/convert.py 转成 MLX 格式（config.json + model.safetensors）放进 --model 目录。
"""
import argparse
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from mlx_audio.sts.models.deepfilternet.model import DeepFilterNetModel

from voice import voiced_flatness

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("out")
ap.add_argument("--model", default="models/denoise/dfn3")
args = ap.parse_args()

dfn = DeepFilterNetModel.from_pretrained(args.model, subfolder=None)
x, sr = sf.read(args.src, dtype="float32")
x = x.mean(1) if x.ndim > 1 else x
if sr != dfn.config.sample_rate:
    x = resample_poly(x, dfn.config.sample_rate, sr).astype(np.float32)
sr = dfn.config.sample_rate
# DeepFilterNet 从空状态起步，开头约 0.4 秒会被当成噪声压掉（实测参考音开头的「Oh」没了，Qwen3-TTS 跟着不收尾）：
# 整段先过一遍热身，只留第二遍
y = np.asarray(dfn.enhance_array(np.concatenate([x, x])), dtype=np.float32)[len(x):]
sf.write(args.out, y, sr)
txt = Path(args.src).with_suffix(".txt")
if txt.exists():
    shutil.copyfile(txt, Path(args.out).with_suffix(".txt"))
db = lambda a: 20 * np.log10(np.sqrt((a ** 2).mean()) + 1e-12)
print(f"写出 {args.out}（{len(y) / sr:.2f}s，{sr}Hz）：开头 0.5 秒 {db(x[: sr // 2]):.0f} → {db(y[: sr // 2]):.0f} dB，"
      f"浊音谱平坦度 {voiced_flatness(x, sr):.3f} → {voiced_flatness(y, sr):.3f}")
