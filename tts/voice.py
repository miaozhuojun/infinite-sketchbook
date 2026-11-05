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
def f0_track(x, sr, hop=0.001, win=0.03):
    """每 hop 秒一帧：(时刻, 基频)，不是浊音的帧基频记 0。自相关法，范围 90–600Hz。
    先统一重采样到 16kHz：同一句在 24kHz 的配音原件和 48kHz 的成片旁白上量出来要一样（不统一时同一个「走」一边过一边不过）。
    帧移 1ms（原来 5ms）：同一句在单句配音和成片片段里起点差零点几秒，5ms 分帧落点不同，嘎裂声里的清浊判断时断时续，
    同一处 141Hz 一边连成 90ms（不过）一边断成几小段（过）（E01 v7「主」）；1ms 时落点差别可以忽略。按块用 FFT 算自相关，速度和原来相当。"""
    x = x.mean(1) if x.ndim > 1 else x
    if sr != 16000:
        x, sr = resample_poly(x, 16000, sr), 16000
    x = np.pad(np.asarray(x, dtype=np.float64), (0, int(win * sr)))  # 末尾补一个窗长的静音：句末最后几十毫秒也要量（单句原件到头就截止，成片旁白后面有停顿，不补两边结果不一样）
    W, H = int(win * sr), max(1, int(hop * sr))
    n = max(0, (len(x) - W) // H)
    if n == 0:
        return []
    starts = np.arange(n) * H
    lo, hi = int(sr / 600), int(sr / 90)
    level, f0 = np.empty(n), np.zeros(n)
    peak, lag = np.empty(n), np.empty(n, dtype=int)
    for c in range(0, n, 20000):
        idx = starts[c:c + 20000, None] + np.arange(W)[None, :]
        fr = x[idx]; fr = fr - fr.mean(1, keepdims=True)
        level[c:c + len(fr)] = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
        ac = np.fft.irfft(np.abs(np.fft.rfft(fr, 2 * W)) ** 2)[:, :W]
        ac = ac / np.maximum(ac[:, :1], 1e-20)
        k = lo + np.argmax(ac[:, lo:hi], 1)
        lag[c:c + len(fr)], peak[c:c + len(fr)] = k, ac[np.arange(len(fr)), k]
    # 只量听得见的部分：比这段话的正常响度低 20dB 以上的帧不算（原来用绝对 -35dB，同一句音量差 12dB 就一边过一边不过；
    # 句末渐弱的尾巴本来就会掉进气泡音，听不出来，也不该算掉嗓子）
    gate = np.percentile(level, 90) - 20
    ok = (level >= gate) & (peak > 0.5)
    f0[ok] = sr / lag[ok]
    return list(zip((starts / sr).tolist(), f0.tolist()))


def pitch_drops(x, sr, floor_hz, min_sec=0.06, bridge=0.02, hop=0.001):
    """连续至少 min_sec 秒的浊音都低于 floor_hz 的段：[(起, 止, 最低基频)]。
    中间夹着不超过 bridge 秒的清音帧（基频 0）仍算同一段：低沉的嘎裂声里清浊判断时断时续，不连起来就会把一段掉嗓子拆成几段短的放过去。"""
    runs, cur, gap = [], [], 0.0
    for t, f in f0_track(x, sr, hop=hop) + [(None, 1e9)]:
        if f and f < floor_hz:
            cur.append((t, f)); gap = 0.0; continue
        if not f and cur and gap + hop <= bridge:
            gap += hop; continue
        if cur and cur[-1][0] - cur[0][0] + hop >= min_sec:
            runs.append((cur[0][0], cur[-1][0] + 0.03, min(f for _, f in cur)))
        cur, gap = [], 0.0
    return runs


def pitch_range_st(x, sr):
    """一句话的语气起伏：浊音基频 5%–95% 分位之间差几个半音（平铺直叙的念稿小，像孩子说话那样有起有落就大）。
    浊音太少（不到 0.3 秒）返回 None。"""
    f = np.array([v for _, v in f0_track(x, sr) if v])
    if len(f) < 300:
        return None
    lo, hi = np.percentile(f, [5, 95])
    return float(12 * np.log2(hi / lo))


def pitch_median_hz(x, sr):
    f = [v for _, v in f0_track(x, sr) if v]
    return float(np.median(f)) if f else None


def weak_chars(x, sr, items):
    """吞字：items 是 [{"text", "t0", "t1"}]（在 x 上的逐字时间，配音时逐句对齐、回转核对过的那份）。
    返回 [(下标, 说明)]：时长 < 50ms 且不是被对齐器并进邻字的，或时长够但能量比所有字的中位数低 18dB 以上的。
    配音生成（整段拼好后）和成片旁白检查用同一个函数，判断才一致。"""
    def db(seg): return 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12) if len(seg) else -240.0
    x = x.mean(1) if x.ndim > 1 else x
    for it in items:
        it["dur"], it["db"] = it["t1"] - it["t0"], db(x[int(it["t0"] * sr):int(it["t1"] * sr)])
    med = float(np.median([it["db"] for it in items]))
    med_dur = float(np.median([it["dur"] for it in items if len(it["text"]) == 1]))
    w = int(0.01 * sr)

    def merged(k):
        """对齐器偶尔把读得轻快的字压成 0ms、把它的声音算给邻字（实测「亮不亮」：「不」0ms，后一个「亮」0.48s，是中位数的 2 倍）。
        邻字时长 ≥ 1.6 倍中位数、且那一段 80% 以上都在正常响度，就算并进去了；真吞掉的字不会让邻字变长。"""
        for j in (k - 1, k + 1):
            if 0 <= j < len(items) and items[j]["dur"] >= 1.6 * med_dur:
                seg = x[int(items[j]["t0"] * sr):int(items[j]["t1"] * sr)]
                frames = [db(seg[i:i + w]) for i in range(0, max(0, len(seg) - w), w)]
                if frames and sum(f > med - 18 for f in frames) >= 0.8 * len(frames):
                    return True
        return False

    return med, [(k, f"「{it['text']}」@{it['t0']:.2f}s 时长{it['dur'] * 1000:.0f}ms 能量{it['db']:.0f}dB") for k, it in enumerate(items)
                 if (it["dur"] < 0.05 and not merged(k)) or (it["dur"] >= 0.05 and it["db"] < med - 18)]


def voiced_flatness(x, sr):
    """说话时的「沙沙声」：浊音帧 1–4kHz 的谱平坦度中位数（谐波之间被噪声填平时变大）。
    干净的童声真人录音约 0.03–0.045；用户听出「一开口就有背景噪声、说完就没」的配音 0.11–0.18，听着干净的 0.04–0.09。
    DNSMOS 的 BAK 对这种叠在说话声上的噪声不敏感（E01 v7–v14），所以另用这个量。"""
    x = np.asarray(x, dtype=np.float64)
    x = x.mean(1) if x.ndim > 1 else x
    W = int(0.032 * sr); H = W // 2
    if len(x) < 2 * W:
        return 0.0
    win = np.hanning(W)
    fr = np.array([x[i:i + W] * win for i in range(0, len(x) - W, H)])
    S = np.abs(np.fft.rfft(fr, axis=1)) ** 2
    f = np.fft.rfftfreq(W, 1 / sr)
    lv = 10 * np.log10(S.sum(1) + 1e-20)
    Sv = S[lv > lv.max() - 25]
    band = (f > 1000) & (f < 4000)
    return float(np.median([np.exp(np.mean(np.log(s[band] + 1e-20))) / np.mean(s[band]) for s in Sv]))
