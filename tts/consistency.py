"""像不像同一个人在自然地说话：句与句之间音色、响度、语速一致，长段不漂（用户听 E02 v13：「每句话的声音都存在微小差异
（包括音色、快慢、音量），给人一种不是同一个人在自然的说话的感觉」）。

每次配音实验、每集成片都按这几项出数（VOICE_PIPELINE.md「像同一个人」）：
- 音色：相邻两句说话人嵌入的距离（1 − 余弦）、每句离全片平均多远。两把尺子：Qwen3 自带的说话人编码器（生成时挑候选用的就是它，
  同一个声音的句子之间 0.987、和别人的声音 0.932，分不开细小差别）和 CAM++（campplus.py，0.78 对 0.16）。
  另有「谱包络距离」（浊音平均梅尔倒谱差，dB）：跟句子内容有关，只在同一份稿子的两种配法之间比才有意义。
- 像这个孩子：各句 CAM++ 嵌入的平均对声音包（这是唯一一项和用户盲听对得上的数：E02 v13 0.59，盲听输掉的「只用说话人嵌入」0.42）。
- 响度：每句 BS.1770 响度（LUFS，按人耳加权，不是均方根）的标准差和相邻差。
- 语速：每句说话语速（voice.py 的 art_rate）的波动（标准差 / 平均）和相邻差。
- 漂移：一条连续生成的声音里按 3 秒窗量音区、音色、沙沙声随时间的走向（一次配长段时第 9–10 秒以后掉嗓子就是它）；
  逐句拼起来的整集按句量，看前三分之一和后三分之一差多少。
"""
from pathlib import Path

import numpy as np
from scipy.signal import lfilter, resample_poly

from voice import art_rate, embedding, f0_track, voiced_flatness
try:
    import campplus
    _CAM = campplus.MODEL.exists()
except Exception:
    _CAM = False


# ---------- 响度：ITU-R BS.1770-4（K 加权 + 400ms 块、门限 -70 LUFS 和相对 -10LU） ----------
def _biquad_shelf(sr):
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    return b, a


def _biquad_hp(sr):
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr)
    a = [1, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)]
    return [1, -2, 1], a


def lufs(x, sr):
    """一段声音的响度（LUFS）。不到一个 400ms 块的短段按整段算"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    y = lfilter(*_biquad_hp(sr), lfilter(*_biquad_shelf(sr), x))
    B, H = int(0.4 * sr), int(0.1 * sr)
    if len(y) < B:
        return float(-0.691 + 10 * np.log10((y ** 2).mean() + 1e-20))
    z = np.array([(y[i:i + B] ** 2).mean() for i in range(0, len(y) - B + 1, H)])
    l = -0.691 + 10 * np.log10(z + 1e-20)
    z = z[l > -70]
    if not len(z):
        return -70.0
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return float(-0.691 + 10 * np.log10(z.mean()))


# ---------- 谱包络：浊音帧的平均梅尔倒谱（c1–c12） ----------
def _mel_fb(sr, n_fft, n_mels=40, lo=80.0, hi=7600.0):
    m = lambda f: 2595 * np.log10(1 + f / 700); im = lambda v: 700 * (10 ** (v / 2595) - 1)
    pts = im(np.linspace(m(lo), m(hi), n_mels + 2)); f = np.fft.rfftfreq(n_fft, 1 / sr)
    fb = np.zeros((n_mels, len(f)))
    for k in range(n_mels):
        a, c, b = pts[k], pts[k + 1], pts[k + 2]
        fb[k] = np.clip(np.minimum((f - a) / (c - a), (b - f) / (b - c)), 0, None)
    return fb


def cepstrum(x, sr, n=12):
    """浊音（比最响帧低 30dB 以内、有基频）帧的平均梅尔倒谱 c1..cn。两段的差 × 10/ln10 × √2 就是梅尔倒谱失真（dB）"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    if sr != 16000:
        x, sr = resample_poly(x, 16000, sr), 16000
    W, H = 400, 160
    if len(x) < 2 * W:
        return np.zeros(n)
    fr = np.lib.stride_tricks.sliding_window_view(x, W)[::H] * np.hanning(W)
    P = np.abs(np.fft.rfft(fr, 512, axis=1)) ** 2
    lv = 10 * np.log10(P.sum(1) + 1e-20)
    voiced = np.zeros(len(fr), bool)
    tr = f0_track(x, sr, hop=0.01)
    for j, (t, f) in enumerate(tr):
        k = int(round(t / 0.01))
        if f and k < len(voiced):
            voiced[k] = True
    keep = (lv > lv.max() - 30) & voiced
    if keep.sum() < 10:
        keep = lv > lv.max() - 30
    M = 0.5 * np.log(P[keep] @ _mel_fb(sr, 512).T + 1e-10)  # 对数幅度
    k = np.arange(M.shape[1])
    dct = np.cos(np.pi / M.shape[1] * (k[None, :] + 0.5) * np.arange(1, n + 1)[:, None]) * np.sqrt(2 / M.shape[1])
    return (M @ dct.T).mean(0)


