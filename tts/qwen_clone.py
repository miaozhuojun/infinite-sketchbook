"""本地免订阅配音链路：Qwen3-TTS 克隆音色 → Qwen3-ForcedAligner 对齐出时间戳 → Qwen3-ASR 回转核对字词。

输出与 edge_baseline.py 相同的 timing JSON，引擎编译器可直接换用。
用法：.venv-mlx/bin/python qwen_clone.py <文本> <输出前缀> [--seed N] [--gap 0.4] [--voice voice.json]
音色配置（参考音、真人录音、相似度下限）只在 voice.json；参考文本取参考音同名 .txt，默认种子 2。
按句生成，每句自检（回转拼音、掉音、时长）不过就换种子；最后检查整段回转和音色一致性，任何一项不过都非零退出。
通过自检的句子按「句子 + 参考音 + 模型 + 参数」缓存在输出目录的 cache/ 里：改稿后只重配改动的句子（--no-cache 全部重来）。
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
from voice import load_voice, similarity

ap = argparse.ArgumentParser()
ap.add_argument("text")
ap.add_argument("out")
ap.add_argument("--seed", type=int, default=2)
ap.add_argument("--voice", default=None, help="音色配置，默认 voice.json")
ap.add_argument("--ref", default=None, help="临时换参考音做试验（正式出片用 voice.json 里的）")
ap.add_argument("--ref-text", default=None)
ap.add_argument("--temperature", type=float, default=0.7)
ap.add_argument("--max-tries", type=int, default=5, help="拼音错误率不为 0 或有字中间掉音时，自动换种子重生成的最多次数（每句单独计）")
ap.add_argument("--gap", type=float, default=0.4, help="句与句之间的停顿秒数")
ap.add_argument("--no-cache", action="store_true", help="不用已缓存的句子，全部重新生成")
args = ap.parse_args()

asr = load_stt("models/Qwen3-ASR-0.6B")
voice = load_voice(args.voice) if args.voice else load_voice()
if not args.ref:
    args.ref = voice["ref"]

# 1. 参考音文本：克隆需要参考音的准确文本；没给就用 ASR 转写（结果打印出来供人工核对）
ref_text = args.ref_text
ref_txt_file = args.ref.rsplit(".", 1)[0] + ".txt"
if not ref_text and os.path.exists(ref_txt_file):
    ref_text = open(ref_txt_file, encoding="utf-8").read().strip()
if not ref_text:
    ref_text = asr.generate(args.ref, language="Chinese").text.strip()
    print(f"参考音转写：{ref_text}")

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
asr_text = lambda path: re.sub(PUNCT, "", asr.generate(path, language="Chinese").text).lower().translate(DIG)


def synth_sentence(text, seed0):
    """生成一句并自检：拼音错误率必须为 0、不能有字中间掉音；开头串进多余字就剪掉；不过就换种子重来。"""
    ref = re.sub(PUNCT, "", text).lower().translate(DIG)
    tmp = args.out + ".sent.wav"
    for attempt in range(args.max_tries):
        seed = seed0 + attempt
        mx.random.seed(seed)
        # 限制最大生成长度：自回归 TTS 偶尔不收尾、一直念下去（实测一句话生成了约 5 分钟音频）。
        # 12Hz 模型每秒 12.5 个 token，按每字 0.5 秒、另加 2 秒余量封顶
        n_chars = len(re.sub(PUNCT, "", text))
        cap = int(12.5 * (0.5 * n_chars + 2))
        chunks = list(tts.generate(text=text, ref_audio=args.ref, ref_text=ref_text, lang_code="chinese", temperature=args.temperature, max_tokens=cap))
        audio = np.concatenate([np.array(c.audio) for c in chunks]).astype(np.float32)
        sr = chunks[0].sample_rate
        dur = len(audio) / sr
        if not (0.12 * n_chars <= dur <= 0.45 * n_chars + 1.5):
            print(f"    种子 {seed}：{dur:.1f}s 对 {n_chars} 个字不合理（失控或吞句），换种子重来")
            continue
        sf.write(tmp, audio, sr)
        hyp = asr_text(tmp)
        c, dz = cer(syl(ref), syl(hyp)), dropouts(audio, sr)
        if c == 0 and dz == 0:
            return audio, sr, seed, ""
        hs, rs = syl(hyp), syl(ref)
        if dz == 0 and 0 < len(hs) - len(rs) <= 3 and hs[len(hs) - len(rs):] == rs:
            prefix = hyp[: len(hs) - len(rs)]
            audio = trim_leaked_prefix(audio, sr, prefix, ref)
            sf.write(tmp, audio, sr)
            if cer(rs, syl(asr_text(tmp))) == 0 and dropouts(audio, sr) == 0:
                return audio, sr, seed, f"开头串进「{prefix}」已剪掉"
        print(f"    种子 {seed} 未通过（拼音错误率 {c:.3f}，掉音 {dz}）：{hyp}")
    raise SystemExit(f"「{text}」连续 {args.max_tries} 次未通过回转检查，需要人工处理（改写难读的词，或换参考音）")


# 按句生成（句号、问号、叹号处断开）：每句单独自检、单独重试；句间统一留 gap 秒停顿，
# 保证每个句号处都有干净的切点（整段一次生成时，克隆音色常常一口气读完、句间没有静音，切点只能合并）
sents = [x for x in re.findall(r"[^。？！]+[。？！]?", args.text) if re.sub(PUNCT, "", x)]
pieces, words, t_cursor, sr = [], [], 0.0, 24000
# 句子缓存：键里有句子、参考音（内容）、参考文本、模型和生成参数，任何一样变了都重新生成；缓存的句子当时已通过逐句自检
CACHE = os.path.join(os.path.dirname(os.path.abspath(args.out)), "cache")
os.makedirs(CACHE, exist_ok=True)
ref_sig = hashlib.sha1(open(args.ref, "rb").read()).hexdigest()
cache_key = lambda sent: hashlib.sha1(json.dumps([sent, ref_sig, ref_text, TTS_MODEL, args.temperature, args.seed, args.max_tries], ensure_ascii=False).encode()).hexdigest()
n_cached = 0
for i, sent in enumerate(sents):
    t0 = time.time()
    key = os.path.join(CACHE, cache_key(sent))
    sent_clean = re.sub(PUNCT, "", sent)
    if not args.no_cache and os.path.exists(key + ".wav") and os.path.exists(key + ".json"):
        audio, sr = sf.read(key + ".wav", dtype="float32")
        meta = json.load(open(key + ".json", encoding="utf-8"))
        seed, note, rel = meta["seed"], "缓存", meta["words"]
        n_cached += 1
    else:
        audio, sr, seed, note = synth_sentence(sent, args.seed)
        sf.write(args.out + ".sent.wav", audio, sr)
        items = aligner.generate(audio=args.out + ".sent.wav", text=sent_clean, language="Chinese")
        rel = [{"text": it.text, "start": float(it.start_time), "end": float(it.end_time)} for it in items]
        sf.write(key + ".wav", audio, sr)
        json.dump({"text": sent, "seed": seed, "note": note, "words": rel}, open(key + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    words += [{"text": w["text"], "start": round(w["start"] + t_cursor, 3), "end": round(w["end"] + t_cursor, 3)} for w in rel]
    gap = np.zeros(int(args.gap * sr), dtype=np.float32) if i < len(sents) - 1 else np.zeros(0, dtype=np.float32)
    pieces += [audio, gap]
    t_cursor += (len(audio) + len(gap)) / sr
    print(f"  第 {i + 1}/{len(sents)} 句（种子 {seed}，{len(audio) / sr:.2f}s，{time.time() - t0:.1f}s）{('：' + note) if note else ''}  {sent}")
if os.path.exists(args.out + ".sent.wav"):
    os.remove(args.out + ".sent.wav")
print(f"  {len(sents)} 句里 {n_cached} 句用了缓存，{len(sents) - n_cached} 句新生成")
full = np.concatenate(pieces)
sf.write(args.out + ".wav", full, sr)

# 整段再回转核对一遍
c_all = cer(syl(clean.lower().translate(DIG)), syl(asr_text(args.out + ".wav")))
json.dump({"source": f"qwen3-tts-1.7b-base clone 按句生成 gap={args.gap}s + qwen3-forcedaligner", "text": args.text, "ref_text": ref_text, "words": words},
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
