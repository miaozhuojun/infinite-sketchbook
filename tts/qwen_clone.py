"""本地免订阅配音链路：Qwen3-TTS 克隆音色 → Qwen3-ForcedAligner 对齐出时间戳 → Qwen3-ASR 回转核对字词。

输出与 edge_baseline.py 相同的 timing JSON，引擎编译器可直接换用。
用法：.venv-mlx/bin/python qwen_clone.py <文本> <输出前缀> [--seed N] [--gap 0.4] [--voice voice.json]
音色配置（参考音、真人录音、相似度下限）只在 voice.json；参考文本取参考音同名 .txt，默认种子 2。
按句生成，每句自检（回转拼音、掉音、掉嗓子、时长、剪掉句首尾静音后逐字对齐不到 50ms、背景噪声）不过就换种子；最后检查整段回转和音色一致性，任何一项不过都非零退出。
通过自检的句子按「句子 + 参考音 + 模型 + 参数」缓存在输出目录的 cache/ 里：改稿后只重配改动的句子（--no-cache 全部重来）。
分镜可以按句指定情绪（--mood「句子=情绪」），那一句改用 voice.json 的 moods 里对应的参考音克隆，语气跟着内容变。
参考音和真人录音只在本机使用，不进仓库；只克隆本人或已取得书面同意的声音（见 voice.example.json）。
"""
import argparse
import hashlib
import json
import os
import re
import time

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.stt import load as load_stt
from mlx_audio.tts.utils import load_model
from voice import phrasing, read_numbers, said_text, pitch_breaks, hard_edges, soften_edges, art_rate, line_defects, load_voice, similarity, pitch_drops, weak_chars, voiced_flatness, embedding, echo_ms, pause_points, prosody, tone_cost, flow_cost, active_level_db, spectral_match, ltas

ap = argparse.ArgumentParser()
ap.add_argument("text")
ap.add_argument("out")
ap.add_argument("--seed", type=int, default=2)
ap.add_argument("--voice", default=None, help="音色配置，默认 voice.json")
ap.add_argument("--ref", default=None, help="临时换参考音做试验（正式出片用 voice.json 里的）")
ap.add_argument("--ref-text", default=None)
ap.add_argument("--temperature", type=float, default=None, help="默认取音色配置的 temperature，没写是 0.7")
ap.add_argument("--max-tries", type=int, default=None, help="自检不过时自动换种子重生成的最多次数（每句单独计）；默认取 voice.json 的 maxTries，没写是 5")
ap.add_argument("--gap", type=float, default=0.4, help="句与句之间的停顿秒数")
ap.add_argument("--no-cache", action="store_true", help="不用已缓存的句子，全部重新生成")
ap.add_argument("--reseed", action="append", default=[], help="「句子=偏移」：这一句换个种子重新生成（听出畸变、怪腔调时用；可重复）")
ap.add_argument("--tone", action="append", default=[], help="「句子=语气」：这一句按哪种语气挑候选（语气名在 voice.json 的 tones 里）")
ap.add_argument("--turn", action="append", default=[], help="对话里一段话的开头（上一句是别人说的，engine/compiler/speakers.mjs）：不和上一句凑成一段配、挑候选时不和上一句比接不接得上")
ap.add_argument("--fast", action="store_true", help="样片用：只查念对没有（回转识别）和逐字对齐（时间），不查音质（掉嗓子、破音、语速、背景、回声、沙沙声、音色），一句只要一条候选；精配过的句子直接用精配的缓存，快配的另存一份缓存，不混进精配的")
ap.add_argument("--mood", action="append", default=[], help="「句子=情绪」：这一句用 voice.json 的 moods 里那段情绪参考音克隆（语气跟着内容变；可重复）")
args = ap.parse_args()

asr = load_stt("models/Qwen3-ASR-0.6B")
voice = load_voice(args.voice) if args.voice else load_voice()
if not args.ref:
    args.ref = voice["ref"]
if args.max_tries is None:
    args.max_tries = voice.get("maxTries", 5)  # 起伏大的参考音句末更容易掉到下限以下，要多试几次
FLOOR = voice.get("pitchFloorHz", 0)  # 最低自然音高，见 voice.py 的 pitch_drops
# 生成时比成片检查严 3%：贴着下限的句子（如 193Hz 对 196Hz）在成片里分帧起点、前后停顿不同，会一边过一边不过；生成时就留出余量
GEN_FLOOR = FLOOR * 1.03
# 背景干净：逐句用 DNSMOS 的 BAK 分（起点错开 8 次取平均）筛掉明显偏脏的配音，低于 voice.json 的 takeMinBak 就换种子。
# 单句的分数挪几个采样就差 0.1–0.2，只当筛子（下限放得比较低），不当关卡；关卡是旁白检查里全片的中位数（minBak）
GEN_BAK = voice.get("takeMinBak", 0)
# 说话时的沙沙声（浊音谱平坦度，见 voice.py），高于 takeMaxFlat 就换种子；10 次都不到就用最干净的一条
MAX_FLAT = voice.get("takeMaxFlat", 0)
# 破音（voice.py 的 pitch_breaks）：候选里有一处就丢（用户听 E02 v3「好几处声音畸变」，E02 每分钟 1.9 处、E01 0.3 处）
NO_BREAKS = voice.get("takeNoBreaks", False)
# 语速一致（用户听 E02 v5：「有的地方语速正常，有的地方突然加快」；各句 3.1–5.0 字/秒，相邻两句差到 20%）：
# rate.target 是这个声音说话的语速（字/秒，只算嘴在动的时间，见 voice.py 的 art_rate），生成时候选离它超过 takeTol 不要，
# 拼好后每句离它超过 maxDev 的单独重配。情绪、音调照旧随语气变，语速不跟着变
RATE = voice.get("rate") or {}
# 一两个字的句子（对话里的「哦。」「对！」）量不出语速：只有一个字，拖长一点就差一倍，语速的筛选和检查都跳过它
RATE_MIN = RATE.get("minChars", 3)
# 回声：停顿处衰减 20dB 的时间（毫秒）高于 takeMaxEcho 就换种子（参考音录在有回声的房间时，每句学到的回声多少不一）
MAX_ECHO = voice.get("takeMaxEcho", 0)
# 每句候选几条、按语气挑（VOICE_PIPELINE.md 第三步）；--tone「句子=语气」覆盖自动判断（问句→好奇、感叹→兴奋、其余→认真讲）
CANDS = max(1, int(voice.get("candidates", 1)))
TONES = voice.get("tones", {})
PACK = voice.get("pack", {})
BASE_F0, BASE_RATE = PACK.get("baseF0", 0), PACK.get("baseRate", 0)
# 连贯（VOICE_PIPELINE.md「连贯」）：候选打分时加上「和上一句接不接得上」，PREV 是上一句选定那条的句尾音高和语速
FLOW = voice.get("flow") if CANDS > 1 else None
# 缓存键按精配的参数算（--fast 下面会把这几项关掉，键不能跟着变，不然找不到精配过的句子）
KEY_CANDS, KEY_ECHO, KEY_FLOW = CANDS, MAX_ECHO, FLOW
FAST = args.fast
if FAST:  # 样片：只留念对、对齐、时长合理、没有掉音这几项，音质的关卡都不查
    FLOOR = GEN_FLOOR = GEN_BAK = MAX_FLAT = MAX_ECHO = 0
    NO_BREAKS, RATE, CANDS, FLOW = False, {}, 1, None
PREV = {}
if GEN_BAK:
    from dnsmos import score as dnsmos_score
    bak_of = lambda a, r: dnsmos_score(a, r)[0][1]

# 1. 参考音文本：克隆需要参考音的准确文本；没给就用 ASR 转写（结果打印出来供人工核对）
def load_ref(path, text=None):
    """参考音 → {path, text, sig}。文本取同名 .txt；sig 是音频内容的哈希，进缓存键。"""
    txt = path.rsplit(".", 1)[0] + ".txt"
    if not text and os.path.exists(txt):
        text = open(txt, encoding="utf-8").read().strip()
    if not text:
        text = asr.generate(path, language="Chinese").text.strip()
        print(f"参考音 {path} 转写：{text}")
    return {"path": path, "text": text, "sig": hashlib.sha1(open(path, "rb").read()).hexdigest()}


REF = load_ref(args.ref, args.ref_text)
ref_text = REF["text"]
# 情绪参考：分镜按句指定情绪（narration.mood），没指定的句子用默认参考音
MOODS = voice.get("moods", {})
mood_of = {}
for m in args.mood:
    sent, name = (x.strip() for x in m.rsplit("=", 1))
    if name not in MOODS:
        raise SystemExit(f"情绪「{name}」不在 voice.json 的 moods 里（现有：{'、'.join(MOODS) or '无'}）")
    mood_of[sent] = name
# 自动换参考：某句用默认参考音试满 max_tries 次都过不了（常见：长陈述句句末掉嗓子），就改用 voice.json 的 fallbackMood 那段参考音再试；
# 换过的句子在缓存里记一个 .fallback 标记，下次直接用，不再白试十次
FALLBACK = voice.get("fallbackMood")
if FALLBACK and FALLBACK not in MOODS:
    raise SystemExit(f"fallbackMood「{FALLBACK}」不在 voice.json 的 moods 里")
