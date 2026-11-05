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
from voice import load_voice, similarity, pitch_drops, weak_chars

ap = argparse.ArgumentParser()
ap.add_argument("text")
ap.add_argument("out")
ap.add_argument("--seed", type=int, default=2)
ap.add_argument("--voice", default=None, help="音色配置，默认 voice.json")
ap.add_argument("--ref", default=None, help="临时换参考音做试验（正式出片用 voice.json 里的）")
ap.add_argument("--ref-text", default=None)
ap.add_argument("--temperature", type=float, default=0.7)
ap.add_argument("--max-tries", type=int, default=None, help="自检不过时自动换种子重生成的最多次数（每句单独计）；默认取 voice.json 的 maxTries，没写是 5")
ap.add_argument("--gap", type=float, default=0.4, help="句与句之间的停顿秒数")
ap.add_argument("--no-cache", action="store_true", help="不用已缓存的句子，全部重新生成")
ap.add_argument("--reseed", action="append", default=[], help="「句子=偏移」：这一句换个种子重新生成（听出畸变、怪腔调时用；可重复）")
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
mood_refs = {name: load_ref(MOODS[name]) for name in set(mood_of.values())}
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
TTS_MODEL = "models/Qwen3-TTS-12Hz-1.7B-Base"
tts = load_model(TTS_MODEL)
clean = re.sub(r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]", "", args.text)
DIG = str.maketrans("0123456789", "零一二三四五六七八九")  # ASR 把数字识别成汉字，比较前统一
from pypinyin import lazy_pinyin


def syl(s):
    """逐字转拼音（不带声调），拉丁字母原样：同音字（成/乘）算一致，读错的音（拧 ning / 零 ling）仍算错。"""
    return lazy_pinyin(s.lower().translate(DIG), errors=lambda x: list(x))


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
asr_text = lambda path: re.sub(PUNCT, "", asr.generate(path, language="Chinese").text).lower().translate(DIG)


def synth_sentence(text, seed0, R):
    """生成一句并自检：拼音错误率必须为 0、不能有字中间掉音、不能掉嗓子（浊音掉到这个孩子最低自然音高以下）；开头串进多余字就剪掉；不过就换种子重来。"""
    ref = re.sub(PUNCT, "", text).lower().translate(DIG)
    tmp = args.out + ".sent.wav"
    best = None  # 只差背景分的候选里最干净的一条
    for attempt in range(args.max_tries):
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
            print(f"    种子 {seed}：{dur:.1f}s 对 {n_chars} 个字不合理（失控或吞句），换种子重来")
            continue
        sf.write(tmp, audio, sr)
        hyp = asr_text(tmp)
        c, dz = cer(syl(ref), syl(hyp)), dropouts(audio, sr)
        drops = pitch_drops(audio, sr, GEN_FLOOR) if FLOOR else []
        if drops:
            print(f"    种子 {seed}：掉嗓子 " + "、".join(f"{a:.2f}–{b:.2f}s 低到 {f:.0f}Hz" for a, b, f in drops) + f"（生成时下限 {GEN_FLOOR:.0f}Hz），换种子重来")
            continue
        note = None
        if c == 0 and dz == 0:
            note = ""
        hs, rs = syl(hyp), syl(ref)
        if note is None and dz == 0 and 0 < len(hs) - len(rs) <= 3 and hs[len(hs) - len(rs):] == rs:
            prefix = hyp[: len(hs) - len(rs)]
            audio = trim_leaked_prefix(audio, sr, prefix, ref)
            sf.write(tmp, audio, sr)
            if cer(rs, syl(asr_text(tmp))) == 0 and dropouts(audio, sr) == 0 and not (FLOOR and pitch_drops(audio, sr, GEN_FLOOR)):
                note = f"开头串进「{prefix}」已剪掉"
        if note is None:
            print(f"    种子 {seed} 未通过（拼音错误率 {c:.3f}，掉音 {dz}）：{hyp}")
            continue
        audio = trim_edges(audio, sr)
        rel = align(audio, sr, text)
        if squashed(rel):
            print(f"    种子 {seed}：对齐时「{'」「'.join(squashed(rel))}」不到 50ms（吞字或对不上），换种子重来")
            continue
        bk = None
        if GEN_BAK and (bk := bak_of(audio, sr)) < GEN_BAK:
            print(f"    种子 {seed}：背景不干净（DNSMOS BAK {bk:.2f}，要 ≥{GEN_BAK}），换种子重来")
            if not best or bk > best[5]:
                best = (audio, sr, seed, note, rel, bk)
            continue
        return audio, sr, seed, note, rel, bk
    # 别的自检都过、只是背景分没到：用这几次里最干净的一条（背景分只是筛子，不该让整集配不出来）
    if best:
        print(f"    {args.max_tries} 次里没有一条背景分到 {GEN_BAK}，用最干净的种子 {best[2]}（BAK {best[5]:.2f}）")
        return best
    raise SystemExit(f"「{text}」连续 {args.max_tries} 次未通过回转检查，需要人工处理（改写难读的词，或换参考音）")


