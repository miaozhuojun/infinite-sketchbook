"""第二把量音色的尺子：3D-Speaker 的 CAM++（中文说话人确认，Apache-2.0；sherpa-onnx 转的 ONNX）。
和 Qwen3 自带的说话人编码器无关：生成时挑候选、成片检查都用 Qwen3 的嵌入，只看它会被挑选本身「做好看」。
输入 16kHz，Kaldi 式 80 维 fbank（25ms 帧、10ms 移、预加重 0.97、povey 窗），按句减均值（模型元数据：样本在 ±1 之间、按全句减均值）。"""
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

MODEL = Path(__file__).parent / "models/campplus/campplus_zh-cn_16k.onnx"  # 不进仓库：fetch_models.sh 从 sherpa-onnx 的发布页下载
_sess = None


def _mel_banks(n_fft=512, sr=16000, n_mels=80, lo=20.0, hi=8000.0):
    mel = lambda f: 1127.0 * np.log(1 + f / 700.0)
    m_lo, m_hi = mel(lo), mel(hi)
    centers = np.linspace(m_lo, m_hi, n_mels + 2)
    f = mel(np.arange(n_fft // 2 + 1) * sr / n_fft)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for k in range(n_mels):
        l, c, r = centers[k], centers[k + 1], centers[k + 2]
        fb[k] = np.clip(np.minimum((f - l) / (c - l), (r - f) / (r - c)), 0, None)
    return fb


_FB = _mel_banks()


def fbank(x, sr):
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    if sr != 16000:
        x = resample_poly(x, 16000, sr)
    W, H = 400, 160
    if len(x) < W:
        x = np.pad(x, (0, W - len(x)))
    fr = np.lib.stride_tricks.sliding_window_view(x, W)[::H].copy()
    fr -= fr.mean(1, keepdims=True)
    fr[:, 1:] -= 0.97 * fr[:, :-1]; fr[:, 0] *= 0.03
    fr *= np.power(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(W) / (W - 1)), 0.85)
    P = np.abs(np.fft.rfft(fr, 512, axis=1)) ** 2
    F = np.log(np.maximum(P @ _FB.T, np.finfo(np.float32).eps))
    return (F - F.mean(0, keepdims=True)).astype(np.float32)


def embedding(x, sr):
    global _sess
    if _sess is None:
        import onnxruntime as ort
        _sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feats = fbank(x, sr)[None]
    e = _sess.run(None, {_sess.get_inputs()[0].name: feats})[0].reshape(-1)
    return e / np.linalg.norm(e)
