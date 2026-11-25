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

没有同音字的读音（散 sàn 只有「散」自己念，更 gèng、少 shǎo、难 nàn、空 kōng 也是；E06 2026-11-25 发现「身上散的热」念成 sǎn 没拦住）：
  - 先放宽「只有一个读音」：拼音库标了几个读音、但词表里 97% 以上的词都念同一个的字也算（插 chā、拆 chāi、神 shén、控 kòng），
    只在严格的同音字一个都没有时才用，已经校准过的字候选不变。
  - 还没有，就几个读音一起把声母换成同一个近音声母（proxies）：散 sǎn / sàn → 惨 / 灿、闪 / 擅。不能一个读音用真同音字、别的用换声母的字：
    换声母的那个白吃声母对不上的亏（试过：念对的「衣服」都判成念错）。
  - 换声母的分差不能直接比（「闪」比「擅」顺得多，「身上[闪]的热」怎么念都高），也不能拿同一组写法配的参照比：参照照写法念，声母对得上，
    分差比真念的大得多（灿 +8～+10，真念 sàn 只有 0～+5），念对的也够不着。所以参照用另一组声母的写法配（每个读音一条），
    声母也对不上、和实测吃一样的亏，看实测落在两条参照之间的哪儿（z，见 _check_proxy），过 Z_OK 算念对。
  - 凑不出两组（省 shěng / xǐng、给 gěi / jǐ、圈 quān / juàn：声母不同；挑 tiāo / tiǎo、晃：只凑得出一组），就是「查不了」：
    lint 单列出来，配音报告（.polyphones.json 的 unchecked）也列，成片单听。不进 readingsReviewed：核了也拦不了，程序听不出来，
    该做的是听（9 集稿子 1188 处多音字：同音字查 874、换声母查 269、查不了 45 处里拼音库标错两处——「悠悠晃着」该念 huàng、
    「开普勒」该念 lè，改对了也还是查不了）。

该念哪个音，拼音库会错（「数一数」标成 shù、「量一下」标成 liàng、「一行一行」标成 xíng、「倒是」标成 dǎo，E08 校准 16 句里错 4 句），
所以只有核过的读音才拿来拦配音：写稿时跑 lint，把这一集每个多音字、拼音库给的读音列出来，制作方一条条核，
改错的写进分镜 narration.readings（{"量一下": "liang2 yi2 xia4"}），核过的「字 读音」全写进 narration.readingsReviewed。
流水线在配音前查：有没核的就停（配音围栏第一道）；配音时每条候选都查核过的多音字，念错就换种子，换满了就把这个字换成同音字再配（第二道；
换声母判的读音没有同音字可换，只换种子）。

用法：
  .venv-mlx/bin/python polyphone_guard.py <配音.wav> <timing.json>   逐句报每个多音字的 margin（不配参照，换声母判的只列分数）
  .venv-mlx/bin/python polyphone_guard.py lint <分镜.beats.json>      列出要核的多音字（没核的非零退出）和查不了的（不影响退出码）
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
    for ch in _gb2312_level1():
        rs = set(pinyin(ch, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True)[0])
        if len(rs) == 1:
            idx.setdefault(rs.pop(), []).append(ch)
    return idx


DOMINANT = 0.97     # 拼音库词表里这个读音占这个字所有词的这么多，就当它只有这一个读音（「插」cha1 23 个词、zha3 0 个）


@functools.lru_cache(None)
def _dominant_index():
    """GB2312 一级字里，拼音库标了几个读音、但词表里几乎只用一个的字（插 chā、拆 chāi、神 shén、控 kòng），按那个读音归类。
    只在严格的同音字一个都没有时才用（homophones），已经校准过的字候选不变。"""
    from pypinyin import Style, pinyin
    idx, counts = {}, _reading_counts()
    for ch in _gb2312_level1():
        rs = set(pinyin(ch, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True)[0])
        n = {r: counts.get((ch, r), 0) for r in rs}
        r, top = max(n.items(), key=lambda kv: kv[1])
        if len(rs) > 1 and top >= MIN_PHRASES and top >= DOMINANT * sum(n.values()):
            idx.setdefault(r, []).append(ch)
    return idx


