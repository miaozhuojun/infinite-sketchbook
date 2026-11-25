"""逐句回转（旁白检查 speech_check.py 的一项，关卡 speech.lineAsr）：按时间线 audioClips 把每段旁白单独切出来，干声（源配音）和总混各识别一遍，
和这一段的旁白稿按拼音比，一个音节都不许差。

「总混可懂度」把整片按 30 秒一块识别、拼音错误率 2% 以内放行：e01-benchmark 707 个字错 1 个是 0.1%，过了，可错的是全片的关键词
（「卷子」的「卷」听成「阵」）；句首的「写」字头弱，干声对、垫上背景乐的总混里听成「野」，整段比也看不出来。

比法和配音时逐句回转同一个口径：said_text（数字按念法、去标点）、pinyin_syllables（同音字算一致、前后鼻音不分；识别那一边用 heard_syllables，
写出来的多音字任一读音和稿子对上就算），另外
  - 拉丁字母词（AI）不比：识别有时写 AI，有时写别的；
  - 「两」当「二」：稿子写「两千五百」「2格」，识别写「2500」「两格」，按念法换回汉字后一边是「二」一边是「两」。
稿子按 timing 的逐字（words）拼：片段的 phrase 是分镜里的短语，通常不写标点，「1、1、0」写成 110 会念成「一百一十」；逐字里它们是三个字。
每个音节对得回是哪个字、哪一句（timing 的 sentences），有出入的句子写进 revoice.json，流水线换种子重配。
不依赖 mlx：识别由调用方传进来（hear），自测用桩。
"""
import re

from voice import heard_syllables, said_text, pinyin_syllables

STRIP = re.compile(r"[\s，。；：！？、,.;:!?\"“”'‘’（）()—-]")  # 和 compiler/validate.mjs 的 strip 一样：片段 phrase 就是这样去的标点
LATIN = re.compile(r"[a-z]+")


def heard(s):
    """念出来的字：said_text 之后去掉拉丁字母词、「两」换成「二」。每个字一个音节（pinyin_syllables 一字一个）"""
    return LATIN.sub("", said_text(s)).replace("两", "二")


def align(r, h):
    """r、h 两串音节的编辑距离和对齐：[(op, i, j)]，op 是 =（一样）、x（念成了别的）、-（稿子第 i 个没听到）、+（多听到 h 的第 j 个）"""
    n, m = len(r), len(h)
    D = [[i + j if not (i and j) else 0 for j in range(m + 1)] for i in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i][j] = min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    ops, i, j = [], n, m
    while i or j:
        if i and j and D[i][j] == D[i - 1][j - 1] + (r[i - 1] != h[j - 1]):
            ops.append(("=" if r[i - 1] == h[j - 1] else "x", i - 1, j - 1)); i -= 1; j -= 1
        elif i and D[i][j] == D[i - 1][j] + 1:
            ops.append(("-", i - 1, j)); i -= 1
        else:
            ops.append(("+", i, j - 1)); j -= 1
    return D[n][m], ops[::-1]


def diff_text(rs, hs, ops):
    """有出入的地方，连着的并成一处：「卷→阵」「漏了『的』」「多了『嗯』」"""
    out, run = [], []
    for op in ops + [("=", None, None)]:
        if op[0] != "=":
            run.append(op); continue
        if run:
            a = "".join(rs[i] for o, i, _ in run if o != "+"); b = "".join(hs[j] for o, _, j in run if o != "-")
            out.append(f"{a}→{b}" if a and b else f"漏了「{a}」" if a else f"多了「{b}」")
            run = []
    return out