# 按句生成（句号、问号、叹号处断开）：每句单独自检、单独重试；句间统一留 gap 秒停顿，
# 保证每个句号处都有干净的切点（整段一次生成时，克隆音色常常一口气读完、句间没有静音，切点只能合并）
sents = [x for x in re.findall(r"[^。？！]+[。？！]?", args.text) if re.sub(PUNCT, "", x)]
takes, sr = [], 24000
# 句子缓存：键里有句子、参考音（内容）、参考文本、模型和生成参数，任何一样变了都重新生成；缓存的句子当时已通过逐句自检
CACHE = os.path.join(os.path.dirname(os.path.abspath(args.out)), "cache")
os.makedirs(CACHE, exist_ok=True)
# 换种子：程序听不出的畸变（自检都过、人耳听着怪）就给那一句换个起始种子，只重配这一句
reseed = {k.strip(): int(v) for k, v in (r.rsplit("=", 1) for r in args.reseed)}
seed_of = lambda sent: args.seed + reseed.get(sent.strip(), 0) * args.max_tries  # 偏移按「整轮重试」跳，不和原来那轮的种子重叠
cache_key = lambda sent: hashlib.sha1(json.dumps([sent, ref_for(sent)["sig"], ref_for(sent)["text"], TTS_MODEL, args.temperature, seed_of(sent), args.max_tries], ensure_ascii=False).encode()).hexdigest()
stray = [t for t in mood_of if t not in {x.strip() for x in sents}]
if stray:
    raise SystemExit("--mood 里这些不是旁白稿里的一整句：" + "；".join(stray))