def _gb2312_level1():
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            if hi == 0xD7 and lo > 0xF9:
                break
            try:
                yield bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue


def homophones(py, avoid="", common=False):
    """只有这一个读音的常用字（严格的一个没有，才用词表里几乎只这么念的字）。
    common：挑词表里词最多的几个（换声母的写法和参照用：「赣」这种生僻的配音和识别都不稳）；默认按 GB2312 的顺序，同音字的候选和校准时一样。"""
    hs = [c for c in _homophone_index().get(py, []) if c not in avoid] or [c for c in _dominant_index().get(py, []) if c not in avoid]
    if common:
        hs = sorted(hs, key=lambda c: -_char_phrases().get(c, 0))
    return hs[:PER_READING]


@functools.lru_cache(None)
def _char_phrases():
    """拼音库词表里每个字出现在多少个词里（当常用程度）。"""
    from pypinyin.phrases_dict import phrases_dict
    c = {}
    for w in phrases_dict:
        for ch in set(w):
            c[ch] = c.get(ch, 0) + 1
    return c


# 没有同音字的读音：几个读音的声母一起换成同一个近音声母，韵母和声调照旧（散：sǎn → 惨 cǎn，sàn → 灿 càn），见文件开头。
INITIALS = ("zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s")
NEAR = {  # 换成哪些声母，近的在前（j q x 后面的 u 是 ü，只在 j q x 里换）
    "s": "c z sh ch zh", "c": "z s ch zh sh", "z": "c s zh ch sh",
    "sh": "ch zh s c z", "ch": "zh sh c z s", "zh": "ch sh z c s", "r": "sh zh ch",
    "g": "k h d t", "k": "g h t d", "h": "g k f",
    "d": "t n l g b", "t": "d n l k p", "n": "l d t m", "l": "n d t",
    "b": "p m d f", "p": "b m t", "m": "b p n f", "f": "h b p",
    "j": "q x", "q": "j x", "x": "j q",
}
PROXY_SETS = 4      # 最多几组换声母的写法（近的声母先用，不够再用远的）。不到 2 组配不了交叉参照，算查不了
# 远的声母（近的凑不够时补）：只当写法，两两交叉配参照，偏差各组互相抵掉。E06 校准：更 只凑得出近的 d（灯 / 瞪）一组，
# 一组配一对参照，「这样更好」念对的 z 0.35、念错的 0.43 分不开；补上 zh、z、sh 四组交叉，念对的 ≥0.49、念错的 ≤0.21
FAR = ("zh", "ch", "sh", "z", "c", "s", "d", "t", "g", "k", "b", "p", "m", "n", "l", "f", "h", "r")
APICAL = ("zh", "ch", "sh", "r", "z", "c", "s")  # 这几个声母后面的 i 是舌尖元音（知 zhī、思 sī），换成别的声母韵母就变了


def split_initial(py):
    for i in INITIALS:
        if py.startswith(i):
            return i, py[len(i):]
    return "", py