def mcd(a, b):
    return float(10 / np.log(10) * np.sqrt(2 * ((np.asarray(a) - np.asarray(b)) ** 2).sum()))


def _f0_median(x, sr):
    """音区：浊音帧基频的几何平均（Hz）。不用中位数：16kHz 自相关的整数延迟让中位数落在 296/308/286 这样的台阶上，差半个多半音"""
    f = np.array([v for _, v in f0_track(x, sr) if v])
    return float(np.exp(np.log(f).mean())) if len(f) > 30 else 0.0


# ---------- 每句的量和全片汇总 ----------
def features(tts, seg, sr, words, text=""):
    """一句的量：words 是这一句里的逐字时间（相对这一句）"""
    seg = np.asarray(seg, dtype=np.float32); seg = seg.mean(1) if seg.ndim > 1 else seg
    return {"text": text, "emb": embedding(tts, seg, sr), "lufs": lufs(seg, sr), "rate": art_rate(words),
            "f0": _f0_median(seg, sr), "cep": cepstrum(seg, sr), "flat": voiced_flatness(seg, sr), "dur": len(seg) / sr,
            **({"emb2": campplus.embedding(seg, sr)} if _CAM else {})}


def sentence_features(tts, x, sr, timing):
    """timing：配音的 timing.json（words 带整段时间、sentences 每句起止）。返回每句 {emb, lufs, rate, f0, cep, flat, t}"""
    x = np.asarray(x, dtype=np.float32); x = x.mean(1) if x.ndim > 1 else x
    out = []
    for s in timing["sentences"]:
        seg = x[int(s["start"] * sr):int(s["end"] * sr)]
        ws = [w for w in timing["words"] if s["start"] - 1e-3 <= w["start"] and w["end"] <= s["end"] + 1e-3]
        out.append(dict(features(tts, seg, sr, ws, s["text"]), t=(s["start"] + s["end"]) / 2))
    return out


def _q(v, p):
    return round(float(np.percentile(v, p)), 3) if len(v) else None


