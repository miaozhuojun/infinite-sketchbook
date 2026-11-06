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


# ---------- 声音一致：回声、基础响度、频谱明暗（见 VOICE_PIPELINE.md） ----------
def _env_db(x, sr, hop=0.005):
    h = int(hop * sr); n = len(x) // h
    return 20 * np.log10(np.sqrt((x[: n * h].reshape(n, h) ** 2).mean(1)) + 1e-9), hop


def pause_points(words, start=0.0, end=None, min_pause=0.12):
    """一句里的停顿点（相对 start 的秒数）：词尾后面至少 min_pause 秒没有下一个词，再加句末"""
    ws = [w for w in words if w["start"] >= start - 1e-3 and (end is None or w["end"] <= end + 1e-3)]
    offs = [w["end"] - start for a, w in enumerate(ws[:-1]) if ws[a + 1]["start"] - w["end"] >= min_pause]
    return offs + ([ws[-1]["end"] - start] if ws else [])


def echo_ms(x, sr, offsets, drop=20.0):
    """回声：每个停顿点声音从最响处衰减 drop dB 要多少毫秒，取中位数（干声约 60–90ms，录在有回声的房间里 150–300ms）。
    用户听 E01 v16：一句有回音一句没有——参考音录在有回声的房间，每句学到的回声多少不一"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    e, hop = _env_db(x, sr); out = []
    for t in offsets:
        i0, i1 = max(0, int((t - 0.08) / hop)), min(len(e), int((t + 0.03) / hop))
        if i1 <= i0:
            continue
        pk = i0 + int(np.argmax(e[i0:i1])); lim = min(len(e), pk + int(0.3 / hop))
        below = np.where(e[pk:lim] < e[pk] - drop)[0]
        out.append(300.0 if not len(below) else below[0] * hop * 1000)
    return float(np.median(out)) if out else 0.0


def active_level_db(x, sr):
    """基础响度：发声部分（比最响的 10ms 低 26dB 以内）的均方根，dBFS。句内轻重不影响它"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    h = int(0.01 * sr); n = len(x) // h
    if n == 0:
        return -120.0
    lv = np.sqrt((x[: n * h].reshape(n, h) ** 2).mean(1)); a = lv > lv.max() * 10 ** (-26 / 20)
    return float(20 * np.log10(np.sqrt((lv[a] ** 2).mean()) + 1e-12))


BANDS = [(80, 160), (160, 315), (315, 630), (630, 1250), (1250, 2500), (2500, 5000), (5000, 10000)]


