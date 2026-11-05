"""去混响（WPE，加权预测误差法，单声道）：参考音里的房间回声会被克隆模型学过去，而且每句学得多少不一样——
有的句子带回声、下一句没有，听着不像同一个人连续在讲（用户听 E01 v16）。先把参考音的回声去掉，再去克隆。
纯信号处理，不用下载模型。参考：Nakatani et al., "Speech Dereverberation Based on Variance-Normalized Delayed Linear Prediction", IEEE TASLP 2010。
用法：python dereverb.py <输入.wav> <输出.wav> [--taps 10 --delay 3 --iters 3]
"""
import numpy as np
from scipy.signal import stft, istft


def wpe(x, sr, taps=10, delay=3, iters=3, n_fft=512, hop=128, eps=1e-8):
    """单声道 WPE：每个频点用前面若干帧（隔 delay 帧以后的 taps 帧）线性预测出晚期混响并减掉，方差按当前估计迭代更新"""
    _, _, X = stft(x, sr, nperseg=n_fft, noverlap=n_fft - hop)  # [F, T]
    F, T = X.shape
    D = X.copy()
    for _ in range(iters):
        lam = np.maximum(np.abs(D) ** 2, eps)  # 每个时频点的方差
        for f in range(F):
            xf = X[f]
            # 延迟后的过去帧堆成 [taps, T]
            Y = np.zeros((taps, T), dtype=complex)
            for k in range(taps):
                s = delay + k
                Y[k, s:] = xf[: T - s]
            w = 1.0 / lam[f]
            R = (Y * w) @ Y.conj().T + eps * np.eye(taps)
            r = (Y * w) @ xf.conj()
            g = np.linalg.solve(R, r)
            D[f] = xf - g.conj() @ Y
    _, y = istft(D, sr, nperseg=n_fft, noverlap=n_fft - hop)
    return y[: len(x)].astype(np.float32)


if __name__ == "__main__":
    import argparse, shutil
    from pathlib import Path
    import soundfile as sf
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--taps", type=int, default=10); ap.add_argument("--delay", type=int, default=3); ap.add_argument("--iters", type=int, default=3)
    a = ap.parse_args()
    x, sr = sf.read(a.src, dtype="float64")
    x = x.mean(1) if x.ndim > 1 else x
    y = wpe(x, sr, a.taps, a.delay, a.iters)
    y *= np.sqrt((x ** 2).mean()) / (np.sqrt((y ** 2).mean()) + 1e-12)  # 响度和原来一样
    sf.write(a.out, y, sr)
    txt = Path(a.src).with_suffix(".txt")
    if txt.exists():
        shutil.copyfile(txt, Path(a.out).with_suffix(".txt"))
    print(f"写出 {a.out}")
