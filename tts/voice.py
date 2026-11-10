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


BREAK_PUNCT = "，、：；,;:"   # 句内该停一下的标点（句号、问号、叹号是句子之间，另有停顿）


def _marks(words, text):
    """marks[i] = 第 i 个词后面跟着的标点（句内停顿和句末标点）；words 和 text 对不上（数字念法、多出的字）时返回 None"""
    import unicodedata
    marks, k, buf = [], 0, ""
    for ch in text:
        if ch in BREAK_PUNCT or ch in "。？！.?!":
            if marks and not buf:
                marks[-1] += ch
            continue
        # 其余标点、符号、空白（引号、括号、书名号、连字符「GPT-3」……）对齐前都去掉了，这里也跳过
        if unicodedata.category(ch)[0] in "PSZ" or not ch.strip() or k >= len(words):
            continue
        buf += ch
        if buf == words[k]["text"]:
            marks.append(""); k += 1; buf = ""
        elif not words[k]["text"].startswith(buf):
            return None
    return marks if k == len(words) else None


def _ctx(words, i):
    return "".join(w["text"] for w in words[max(0, i - 4): i + 1]), "".join(w["text"] for w in words[i + 1: i + 4])


DRAWL = {"minSec": 0.42, "ratio": 2.2}   # 字拖长的默认门槛，voice.json 的 drawl 可以改（minSec 填 0 表示不查）


def drawls(words, text, min_sec=DRAWL["minSec"], ratio=DRAWL["ratio"]):
    """字拖长：句中一个字后面没有标点，对齐出来的时长 ≥ min_sec 秒，而且 ≥ ratio 倍这条配音单字时长的中位数。返回 [(前文, 后文, 秒)]。
    用户 2026-11-10 听 E04 样片「天黑不天黑都一样」：听着在「黑」后面断开了，其实没有静音（phrasing 的 stray 抓不到），是「黑」拖了 0.56 秒，
    这一段别的字中位 0.24 秒。拖长和停错一样，听着都是断在没有标点的地方。
    只看单字的词（英文、数字连成一个词的时长不能按一个字比）；最后一个字是句末，拖长是正常收尾，不查。
    words 和 text 对不上时返回 []，不拦。"""
    if not min_sec or len(words) < 3:
        return []
    marks = _marks(words, text)
    if marks is None:
        return []
    dur = [w["end"] - w["start"] for w in words]
    single = [d for w, d in zip(words, dur) if len(w["text"]) == 1]
    if len(single) < 3:
        return []
    med = float(np.median(single))
    return [(*_ctx(words, i), round(dur[i], 2)) for i in range(len(words) - 1)
            if not marks[i] and len(words[i]["text"]) == 1 and dur[i] >= min_sec and dur[i] >= ratio * med]


