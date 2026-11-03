"""生成锚定参考音（填进 voice.json 的 ref）：在真人参考音后面，接一句用同一音色克隆、回转核对过的陈述句。
为什么：参考音以问句收尾时，逐句生成的模型常常接着念那句问话，或者一直不收尾；以陈述句收尾后，逐句生成就稳定了。
用法：.venv-mlx/bin/python build_anchor.py <真人参考前缀> <输出前缀> [--sentence 锚句]
  例：build_anchor.py ref/my-voice/ref ref/my-voice/ref_anchor    （读 ref.wav、ref.txt，写 ref_anchor.wav、ref_anchor.txt）
改了真人参考或锚句才需要重跑；跑完重新标定 voice.json 的相似度下限。
"""
import argparse
import re

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.stt import load as load_stt
from mlx_audio.tts.utils import load_model
from pypinyin import lazy_pinyin

ap = argparse.ArgumentParser()
ap.add_argument("src", help="真人参考音前缀（不带扩展名），要有同名 .wav 和 .txt")
ap.add_argument("out", help="输出前缀")
ap.add_argument("--sentence", default="今天，我们把一个东西拆开，看看它到底是怎么运转的。", help="接在后面的陈述句")
args = ap.parse_args()
SRC, OUT, ANCHOR = args.src, args.out, args.sentence
PUNCT = r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]"
syl = lambda s: lazy_pinyin(re.sub(PUNCT, "", s).lower(), errors=lambda x: list(x))

asr, tts = load_stt("models/Qwen3-ASR-0.6B"), load_model("models/Qwen3-TTS-12Hz-1.7B-Base")
ref, sr = sf.read(SRC + ".wav", dtype="float32")
ref_text = open(SRC + ".txt", encoding="utf-8").read().strip()
for seed in range(2, 12):
    mx.random.seed(seed)
    ch = list(tts.generate(text=ANCHOR, ref_audio=SRC + ".wav", ref_text=ref_text, lang_code="chinese", temperature=0.7, max_tokens=300))
    a = np.concatenate([np.array(c.audio) for c in ch]).astype(np.float32)
    sf.write(OUT + ".tmp.wav", a, sr)
    hyp = asr.generate(OUT + ".tmp.wav", language="Chinese").text
    print(f"种子 {seed}：{len(a) / sr:.1f}s「{hyp}」")
    if syl(hyp) == syl(ANCHOR):
        break
else:
    raise SystemExit("锚句 10 个种子都没通过回转检查")
w = int(0.005 * sr)
a[:w] *= np.linspace(0, 1, w)
a[-w:] *= np.linspace(1, 0, w)
sf.write(OUT + ".wav", np.concatenate([ref, a, np.zeros(int(0.6 * sr), dtype=np.float32)]), sr)
open(OUT + ".txt", "w", encoding="utf-8").write(ref_text + " " + ANCHOR)
import os; os.remove(OUT + ".tmp.wav")
print(f"已写出 {OUT}.wav / .txt")
