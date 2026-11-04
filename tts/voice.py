"""音色是作品身份：配置在 voice.json，一致性度量只在这里定义——说话人嵌入（Qwen3-TTS 自带的说话人编码器）与真人录音质心的余弦相似度。
配音生成（qwen_clone.py）和旁白检查（speech_check.py）都用它，低于 voice.json 的下限即失败。
掉嗓子（pitch_drops）也在这里定义：浊音连续低于这个人最低自然音高，两边用同一条规则。"""
import json
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = Path(__file__).parent


def load_voice(path=HERE / "voice.json"):
    v = json.loads(Path(path).read_text(encoding="utf-8"))
    v["ref"] = str(HERE / v["ref"])
    v["ref_text"] = Path(v["ref"]).with_suffix(".txt").read_text(encoding="utf-8").strip()
    return v


def embedding(tts, x, sr):
    x = x.mean(1) if x.ndim > 1 else x
    x = (resample_poly(x, 24000, sr) if sr != 24000 else x).astype(np.float32)
    e = np.array(tts.extract_speaker_embedding(mx.array(x))).reshape(-1)
    return e / np.linalg.norm(e)


def similarity(tts, x, sr, voice):
    real = [embedding(tts, *sf.read(str(HERE / p), dtype="float32")) for p in voice["real"]]
    c = np.mean(real, 0)
    return float(embedding(tts, x, sr) @ (c / np.linalg.norm(c)))


# ---------- 掉嗓子：一段浊音突然掉到这个人最低自然音高以下（童声掉成成人男声的音高） ----------
# 用户在 E01 两次听出「学会」畸变：那两个字的基频掉到 124–171Hz，孩子平时在 240–350Hz。
# 帧间突跳查不出来（是平滑地掉下去的），音色相似度、回转识别也都正常，要直接看音高够不够这个孩子的下限。
def f0_track(x, sr, hop=0.005, win=0.03):
    """每 hop 秒一帧：(时刻, 基频)，不是浊音的帧基频记 0。自相关法，范围 90–600Hz。"""
    x = x.mean(1) if x.ndim > 1 else x
    out, W, H = [], int(win * sr), int(hop * sr)
    for i in range(0, len(x) - W, H):
        s = x[i:i + W] - x[i:i + W].mean()
        if 20 * np.log10(np.sqrt((s ** 2).mean()) + 1e-9) < -35:
            out.append((i / sr, 0.0)); continue
        ac = np.correlate(s, s, "full")[W - 1:]; ac /= ac[0]
        lo, hi = int(sr / 600), int(sr / 90); k = lo + int(np.argmax(ac[lo:hi]))
        out.append((i / sr, sr / k if ac[k] > 0.5 else 0.0))
    return out


def pitch_drops(x, sr, floor_hz, min_sec=0.06):
    """连续至少 min_sec 秒的浊音都低于 floor_hz 的段：[(起, 止, 最低基频)]。"""
    runs, cur = [], []
    for t, f in f0_track(x, sr) + [(None, 0.0)]:
        if f and f < floor_hz:
            cur.append((t, f)); continue
        if cur and cur[-1][0] - cur[0][0] + 0.005 >= min_sec:
            runs.append((cur[0][0], cur[-1][0] + 0.03, min(f for _, f in cur)))
        cur = []
    return runs