def proxies(readings, avoid=""):
    """几个读音一起换声母的写法：[(声母, {读音: [写法]})]。readings[0] 是该念的读音，每组都盖住它和至少一个别的读音
    （换出来的音节互不相同、都有同音字），只留盖得最全的，近的声母在前，最多 PROXY_SETS 组；凑不到 2 组返回 []。"""
    parts = [split_initial(r) for r in readings]
    if not parts[0][0]:
        return []  # 零声母（阿 ā、额 é）没有声母可换
    own = {i for i, _ in parts}
    near = [x for i, _ in parts if i for x in NEAR.get(i, "").split()]
    if own & {"j", "q", "x"}:
        keep = ("j", "q", "x")  # j q x 后面的 u 是 ü，换成别的声母韵母就变了
    elif any(i in APICAL and f == "i" for i, f in parts):
        keep = APICAL
    else:
        keep = tuple(x for x in INITIALS if x not in ("j", "q", "x"))
    got = []
    for sub in dict.fromkeys(x for x in near + list(FAR) + list(keep) if x in keep):
        if sub in own:
            continue  # 换成某个读音自己的声母，那个读音的写法就是真同音字了（调 diào / tiáo 换成 t：跳 / 条），又不公平了
        hs, seen = {}, set()
        for r, (i, f) in zip(readings, parts):
            s = sub + f
            if i and s not in seen and (h := homophones(s, avoid, True) or homophones(s, common=True)):
                hs[r] = h
                seen.add(s)  # 两个读音只差在声母上，换成同一个声母就分不出了：留前一个
        if readings[0] in hs and len(hs) > 1:
            got.append((sub, hs))
    most = max((len(hs) for _, hs in got), default=0)
    sets = [(sub, hs) for sub, hs in got if len(hs) == most][:PROXY_SETS]
    return sets if len(sets) >= 2 else []


def plan(py, others, avoid=""):
    """这个字怎么查：[(怎么来的, {读音: [写法]})]，第一个读音是该念的。查不了返回 []。
    1. 各个读音都有同音字：一组「同音」。
    2. 该念的读音有同音字、别的读音有的有有的没有：没有的那几个读音丢掉不查，剩下的一组「同音」（PR #84 起就这样，校准过）。
    3. 不然几个读音一起换声母（proxies），盖不全的读音丢掉，2～PROXY_SETS 组。"""
    rs = [py] + [r for r in others if r != py]
    same = {r: h for r in rs if (h := homophones(r, avoid) or homophones(r))}
    if py in same and len(same) > 1:
        return [("同音", same)]
    return [(f"换声母 {sub}", hs) for sub, hs in proxies(rs, avoid)]


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


def polyphones(text):
    """这句里的多音字（拼音库里有不止一个常用读音、不在 SKIP 里的）：[(第几个单位, 字, 该念的读音, [别的常用读音])]。"""
    out = []
    for i, (ch, py) in enumerate(units(text)):
        if not py or ch in SKIP or py.endswith("5"):
            continue
        others = [r for r in readings_of(ch) if r != py]
        if others:
            out.append((i, ch, py, others))
    return out


def targets(text):
    """这句里要查的多音字：[(第几个单位, 字, 该念的读音, [查的别的读音])]。"""
    out = []
    for i, ch, py, others in polyphones(text):
        if (p := plan(py, others)):
            out.append((i, ch, py, [r for r in p[0][1] if r != py]))
    return out


def unchecked(text):
    """这句里查不了的读音：[(第几个单位, 字, 该念的读音, [查不了的别的读音])]。整个字查不了的，别的读音全列上；
    查得了一部分的（多数读音有写法、个别凑不出），只列凑不出的那几个。"""
    out = []
    for i, ch, py, others in polyphones(text):
        p = plan(py, others)
        miss = [r for r in others if not p or r not in p[0][1]]
        if miss:
            out.append((i, ch, py, miss))
    return out


def pair(ch, py):
    return f"{ch} {py}"


def apply_readings(readings):
    """分镜 narration.readings（{"量一下": "liang2 yi2 xia4"}）叠进拼音库（和 readings.json 的 phrases 一样，进程里全局生效）。"""
    from pypinyin import load_phrases_dict
    from pypinyin.contrib.tone_convert import to_tone
    if readings:
        load_phrases_dict({w: [[to_tone(p)] for p in (ps.split() if isinstance(ps, str) else ps)] for w, ps in readings.items()})


