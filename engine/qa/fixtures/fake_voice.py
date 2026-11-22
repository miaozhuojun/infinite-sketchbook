"""假配音环境：不载模型，把 tts/qwen_clone.py 整个跑一遍，给检查器自测（qa/selftest.mjs）验配音的流程（卡句早报、拼好后换种子配不出来就不再重配）。
CI 和工作树里没有模型、参考音、音色配置，也没有 mlx（只有 Apple Silicon 上有）：这里把 mlx、mlx_audio 换成桩，pypinyin 没装时也换成桩（逐字算一个音节），
voice.py、qwen_clone.py 里的检查都是真的。

桩怎么做：
  - 配音（TTS）：每个字一段 0.2 秒的纯音，频率按字分（每个字一个频率），逗号处停 0.25 秒，有声的段两头淡入淡出（不算硬切），没声的地方垫一层很轻的底噪（不算掉音）。
    剧本（rules）可以让某几个种子（from ≤ 种子 < below）把某个词念成别的词（say），或者把某个字念得很轻（weak，比别的字低 40dB）。
  - 回转识别（ASR）和逐字对齐：按频率把字认回来（每 10ms 一帧，取最响的频率，落到最近的那个字上），对齐就用认出来的每个字的起止。
    同一个字不能紧挨着出现两次（认不开），剧本里的句子要避开。
用法：python fake_voice.py <工作目录> <剧本.json>
  剧本：{"text": 旁白稿, "rules": [{"has": "球只", "say": "我只", "from": 种子下限, "below": 种子上限（都不写就是每个种子都这样）}, {"has": "十", "weak": true}],
         "voice": {覆盖音色配置}, "args": [qwen_clone.py 另加的参数]}
  配音输出前缀是 <工作目录>/out/fake；qwen_clone.py 的输出原样打出来，退出码也照传。听错的说法记在 <工作目录>/misheard.json（TTS_MISHEARD），不碰本机那份
"""
import json
import os
import runpy
import sys
import types
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
TTS = ROOT / "tts"
work, scen = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
work.mkdir(parents=True, exist_ok=True)
SR = 24000
PUNCT = set("，。；：！？、,.;:!?\"“”'‘’（）()—- ")
PAUSE = set("，、：；,;:")
FREQ = {}  # 字 → 频率（第一次见到时分一个）


def freq(ch):
    if ch not in FREQ:
        FREQ[ch] = 320.0 + 45.0 * len(FREQ)
    return FREQ[ch]


for ch in scen["text"] + "".join(r.get("say", "") for r in scen.get("rules", [])) + "参考音":
    if ch not in PUNCT:
        freq(ch)
for s in [scen["text"]] + [r.get("say", "") for r in scen.get("rules", [])]:
    chars = [c for c in s if c not in PUNCT]
    assert all(a != b for a, b in zip(chars, chars[1:])), f"剧本里同一个字紧挨着出现两次，桩认不开：{s}"

RNG = np.random.default_rng(0)


def render(text, weak=()):
    """一句话的声音：每个字 0.2 秒纯音（两个谐波），weak 里的字低 40dB；逗号停 0.25 秒；有声段两头 20ms 淡入淡出；底噪 1e-4"""
    floor = lambda d: RNG.standard_normal(int(d * SR)) * 1e-4
    out, seg = [floor(0.15)], []

    def flush():
        if seg:
            x = np.concatenate(seg); n = int(0.02 * SR); r = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))
            x[:n] *= r; x[-n:] *= r[::-1]
            out.append(x + floor(len(x) / SR)); seg.clear()

    for i, ch in enumerate(text):
        if ch in PUNCT:
            if ch in PAUSE:
                flush(); out.append(floor(0.25))
            continue
        t = np.arange(int(0.2 * SR)) / SR
        f = freq(ch)
        seg.append((0.3 if i not in weak else 0.003) * (0.7 * np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)))
    flush()
    out.append(floor(0.2))
    return np.concatenate(out).astype(np.float32)


def decode(x, sr):
    """按频率认字：[(字, 起, 止)]。每 10ms 一帧（80ms 窗），比最响处低 55dB 以内的帧才算有声，连着落到同一个字上的帧算一个字（至少 3 帧）"""
    x = x.mean(1) if x.ndim > 1 else x
    win, hop = int(0.08 * sr), int(0.01 * sr)
    if len(x) < win:
        return []
    w = np.hanning(win)
    idx = np.arange(0, len(x) - win + 1, hop)
    rms = np.array([np.sqrt((x[i:i + win] ** 2).mean()) for i in idx])
    on = rms > rms.max() * 10 ** (-55 / 20)
    names, fs = list(FREQ), np.array(list(FREQ.values()))
    lab = []
    for i, v in zip(idx, on):
        if not v:
            lab.append(None); continue
        sp = np.abs(np.fft.rfft(x[i:i + win] * w, 16384))
        f = np.fft.rfftfreq(16384, 1 / sr)[int(np.argmax(sp[: int(3500 / sr * 16384)]))]
        k = int(np.argmin(np.abs(fs - f)))
        lab.append(names[k] if abs(fs[k] - f) < 15 else None)
    runs, j = [], 0
    while j < len(lab):
        k = j
        while k < len(lab) and lab[k] == lab[j]:
            k += 1
        if lab[j] is not None and k - j >= 3:
            runs.append((lab[j], (idx[j] + win / 2) / sr - 0.005, (idx[k - 1] + win / 2) / sr + 0.005))
        j = k
    return runs


