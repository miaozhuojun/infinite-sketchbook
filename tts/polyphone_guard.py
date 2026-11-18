"""多音字念对没有（配音围栏的一环）：每个多音字，用回转识别模型强制解码给几种读音的同音字写法打分，看这段声音最像念成了哪个读音。

为什么要它：回转识别按意思写字，「调光灯」念成 diào 也照样写回「调光灯」，拼音比对查不出来；声调检查（tone_check.py）
只看基频走势，准确度约七成，只给建议（用户 2026-11-19 听 E08 样片 v1：「1:29 的调光灯的调多音字读音不对」，程序一项都没报）。

怎么判：
  1. 该念哪个音：pypinyin 按词注音（不带变调），叠上 readings.json 登记的读法；这个字在拼音库里有几种读音（去掉轻声），就是几个候选。
  2. 每个读音挑几个只有这一个读音的常用字（GB2312 一级字）当它的写法：tiáo →「条」，diào →「吊、钓、掉」。
  3. 取这个字前后各两个字的那一小段声音，让识别模型在「左边 + 写法 + 右边」几种写法里打分（强制解码的对数概率，每个读音取写法里最高的）。
     左右两边照原文，所以语言模型的偏好对各个候选差不多；写法都是生造的（「都是条光灯」「都是吊光灯」），声音像谁谁就高。
  4. 该念的读音比最像的别的读音低（margin < 0），就是念错了；高得不多（margin < MARGIN），说明念得含糊、不像任何一个，也算没念对。
     拿同一个音色故意念成各个读音（把原字换成同音字配出来）验证：念对的 margin 在 7 上下，念错的为负。
  5. 念得含糊（margin 不到 OK_MARGIN）时，拿同一个音色把这一小段照该念的读音（换成同音字）配一遍当参照，参照自己的 margin 是多少，
     这一条就该到多少（差不过 REF_SLACK 算念对）：有的词识别模型本来就分不清（「重新」念对了 margin 也是 −1.7），参照把这类偏差扣掉。

该念哪个音，拼音库会错（「数一数」标成 shù、「量一下」标成 liàng、「一行一行」标成 xíng、「倒是」标成 dǎo，E08 校准 16 句里错 4 句），
所以只有核过的读音才拿来拦配音：写稿时跑 lint，把这一集每个多音字、拼音库给的读音列出来，制作方一条条核，
改错的写进分镜 narration.readings（{"量一下": "liang2 yi2 xia4"}），核过的「字 读音」全写进 narration.readingsReviewed。
流水线在配音前查：有没核的就停（配音围栏第一道）；配音时每条候选都查核过的多音字，念错就换种子，换满了就把这个字换成同音字再配（第二道）。

用法：
  .venv-mlx/bin/python polyphone_guard.py <配音.wav> <timing.json>   逐句报每个多音字的 margin
  .venv-mlx/bin/python polyphone_guard.py lint <分镜.beats.json>      列出要核的多音字（没核的非零退出）
"""
import functools
import json
import re
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np

HERE = Path(__file__).parent
# 不判的字：轻声助词、一和不的变调、语气词；还有读音靠上下文都对、分不出来的常用虚词
SKIP = set("的了着地得一不个们子么呢吗吧啊呀哦嘛啦哪那这么还和为都只")
WINDOW = 2          # 左右各取几个字的声音和原文
PER_READING = 3     # 每个读音最多几个同音写法
MARGIN = 2.0        # 该念的读音至少要比别的读音高这么多（对数概率）才算念清楚了（不带参照时）
OK_MARGIN = 3.0     # 高过这么多就不用配参照
REF_SLACK = 2.5     # 比参照低不过这么多算念对（E08 校准：念对的和参照差 0–1，念错的差 6 以上）


@functools.lru_cache(None)
def _homophone_index():
    """GB2312 一级常用字里，拼音库认为只有一个读音的字，按读音（TONE3）归类。"""
    from pypinyin import Style, pinyin
    idx = {}
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            if hi == 0xD7 and lo > 0xF9:
                break
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            rs = set(pinyin(ch, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True)[0])
            if len(rs) == 1:
                idx.setdefault(rs.pop(), []).append(ch)
    return idx


def homophones(py, avoid=""):
    return [c for c in _homophone_index().get(py, []) if c not in avoid][:PER_READING]


MIN_PHRASES = 5     # 一个读音在拼音库的词表里至少出现在这么多个词里，才算常用读音（「是」的 tí、「亮」的 liáng 这类不算候选）


@functools.lru_cache(None)
def _reading_counts():
    """拼音库词表里，每个字的每个读音出现在多少个词里（TONE3）。"""
    from pypinyin.contrib.tone_convert import to_tone3
    from pypinyin.phrases_dict import phrases_dict
    c = {}
    for w, pys in phrases_dict.items():
        for ch, p in zip(w, pys):
            k = (ch, to_tone3(p[0], neutral_tone_with_five=True))
            c[k] = c.get(k, 0) + 1
    return c