n_cached = 0
for i, sent in enumerate(sents):
    t0 = time.time()
    key = os.path.join(CACHE, cache_key(sent))
    cached = not args.no_cache and os.path.exists(key + ".wav") and os.path.exists(key + ".json")
    if cached and FLOOR and pitch_drops(*sf.read(key + ".wav", dtype="float32"), GEN_FLOOR):
        print(f"  缓存里的「{sent}」掉嗓子，重新生成")  # 缓存是在加这项检查之前生成的，不能直接信
        cached = False
    if cached:  # 同理：加「剪句首尾静音、对齐不到 50ms 就换种子」之前的缓存
        x_c, sr_c = sf.read(key + ".wav", dtype="float32")
        if len(x_c) - len(trim_edges(x_c, sr_c)) > 0.3 * sr_c or squashed(json.load(open(key + ".json", encoding="utf-8"))["words"]):
            print(f"  缓存里的「{sent}」句首尾静音过长或对齐有字不到 50ms，重新生成")
            cached = False
        elif GEN_BAK:
            meta_c = json.load(open(key + ".json", encoding="utf-8"))
            if "bak" not in meta_c:  # 分数记进缓存：DNSMOS 一句要两三秒，每次都重算太慢
                meta_c["bak"] = round(bak_of(x_c, sr_c), 3)
                json.dump(meta_c, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
            if meta_c["bak"] < GEN_BAK:
                print(f"  缓存里的「{sent}」背景不干净（DNSMOS BAK {meta_c['bak']:.2f}），重新生成")
                cached = False
    if cached:
        audio, sr = sf.read(key + ".wav", dtype="float32")
        meta = json.load(open(key + ".json", encoding="utf-8"))
        seed, note, rel = meta["seed"], "缓存", meta["words"]
        n_cached += 1
    else:
        audio, sr, seed, note, rel, bk = synth_sentence(sent, seed_of(sent), ref_for(sent))
        sf.write(key + ".wav", audio, sr)
        json.dump({"text": sent, "seed": seed, "note": note, "words": rel, **({"bak": round(bk, 3)} if bk is not None else {})}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    takes.append([audio, sr, seed, note, rel])
    mood = mood_of.get(sent.strip())
    print(f"  第 {i + 1}/{len(sents)} 句（{('情绪「' + mood + '」，') if mood else ''}种子 {seed}，{len(audio) / sr:.2f}s，{time.time() - t0:.1f}s）{('：' + note) if note else ''}  {sent}")


def assemble():
    """各句之间留 gap 秒拼成整段；返回整段、逐字时间、每句起止"""
    pieces, words, spans, t = [], [], [], 0.0
    for i, (sent, (audio, sr_, _, _, rel)) in enumerate(zip(sents, takes)):
        spans.append({"text": sent, "start": round(t, 3), "end": round(t + len(audio) / sr_, 3)})  # 这一句配音在整段里的起止：旁白检查按句量掉嗓子，和逐句自检用同一段声音
        words.extend({"text": w["text"], "start": round(w["start"] + t, 3), "end": round(w["end"] + t, 3), "sent": i} for w in rel)
        gap = np.zeros(int(args.gap * sr_) if i < len(sents) - 1 else 0, dtype=np.float32)
        pieces += [audio, gap]
        t += (len(audio) + len(gap)) / sr_
    return np.concatenate(pieces), words, spans


# 吞字要和成片旁白检查一个口径：拿整段所有字的响度中位数做参照（单句里看不出来），所以拼好后再查一遍，有字偏弱的句子换下一个种子重配
for rnd in range(4):
    full, words, spans = assemble()
    _, weak = weak_chars(full, sr, [{"text": w["text"], "t0": w["start"], "t1": w["end"]} for w in words])
    bad = sorted({words[k]["sent"] for k, _ in weak})
    if not bad:
        break
    if rnd == 3:
        raise SystemExit("重配 3 轮后仍有字偏弱：" + "；".join(m for _, m in weak))
    for i in bad:
        print(f"  拼好后第 {i + 1} 句有字偏弱（{'；'.join(m for k, m in weak if words[k]['sent'] == i)}），换下一个种子重配")
        audio, sr, seed, note, rel, bk = synth_sentence(sents[i], takes[i][2] + 1, ref_for(sents[i]))
        takes[i] = [audio, sr, seed, note, rel]
        key = os.path.join(CACHE, cache_key(sents[i]))
        sf.write(key + ".wav", audio, sr)
        json.dump({"text": sents[i], "seed": seed, "note": note, "words": rel, **({"bak": round(bk, 3)} if bk is not None else {})}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
for w in words:
    w.pop("sent")
if os.path.exists(args.out + ".sent.wav"):
    os.remove(args.out + ".sent.wav")
print(f"  {len(sents)} 句里 {n_cached} 句用了缓存，{len(sents) - n_cached} 句新生成")
sf.write(args.out + ".wav", full, sr)

# 整段再回转核对一遍
c_all = cer(syl(clean.lower().translate(DIG)), syl(asr_text(args.out + ".wav")))
json.dump({"source": f"qwen3-tts-1.7b-base clone 按句生成 gap={args.gap}s + qwen3-forcedaligner", "text": args.text, "ref_text": ref_text, "words": words, "sentences": spans},
          open(args.out + ".timing.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
if c_all > 0:
    raise SystemExit(f"整段回转拼音错误率 {c_all:.3f}（逐句都通过，但拼起来后识别有出入），需要人工检查")
# 音色一致性：和真人录音质心比，防止参考音或模型改动让音色悄悄漂移
sim = similarity(tts, full, sr, voice)
ok = sim >= voice["minSimilarity"]
print(f"[{'通过' if ok else '失败'}] 音色一致性：与真人录音相似度 {sim:.3f}（下限 {voice['minSimilarity']}）")
if not ok:
    raise SystemExit("音色和真人录音差得太多，可能参考音或模型被改动，需要人工处理")
print(f"通过：{len(sents)} 句逐句与整段回转拼音错误率都为 0，无掉音；对齐 {len(words)} 项，全长 {len(full) / sr:.2f}s")
