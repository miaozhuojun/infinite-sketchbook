"""DNSMOS P.835（微软 DNS-Challenge，模型 CC-BY-4.0）：给一段语音打三个分（1–5）——SIG 语音本身、BAK 背景噪声（越高越干净）、OVRL 总体。
模型文件不进仓库：engine/assets.local/dnsmos/sig_bak_ovr.onnx（来源 https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS/DNSMOS）。
做法照官方 dnsmos_local.py：16kHz，9.01 秒一窗、每秒挪一窗（不够 9 秒就首尾相接补够），原始分过官方的多项式校准后取平均；另外先把音量统一到 -26dBFS。
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


def score(x, sr):
    """→ (SIG, BAK, OVRL)，以及每个 9 秒窗的 BAK（看噪声出在哪一段）"""
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
    L = int(9.01 * 16000)
    while len(x) < L:
        x = np.concatenate([x, x])
    n = int(np.floor(len(x) / 16000) - 9.01) + 1
    rows = []
    for i in range(n):
        seg = x[i * 16000:i * 16000 + L]
        if len(seg) < L:
            continue
        s, b, o = _sess.run(None, {"input_1": seg[None, :]})[0][0]
        rows.append((P_SIG(s), P_BAK(b), P_OVR(o)))
    r = np.array(rows)
    return tuple(r.mean(0)), r[:, 1]


if __name__ == "__main__":
    for p in sys.argv[1:]:
        (s, b, o), bw = score(*sf.read(p, dtype="float32"))
        print(f"SIG {s:.2f}  BAK {b:.2f}（最差窗 {bw.min():.2f}）  OVRL {o:.2f}  {p}")