mood_refs = {name: load_ref(MOODS[name]) for name in set(mood_of.values()) | ({FALLBACK} if FALLBACK else set())}
ref_for = lambda sent: mood_refs[mood_of[sent.strip()]] if sent.strip() in mood_of else REF

aligner = load_stt("models/Qwen3-ForcedAligner-0.6B")


def trim_leaked_prefix(audio, sr, prefix, text):
    """参考音尾巴串进来的开头多余字：对齐"多余字+本句"，在本句第一个字之前最安静处剪掉。"""
    sf.write(args.out + ".tmp.wav", audio, sr)
    items = list(aligner.generate(audio=args.out + ".tmp.wav", text=prefix + text, language="Chinese"))
    os.remove(args.out + ".tmp.wav")
    k = len(prefix)
    lo, hi = int(items[k - 1].end_time * sr), int(items[k].start_time * sr)
    if hi - lo < int(0.01 * sr):
        lo, hi = max(0, hi - int(0.15 * sr)), hi
    w = int(0.01 * sr)
    energy = [np.sqrt((audio[i:i + w] ** 2).mean()) for i in range(lo, max(lo + 1, hi - w), max(1, w // 2))]
    cut = lo + int(np.argmin(energy)) * max(1, w // 2) + w // 2
    return audio[cut:]


# 2. 克隆合成（按句）：每句生成后立刻做回转识别和掉音检查，不过就换种子重来（自修复）
# 生成用哪个模型：音色配置的 model，默认 Qwen3。量音色（说话人嵌入：挑候选、每句一致、和真人录音比）一直用 Qwen3，尺子不跟着换。
# 对话里的爸爸用 Breeze TTS 2 克隆（他的声音就是 Breeze 按描述设计的）：Qwen3 克隆他每秒 5.4–6.9 字，比原片 4.3 快一截，憨憨慢吞吞的劲儿没了；
# Breeze 克隆 3.3–5.4 字/秒，像原片的程度和 Qwen3 差不多（CAM++ 0.71–0.91 对 0.73–0.93）。两个模型都是每秒 12.5 帧，下面的长度上限通用
QWEN = "models/Qwen3-TTS-12Hz-1.7B-Base"
TTS_MODEL = voice.get("model", QWEN)
if args.temperature is None:
    args.temperature = voice.get("temperature", 0.7)
tts = load_model(TTS_MODEL)
spk = tts if TTS_MODEL == QWEN else load_model(QWEN)  # 量音色用
# 声音包的音色（主参考音的说话人嵌入）：候选打分时和它比，整集都向同一个音色靠
PACK_EMB = embedding(spk, *sf.read(REF["path"], dtype="float32"))
tone_arg = {k.strip(): v.strip() for k, v in (t.rsplit("=", 1) for t in args.tone)}
for t in tone_arg.values():
    if TONES and t not in TONES:
        raise SystemExit(f"语气「{t}」不在 voice.json 的 tones 里（现有：{'、'.join(TONES)}）")


def tone_of(sent):
    """这一句的语气：分镜标了就用标的；没标的按句末标点推（问句→好奇，感叹→兴奋，其余→认真讲）"""
    s0 = sent.strip()
    if s0 in tone_arg:
        return tone_arg[s0]
    return "好奇" if s0.endswith("？") else "兴奋" if s0.endswith("！") else "认真讲"
clean = re.sub(r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]", "", args.text)
DIG = str.maketrans("0123456789", "零一二三四五六七八九")  # ASR 把数字识别成汉字，比较前统一
from pypinyin import lazy_pinyin


def syl(s):
    """逐字转拼音（不带声调），拉丁字母原样：同音字（成/乘）算一致，读错的音（拧 ning / 零 ling）仍算错。"""
    return lazy_pinyin(read_numbers(s.lower()), errors=lambda x: list(x))


def cer(r, h):
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


def dropouts(x, sr):
    """两侧 20ms 都在发声的 ≥5ms 全零段 = 字中间掉音。"""
    def db(seg): return 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12) if len(seg) else -240.0
    z, out, i, w = np.abs(x) < 1e-7, 0, 0, int(0.02 * sr)
    while i < len(z):
        if z[i]:
            j = i
            while j < len(z) and z[j]: j += 1
            if j - i >= int(0.005 * sr) and db(x[max(0, i - w):i]) > -40 and db(x[j:j + w]) > -40: out += 1
            i = j
        else: i += 1
    return out


PUNCT = r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]"


def trim_edges(audio, sr, pad=0.08):
    """剪掉句首句尾的长静音，两头各留 pad 秒。有的参考音（如活泼参考）生成的句子开头有 0.8 秒静音，
    对齐器会把头一两个字压成 0ms 挤在静音边上（E01 v7「第」「二」都对在 0.80s），先剪掉再对齐。"""
    h = int(0.01 * sr)
    lv = np.array([20 * np.log10(np.sqrt((audio[i:i + h] ** 2).mean()) + 1e-12) for i in range(0, len(audio) - h, h)])
    on = np.where(lv > lv.max() - 45)[0]
    if not len(on):
        return audio
    a, b = max(0, on[0] * h - int(pad * sr)), min(len(audio), (on[-1] + 1) * h + int(pad * sr))
    return audio[a:b]


def align(audio, sr, text):
    sf.write(args.out + ".sent.wav", audio, sr)
    items = aligner.generate(audio=args.out + ".sent.wav", text=re.sub(PUNCT, "", text), language="Chinese")
    return [{"text": it.text, "start": float(it.start_time), "end": float(it.end_time)} for it in items]


# 对齐出来不到 50ms 的单字：要么真吞了，要么对齐器没对上；两种都换种子（成片旁白检查的「没有吞字」靠这份逐字时间）
squashed = lambda rel: [w["text"] for w in rel if len(w["text"]) == 1 and w["end"] - w["start"] < 0.05]
asr_text = lambda path: said_text(asr.generate(path, language="Chinese").text)


# 一句试满都没有沙沙声低于上限、只好用最干净的一条时，缓存里记下（flatFallback = 当时的上限），以后缓存检查不再因为沙沙声扔掉它：
# 「这就叫机器学习。」几乎全是 j/q/x，浊音谱平坦度天生偏高，30 多个种子都在 0.09 以上；原来每次跑都扔掉重配、再退回同一条，一次三分钟
FLAT_FALLBACK = "沙沙声试满都没低于上限，用最干净的一条"
STRAY_FALLBACK = "每条都有没标点却停的地方，用停得最短的一条"  # 缓存里记 strayFallback，以后复查不再因为断句扔掉它
# 配音容易听错的说法（tts/misheard.json，本机私有；没有时从 misheard.example.json 起头）：一句试满都没过、回转识别至少两次听成同一个说法，
# 就把「稿子 / 听成 / 听错的字」追加进去。分镜校验的写稿自查（engine/compiler/script_checks.mjs 的 script.tts）以后提醒含这些字的句子。
# E03：「那，拧哪个？」听成「那您哪个」，「往哪边拧？」听成「往哪边去」
MISHEARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "misheard.json")
HEARD = {}  # 句子 → 这次各个种子回转识别没对上时听成的说法（只收字数对得上的那种，给 misheard.json 用）
HYPS = {}  # 句子 → 回转识别没对上时听成的说法，字数差多少都记，卡句清单用（识别自己多加了符号、多念漏念几个字的，在清单里一眼看得出）
# 句子 → 这次没过关的种子 [(种子, 哪一类, 那一行说明)]。一句试满都没过时不再当场中断：记下来接着配后面的句子，
# 全部配完一次列出所有卡住的句子（最常见的原因、回转识别听成了什么），再非零退出。
# 原来卡一句就中断整轮：E04 153 句，跑了 37 分钟才报出一句卡住，改写后又跑 11 分钟报出下一句，一轮只能发现一句
FAILS = {}
SPLIT_STUCK = {}  # 句子 → 自动拆成两半后没过的那一半


def reject(text, seed, kind, msg):
    """一个种子没过关：照旧打印那一行，同时按类别记下，卡句清单要用"""
    FAILS.setdefault(text, []).append((seed, kind, msg))
    print(f"    种子 {seed}{msg}")


def note_misheard(sent):
    import difflib
    from collections import Counter
    hyps = Counter(HEARD.get(sent, []))
    if not hyps or hyps.most_common(1)[0][1] < 2:
        return
    heard, n = hyps.most_common(1)[0]
    said = said_text(sent)
    risky = [said[i1:i2] for op, i1, i2, _, _ in difflib.SequenceMatcher(None, said, heard, autojunk=False).get_opcodes() if op in ("replace", "delete")]
    data = json.load(open(MISHEARD, encoding="utf-8")) if os.path.exists(MISHEARD) else {"pairs": []}
    example = MISHEARD.replace(".json", ".example.json")
    if any(q.get("said") == sent.strip() and q.get("heard") == heard for q in json.load(open(example, encoding="utf-8")).get("pairs", [])) if os.path.exists(example) else False:
        return
    if any(q.get("said") == sent.strip() and q.get("heard") == heard for q in data["pairs"]):
        return
    data["pairs"].append({"said": sent.strip(), "heard": heard, "risky": risky, "date": time.strftime("%Y-%m-%d")})
    json.dump(data, open(MISHEARD, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"  记进 misheard.json：「{sent.strip()}」回转识别 {n} 次听成「{heard}」，写稿自查以后提醒含「{'」「'.join(risky)}」的句子")


def synth_sentence(text, seed0, R, strict=False, tone=None):
    """生成一句：一个个种子试，硬关卡（时长、回转拼音、掉音、掉嗓子、对齐、沙沙声、回声）都过的留作候选，
    凑够 CANDS 条（或试满 max_tries 次）后，按语气目标和音色接近度打分挑一条（VOICE_PIPELINE.md 第三步）。
    strict：重配已有的一句时（吞字、音色一致），只收全部关卡都过的候选，不退而求其次——
    E01 v17 音色一致重配收了一条沙沙声 0.116 的「这就叫机器学习。」，下次跑缓存检查又把它扔掉重配，每次多花三分钟"""
    ref = said_text(text)  # 先换念法再去标点，见 voice.py 的 said_text
    tmp = args.out + ".sent.wav"
    best = None  # 只差背景分的候选里最干净的一条
    best_flat = None  # 只差沙沙声的候选里最干净的一条
    best_rate = None  # 只差语速的候选里离目标最近的一条
    best_stray = None  # 只差断句（没标点却停了）的候选里停得最短的一条
    cands = []
    tone = tone or tone_of(text); target = TONES.get(tone, {})
    for attempt in range(args.max_tries):
        if len(cands) >= CANDS:
            break
        seed = seed0 + attempt
        mx.random.seed(seed)
        # 限制最大生成长度：自回归 TTS 偶尔不收尾、一直念下去（实测一句话生成了约 5 分钟音频）。
        # 12Hz 模型每秒 12.5 个 token，按每字 0.5 秒、另加 2 秒余量封顶
        n_chars = len(re.sub(PUNCT, "", text))
        cap = int(12.5 * (0.5 * n_chars + 2))
        chunks = list(tts.generate(text=text, ref_audio=R["path"], ref_text=R["text"], lang_code="chinese", temperature=args.temperature, max_tokens=cap))
        audio = np.concatenate([np.array(c.audio) for c in chunks]).astype(np.float32)
        sr = chunks[0].sample_rate
        dur = len(audio) / sr
        if not (0.12 * n_chars <= dur <= 0.45 * n_chars + 1.5):
            reject(text, seed, "时长不合理", f"：{dur:.1f}s 对 {n_chars} 个字不合理（失控或吞句），换种子重来")
            continue
        # 语速粗筛：识别、对齐要好几秒，先按「有声音的时长」粗估语速，差得太远的直接换种子（E02 v6 加语速关卡后配音慢了一倍）。
        # 粗估和逐字对齐量出来的语速差不多，留 12% 余量，只筛掉明显不行的
        if RATE.get("target") and n_chars >= RATE_MIN:
            h10 = int(0.01 * sr); lv10 = 20 * np.log10(np.sqrt(np.convolve(audio.astype(np.float64) ** 2, np.ones(h10) / h10, "valid")[::h10]) + 1e-9)
            est = n_chars / max(0.3, (lv10 > lv10.max() - 35).sum() * 0.01) / 1.05  # 粗估比逐字对齐平均快 5%（323 条缓存标定：误筛 3/189，提前筛掉 28/134）
            if abs(est / RATE["target"] - 1) > RATE.get("takeTol", 0.08) + 0.12:
                reject(text, seed, "语速不对", f"：粗估语速 {est:.2f} 字/秒，离 {RATE['target']} 太远，不识别了，换种子重来")
                continue
        sf.write(tmp, audio, sr)
        hyp = asr_text(tmp)
        c, dz = cer(syl(ref), syl(hyp)), dropouts(audio, sr)
        drops = pitch_drops(audio, sr, GEN_FLOOR) if FLOOR else []
        if drops:
            reject(text, seed, "掉嗓子", f"：掉嗓子 " + "、".join(f"{a:.2f}–{b:.2f}s 低到 {f:.0f}Hz" for a, b, f in drops) + f"（生成时下限 {GEN_FLOOR:.0f}Hz），换种子重来")
            continue
        brk = pitch_breaks(audio, sr) if NO_BREAKS else []
        if brk:
            reject(text, seed, "破音", f"：破音 " + "、".join(f"{t:.2f}s 跳 {j:.0f} 半音" for t, j in brk) + "，换种子重来")
            continue
        note = None
        if c == 0 and dz == 0:
            note = ""
        hs, rs = syl(hyp), syl(ref)
        if note is None and dz == 0 and 0 < len(hs) - len(rs) <= 3 and hs[len(hs) - len(rs):] == rs:
            prefix = hyp[: len(hs) - len(rs)]
            audio = soften_edges(trim_leaked_prefix(audio, sr, prefix, ref), sr)  # 剪开处淡入：E02 v5「权」2ms 里从静音跳到 -20dB，咔一声
            sf.write(tmp, audio, sr)
            if cer(rs, syl(asr_text(tmp))) == 0 and dropouts(audio, sr) == 0 and not (FLOOR and pitch_drops(audio, sr, GEN_FLOOR)):
                note = f"开头串进「{prefix}」已剪掉"
        if note is None:
            reject(text, seed, "回转识别没对上" if c > 0 else "掉音", f" 未通过（拼音错误率 {c:.3f}，掉音 {dz}）：{hyp}")
            if c > 0:
                HYPS.setdefault(text, []).append(hyp)
            if c > 0 and abs(len(hs) - len(rs)) <= 1:  # 开头串进多余字的那种（只多出字）不算听错
                HEARD.setdefault(text, []).append(hyp)
            continue
        audio = soften_edges(trim_edges(audio, sr), sr)
        rel = align(audio, sr, text)
        if squashed(rel):
            reject(text, seed, "吞字或对不上", f"：对齐时「{'」「'.join(squashed(rel))}」不到 50ms（吞字或对不上），换种子重来")
            continue
        # 硬切（成片旁白检查 0k 的同一条规则）：原来只在拼好后和成片里查，这里先挡掉，退路里也就不会有
        if (he := hard_edges(audio, sr)):
            reject(text, seed, "硬切", f"：硬切 " + "、".join(f"{k}音 {t:.2f}s {d:.0f}dB" for k, t, d in he) + "，换种子重来")
            continue
        bk = None
        if GEN_BAK and (bk := bak_of(audio, sr)) < GEN_BAK:
            reject(text, seed, "背景不干净", f"：背景不干净（DNSMOS BAK {bk:.2f}，要 ≥{GEN_BAK}），换种子重来")
            if not best or bk > best[5]:
                best = (audio, sr, seed, note, rel, bk)
            continue
        # 回声先查：只差沙沙声的候选会留作退路，退路也得没有回声（E01 v17：退路没查回声，混进一句 190ms 的）
        if MAX_ECHO and (ec := echo_ms(audio, sr, pause_points(rel))) > MAX_ECHO:
            reject(text, seed, "有回声", f"：有回声（停顿处衰减 20dB 要 {ec:.0f}ms，要 ≤{MAX_ECHO}），换种子重来")
            continue
        if MAX_FLAT and (fl := voiced_flatness(audio, sr)) > MAX_FLAT:
            reject(text, seed, "有沙沙声", f"：说话时有沙沙声（浊音谱平坦度 {fl:.3f}，要 ≤{MAX_FLAT}），换种子重来")
            if not best_flat or fl < best_flat[0]:
                best_flat = (fl, (audio, sr, seed, note, rel, bk))
            continue
        # 打分：离语气目标多远 + 和声音包音色差多少（同一段参考音挑出来的，语气有变化、音色不变）
        pr = prosody(audio, sr, rel)
        if RATE.get("target") and len(re.sub(PUNCT, "", text)) >= RATE_MIN and abs(pr["artRate"] / RATE["target"] - 1) > RATE.get("takeTol", 0.08):
            reject(text, seed, "语速不对", f"：语速 {pr['artRate']:.2f} 字/秒，离这个声音的 {RATE['target']} 超过 {RATE.get('takeTol', 0.08):.0%}，换种子重来")
            if not best_rate or abs(pr["artRate"] / RATE["target"] - 1) < best_rate[0]:
                best_rate = (abs(pr["artRate"] / RATE["target"] - 1), (audio, sr, seed, note, rel, bk))
            continue
        # 断错了地方：没有标点却停了（「你还真猜对了……一半」）。放在别的关卡后面，被它拒掉的候选别的都过了，可以当退路。
        # 样片也查：用户看样片就听得出来（2026-11-10，E04）
        stray, missed = phrasing(audio, sr, rel, text)
        if stray:
            reject(text, seed, "断错了地方", "：没有标点却停了 " + "、".join(f"「{a}|{b}」{g:.2f}s" for a, b, g in stray) + "，换种子重来")
            g_ = max(g for _, _, g in stray)
            if not best_stray or g_ < best_stray[0]:
                best_stray = (g_, (audio, sr, seed, note, rel, bk))
            continue
        e = embedding(spk, audio, sr)
        # 配了语速目标时，连贯打分不再拿声音包的基准语速比（量法不同：声音包按「首字到末字」量，逗号停顿算进去，每句都显得慢，候选就偏向快的那条）
        score = tone_cost(pr, target, BASE_F0, BASE_RATE) + 300 * (1 - float(e @ PACK_EMB)) + flow_cost(pr, PREV, FLOW, None if RATE.get("target") else BASE_RATE, target.get("rate"))
        pr["missed"] = len(missed)  # 逗号处一口气念过去的个数：挑候选时先比它，再比语气分（该断的地方要断）
        cands.append((score, (audio, sr, seed, note, rel, bk), pr))
    if cands:
        cands.sort(key=lambda q: (q[2].get("missed", 0), q[0]))
        sc, pick, pr = cands[0]
        if len(cands) > 1:
            print(f"    {len(cands)} 条候选按「{tone}」挑了种子 {pick[2]}（音区 {12 * np.log2(pr['f0'] / BASE_F0) if BASE_F0 and pr['f0'] else 0:+.1f} 半音、起伏 {pr['range']:.1f}、句末 {pr['end']:+.1f}）")
        return pick
    if strict:
        raise SystemExit(f"「{text}」{args.max_tries} 次里没有全部关卡都过的候选")
    # 退路也要过成片旁白检查会点名的几项（voice.py 的 line_defects：掉嗓子、破音、硬切、语速离目标不超过 maxDev），过不了宁可再试一轮种子：
    # 原来语速退路收下离目标差 12% 的一条（成片检查上限 10%），E03 定稿后一句句在渲染完的成片里被点名
    usable = lambda q: not line_defects(q[0], q[1], q[4], voice, GEN_FLOOR)
    if best_rate and not usable(best_rate[1]):
        print(f"    最接近语速目标的种子 {best_rate[1][2]} 也差 {best_rate[0]:.0%}，超过成片旁白检查的上限 {RATE.get('maxDev', 0.10):.0%}，不用它")
        best_rate = None
    best_flat = best_flat if best_flat and usable(best_flat[1]) else None
    best = best if best and usable(best) else None
    if best_rate:
        print(f"    {args.max_tries} 次里没有一条语速在目标 ±{RATE.get('takeTol', 0.08):.0%} 里，用最接近的种子 {best_rate[1][2]}（差 {best_rate[0]:.0%}）")
        return best_rate[1]
    # 别的自检都过、只是背景分没到：用这几次里最干净的一条（背景分只是筛子，不该让整集配不出来）
    if best_flat:
        print(f"    {args.max_tries} 次里没有一条沙沙声低于 {MAX_FLAT}，用最干净的种子 {best_flat[1][2]}（{best_flat[0]:.3f}）")
        a_, sr_, sd_, nt_, rel_, bk_ = best_flat[1]
        return a_, sr_, sd_, (nt_ + "；" if nt_ else "") + FLAT_FALLBACK, rel_, bk_
    if best:
        print(f"    {args.max_tries} 次里没有一条背景分到 {GEN_BAK}，用最干净的种子 {best[2]}（BAK {best[5]:.2f}）")
        return best
    if best_stray:
        print(f"    {args.max_tries} 次里每条都有没标点却停的地方，用停得最短的种子 {best_stray[1][2]}（{best_stray[0]:.2f}s）")
        a_, sr_, sd_, nt_, rel_, bk_ = best_stray[1]
        return a_, sr_, sd_, (nt_ + "；" if nt_ else "") + STRAY_FALLBACK, rel_, bk_
    raise SystemExit(f"「{text}」连续 {args.max_tries} 次没有一条全部关卡都过（回转识别、掉嗓子、破音、硬切、语速……原因见上面每个种子那一行），需要人工处理（改写难读的词、拆短，或换参考音）")


def split_synth(sent, seed0, pause=0.25, strict=False):
    """自动拆句：一句试满都没过（多半是长陈述句句末掉嗓子），在最后一个逗号、冒号或分号处拆成两半，各按一句配，
    中间留 pause 秒（一个逗号的停顿）拼回去。字不变，时间线里还是一句。两半都要各自过全部关卡"""
    body = sent.rstrip("。？！")
    cut = max(body.rfind("，"), body.rfind("："), body.rfind("；"))
    if cut < 4 or len(re.sub(PUNCT, "", body[cut + 1:])) < 3:
        return None
    a_txt, b_txt = body[:cut] + "。", body[cut + 1:] + sent[len(body):]
    print(f"  「{sent}」拆成「{a_txt}」「{b_txt}」两半分别配")
    half = a_txt
    try:
        r1 = synth_sentence(a_txt, seed0, ref_for(sent), strict)
        half = b_txt
        r2 = synth_sentence(b_txt, seed0 + 50, ref_for(sent), strict)
    except SystemExit:
        SPLIT_STUCK[sent] = half  # 卡句清单里写明是哪一半没过
        return None
    a1, sr_, s1, n1, rel1, bk1 = r1; a2, _, _, n2, rel2, _ = r2
    off = len(a1) / sr_ + pause
    audio = np.concatenate([a1, np.zeros(int(pause * sr_), np.float32), a2])
    rel = rel1 + [dict(w, start=w["start"] + off, end=w["end"] + off) for w in rel2]
    return audio, sr_, s1, "；".join(x for x in [n1, n2, "自动拆成两半配"] if x), rel, bk1


def stray_cached(key, sent):
    """缓存里的这句断错了地方（加断句检查之前配的）：重配"""
    meta_c = json.load(open(key + ".json", encoding="utf-8"))
    if meta_c.get("strayFallback") or os.path.exists(key + ".postfail"):  # 试满才收下的退路、换种子也配不好留了原条的：再配还是一样
        return False
    x_c, sr_c = sf.read(key + ".wav", dtype="float32")
    st, _ = phrasing(x_c, sr_c, meta_c["words"], sent)
    if st:
        print(f"  缓存里的「{sent.strip()}」没有标点却停了（" + "、".join(f"{a}|{b} {g:.2f}s" for a, b, g in st) + "），重新生成")
    return bool(st)


def make_take(sent, seed0, strict=False):
    """配一句的完整做法（主循环、拼好后的吞字重配、音色一致重配都用它）：先按 seed0 起试一轮，不过就再试 extraRounds 轮新种子，
    还不过就自动拆成两半配；都不行返回 None"""
    for r in range(1 + voice.get("extraRounds", 0)):
        try:
            res = synth_sentence(sent, seed0 + r * args.max_tries, ref_for(sent), strict)
            return res[:3] + ((res[3] + "；" if res[3] else "") + f"多试了 {r} 轮",) + res[4:] if r else res
        except SystemExit:
            if r < voice.get("extraRounds", 0):
                print(f"  「{sent}」{args.max_tries} 次没过，换下一轮种子再试")
    return split_synth(sent, seed0, strict=strict)


# 按句生成（句号、问号、叹号处断开）：每句单独自检、单独重试；句间统一留 gap 秒停顿，
# 保证每个句号处都有干净的切点（整段一次生成时，克隆音色常常一口气读完、句间没有静音，切点只能合并）
sents = [x for x in re.findall(r"[^。？！]+[。？！]?", args.text) if re.sub(PUNCT, "", x)]
takes, sr = [], 24000
# 句子缓存：键里有句子、参考音（内容）、参考文本、模型和生成参数，任何一样变了都重新生成；缓存的句子当时已通过逐句自检
CACHE = os.path.join(os.path.dirname(os.path.abspath(args.out)), "cache")
os.makedirs(CACHE, exist_ok=True)
# 换种子：程序听不出的畸变（自检都过、人耳听着怪）就给那一句换个起始种子，只重配这一句
reseed = {k.strip(): int(v) for k, v in (r.rsplit("=", 1) for r in args.reseed)}
TURN = {t.strip() for t in args.turn}  # 对话：这几句是一段话的开头，前面是别人在说
seed_of = lambda sent: args.seed + reseed.get(sent.strip(), 0) * args.max_tries  # 偏移按「整轮重试」跳，不和原来那轮的种子重叠
# 候选 1 条时缓存键和原来一样（老缓存照用）；多条时还要看语气、语气目标和声音包的基准，任何一样变了都重挑
cache_key = lambda sent, fast=None: hashlib.sha1(json.dumps([sent, ref_for(sent)["sig"], ref_for(sent)["text"], TTS_MODEL, args.temperature, seed_of(sent), args.max_tries]
                                                 + ([KEY_CANDS, tone_of(sent), TONES.get(tone_of(sent), {}), BASE_F0, BASE_RATE, KEY_ECHO] if KEY_CANDS > 1 else [])
                                                 + ([KEY_FLOW] if KEY_FLOW else []) + (["fast"] if (FAST if fast is None else fast) else []), ensure_ascii=False).encode()).hexdigest()  # 加了连贯打分以后旧缓存不再算数
stray = [t for t in mood_of if t not in {x.strip() for x in sents}]
if stray:
    raise SystemExit("--mood 里这些不是旁白稿里的一整句：" + "；".join(stray))
n_cached = 0
stuck_at = {}  # 试满都没配出来的句子 → 它在稿子里的第几句（从 0 数；同一句话可能出现几次）
# 卡了这么多句、而且比这一轮新配出来的还多，就不再往下配：多半是参考音或 voice.json 的阈值出了问题，
# 每句都试满再拆两半，一集要白跑几个小时。正常的稿子一集卡两三句，新配出来的远比这多，碰不到这条
STUCK_STOP = 3
fresh_ok = 0  # 这一轮新配出来（不是从缓存取）的句子数
stopped_at = None  # 因为上面这条提前停下时，停在第几句（从 1 数）
# 上一句卡住了：这一句挑候选时对着的「上一句」是再往前那句，不是改写后的新句子，所以这一句不进缓存，改完重跑时对着新的上一句重挑。
# 原来卡一句就中断，后面的句子都是改完才配的；不这样做，卡句后面那一句挑中的候选会和原来不一样
after_stuck = False
held = 0  # 因此没进缓存的句子数


def split_chunk(res, texts):
    """一段一起配出来的声音，按句切开：在每两句之间停顿的正中切（每句要几个字按去标点数）。句间没有停顿就切不开，返回 None"""
    audio, sr_, seed, note, rel = res
    counts = [len(re.sub(PUNCT, "", t)) for t in texts]
    ends, acc, ci, target = [], 0, 0, counts[0]
    for j, w in enumerate(rel):
        acc += len(re.sub(PUNCT, "", w["text"]))
        if acc >= target and len(ends) < len(counts) - 1:
            ends.append(j); ci += 1; target += counts[ci]
    if len(ends) != len(counts) - 1:
        return None
    cuts, starts = [0.0], [0]
    h = int(0.01 * sr_)
    peak = 20 * np.log10(np.abs(audio).max() + 1e-9)
    for j in ends:
        e, s2 = rel[j]["end"], rel[j + 1]["start"]
        if s2 - e < 0.12:
            return None
        # 切在句间停顿里最安静的 10ms 上，不按对齐的正中切：对齐的字尾常早几十毫秒，正中切会切在上一句的尾音里
        # （E02 v5「还是右边」的「边」还在响就断了）；停顿里最安静处也不够静，就不切，整段退回逐句配
        i0, i1 = int(e * sr_), max(int(e * sr_) + 1, int(s2 * sr_) - h)
        lv = [20 * np.log10(np.sqrt((audio[i:i + h] ** 2).mean()) + 1e-9) for i in range(i0, i1, max(1, h // 2))]
        if not lv or min(lv) > peak - 45:
            return None
        cuts.append((i0 + int(np.argmin(lv)) * max(1, h // 2) + h // 2) / sr_); starts.append(j + 1)
    cuts.append(len(audio) / sr_); starts.append(len(rel))
    out = []
    for k in range(len(texts)):
        a, b = cuts[k], cuts[k + 1]
        ws = [dict(w, start=round(w["start"] - a, 3), end=round(w["end"] - a, 3)) for w in rel[starts[k]:starts[k + 1]]]
        out.append((audio[int(a * sr_):int(b * sr_)], sr_, seed, (note + "；" if note else "") + f"整段一起配（{len(texts)} 句）", ws))
    return out


# 两三句一起配（voice.json 的 chunk）：按句单独生成，每句都从头起调，听着一句一句断开、有顿挫（用户听 E02 v3：不自然）。
# 语气相同的相邻句子凑成一段（最多 chunk.maxSentences 句、chunk.maxChars 个字）一次配出来，再在句间停顿的正中切开，
# 同一段里的句子之间不再另加停顿。一段配不过（全部关卡）就退回逐句配
CHUNK = voice.get("chunk") or {}
pre, joined = {}, set()  # pre[i]：这一句从段里切出来的 take；joined：这一句后面紧跟同一段的下一句（拼接时不另加停顿）
if CHUNK.get("maxSentences", 1) > 1:
    groups, cur = [], []
    clean_len = lambda t: len(re.sub(PUNCT, "", t))
    for i, sent in enumerate(sents):
        brk = cur and (len(cur) >= CHUNK["maxSentences"] or sum(clean_len(sents[k]) for k in cur) + clean_len(sent) > CHUNK.get("maxChars", 60)
                       or tone_of(sent) != tone_of(sents[cur[0]]) or sent.strip() in reseed or sents[cur[0]].strip() in reseed or sent.strip() in mood_of
                       or sent.strip() in TURN)
        if brk:
            groups.append(cur); cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    for g in groups:
        if len(g) < 2:
            continue
        text = "".join(sents[k] for k in g)
        ckey = os.path.join(CACHE, "chunk-" + cache_key(text))
        if FAST:  # 样片：精配过的段直接用；段里每句都精配过就逐句用精配的，不另配一段
            full_c = os.path.join(CACHE, "chunk-" + cache_key(text, False))
            if os.path.exists(full_c + ".wav") and os.path.exists(full_c + ".json"):
                ckey = full_c
            elif all(os.path.exists(os.path.join(CACHE, cache_key(sents[k], False)) + ".wav") for k in g):
                continue
        res = None
        if not args.no_cache and os.path.exists(ckey + ".wav") and os.path.exists(ckey + ".json"):
            a_, s_ = sf.read(ckey + ".wav", dtype="float32"); m_ = json.load(open(ckey + ".json", encoding="utf-8"))
            if not (NO_BREAKS and pitch_breaks(a_, s_)):
                res = (a_, s_, m_["seed"], "缓存", m_["words"])
        # 一段配不过的记下来（.fail），以后直接逐句配：种子是确定的，再试也是同样几条都不过。
        # 原来每次跑都把配不过的段从头试满 10 个种子再退回逐句，句子全走缓存时主讲配音也要 11 分钟（E02 父子对话样稿，正常几十秒）
        if res is None and not args.no_cache and os.path.exists(ckey + ".fail"):
            continue
        if res is None:
            print(f"  {len(g)} 句一起配：{text}")
            try:
                r = synth_sentence(text, seed_of(sents[g[0]]), ref_for(sents[g[0]]), strict=True, tone=tone_of(sents[g[0]]))
            except SystemExit:
                print("    这一段一起配不过，退回逐句配")
                open(ckey + ".fail", "w").write(text)
                continue
            res = r[:5]
            sf.write(ckey + ".wav", r[0], r[1])
            json.dump({"text": text, "seed": r[2], "note": r[3], "words": r[4]}, open(ckey + ".json", "w", encoding="utf-8"), ensure_ascii=False)
        parts = split_chunk(res, [sents[k] for k in g])
        if not parts:
            print(f"    「{text[:16]}…」句间没有停顿，切不开，退回逐句配")
            continue
        for k, take in zip(g, parts):
            # 这一句拼好后查出过破音、已经单独重配过（.nochunk 标记），就用单独配的那条
            if os.path.exists(os.path.join(CACHE, cache_key(sents[k])) + ".nochunk") or FAST and os.path.exists(os.path.join(CACHE, cache_key(sents[k], False)) + ".nochunk"):
                continue
            # 一段一起配只按整段验收：切出来的每一句再按成片旁白检查的口径验一遍（语速、硬切按句量），不过的这一句单独配
            if not FAST and (lb := line_defects(take[0], take[1], take[4], voice)):
                print(f"    整段切出来的第 {k + 1} 句{'、'.join(lb)}，这一句单独配")
                continue
            pre[k] = take
        joined.update(k for k in g[:-1] if k in pre and k + 1 in pre)

for i, sent in enumerate(sents):
    t0 = time.time()
    if FLOW and sent.strip() in TURN:
        PREV = {}  # 对话：上一句是别人说的，这一句重新起头，不按「和上一句接得上」挑
        after_stuck = False
    if i in pre:  # 整段一起配好的，直接用
        audio, sr, seed, note, rel = pre[i]
        takes.append([audio, sr, seed, note, rel])
        n_cached += note.startswith("缓存")
        fresh_ok += not note.startswith("缓存")
        after_stuck = False
        if FLOW:
            PREV = prosody(audio, sr, rel)
        print(f"  第 {i + 1}/{len(sents)} 句（种子 {seed}，{len(audio) / sr:.2f}s）：{note}  {sent}")
        continue
    fb_mark = os.path.join(CACHE, cache_key(sent)) + ".fallback"
    fb_full = os.path.join(CACHE, cache_key(sent, False)) + ".fallback"
    if FALLBACK and sent.strip() not in mood_of and (os.path.exists(fb_mark) or FAST and os.path.exists(fb_full)):
        mood_of[sent.strip()] = FALLBACK
    key = os.path.join(CACHE, cache_key(sent))
    full_key = os.path.join(CACHE, cache_key(sent, False))
    if FAST and not args.no_cache and os.path.exists(full_key + ".wav") and os.path.exists(full_key + ".json"):
        key = full_key  # 样片：这句精配过，直接用精配的那条
    cached = not args.no_cache and os.path.exists(key + ".wav") and os.path.exists(key + ".json")
    if cached and FLOOR and pitch_drops(*sf.read(key + ".wav", dtype="float32"), GEN_FLOOR):
        print(f"  缓存里的「{sent}」掉嗓子，重新生成")  # 缓存是在加这项检查之前生成的，不能直接信
        cached = False
    if cached:  # 同理：加「剪句首尾静音、对齐不到 50ms 就换种子」之前的缓存
        x_c, sr_c = sf.read(key + ".wav", dtype="float32")
        if len(x_c) - len(trim_edges(x_c, sr_c)) > 0.3 * sr_c or squashed(json.load(open(key + ".json", encoding="utf-8"))["words"]):
            print(f"  缓存里的「{sent}」句首尾静音过长或对齐有字不到 50ms，重新生成")
            cached = False
        # 缓存检查比生成时松 5%（回差）：缓存存成 16 位整数，重读后量出来会差一点，卡在线上的句子每次跑都被扔掉重配（「那就再补一条…」生成时 0.090、重读 0.091）
        elif NO_BREAKS and pitch_breaks(x_c, sr_c):
            print(f"  缓存里的「{sent}」有破音，重新生成")
            cached = False
        # 拼好后换种子也配不出来、留了原来那条的句子（.postfail，种子没变）不再按这几项扔掉重配：同样的种子再试也是同样的结果，交给成片旁白检查点名、流水线换种子
        elif not FAST and not (os.path.exists(key + ".postfail") and json.load(open(key + ".postfail", encoding="utf-8")).get("seed") == json.load(open(key + ".json", encoding="utf-8")).get("seed")) \
                and (lb := line_defects(x_c, sr_c, json.load(open(key + ".json", encoding="utf-8"))["words"], voice)):
            print(f"  缓存里的「{sent}」{'、'.join(lb)}（成片旁白检查会点名），重新生成")
            cached = False
        elif MAX_ECHO and echo_ms(x_c, sr_c, pause_points(json.load(open(key + ".json", encoding="utf-8"))["words"])) > MAX_ECHO * 1.05:
            print(f"  缓存里的「{sent}」有回声，重新生成")
            cached = False
        elif MAX_FLAT and json.load(open(key + ".json", encoding="utf-8")).get("flatFallback") != MAX_FLAT and voiced_flatness(x_c, sr_c) > MAX_FLAT * 1.05:
            print(f"  缓存里的「{sent}」说话时有沙沙声，重新生成")
            cached = False
        elif GEN_BAK:
            meta_c = json.load(open(key + ".json", encoding="utf-8"))
            if "bak" not in meta_c:  # 分数记进缓存：DNSMOS 一句要两三秒，每次都重算太慢
                meta_c["bak"] = round(bak_of(x_c, sr_c), 3)
                json.dump(meta_c, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
            if meta_c["bak"] < GEN_BAK:
                print(f"  缓存里的「{sent}」背景不干净（DNSMOS BAK {meta_c['bak']:.2f}），重新生成")
                cached = False
    if cached and stray_cached(key, sent):
        cached = False
    if FAST and not cached:
        key = os.path.join(CACHE, cache_key(sent))  # 精配那条没过复查：快配写进快配的缓存，绝不覆盖精配的
        cached = not args.no_cache and os.path.exists(key + ".wav") and os.path.exists(key + ".json")
        if cached and stray_cached(key, sent):
            cached = False
    if cached:
        audio, sr = sf.read(key + ".wav", dtype="float32")
        meta = json.load(open(key + ".json", encoding="utf-8"))
        seed, note, rel = meta["seed"], "缓存", meta["words"]
        n_cached += 1
    else:
        # 默认参考音先多试几轮（每轮 max_tries 个新种子），再自动拆两半：换参考音会让这一句听着像换了个人（用户听 E01 v15）
        # 同一句话在稿子里出现两次、头一次已经卡住：种子是确定的，再试也是同样几十条都不过
        res = None if sent in stuck_at else make_take(sent, seed_of(sent))
        if not res and sent not in stuck_at and FALLBACK and sent.strip() not in mood_of:
            print(f"  「{sent}」用默认参考音 {args.max_tries} 次都没过，改用「{FALLBACK}」参考音")
            open(fb_mark, "w").write(FALLBACK)
            mood_of[sent.strip()] = FALLBACK
            key = os.path.join(CACHE, cache_key(sent))
            try:
                res = synth_sentence(sent, seed_of(sent), ref_for(sent))
                res = res[:3] + ((res[3] + "；" if res[3] else "") + f"自动换「{FALLBACK}」参考音",) + res[4:]
            except SystemExit:
                res = None
        if not res:
            # 试满都没过、拆成两半也不行：不当场中断，记下来接着配后面的句子，全部配完一次列出（见下面的卡句清单）
            if sent not in stuck_at:
                note_misheard(sent)
            stuck_at.setdefault(sent, []).append(i)
            after_stuck = True
            print(f"  第 {i + 1}/{len(sents)} 句没配出来（{time.time() - t0:.1f}s），先记下，接着配后面的  {sent}")
            if len(stuck_at) >= STUCK_STOP and len(stuck_at) > fresh_ok:
                stopped_at = i + 1
                break
            continue
        audio, sr, seed, note, rel, bk = res
        fresh_ok += 1
        if after_stuck and FLOW:
            held += 1
            note = (note + "；" if note else "") + "上一句没配出来，这一句不进缓存，改完重跑时对着新的上一句重挑"
        else:
            sf.write(key + ".wav", audio, sr)
            json.dump({"text": sent, "seed": seed, "note": note, "words": rel, **({"bak": round(bk, 3)} if bk is not None else {}),
                       **({"flatFallback": MAX_FLAT} if FLAT_FALLBACK in (note or "") else {}), **({"strayFallback": True} if STRAY_FALLBACK in (note or "") else {})}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    after_stuck = False
    takes.append([audio, sr, seed, note, rel])
    if FLOW:  # 下一句挑候选时要和这一句接得上
        PREV = prosody(audio, sr, rel)
    mood = mood_of.get(sent.strip())
    print(f"  第 {i + 1}/{len(sents)} 句（{('情绪「' + mood + '」，') if mood else ''}种子 {seed}，{len(audio) / sr:.2f}s，{time.time() - t0:.1f}s）{('：' + note) if note else ''}  {sent}")


def tally(text):
    """这句话各个种子没过关的原因，按次数从多到少：「掉嗓子 18 次、回转识别没对上 9 次」"""
    from collections import Counter
    return "、".join(f"{k} {n} 次" for k, n in Counter(k for _, k, _ in FAILS.get(text, [])).most_common())


def heard_as(text):
    """这句话回转识别最常听成的两种说法：「；回转识别听成「……」5 次」，没有就是空串"""
    from collections import Counter
    top = Counter(HYPS.get(text, [])).most_common(2)
    return "；回转识别听成" + "、".join(f"「{h}」{n} 次" for h, n in top) if top else ""


# 卡句清单：试满都没配出来的句子一次列全，每句一行 [错误]（流水线把这些行原样记进报告的「待改」），每个种子的原因另存 <输出前缀>.stuck.json。
# 配好的句子进了缓存（紧跟在卡句后面的那一句除外，见 after_stuck），改写卡住的句子后重跑只配改过的和它后面那一句。
# 没配全就不拼接、不做后面的整段检查（吞字、音色一致），那些检查在重跑配全后才做，可能再重配几句
STUCK_FILE = args.out + ".stuck.json"
if stuck_at:
    from collections import Counter
    rows = []
    for sent, idx in stuck_at.items():
        why = f"试了 {len(FAILS.get(sent, []))} 条：{tally(sent) or '没有记录'}{heard_as(sent)}"
        if sent in SPLIT_STUCK:
            half = SPLIT_STUCK[sent]
            why += f"；拆成两半，「{half}」这一半也没过" + (f"（{tally(half)}{heard_as(half)}）" if tally(half) else "")
        else:
            why += "；句子里没有能拆成两半的逗号"
        print(f"[错误] 第 {'、'.join(str(k + 1) for k in idx)}/{len(sents)} 句配不出来：「{sent.strip()}」{why}")
        rows.append({"index": [k + 1 for k in idx], "text": sent.strip(), "reasons": dict(Counter(k for _, k, _ in FAILS.get(sent, []))),
                     "heard": [{"text": h, "times": n} for h, n in Counter(HYPS.get(sent, [])).most_common()],
                     "seeds": [{"seed": sd, "reason": k, "detail": m.lstrip("： ")} for sd, k, m in FAILS.get(sent, [])],
                     **({"half": {"text": SPLIT_STUCK[sent], "seeds": [{"seed": sd, "reason": k, "detail": m.lstrip("： ")} for sd, k, m in FAILS.get(SPLIT_STUCK[sent], [])]}} if sent in SPLIT_STUCK else {})})
    if stopped_at:
        print(f"[错误] 配到第 {stopped_at}/{len(sents)} 句就停了：已经卡了 {len(stuck_at)} 句，比这一轮新配出来的（{fresh_ok} 句）还多，"
              f"多半是参考音或 voice.json 的阈值出了问题，先查配置；后面 {len(sents) - stopped_at} 句没试")
    json.dump({"sentences": len(sents), **({"stoppedAt": stopped_at} if stopped_at else {}), "stuck": rows}, open(STUCK_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if os.path.exists(args.out + ".sent.wav"):
        os.remove(args.out + ".sent.wav")
    n_stuck = sum(len(v) for v in stuck_at.values())
    raise SystemExit(f"{len(sents)} 句里 {n_stuck} 句试满都没配出来（上面 [错误] 各行；每个种子的原因在 {STUCK_FILE}），配好的 {len(takes)} 句"
                     + (f"里 {len(takes) - held} 句进了缓存（紧跟在卡句后面的 {held} 句不进，重跑时重配）。" if held else "已进缓存。")
                     + ("先查配置" if stopped_at else "需要人工处理：改写难读的词、拆短，或换参考音"))
if os.path.exists(STUCK_FILE):
    os.remove(STUCK_FILE)


def finish(audio, sr_):
    """拼接前的固定处理（VOICE_PIPELINE.md 第四步）：频谱轻轻向声音包对齐、基础响度统一到同一目标（只调整句增益，句内轻重保留）"""
    y = audio
    if PACK.get("ltas") and voice.get("spectralMatchDb", 0):
        y = spectral_match(y, sr_, PACK["ltas"], voice["spectralMatchDb"])
    if voice.get("sentenceLevelDb"):
        y = (y * 10 ** ((voice["sentenceLevelDb"] - active_level_db(y, sr_)) / 20)).astype(np.float32)
    return np.clip(y, -0.99, 0.99).astype(np.float32)


# 停顿上限（音色配置的 maxPause、maxJoinPause，秒；不写就不动）：字与字之间超过 maxPause 的静音从正中剪短到 maxPause，
# 一段一起配、首尾相接的两句之间的静音最多留 maxJoinPause。只剪静音，逐字时间跟着前移；拼接时做，缓存里的声音不动。
# 用户听 E02 父子对话样片：爸爸一句话里断句的间隔有点长（Breeze 在逗号处停 1 秒左右，「哦。」到「比我还重一点。」停 1.9 秒；孩子句内停顿中位 0.24 秒）
MAX_PAUSE, JOIN_PAUSE = voice.get("maxPause"), voice.get("maxJoinPause")
def cap_pauses(audio, sr_, rel, lead=None, tail=None):
    h = int(0.01 * sr_)
    lv = np.sqrt(np.convolve(audio.astype(np.float64) ** 2, np.ones(h) / h, "same")) if len(audio) > h else np.abs(audio)
    loud = lv.max() if len(lv) else 0.0
    quiet = lambda a, b: b <= a or lv[a:b].max() <= loud * 10 ** (-30 / 20)  # 要剪的那段比这句最响处低 30dB 以上才剪
    cuts = []
    if MAX_PAUSE:
        for x, y in zip(rel, rel[1:]):
            g = y["start"] - x["end"]
            if g > MAX_PAUSE:
                mid, half = (x["end"] + y["start"]) / 2, (g - MAX_PAUSE) / 2
                a, b = int((mid - half) * sr_), int((mid + half) * sr_)
                if quiet(a, b):
                    cuts.append((a, b))
    if lead is not None and rel and rel[0]["start"] > lead and quiet(0, int((rel[0]["start"] - lead) * sr_)):
        cuts.append((0, int((rel[0]["start"] - lead) * sr_)))
    if tail is not None and rel and len(audio) / sr_ - rel[-1]["end"] > tail and quiet(int((rel[-1]["end"] + tail) * sr_), len(audio)):
        cuts.append((int((rel[-1]["end"] + tail) * sr_), len(audio)))
    if not cuts:
        return audio, rel
    cuts.sort()
    keep, pos = [], 0
    for a, b in cuts:
        keep.append(audio[pos:a]); pos = b
    keep.append(audio[pos:])
    shift = lambda t: t - sum(b - a for a, b in cuts if b <= int(t * sr_) + 1) / sr_
    return np.concatenate(keep), [dict(w, start=round(shift(w["start"]), 3), end=round(shift(w["end"]), 3)) for w in rel]


def assemble():
    """各句之间留 gap 秒拼成整段；返回整段、逐字时间、每句起止"""
    pieces, words, spans, t = [], [], [], 0.0
    for i, (sent, (audio, sr_, _, _, rel)) in enumerate(zip(sents, takes)):
        if MAX_PAUSE or JOIN_PAUSE:
            audio, rel = cap_pauses(audio, sr_, rel, lead=JOIN_PAUSE / 2 if JOIN_PAUSE and (i - 1) in joined else None,
                                    tail=JOIN_PAUSE / 2 if JOIN_PAUSE and i in joined else None)
        spans.append({"text": sent, "start": round(t, 3), "end": round(t + len(audio) / sr_, 3)})  # 这一句配音在整段里的起止：旁白检查按句量掉嗓子，和逐句自检用同一段声音
        words.extend({"text": w["text"], "start": round(w["start"] + t, 3), "end": round(w["end"] + t, 3), "sent": i} for w in rel)
        gap = np.zeros(int(args.gap * sr_) if i < len(sents) - 1 and i not in joined else 0, dtype=np.float32)  # 同一段一起配的句子之间，停顿已经在声音里
        pieces += [soften_edges(finish(audio, sr_), sr_), gap]  # 每条两头淡入淡出：不管在哪儿剪开过，接进来都不咔
        t += (len(audio) + len(gap)) / sr_
    return np.concatenate(pieces), words, spans


# 吞字要和成片旁白检查一个口径：拿整段所有字的响度中位数做参照（单句里看不出来），所以拼好后再查一遍，有字偏弱的句子换下一个种子重配
for rnd in range(4):
    full, words, spans = assemble()
    if FAST:
        break  # 样片不为字偏弱重配
    _, weak = weak_chars(full, sr, [{"text": w["text"], "t0": w["start"], "t1": w["end"]} for w in words])
    bad = sorted({words[k]["sent"] for k, _ in weak})
    if not bad:
        break
    if rnd == 3:
        raise SystemExit("重配 3 轮后仍有字偏弱：" + "；".join(m for _, m in weak))
    for i in bad:
        print(f"  拼好后第 {i + 1} 句有字偏弱（{'；'.join(m for k, m in weak if words[k]['sent'] == i)}），换下一个种子重配")
        res = make_take(sents[i], takes[i][2] + 1, strict=True)
        if not res:
            print(f"    第 {i + 1} 句换种子没配出来，留原来那条"); continue
        audio, sr, seed, note, rel, bk = res
        takes[i] = [audio, sr, seed, note, rel]
        joined.discard(i); joined.discard(i - 1)  # 单独重配了，前后按句间停顿拼
        key = os.path.join(CACHE, cache_key(sents[i]))
        sf.write(key + ".wav", audio, sr)
        json.dump({"text": sents[i], "seed": seed, "note": note, "words": rel, **({"bak": round(bk, 3)} if bk is not None else {})}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
# 拼好后在整段上按成片旁白检查的口径再查一遍（一段一起配的声音切开、对齐响度以后，个别卡在线上的会冒出来；E02 v4「定在5」破音），
# 查出来的句子单独换种子重配，最多 3 轮——不用人去成片里找、手动换种子
# 也查成片旁白检查要查的其余几项（掉嗓子用成片的下限、每句回声）：E02 v4 有一句生成时过了、拼好后掉嗓子 139Hz，一句回声 122ms
FINAL_ECHO = 0 if FAST else voice.get("maxEcho", 0)
def assembled_defects(full, spans, words):
    bad = {}
    for t_, j in (pitch_breaks(full, sr) if NO_BREAKS else []):
        for k, sp in enumerate(spans):
            if sp["start"] - 0.05 <= t_ <= sp["end"] + 0.05:
                bad.setdefault(k, []).append(f"破音 {t_:.2f}s")
    for k, sp in enumerate(spans):
        seg = full[int(sp["start"] * sr):int(sp["end"] * sr)]
        if FLOOR and pitch_drops(seg, sr, FLOOR):
            bad.setdefault(k, []).append("掉嗓子")
        ws_k = [w for w in words if w["sent"] == k]
        if (he := hard_edges(seg, sr)):
            bad.setdefault(k, []).append("硬切 " + "、".join(f"{a}{t:.2f}s" for a, t, _ in he))
        if RATE.get("target") and sum(len(w["text"]) for w in ws_k) >= RATE_MIN and abs(art_rate(ws_k) / RATE["target"] - 1) > RATE.get("maxDev", 0.10):
            bad.setdefault(k, []).append(f"语速 {art_rate(ws_k):.2f} 字/秒（目标 {RATE['target']}，最多差 {RATE.get('maxDev', 0.10):.0%}）")
        if FINAL_ECHO:
            ws = [dict(w, start=w["start"] - sp["start"], end=w["end"] - sp["start"]) for w in words if w["sent"] == k]
            if (ec := echo_ms(seg, sr, pause_points(ws))) > FINAL_ECHO:
                bad.setdefault(k, []).append(f"回声 {ec:.0f}ms")
    return bad
if NO_BREAKS or FLOOR or FINAL_ECHO or RATE.get("target"):
    # 换种子也配不出来的句子记下来（.postfail，连同当时那条的种子），以后留原来那条、不再重试：种子是确定的，再试也是同样几十条都不过。
    # 原来每跑一次都对它试满几十个种子，一轮里三轮还各试一遍（E02 父子对话样稿「一开始，旋钮是随便拧的。」，主讲配音每次多花几分钟）
    post_key = lambda i: os.path.join(CACHE, cache_key(sents[i])) + ".postfail"
    gave_up = {i for i in range(len(sents)) if os.path.exists(post_key(i)) and json.load(open(post_key(i), encoding="utf-8")).get("seed") == takes[i][2]}
    for rnd in range(3):
        full, words, spans = assemble()
        defects = assembled_defects(full, spans, words)
        for i in sorted(set(defects) & gave_up):
            print(f"  拼好后第 {i + 1} 句{'、'.join(defects[i])}：以前换种子试满都没配出来，留原来那条（{sents[i]}）")
        bad = sorted(set(defects) - gave_up)
        if not bad:
            break
        for i in bad:
            print(f"  拼好后第 {i + 1} 句{'、'.join(defects[i])}，单独换种子重配：{sents[i]}")
            res = make_take(sents[i], takes[i][2] + 1, strict=True)
            if not res:
                gave_up.add(i)
                note_misheard(sents[i])
                json.dump({"seed": takes[i][2], "defects": defects[i]}, open(post_key(i), "w", encoding="utf-8"), ensure_ascii=False)
                print(f"    第 {i + 1} 句换种子没配出全部关卡都过的，留原来那条"); continue
            audio, sr, seed, note, rel, bk = res
            takes[i] = [audio, sr, seed, note, rel]
            joined.discard(i); joined.discard(i - 1)
            key = os.path.join(CACHE, cache_key(sents[i]))
            sf.write(key + ".wav", audio, sr)
            json.dump({"text": sents[i], "seed": seed, "note": note, "words": rel}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
            open(key + ".nochunk", "w").write("拼好后查出问题，单独重配")  # 以后这一句不再从整段里切
            pre.pop(i, None)

# 每句都是同一个人：按句生成时每句是单独采样的，音色会一句一句地飘，听着像几个人你一句我一句（用户听 E01 v15）。
# 每句的说话人嵌入和整集的平均比，低于 takeMinConsistency 的句子换下一个种子重配，最多 3 轮；还不够就留最像的那条
MIN_CONS = 0 if FAST else voice.get("takeMinConsistency", 0)
if MIN_CONS:
    embs = [None] * len(sents)
    best_c = {}
    # 已经为音色一致重配过、留下了最像的一条的句子，缓存里记着 consChecked，以后不再重配：种子是确定的，再试也是同样几条（原来每次跑都重来，一次三分钟）
    meta_of = lambda i: (lambda k: json.load(open(k, encoding="utf-8")) if os.path.exists(k) else {})(os.path.join(CACHE, cache_key(sents[i])) + ".json")
    settled = {i for i in range(len(sents)) if meta_of(i).get("consChecked")}
    tried = set()
    for rnd in range(4):
        for i, tk in enumerate(takes):
            if embs[i] is None:
                e = embedding(spk, tk[0], tk[1]); embs[i] = e / np.linalg.norm(e)
        cen = np.mean(embs, 0); cen /= np.linalg.norm(cen)
        cos = [float(e @ cen) for e in embs]
        for i, c in enumerate(cos):
            if i not in best_c or c > best_c[i][0]:
                best_c[i] = (c, list(takes[i]))
        bad = [i for i, c in enumerate(cos) if c < MIN_CONS and i not in settled]
        if not bad or rnd == 3:
            break
        for i in bad:
            print(f"  第 {i + 1} 句音色和整集不太像（{cos[i]:.3f}，要 ≥{MIN_CONS}），换下一个种子重配：{sents[i]}")
            tried.add(i)
            res = make_take(sents[i], takes[i][2] + 1, strict=True)
            if not res:
                settled.add(i)  # 这一轮全部关卡都过的一条都没有，再试下一轮也是从同一个种子起，不再试
                print(f"    第 {i + 1} 句换种子没配出全部关卡都过的，留原来那条"); continue
            audio, sr, seed, note, rel, bk = res
            takes[i] = [audio, sr, seed, note, rel]; embs[i] = None
            joined.discard(i); joined.discard(i - 1)
    final = list(cos)
    for i, c in enumerate(cos):
        if c < MIN_CONS and best_c[i][0] > c:
            takes[i] = best_c[i][1]; final[i] = best_c[i][0]
            joined.discard(i); joined.discard(i - 1)
            print(f"  第 {i + 1} 句重配 3 轮仍不到 {MIN_CONS}，用最像的一条（{best_c[i][0]:.3f}）")
    for i, tk in enumerate(takes):
        key = os.path.join(CACHE, cache_key(sents[i]))
        meta = json.load(open(key + ".json", encoding="utf-8")) if os.path.exists(key + ".json") else {}
        if meta.get("seed") != tk[2] or (i in tried and not meta.get("consChecked")):
            if meta.get("seed") != tk[2]:
                sf.write(key + ".wav", tk[0], tk[1]); meta = {}
            json.dump({**meta, "text": sents[i], "seed": tk[2], "note": tk[3], "words": tk[4], **({"consChecked": True} if i in tried else {})},
                      open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    full, words, spans = assemble()
    print(f"  每句音色和整集平均的相似度（换回最像的之后，按换之前的整集平均估）：最低 {min(final):.3f}，中位 {np.median(final):.3f}")
for w in words:
    w.pop("sent")
if os.path.exists(args.out + ".sent.wav"):
    os.remove(args.out + ".sent.wav")
print(f"  {len(sents)} 句里 {n_cached} 句用了缓存，{len(sents) - n_cached} 句新生成")
sf.write(args.out + ".wav", full, sr)

# 整段再回转核对一遍。分块识别：一次识别十分钟的音频，Qwen3-ASR 会整段漏掉（E03 v2：逐句都过，整段识别漏了中间约 90 秒，
# 错误率 0.105）。在句间停顿正中切成不超过 ASR_CHUNK 秒的几块，块里几句照样拼着识别，句与句的接缝绝大多数仍在块里查得到
ASR_CHUNK = 30.0


def asr_long(path, spans, max_sec=ASR_CHUNK):
    x_, sr_ = sf.read(path, dtype="float32")
    if not spans or len(x_) / sr_ <= max_sec:
        return asr_text(path)
    cuts, start = [0.0], spans[0]["start"]
    for a_, b_ in zip(spans, spans[1:]):
        if b_["end"] - start > max_sec:
            cut = (a_["end"] + b_["start"]) / 2
            cuts.append(cut); start = b_["start"]
    cuts.append(len(x_) / sr_)
    hyp = []
    for c0, c1 in zip(cuts, cuts[1:]):
        tmp = args.out + ".chunk.wav"
        sf.write(tmp, x_[int(c0 * sr_):int(c1 * sr_)], sr_)
        try:
            hyp.append(asr_text(tmp))
        finally:
            os.remove(tmp)
    return "".join(hyp)


c_all = cer(syl(said_text(args.text)), syl(asr_long(args.out + ".wav", spans)))
json.dump({"source": f"qwen3-tts-1.7b-base clone 按句生成 gap={args.gap}s + qwen3-forcedaligner", "text": args.text, "ref_text": ref_text, "words": words, "sentences": spans},
          open(args.out + ".timing.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
# 逐句都已是 0；整段长了识别偶尔差一两个音节（E01 v15 670 个音节里差 1 个），放到 0.5%，成片的总混可懂度另有 2% 的关卡
if c_all > 0.005 and FAST:
    print(f"  整段回转拼音错误率 {c_all:.3f}（样片不拦，精配时再查）")
elif c_all > 0.005:
    raise SystemExit(f"整段回转拼音错误率 {c_all:.3f}（逐句都通过，但拼起来后识别有出入），需要人工检查")
# 音色一致性：和真人录音质心比，防止参考音或模型改动让音色悄悄漂移
sim = similarity(spk, full, sr, voice)
ok = sim >= voice["minSimilarity"] or FAST  # 样片只报数，不拦
print(f"[{'通过' if ok else '失败'}] 音色一致性：与真人录音相似度 {sim:.3f}（下限 {voice['minSimilarity']}）")
if not ok:
    raise SystemExit("音色和真人录音差得太多，可能参考音或模型被改动，需要人工处理")
print(f"通过：{len(sents)} 句逐句与整段回转拼音错误率都为 0，无掉音；对齐 {len(words)} 项，全长 {len(full) / sr:.2f}s")