def lint(script, which=targets):
    """这一集要核的多音字：{「字 读音」: [上下文……]}（按拼音库加上登记的读法注音）。
    which=unchecked：查不了的读音 {「字 读音」: {"miss": [查不了的别的读音], "ctx": [上下文……]}}。"""
    out = {}
    for sent in re.findall(r"[^。？！]+[。？！]?", script):
        us = units(sent)
        for i, ch, py, rest in which(sent):
            ctx = "".join(u[0] for u in us[max(0, i - 2):i + 3])
            if which is targets:
                out.setdefault(pair(ch, py), []).append(ctx)
            else:
                e = out.setdefault(pair(ch, py), {"miss": [], "ctx": []})
                e["miss"] = list(dict.fromkeys(e["miss"] + rest))
                e["ctx"].append(ctx)
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
    """一句配音里每个多音字的判断：[{ch, at, py, heard, margin, ok, ctx, reviewed, ref, z, gap, how}]。
    reviewed：核过的「字 读音」集合（None 表示都算核过）；reference(window_text) → 声音：拿来配参照的函数（None 不配参照）。
    gap：离过线还差多少（≥0 就是过了；同音字按对数概率，换声母按 z），配音挑退路时用。"""
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
        rv = reviewed is None or pair(ch, py) in reviewed
        sets = plan(py, others, avoid=left + right)
        if not sets:
            continue
        base = dict(ch=ch, at=round(ws[i]["start"], 2), py=py, reviewed=rv, ctx=f"{left}[{ch}]{right}", pos=offs[i] if i < len(offs) else None, how=sets[0][0])
        if sets[0][0] != "同音":
            res.append({**base, **_check_proxy(scorer, seg, left, right, py, sets, reference if rv else None)})
            continue
        cands = sets[0][1]
        others = [r for r in cands if r != py]
        margin, best = _margin(scorer, seg, left, right, py, others, cands)
        alt = max(others, key=lambda r: best[r])
        line, ref = OK_MARGIN if reference else MARGIN, None
        ok = margin >= line
        if not ok and reference and rv:
            ref = _ref_margin(scorer, reference, left, right, py, others, cands)
            ok = ref is not None and margin >= ref - REF_SLACK
            line = ref - REF_SLACK if ref is not None else line
        res.append({**base, "heard": py if margin > 0 else alt, "margin": round(margin, 2), "ok": ok, "ref": ref, "z": None, "gap": round(margin - line, 2),
                    "say": cands[py][0], "scores": {r: round(v, 2) for r, v in best.items()}})
    return res


Z_OK = 0.4          # 换声母判的读音：z 过这条线算念对（z：0 像别的读音的参照、1 像该念读音的参照，见 _check_proxy；E06 校准）
MIN_SPREAD = 3.0    # 两条参照自己的分差不到这么多，说明这组写法在这一小段里分不开这两个读音，这一对不算