def phrasing(x, sr, words, text, stray=0.26, miss=0.06, floor_db=35.0, drawl=None):
    """断句：一句里每两个字之间最长的一段静音（前一个字的中点到后一个字的中点，比最响处低 floor_db 算静音）。
    返回 (stray, missed)，每项是 [(前文, 后文, 秒, 类)]：
      stray：断在了没有标点的地方，两类——
        「停」：没有标点却停了 ≥ stray 秒（「你还真猜对了……一半」0.29、「原地转圈……圈」0.34）。门槛 0.26：下一个字是 b/d/g/z 这类塞音时，
          闭口那一下也是静音，0.20–0.25 秒常见（PR #59 审查在 989 条缓存上量到）；
        「拖」：没有静音，但字拖长了（drawls，「天黑……不天黑」的「黑」0.56 秒），秒数是这个字的时长。drawl 是 voice.json 的 drawl（minSec、ratio），
          不给时用 DRAWL；
      missed：逗号、顿号、冒号、分号处静音不到 miss 秒，一口气念了过去（「这一句只是他们觉得，并没有证明」逗号处 0），类是「连」。
    用户 2026-11-10 听 E04 样片：该断的地方不断，不该断的地方断了。样片量出来 289 个逗号里 124 个没停，没标点却停了 0.2 秒以上的 9 处。
    words 和 text 对不上（数字念法、多出的字）时返回 ([], [])，不拦。"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    if not words:
        return [], []
    marks = _marks(words, text)
    if marks is None:
        return [], []
    e, hop = _env_db(x, sr); quiet = e < e.max() - floor_db
    mid = lambda w: (w["start"] + w["end"]) / 2

    def longest(t0, t1):
        best = cur = 0
        for q in quiet[max(0, int(t0 / hop)): int(t1 / hop)]:
            cur = cur + 1 if q else 0; best = max(best, cur)
        return best * hop

    st, ms = [], []
    for i in range(len(words) - 1):
        g = longest(mid(words[i]), mid(words[i + 1]))
        if not marks[i] and g >= stray:
            st.append((*_ctx(words, i), round(g, 2), "停"))
        elif marks[i] and marks[i][-1] in BREAK_PUNCT and g < miss:
            ms.append((*_ctx(words, i), round(g, 2), "连"))
    d = {**DRAWL, **(drawl or {})}
    seen = {a for a, _, _, _ in st}
    st += [(a, b, g, "拖") for a, b, g in drawls(words, text, d["minSec"], d["ratio"]) if a not in seen]  # 同一处又停又拖只记一次
    return st, ms


def stray_text(items):
    """断错地方的说明：「天黑|不天」拖长 0.56s、「猜对了|一半」停了 0.29s"""
    return "、".join(f"「{a}|{b}」{'拖长' if k == '拖' else '停了'} {g:.2f}s" for a, b, g, k in items)


def stray_excess(items, stray=0.26, drawl=None):
    """断错得多厉害：每处秒数除以它那一类的门槛，取最大。试满都断错时挑它最小的一条当退路"""
    lim = {"停": stray, "拖": {**DRAWL, **(drawl or {})}["minSec"] or 1.0}
    return max(g / lim[k] for _, _, g, k in items)


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
    return {"f0": med, "range": rng, "rate": chars / max(span, 0.3), "end": slope, "start": start, "endf0": endf0, "artRate": art_rate(words)}


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


# 书名号、引号这些也去掉：回转识别会自己加（E04「书名就叫感知机。」听成「书名就叫《感知机》」，字全对，30 个种子却都按念错算）
SAID_PUNCT = r"[，。；：！？、,.;:!?\"“”'‘’（）()《》〈〉「」『』【】…·—\s-]"


def said_text(s):
    """回转比对用的「念出来的字」：先按念法换数字，再去标点（顺序不能反：先去标点「1、1、0」会连成 110，念成「一百一十」；E02 v6 两次栽在这里）。
    配音生成的逐句比对、整段比对和成片旁白检查都用它，口径只有一处"""
    import re as _re
    return _re.sub(SAID_PUNCT, "", read_numbers(str(s).lower()))


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


# ---------- 起音收音不硬切、语速一致（用户听 E02 v5：「1:20 有个突兀的声音」「有的地方突然加快语速」） ----------
def hard_edges(x, sr, silent_db=-60.0, loud_db=-35.0, look=0.03):
    """硬切：声音从纯静音一下子起来（前 look 秒都低于 silent_db，下一个 2ms 就到 loud_db 以上），或者说着说着一下子掉进纯静音。
    正常的字头字尾要十几毫秒才起来、落下（「投」从 -56 到 -30 用了 16ms）；E02 v5「权重越大」的「权」2ms 里从静音跳到 -20dB，
    是剪掉开头串进来的多余字时切在了发声处、又没淡入。返回 [(起/收, 时刻, 那 2ms 的峰值 dB)]"""
    x = np.asarray(x, dtype=np.float64); x = x.mean(1) if x.ndim > 1 else x
    w = max(1, int(0.002 * sr)); n = len(x) // w
    if n < 3:
        return []
    db = 20 * np.log10(np.abs(x[: n * w]).reshape(n, w).max(1) + 1e-9)
    k = max(1, int(look / 0.002)); out = []
    for i in range(k, n - k):
        if db[i] > loud_db and db[i - k:i].max() < silent_db:
            out.append(("起", round(i * w / sr, 3), round(float(db[i]), 1)))
        if db[i] > loud_db and db[i + 1:i + 1 + k].max() < silent_db:
            out.append(("收", round((i + 1) * w / sr, 3), round(float(db[i]), 1)))
    return out


def soften_edges(x, sr, ms=10.0):
    """两头各做 ms 毫秒的升余弦淡入淡出：一条配音不管在哪里被剪开，接进成片时都不会「咔」一声"""
    x = np.array(x, dtype=np.float32, copy=True); n = min(len(x) // 4, int(ms / 1000 * sr))
    if n > 1:
        r = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))).astype(np.float32)
        x[:n] *= r; x[-n:] *= r[::-1]
    return x


def art_rate(words, gap_cap=0.12):
    """说话的语速（字/秒）：只算嘴在动的时间，字间停顿最多算 gap_cap 秒。逗号处的停顿不算进去，
    长句、短句、带逗号和不带逗号的句子才能放在一起比（原来的「字数 / 首字到末字」把停顿算进去，带逗号的句子显得慢）"""
    ws = [w for w in words if w.get("text")]
    if not ws:
        return 0.0
    t = sum(w["end"] - w["start"] for w in ws) + sum(min(gap_cap, max(0.0, b["start"] - a["end"])) for a, b in zip(ws, ws[1:]))
    return sum(len(w["text"]) for w in ws) / max(t, 0.3)


def line_defects(x, sr, words, voice, floor_hz=None):
    """一句配音会被成片旁白检查点名、要换种子重配的几项：掉嗓子、破音、硬切、语速（speech_check.py 0b、0j、0k、0l，同一套函数、同一套阈值）。
    配音生成时每个候选、退路和缓存复查都拿它验收，坏句子在生成时就换种子，不等到混音后的旁白检查（E03 内容定稿后每轮退回都是这几类）。
    words 是这一句的逐字时间（相对这一句）；floor_hz 默认这个声音的 pitchFloorHz，生成时传更严的 GEN_FLOOR。返回问题描述的列表，空 = 都过"""
    out = []
    floor = voice.get("pitchFloorHz", 0) if floor_hz is None else floor_hz
    if floor and (d := pitch_drops(x, sr, floor)):
        out.append("掉嗓子 " + "、".join(f"{a:.2f}–{b:.2f}s 低到 {f:.0f}Hz" for a, b, f in d) + f"（下限 {floor:.0f}Hz）")
    if voice.get("takeNoBreaks") and (b := pitch_breaks(x, sr)):
        out.append("破音 " + "、".join(f"{t:.2f}s 跳 {j:.0f} 半音" for t, j in b))
    if (h := hard_edges(x, sr)):
        out.append("硬切 " + "、".join(f"{k}音 {t:.2f}s {d:.0f}dB" for k, t, d in h))
    R = voice.get("rate") or {}
    if R.get("target") and sum(len(w["text"]) for w in words) >= R.get("minChars", 3):
        r = art_rate(words)
        if abs(r / R["target"] - 1) > R.get("maxDev", 0.10):
            out.append(f"语速 {r:.2f} 字/秒（目标 {R['target']}，最多差 {R.get('maxDev', 0.10):.0%}）")
    return out


# ---------- 变速不变调（旁白检查自测的注入用它造「换了个嗓子」的声音；VOICE_PIPELINE.md「像同一个人」） ----------
def stretch(x, rate, sr, frame=0.03, tol=0.012):
    """WSOLA 变速不变调：rate > 1 变快（时长 ÷ rate），< 1 变慢。frame 秒汉宁窗、半帧重叠，每帧在 ±tol 秒里找和上一帧接得最顺的位置。
    试过拿它把每句语速拉齐（±12% 以内 DNSMOS 和沙沙声都不变差），但盲听输给了原样，配音流程里不用；现在只给自测注入用"""
    x = np.asarray(x, dtype=np.float64)
    if abs(rate - 1) < 1e-3 or len(x) < int(0.2 * sr):
        return x.astype(np.float32)
    N = int(frame * sr) // 2 * 2; Hs = N // 2; Ha = Hs * rate; T = int(tol * sr)
    win = np.hanning(N)
    y = np.zeros(int(len(x) / rate) + 2 * N); wsum = np.zeros_like(y)
    xp = np.pad(x, (T, N + T + int(Ha) + 2))
    prev, k = 0, 0
    while True:
        out_pos, nominal = k * Hs, int(round(k * Ha))
        if nominal + N > len(x) + N // 2 or out_pos + N > len(y):
            break
        best = 0
        if k:
            nat = xp[T + prev + Hs:T + prev + Hs + N]  # 上一帧顺着往后走半帧的那段（自然延续）
            seg = xp[nominal:nominal + 2 * T + N]
            if len(seg) < N + 2 * T or len(nat) < N:
                break
            c = np.correlate(seg, nat, mode="valid") / (np.sqrt(np.convolve(seg ** 2, np.ones(N), "valid")) + 1e-9)
            best = int(np.argmax(c)) - T
        start = nominal + best
        y[out_pos:out_pos + N] += xp[T + start:T + start + N] * win; wsum[out_pos:out_pos + N] += win
        prev = start; k += 1
    return (y / np.maximum(wsum, 1e-3))[:int(len(x) / rate)].astype(np.float32)