# ---------- 桩：mlx、mlx_audio（不载模型），pypinyin（没装时） ----------
SEED = [0]
mx = types.ModuleType("mlx.core")
mx.random = types.SimpleNamespace(seed=lambda s: SEED.__setitem__(0, int(s)))
mx.array = lambda a, *_, **__: np.asarray(a)
mlx = types.ModuleType("mlx"); mlx.core = mx
sys.modules.update({"mlx": mlx, "mlx.core": mx})


class Chunk:
    def __init__(self, audio):
        self.audio, self.sample_rate = audio, SR


class FakeTTS:
    def generate(self, text, **_):
        said, weak = text, set()
        for r in scen.get("rules", []):
            if r["has"] in said and r.get("from", 0) <= SEED[0] < r.get("below", 1 << 30):
                if r.get("weak"):
                    p = said.index(r["has"]); weak.update(range(p, p + len(r["has"])))
                elif "say" in r:
                    said = said.replace(r["has"], r["say"])
        yield Chunk(render(said, weak))

    def extract_speaker_embedding(self, x):
        return np.ones(8, dtype=np.float32)  # 音色都一样


class Item:
    def __init__(self, text, a, b):
        self.text, self.start_time, self.end_time = text, a, b


class FakeASR:
    def generate(self, path, **_):
        return types.SimpleNamespace(text="".join(c for c, _, _ in decode(*sf.read(path, dtype="float32"))))


class FakeAligner:
    def generate(self, audio, text, **_):
        runs = decode(*sf.read(audio, dtype="float32"))
        chars = [c for c in text if c not in PUNCT]
        if [c for c, _, _ in runs] == chars:
            return [Item(c, a, b) for c, a, b in runs]
        a, b = (runs[0][1], runs[-1][2]) if runs else (0.0, 1.0)  # 对不上（念错的那条）：均分，像对齐器硬对
        d = (b - a) / max(1, len(chars))
        return [Item(c, a + i * d, a + (i + 1) * d) for i, c in enumerate(chars)]


stt = types.ModuleType("mlx_audio.stt"); stt.load = lambda p, *_, **__: FakeAligner() if "Aligner" in str(p) else FakeASR()
tts_utils = types.ModuleType("mlx_audio.tts.utils"); tts_utils.load_model = lambda *_, **__: FakeTTS()
tts_pkg = types.ModuleType("mlx_audio.tts"); tts_pkg.utils = tts_utils
mlx_audio = types.ModuleType("mlx_audio"); mlx_audio.stt, mlx_audio.tts = stt, tts_pkg
sys.modules.update({"mlx_audio": mlx_audio, "mlx_audio.stt": stt, "mlx_audio.tts": tts_pkg, "mlx_audio.tts.utils": tts_utils})
try:
    import pypinyin  # noqa: F401
except ImportError:
    py = types.ModuleType("pypinyin")
    py.lazy_pinyin = lambda s, errors=None, **_: list(s)
    py.pinyin = lambda s, **_: [[c] for c in s]
    py.Style = types.SimpleNamespace(NORMAL=0, TONE3=8, INITIALS=3, FINALS=5)
    py.load_phrases_dict = py.load_single_dict = lambda *_, **__: None
    contrib = types.ModuleType("pypinyin.contrib"); tc = types.ModuleType("pypinyin.contrib.tone_convert")
    tc.to_tone = tc.to_tone3 = lambda p: p
    contrib.tone_convert = tc
    pd = types.ModuleType("pypinyin.phrases_dict"); pd.phrases_dict = {}
    sys.modules.update({"pypinyin": py, "pypinyin.contrib": contrib, "pypinyin.contrib.tone_convert": tc, "pypinyin.phrases_dict": pd})

# ---------- 参考音、音色配置，然后整个跑 qwen_clone.py ----------
sf.write(work / "ref.wav", render("参考音"), SR)
(work / "ref.txt").write_text("参考音", encoding="utf-8")
voice = {"ref": str(work / "ref.wav"), "real": [str(work / "ref.wav")], "minSimilarity": 0.5, "maxTries": 10, "extraRounds": 2, "candidates": 1, "tones": {},
         **scen.get("voice", {})}
(work / "voice.json").write_text(json.dumps(voice, ensure_ascii=False), encoding="utf-8")
(work / "out").mkdir(exist_ok=True)
os.environ["TTS_MISHEARD"] = str(work / "misheard.json")
sys.path.insert(0, str(TTS))
sys.argv = [str(TTS / "qwen_clone.py"), scen["text"], str(work / "out" / "fake"), "--voice", str(work / "voice.json"), *scen.get("args", [])]
runpy.run_path(str(TTS / "qwen_clone.py"), run_name="__main__")