def _check_proxy(scorer, seg, left, right, py, sets, reference):
    """没有同音字的读音，用换声母的写法（proxies）判。换声母的分差不能直接比：写法的声母和念的对不上，识别模型的偏好又随写法变
    （「身上[闪]的热」比「身上[擅]的热」顺得多，怎么念都是闪高）。所以拿同一个音色配参照，看实测落在参照之间的哪儿：
      - 组 A 的写法打分，参照用另一组 B 的写法配（每个读音一条）：参照的声母和 A 也对不上，和实测吃一样的亏。
        参照用 A 自己的写法配不行：声母对得上，分差大得多（灿 +8～+10，真念 sàn 只有 0～+5），念对的也够不着（E06 校准）。
      - 两两分差 D = A 组该念读音的最高分 − 别的读音 r 的最高分；念 py 的参照 D 是 hi、念 r 的参照 D 是 lo，
        z =（实测 D − lo）/（hi − lo），对每个别的读音取最小，所有（A, B）对平均，过 Z_OK 算念对。
      - 组越多越稳（各组的偏差互相抵掉）：E06 校准 63 条，两组时「有空来玩」念对的 z 只有 0.08～0.37，三四组时全部分开（只漏「空气」念成 kòng 两条）。
    没给 reference（不配参照）就不判（ok=True，z=None）。"""
    flat = [(n, r, h) for n, hs in sets for r, cs in hs.items() for h in cs]
    sc = scorer.logps(seg, [left + h + right for _, _, h in flat])
    best = {}
    for (n, r, _), v in zip(flat, sc):
        b = best.setdefault(n, {})
        b[r] = max(b.get(r, -1e9), v)
    raw = [b[py] - max(v for r, v in b.items() if r != py) for b in best.values()]
    zs, rivals = [], {}
    for n, hs in sets if reference else []:
        for m, ks in sets:
            if m == n or not set(hs) <= set(ks):
                continue
            refs = {r: _ref_best(scorer, reference, left, right, hs, ks[r][0]) for r in hs}
            zr = {}
            for r in hs:
                if r == py or refs[py] is None or refs[r] is None:
                    continue
                hi, lo = refs[py][py] - refs[py][r], refs[r][py] - refs[r][r]
                if hi - lo >= MIN_SPREAD:
                    zr[r] = (best[n][py] - best[n][r] - lo) / (hi - lo)
            if zr:
                r = min(zr, key=zr.get)
                zs.append(zr[r])
                rivals[r] = rivals.get(r, 0) + 1
    z = sum(zs) / len(zs) if zs else None
    alt = max(rivals, key=rivals.get) if rivals else max((r for r in sets[0][1] if r != py), key=lambda r: best[sets[0][0]][r])
    return dict(heard=py if z is None or z >= Z_OK else alt, margin=round(sum(raw) / len(raw), 2), ok=z is None or z >= Z_OK, ref=None,
                z=None if z is None else round(z, 2), gap=0.0 if z is None else round(z - Z_OK, 2), say=None,
                scores={n: {r: round(v, 2) for r, v in b.items()} for n, b in best.items()})


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


_REF_AUDIO = {}


def _ref_best(scorer, reference, left, right, cands, say):
    """换声母的参照：这一小段照写法 say 配一遍（按文字缓存声音），拿一组写法 cands（{读音: [写法]}）打分，每个读音取最高。"""
    text = left + say + right
    key = (text, tuple((r, tuple(cs)) for r, cs in cands.items()))
    if key not in _REF:
        if text not in _REF_AUDIO:
            got = reference(text)
            seg = _crop16(got[0], got[1], 0, len(got[0]) / got[1]) if got is not None else None
            _REF_AUDIO[text] = seg if seg is not None and len(seg) >= 1600 else None
        seg, best = _REF_AUDIO[text], None
        if seg is not None:
            flat = [(r, h) for r, hs in cands.items() for h in hs]
            best = {}
            for (r, _), v in zip(flat, scorer.logps(seg, [left + h + right for _, h in flat])):
                best[r] = max(best.get(r, -1e9), v)
        _REF[key] = best
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
        blind = lint(nar.get("script", ""), unchecked)
        if blind:
            print(f"查不了的 {len(blind)} 种（念成后面这个读音时程序听不出来，配音时不拦：成片单听这几处，或者换个说法；不用写进 readingsReviewed）：")
            for k, v in blind.items():
                print(f"  ? {k}，念成 {'、'.join(v['miss'])} 查不出：{' / '.join(dict.fromkeys(v['ctx']))[:80]}")
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
        for r in check_sentence(sc, x, sr, s["text"], ws):  # 不配参照：换声母判的读音只列分数，不判
            judged = r["how"] == "同音"
            print(f"{'  ' if r['ok'] or not judged else '✗ '}{r['at']:8.2f} {r['ctx']}  该念 {r['py']}  margin {r['margin']:+.2f}" + ("" if judged else f"（{r['how']}，要配参照才判）") + f"  {r['scores']}")