def readings_of(ch):
    """这个字的常用读音（去掉轻声和几乎不用的读音）。"""
    from pypinyin import Style, pinyin
    rs = [r for r in pinyin(ch, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True)[0] if not r.endswith("5")]
    return [r for r in dict.fromkeys(rs) if _reading_counts().get((ch, r), 0) >= MIN_PHRASES]


def units(text):
    """一句拆成和逐字时间一样的单位（汉字一个一个，连着的数字、字母各算一段），汉字配上按词注的音（不带变调）。"""
    from pypinyin import Style, lazy_pinyin
    out = []
    for seg in re.split(r"[，。？！、：；,.?!:;\s]+", text):
        toks = re.findall(r"[一-鿿]|\d+|[A-Za-z]+", seg)
        cjk = "".join(t for t in toks if re.fullmatch(r"[一-鿿]", t))
        py = iter(lazy_pinyin(cjk, style=Style.TONE3, neutral_tone_with_five=True))
        out += [(t, next(py) if re.fullmatch(r"[一-鿿]", t) else None) for t in toks]
    return out


def unit_offsets(text):
    """每个单位在原文里的位置（和 units 一一对应：标点不算单位）。"""
    return [m.start() for m in re.finditer(r"[一-鿿]|\d+|[A-Za-z]+", text)]


def targets(text):
    """这句里要查的多音字：[(第几个单位, 字, 该念的读音, [别的读音])]。"""
    out = []
    for i, (ch, py) in enumerate(units(text)):
        if not py or ch in SKIP or py.endswith("5"):
            continue
        rs = readings_of(ch)
        others = [r for r in rs if r != py and homophones(r)]
        if not others or not homophones(py):
            continue
        out.append((i, ch, py, others))
    return out


def pair(ch, py):
    return f"{ch} {py}"


def apply_readings(readings):
    """分镜 narration.readings（{"量一下": "liang2 yi2 xia4"}）叠进拼音库（和 readings.json 的 phrases 一样，进程里全局生效）。"""
    from pypinyin import load_phrases_dict
    from pypinyin.contrib.tone_convert import to_tone
    if readings:
        load_phrases_dict({w: [[to_tone(p)] for p in (ps.split() if isinstance(ps, str) else ps)] for w, ps in readings.items()})


def lint(script):
    """这一集要核的多音字：{「字 读音」: [上下文……]}（按拼音库加上登记的读法注音）。"""
    out = {}
    for sent in re.findall(r"[^。？！]+[。？！]?", script):
        us = units(sent)
        for i, ch, py, _ in targets(sent):
            out.setdefault(pair(ch, py), []).append("".join(u[0] for u in us[max(0, i - 2):i + 3]))
    return out


def align_units(text, words):
    """把这句的单位和逐字时间一个个对上（连着的数字在逐字时间里可能并成一段）；对不上返回 None。"""
    us, got, k = units(text), [], 0
    i = 0
    while i < len(us):
        if k >= len(words):
            return None
        w, j, acc = words[k]["text"], i, ""
        while j < len(us) and len(acc) < len(w):
            acc += us[j][0]; j += 1
        if acc != w:
            return None
        got += [words[k]] * (j - i)
        i, k = j, k + 1
    return us, got


class Scorer:
    def __init__(self, asr):
        self.m = asr

    def logps(self, audio16, texts):
        """一段 16k 声音，几种写法各自的强制解码对数概率（音频只编码一次）。"""
        m = self.m
        feats, mask, n = m._preprocess_audio(audio16)
        ids = m._build_prompt(n, "Chinese")
        af = m.get_audio_features(feats, mask)
        base = m._build_inputs_embeds(ids, af)
        L = ids.shape[1]
        out = []
        for t in texts:
            cand = m._tokenizer.encode(t)
            emb = mx.concatenate([base, m.model.embed_tokens(mx.array([cand]))], axis=1)
            lg = m._forward_with_embeds(emb)[0].astype(mx.float32)  # 原来 bf16：对数概率只有 0.125 一档，几个候选常打成平手
            lp = lg - mx.logsumexp(lg, axis=-1, keepdims=True)
            out.append(sum(float(lp[L - 1 + k, tok]) for k, tok in enumerate(cand)))
        return out


def _crop16(x, sr, t0, t1):
    from scipy.signal import resample_poly
    a = x[int(max(0.0, t0) * sr):int(t1 * sr)]
    return (resample_poly(a, 16000, sr) if sr != 16000 else a).astype(np.float32)