def ltas(x, sr):
    """长期平均频谱（倍频程，dB，相对总能量）：句与句的明暗差就看它"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    S = np.abs(np.fft.rfft(x)) ** 2; f = np.fft.rfftfreq(len(x), 1 / sr); tot = S.sum() + 1e-20
    return np.array([10 * np.log10(S[(f >= a) & (f < b)].sum() / tot + 1e-20) for a, b in BANDS])


def spectral_match(x, sr, target, max_db=2.0):
    """把一句的长期平均频谱轻轻拉向 target（倍频程平滑增益，每带最多 ±max_db），消掉残余的明暗差"""
    x = np.asarray(x, dtype=np.float64)
    g_db = np.clip(np.asarray(target) - ltas(x, sr), -max_db, max_db)
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / sr)
    centers = np.array([np.sqrt(a * b) for a, b in BANDS])
    g = 10 ** (np.interp(np.log2(np.maximum(f, 1)), np.log2(centers), g_db) / 20)
    y = np.fft.irfft(X * g, len(x))
    return (y * np.sqrt((x ** 2).mean() / ((y ** 2).mean() + 1e-20))).astype(np.float32)  # 总能量不变（响度另外统一）


# ---------- 语气：韵律量和按语气目标打分（每句候选里挑一条） ----------
def prosody(x, sr, words):
    """音区（中位基频 Hz）、句内起伏（半音）、语速（字/秒，按对齐算）、句末升降（最后 0.4 秒浊音基频斜率，半音/秒）"""
    x = np.asarray(x, dtype=np.float32); x = x.mean(1) if x.ndim > 1 else x
    tr = [(t, f) for t, f in f0_track(x, sr) if f]
    f0 = np.array([f for _, f in tr]) if tr else np.array([0.0])
    med = float(np.median(f0)) if tr else 0.0
    rng = float(12 * np.log2(np.percentile(f0, 95) / np.percentile(f0, 5))) if len(f0) > 60 else 0.0
    chars = sum(len(w["text"]) for w in words); span = (words[-1]["end"] - words[0]["start"]) if words else 1.0
    tail = [(t, 12 * np.log2(f / med)) for t, f in tr if words and t >= words[-1]["end"] - 0.4] if med else []
    slope = float(np.polyfit([t for t, _ in tail], [s for _, s in tail], 1)[0]) if len(tail) > 20 else 0.0
    # 句首、句尾 0.3 秒浊音的中位基频：量句与句之间的音高「重新起头」有多大（E01 句首比上一句句尾平均高 6 个半音，听着像一句一句分开说）
    start = float(np.median([f for t, f in tr if t < tr[0][0] + 0.3])) if tr else 0.0
    endf0 = float(np.median([f for t, f in tr if t > tr[-1][0] - 0.3])) if tr else 0.0
    return {"f0": med, "range": rng, "rate": chars / max(span, 0.3), "end": slope, "start": start, "endf0": endf0}


def flow_cost(p, prev, flow, base_rate, tone_rate=None):
    """和上一句接不接得上（越小越好）：句首比上一句句尾高出多少半音（超过 maxReset 才罚），
    语速离这一集的基准多远（语气目标里没写语速的句子，超过 rateTol 才罚）。flow 是 voice.json 的 flow"""
    if not flow:
        return 0.0
    c = 0.0
    if prev and prev.get("endf0") and p.get("start"):
        reset = abs(12 * np.log2(p["start"] / prev["endf0"]))
        c += flow.get("resetWeight", 1.0) * (max(0.0, reset - flow.get("maxReset", 4.0)) / 2.0) ** 2
    if base_rate and tone_rate is None and p.get("rate"):
        dev = abs(p["rate"] / base_rate - 1)
        c += flow.get("rateWeight", 1.0) * (max(0.0, dev - flow.get("rateTol", 0.12)) / 0.1) ** 2
    return float(c)


def tone_cost(p, target, base_f0, base_rate):
    """离语气目标多远（越小越好）：音区偏移（半音）、起伏下限、语速比例、句末上扬/下降"""
    c = 0.0
    if p["f0"] and base_f0 and "register" in target:
        c += ((12 * np.log2(p["f0"] / base_f0) - target["register"]) / 1.5) ** 2
    if "rangeMin" in target:
        c += (max(0.0, target["rangeMin"] - p["range"]) / 2.0) ** 2
    if "rate" in target and base_rate:
        c += ((p["rate"] / base_rate - target["rate"]) / 0.1) ** 2
    if target.get("end") == "rise":
        c += (max(0.0, 2.0 - p["end"]) / 2.0) ** 2
    if target.get("end") == "fall":
        c += (max(0.0, p["end"] + 1.0) / 2.0) ** 2
    return float(c)


_D = "零一二三四五六七八九"


def _cn(n):
    """0–9999 的中文读法（五十、一百零三、一千二百）"""
    if n < 10:
        return _D[n]
    if n < 20:
        return "十" + (_D[n % 10] if n % 10 else "")
    if n < 100:
        return _D[n // 10] + "十" + (_D[n % 10] if n % 10 else "")
    if n < 1000:
        r = n % 100
        return _D[n // 100] + "百" + ("" if r == 0 else ("零" + _D[r] if r < 10 else (_D[r // 10] + "十" + (_D[r % 10] if r % 10 else ""))))
    r = n % 1000
    return _D[n // 1000] + "千" + ("" if r == 0 else ("零" + _cn(r) if r < 100 else _cn(r)))


def read_numbers(s):
    """把阿拉伯数字换成念出来的汉字，回转比对用（ASR 会把念出的数写成汉字或阿拉伯数字）：
    像年份的四位数（1000–2099）一个个念（一九五八），其余按数念（50 → 五十；原来一个个换成「五零」，「试了50次」怎么配都过不了）"""
    import re as _re
    return _re.sub(r"\d+", lambda m: "".join(_D[int(c)] for c in m[0]) if len(m[0]) == 4 and 1000 <= int(m[0]) <= 2099 or len(m[0]) > 4 or m[0].startswith("0") and len(m[0]) > 1
                   else _cn(int(m[0])), s)


def pitch_breaks(x, sr, min_st=14.0, merge=0.05):
    """破音：浊音里相邻两帧（1ms）音高突然跳 min_st 半音以上、又不是正好一个或两个八度（八度跳多半是基频估错，不是声音坏了）。
    用户听 E02 v3「好几处声音畸变」：E02 每分钟 1.9 处，E01 只有 0.3 处，原来没有一项检查管它。返回 [(时刻, 跳了几个半音)]"""
    tr = f0_track(x, sr)
    out, prev = [], None
    for t, f in tr:
        if f and prev and prev[1] and t - prev[0] < 0.012:
            j = abs(12 * np.log2(f / prev[1]))
            if j > min_st and abs(j - 12) > 1.5 and abs(j - 24) > 1.5 and (not out or t - out[-1][0] > merge):
                out.append((round(float(t), 3), round(float(j), 1)))
        prev = (t, f)
    return out
