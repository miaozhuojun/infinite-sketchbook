"""DNSMOS P.835（微软 DNS-Challenge，模型 CC-BY-4.0）：给一段语音打三个分（1–5）——SIG 语音本身、BAK 背景噪声（越高越干净）、OVRL 总体。
模型文件不进仓库：engine/assets.local/dnsmos/sig_bak_ovr.onnx（来源 https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS/DNSMOS）。
做法照官方 dnsmos_local.py：16kHz，9.01 秒一窗、每秒挪一窗（不够 9 秒就首尾相接补够），原始分过官方的多项式校准后取平均；另外先把音量统一到 -26dBFS，并把起点错开 8 次取平均（见 score）。
用法：python dnsmos.py <wav>...      （也可 import score）
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

MODEL = Path(__file__).resolve().parent.parent / "engine/assets.local/dnsmos/sig_bak_ovr.onnx"
P_SIG = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
P_BAK = np.poly1d([-0.13166888, 1.60915514, -0.39604546])
P_OVR = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
_sess = None


def _windows(x):
    L = int(9.01 * 16000)
    while len(x) < L:
        x = np.concatenate([x, x])
    n = int(np.floor(len(x) / 16000) - 9.01) + 1
    return [x[i * 16000:i * 16000 + L] for i in range(n) if len(x[i * 16000:i * 16000 + L]) == L]


def score(x, sr, jitter=8):
    """→ (SIG, BAK, OVRL)，以及每个 9 秒窗的 BAK（看噪声出在哪一段）。
    jitter：短句要首尾相接补够 9 秒，接缝落在哪对分数影响很大（同一句挪 5 个采样 BAK 差 0.2–0.3）；
    把起点均匀挪 jitter 次（短句转一圈、长句在 1 秒内错开）取平均，同一段声音前后差几个采样，分数基本不变"""
    global _sess
    if _sess is None:
        import onnxruntime as ort
        _sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    x = x.mean(1) if x.ndim > 1 else x
    if sr != 16000:
        x = resample_poly(x, 16000, sr)
    x = np.asarray(x, dtype=np.float32)
    # 先把发声部分的音量统一到 -26dBFS：DNSMOS 的分数跟输入音量有关，同一句在配音原件（约 -29dB）和响度归一后的成片（-16 LUFS）上能差 0.3 分
    fr = x[:len(x) // 320 * 320].reshape(-1, 320)
    if len(fr):
        lv = np.sqrt((fr ** 2).mean(1)); act = lv > lv.max() * 10 ** (-40 / 20)
        x = x * np.float32(10 ** (-26 / 20) / max(float(np.sqrt((fr[act] ** 2).mean())), 1e-9))
    short = len(x) < int(9.01 * 16000)
    per = []
    for k in range(jitter):
        xs = np.roll(x, int(k * len(x) / jitter)) if short else x[int(k * 16000 / jitter):]
        segs = _windows(xs)
        out = np.array([_sess.run(None, {"input_1": seg[None, :]})[0][0] for seg in segs])
        per.append(np.stack([P_SIG(out[:, 0]), P_BAK(out[:, 1]), P_OVR(out[:, 2])], 1))
    r = per[0] if jitter == 1 else np.concatenate(per)
    return tuple(r.mean(0)), per[0][:, 1]


if __name__ == "__main__":
    for p in sys.argv[1:]:
        (s, b, o), bw = score(*sf.read(p, dtype="float32"))
        print(f"SIG {s:.2f}  BAK {b:.2f}（最差窗 {bw.min():.2f}）  OVRL {o:.2f}  {p}")