def check_sentence(scorer, x, sr, text, words, offset=0.0, reviewed=None, reference=None):
    """一句配音里每个多音字的判断：[{ch, at, py, heard, margin, ok, ctx, reviewed, ref}]。
    reviewed：核过的「字 读音」集合（None 表示都算核过）；reference(window_text) → 声音：拿来配参照的函数（None 不配参照）。"""
    al = align_units(text, words)
    if not al:
        return [dict(ch="", unaligned=True, ok=True, reviewed=False)] if targets(text) else []  # 对不上逐字时间：这句没查，记一条
    us, ws = al
    offs = unit_offsets(text)
    res = []
    for i, ch, py, others in targets(text):
        a, b = max(0, i - WINDOW), min(len(us) - 1, i + WINDOW)
        left = "".join(u[0] for u in us[a:i]); right = "".join(u[0] for u in us[i + 1:b + 1])
        seg = _crop16(x, sr, ws[a]["start"] - offset - 0.05, ws[b]["end"] - offset + 0.05)
        if len(seg) < 1600:
            continue
        cands = {r: homophones(r, avoid=left + right) or homophones(r) for r in [py] + others}
        margin, best = _margin(scorer, seg, left, right, py, others, cands)
        alt = max(others, key=lambda r: best[r])
        rv = reviewed is None or pair(ch, py) in reviewed
        ok, ref = margin >= (OK_MARGIN if reference else MARGIN), None
        if not ok and reference and rv:
            ref = _ref_margin(scorer, reference, left, right, py, others, cands)
            ok = ref is not None and margin >= ref - REF_SLACK
        res.append(dict(ch=ch, at=round(ws[i]["start"], 2), py=py, heard=py if margin > 0 else alt, margin=round(margin, 2), ok=ok, ref=ref,
                        reviewed=rv, ctx=f"{left}[{ch}]{right}", say=cands[py][0], pos=offs[i] if i < len(offs) else None, scores={r: round(v, 2) for r, v in best.items()}))
    return res


def _margin(scorer, seg, left, right, py, others, cands):
    flat = [(r, h) for r, hs in cands.items() for h in hs]
    sc = scorer.logps(seg, [left + h + right for _, h in flat])
    best = {}
    for (r, _), s in zip(flat, sc):
        best[r] = max(best.get(r, -1e9), s)
    return best[py] - max(best[r] for r in others), best


_REF = {}


def _ref_margin(scorer, reference, left, right, py, others, cands):
    """参照：这一小段把多音字换成该念读音的同音字，用同一个音色配一遍，算它自己的 margin（按窗口文字缓存）。"""
    key = (left, py, right)
    if key not in _REF:
        hom = cands[py][0]
        got = reference(left + hom + right)
        if got is None:
            _REF[key] = None
        else:
            a, sr_ = got
            seg = _crop16(a, sr_, 0, len(a) / sr_)
            _REF[key] = round(_margin(scorer, seg, left, right, py, others, cands)[0], 2) if len(seg) >= 1600 else None
    return _REF[key]


def load_scorer(asr=None):
    if asr is None:
        from mlx_audio.stt import load as load_stt
        asr = load_stt(str(HERE / "models/Qwen3-ASR-0.6B"))
    return Scorer(asr)


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    from tone_check import load_readings
    load_readings(HERE / "readings.json")
    if sys.argv[1] == "lint":
        beats = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        nar = beats.get("narration") or {}
        apply_readings(nar.get("readings"))
        found, done = lint(nar.get("script", "")), set(nar.get("readingsReviewed") or [])
        todo = {k: v for k, v in found.items() if k not in done}
        stale = sorted(done - set(found))
        for k, v in found.items():
            print(f"{'  ' if k in done else '✗ '}{k}：{' / '.join(dict.fromkeys(v))[:80]}")
        if stale:
            print("核过但稿子里已经没有的（可以删）：" + "、".join(stale))
        print(f"多音字 {len(found)} 种读法，没核的 {len(todo)} 种" + ("：读音对的把「字 读音」写进 narration.readingsReviewed；读音错的先在 narration.readings 写对（如 {\"量一下\": \"liang2 yi2 xia4\"}），再把改好的写进 readingsReviewed" if todo else ""))
        sys.exit(1 if todo else 0)
    import soundfile as sf
    wav, tj = sys.argv[1:3]
    x, sr = sf.read(wav, dtype="float64")
    x = x.mean(1) if x.ndim > 1 else x
    tm = json.loads(Path(tj).read_text())
    sc = load_scorer()
    words = tm["words"]
    for s in tm.get("sentences") or [{"text": tm["text"], "start": 0, "end": 1e9}]:
        ws = [w for w in words if w["start"] >= s["start"] - 0.02 and w["end"] <= s["end"] + 0.02]
        for r in check_sentence(sc, x, sr, s["text"], ws):
            print(f"{'  ' if r['ok'] else '✗ '}{r['at']:8.2f} {r['ctx']}  该念 {r['py']}  margin {r['margin']:+.2f}  {r['scores']}")
