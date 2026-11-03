"""音色是作品身份：配置在 voice.json，一致性度量只在这里定义——说话人嵌入（Qwen3-TTS 自带的说话人编码器）与真人录音质心的余弦相似度。
配音生成（qwen_clone.py）和旁白检查（speech_check.py）都用它，低于 voice.json 的下限即失败。"""
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