def clip_refs(clips, words):
    """每个片段的稿子：[(字串, 每个字属于第几个 word)]，找不到的片段给 None（按片段 phrase 比）。
    和 compiler/compile.mjs 一样，在去标点的逐字全文里按顺序找片段的 phrase；一个 word 整个落在片段里就按 word 换念法（「50」是五十），
    被片段切开的 word 只取片段里那几个字"""
    chars = [(c, wi) for wi, w in enumerate(words) for c in STRIP.sub("", w["text"])]
    full = "".join(c for c, _ in chars)
    out, cur = [], 0
    for c in clips:
        t = STRIP.sub("", c["phrase"])
        i = full.find(t, cur) if t else -1
        if i < 0:
            out.append(None); continue
        cur = i + len(t)
        span = chars[i:i + len(t)]
        s, owner = "", []
        for wi in dict.fromkeys(wi for _, wi in span):
            whole = STRIP.sub("", words[wi]["text"])
            part = "".join(ch for ch, w2 in span if w2 == wi)
            piece = heard(words[wi]["text"] if part == whole else part)
            s += piece; owner += [wi] * len(piece)
        out.append((s, owner))
    return out


def word_sentence(words, sentences):
    """每个 word 属于第几句：字的中点落在哪一句（源配音上的时间）里，落在句与句之间就取最近的一句；没有 sentences 时都是 None"""
    out = []
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        k = next((k for k, s in enumerate(sentences) if s["start"] <= mid < s["end"]), None)
        if k is None and sentences:
            k = min(range(len(sentences)), key=lambda k: min(abs(mid - sentences[k]["start"]), abs(mid - sentences[k]["end"])))
        out.append(k)
    return out


def check_lines(clips, timing, dry_clip, mix_clip, hear, min_chars=3):
    """逐段比。dry_clip(第几段, 片段)、mix_clip(第几段, 片段) 给出这一段的 (音频, 采样率)，mix_clip 是 None 时不查总混；hear(音频, 采样率) 返回识别出的字。
    返回 {"checked", "skipped", "bad": [{clip, ref, dry, mix, dryDiff, mixDiff, mixOnly, atStart, ks}]}"""
    words, sents = timing.get("words", []), timing.get("sentences") or []
    refs = clip_refs(clips, words)
    w2s = word_sentence(words, sents)
    res = {"checked": 0, "skipped": 0, "bad": []}
    for ci, (c, rf) in enumerate(zip(clips, refs)):
        rs, owner = rf if rf else (heard(c["phrase"]), None)
        if len(rs) < min_chars:
            res["skipped"] += 1; continue
        res["checked"] += 1
        r = pinyin_syllables(rs)
        got = {}
        for name, cut in (("dry", dry_clip), ("mix", mix_clip)):
            if cut is None:
                continue
            text = hear(*cut(ci, c))
            hs = heard(text)
            d, ops = align(r, heard_syllables(hs))
            got[name] = (text, hs, d, ops)
        if not any(g[2] for g in got.values()):
            continue
        # 有出入的音节落在哪几句：念错、没听到的是稿子上那个字；多听到的算在它前面那个字（在开头就算后面那个）
        ks, at_start = set(), False
        for text, hs, d, ops in got.values():
            for op, i, j in ops:
                if op == "=":
                    continue
                ri = i if op != "+" else max(0, min(i - 1, len(rs) - 1)) if i else 0
                at_start |= ri == 0
                if owner and ri < len(owner) and w2s[owner[ri]] is not None:
                    ks.add(w2s[owner[ri]])
        if not ks and sents:  # 对不回逐字（旧时间线、片段找不到）：按片段在源配音上的时间，和它重叠的句子都算
            ks = {k for k, s in enumerate(sents) if s["start"] < c["srcOut"] and s["end"] > c["srcIn"]}
        dry, mix = got.get("dry"), got.get("mix")
        res["bad"].append({
            "clip": ci, "at": c["at"], "phrase": c["phrase"], "ref": rs,
            "dry": dry[0] if dry else None, "mix": mix[0] if mix else None,
            "dryDiff": diff_text(rs, dry[1], dry[3]) if dry and dry[2] else [],
            "mixDiff": diff_text(rs, mix[1], mix[3]) if mix and mix[2] else [],
            "mixOnly": bool(dry and not dry[2] and mix and mix[2]),
            "atStart": at_start, "ks": sorted(ks),
        })
    return res