def summarize(feats, joined=None, pack_cam=None):
    """全片（或一节）的一致性指标。joined[i] = 第 i 句和第 i+1 句是一次生成出来的（一起配的一段），相邻差按「同一段 / 跨段」分开报；
    pack_cam：声音包的 CAM++ 嵌入，给了就报「像这个孩子」（各句 CAM++ 嵌入的平均对声音包）"""
    n = len(feats)
    E = np.array([f["emb"] for f in feats]); cen = E.mean(0); cen /= np.linalg.norm(cen)
    adj_emb = [1 - float(E[i] @ E[i + 1]) for i in range(n - 1)]
    cen_emb = [1 - float(e @ cen) for e in E]
    C = np.array([f["cep"] for f in feats]); cc = C.mean(0)
    adj_cep = [mcd(C[i], C[i + 1]) for i in range(n - 1)]
    cen_cep = [mcd(c, cc) for c in C]
    L = np.array([f["lufs"] for f in feats]); R = np.array([f["rate"] for f in feats])
    F = np.array([f["f0"] for f in feats]); Fs = 12 * np.log2(np.maximum(F, 1) / np.median(F[F > 0]))
    adj_l = np.abs(np.diff(L)); adj_r = np.abs(np.diff(R)) / R.mean(); adj_f = np.abs(np.diff(Fs))
    third = max(1, n // 3)
    drift = {"音区(半音)": round(float(Fs[-third:].mean() - Fs[:third].mean()), 2),
             "响度(LU)": round(float(L[-third:].mean() - L[:third].mean()), 2),
             "语速(%)": round(float((R[-third:].mean() / R[:third].mean() - 1) * 100), 1),
             "音色(对前三分之一平均)": round(float(1 - (E[-third:].mean(0) / np.linalg.norm(E[-third:].mean(0))) @ (E[:third].mean(0) / np.linalg.norm(E[:third].mean(0)))), 4)}
    m = {"句数": n}
    if all("emb2" in f for f in feats):  # CAM++（和挑候选用的 Qwen3 嵌入无关的第二把尺子）
        E2 = np.array([f["emb2"] for f in feats]); c2 = E2.mean(0); c2 /= np.linalg.norm(c2)
        a2 = [1 - float(E2[i] @ E2[i + 1]) for i in range(n - 1)]
        m.update({"音色(CAM++)·相邻 中位": _q(a2, 50), "音色(CAM++)·相邻 90%": _q(a2, 90), "音色(CAM++)·离平均 中位": _q([1 - float(e @ c2) for e in E2], 50)})
        if pack_cam is not None:
            m["像这个孩子(CAM++ 平均对声音包)"] = round(float(c2 @ pack_cam), 3)
    m.update({
        "音色·相邻嵌入距离 中位": _q(adj_emb, 50), "音色·相邻嵌入距离 90%": _q(adj_emb, 90), "音色·相邻嵌入距离 最大": _q(adj_emb, 100),
        "音色·离全片平均 中位": _q(cen_emb, 50), "音色·离全片平均 最大": _q(cen_emb, 100),
        "谱包络·相邻(dB，同稿才可比) 中位": _q(adj_cep, 50), "谱包络·相邻(dB，同稿才可比) 90%": _q(adj_cep, 90),
        "谱包络·离平均(dB，同稿才可比) 中位": _q(cen_cep, 50), "谱包络·离平均(dB，同稿才可比) 最大": _q(cen_cep, 100),
        "响度·标准差(LU)": round(float(L.std()), 2), "响度·相邻差 90%(LU)": _q(adj_l, 90), "响度·相邻差 最大(LU)": _q(adj_l, 100),
        "语速·波动": round(float(R.std() / R.mean()), 3), "语速·相邻差 90%": _q(adj_r, 90), "语速·相邻差 最大": _q(adj_r, 100),
        "音区·相邻差 中位(半音)": _q(adj_f, 50), "音区·相邻差 90%(半音)": _q(adj_f, 90),
        "沙沙声 中位": _q([f["flat"] for f in feats], 50), "沙沙声·相邻差 90%": _q(np.abs(np.diff([f["flat"] for f in feats])), 90),
        "漂移(后三分之一 − 前三分之一)": drift,
    })
    if joined is not None and any(joined[:n - 1]) and not all(joined[:n - 1]):
        inn = [i for i in range(n - 1) if joined[i]]; out = [i for i in range(n - 1) if not joined[i]]
        m["相邻差：同一段 vs 跨段"] = {
            "对数": f"{len(inn)} / {len(out)}",
            "嵌入距离中位": f"{np.median([adj_emb[i] for i in inn]):.4f} / {np.median([adj_emb[i] for i in out]):.4f}",
            "谱包络中位(dB)": f"{np.median([adj_cep[i] for i in inn]):.2f} / {np.median([adj_cep[i] for i in out]):.2f}",
            "响度差中位(LU)": f"{np.median([adj_l[i] for i in inn]):.2f} / {np.median([adj_l[i] for i in out]):.2f}",
            "语速差中位": f"{np.median([adj_r[i] for i in inn]):.3f} / {np.median([adj_r[i] for i in out]):.3f}",
            "音区差中位(半音)": f"{np.median([adj_f[i] for i in inn]):.2f} / {np.median([adj_f[i] for i in out]):.2f}"}
    return m


def window_drift(tts, x, sr, win=3.0, hop=1.5):
    """一条连续生成的长声音里，按 win 秒窗（hop 秒一步）量音区、音色（对第一个窗）、沙沙声；返回每窗的量和每 10 秒的斜率"""
    x = np.asarray(x, dtype=np.float32); x = x.mean(1) if x.ndim > 1 else x
    W, H = int(win * sr), int(hop * sr)
    rows = []
    for i in range(0, max(1, len(x) - W + 1), H):
        seg = x[i:i + W]
        if np.sqrt((seg ** 2).mean()) < 1e-3:
            continue
        rows.append({"t": (i + W / 2) / sr, "f0": _f0_median(seg, sr), "emb": embedding(tts, seg, sr), "flat": voiced_flatness(seg, sr)})
    if len(rows) < 3:
        return {"窗": rows}
    e0 = rows[0]["emb"]
    t = np.array([r["t"] for r in rows]); f = np.array([r["f0"] for r in rows])
    ok = f > 0; st = 12 * np.log2(np.maximum(f, 1) / np.median(f[ok]))
    sim = np.array([float(r["emb"] @ e0) for r in rows]); fl = np.array([r["flat"] for r in rows])
    slope = lambda y, m=None: round(float(np.polyfit(t[m] if m is not None else t, y[m] if m is not None else y, 1)[0] * 10), 3)
    return {"窗": [{"t": round(r["t"], 1), "f0": round(r["f0"]), "对首窗音色": round(float(r["emb"] @ e0), 3), "沙沙声": round(r["flat"], 3)} for r in rows],
            "音区斜率(半音/10秒)": slope(st, ok), "音色斜率(对首窗/10秒)": slope(sim), "沙沙声斜率(/10秒)": slope(fl)}


if __name__ == "__main__":
    # 用法：.venv-mlx/bin/python consistency.py <配音.wav> <配音.timing.json> [--from 句子开头几个字] [--to 句子开头几个字] [--json 输出文件]
    # 每次配音实验、每集成片都用它出同一套数（VOICE_PIPELINE.md「像同一个人」）
    import argparse, json
    import soundfile as sf
    from mlx_audio.tts.utils import load_model
    ap = argparse.ArgumentParser()
    ap.add_argument("wav"); ap.add_argument("timing")
    ap.add_argument("--from", dest="a", default=None); ap.add_argument("--to", dest="b", default=None); ap.add_argument("--json", default=None)
    a = ap.parse_args()
    tm = json.load(open(a.timing, encoding="utf-8")); sp = tm["sentences"]
    i0 = next(i for i, s in enumerate(sp) if s["text"].startswith(a.a)) if a.a else 0
    i1 = next(i for i, s in enumerate(sp) if s["text"].startswith(a.b)) + 1 if a.b else len(sp)
    x, sr = sf.read(a.wav, dtype="float32")
    tts = load_model(str(Path(__file__).parent / "models/Qwen3-TTS-12Hz-1.7B-Base"))
    sub = {"sentences": sp[i0:i1], "words": tm["words"]}
    joined = [abs(sp[i]["end"] - sp[i + 1]["start"]) < 1e-6 for i in range(i0, i1 - 1)] + [False]  # 一起配的一段：前一句的结尾就是后一句的开头
    import json as _j
    ref = Path(__file__).parent / _j.load(open(Path(__file__).parent / "voice.json", encoding="utf-8"))["ref"]
    pack = campplus.embedding(*sf.read(str(ref), dtype="float32")) if _CAM else None
    res = summarize(sentence_features(tts, x, sr, sub), joined, pack)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    if a.json:
        json.dump(res, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
