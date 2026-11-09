"""声调检查（建议，不判失败）：每个字的基频走势，和这个字按上下文该念的声调比。

为什么要它：回转识别按上下文写字，「拧（nǐng）旋钮」念成 níng 也照样写回「拧」，拼音比对查不出声调错（用户听 E03 样片：前半段有读错的）。
做法：
  1. 该念第几声：pypinyin 按词和上下文注音（带变调：一、不、三声连读），再叠上 readings.json 里登记的读法（拼音库标错的，比如「拧旋钮」的拧是 nǐng，库里是 níng）。
  2. 实际念的：逐字时间（配音对齐的 timing.json）切出每个字，量基频（voice.f0_track），换成相对这句中位音高的半音，取五个时段的走势、斜率和平均高低。
  3. 每个说话人用自己这一集的字当训练样本（一集绝大多数字念得对），按声调各求一个中心，协方差合用（线性判别）；
     每个字看「最像的声调」比「该念的声调」像多少（对数似然差，margin）。
  4. 报两类：
     - 整个字一直念错（systematic）：同一个字出现 ≥3 次，过半最像别的同一个声调、margin 中位 ≥1.5。这类最值得改（多音字按库里的读法念、整集都错）；
     - 单个字特别离谱（margin ≥ 6，约是这一集最离谱的 1% 以内）：列出时刻，单听确认。
不判：一、不（变调随后字）、轻声、句末的字（句末三声念全、问句上扬，走势不代表本调）、浊音不到 40ms 的字。
准确度有限：语流里的声调靠走势分，这一集上整体约六成五对（随机是两成五），二声、三声最容易混。所以只给建议，单听确认后改写或登记读法。

用法：.venv-mlx/bin/python tone_check.py <配音.wav> <timing.json> [--readings readings.json] [--json 输出.json]
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SKIP_CHARS = set("一不")
MIN_VOICED = 8  # 5ms 一帧：至少 40ms 浊音
SYSTEMATIC = dict(min_n=3, share=0.5, margin=1.5)
SINGLE_MARGIN = 6.0
TONES = (1, 2, 3, 4)


def _to_mark(t3):
    from pypinyin.contrib.tone_convert import to_tone
    return to_tone(t3)


def load_readings(path):
    """注意：load_single_dict / load_phrases_dict 改的是整个进程共用的拼音库，同一进程里后面的拼音比对（speech_check 的可懂度）也按登记的读法注音。
    readings.json：{"chars": {"拧": "ning3"}, "phrases": {"还得": ["hai2", "dei3"]}}；拼音库标错的读法登记在这里。"""
    from pypinyin import load_phrases_dict, load_single_dict
    if not path or not Path(path).exists():
        return {}
    r = json.loads(Path(path).read_text(encoding="utf-8"))
    if r.get("chars"):
        load_single_dict({ord(c): _to_mark(p) for c, p in r["chars"].items()})
    if r.get("phrases"):
        load_phrases_dict({w: [[_to_mark(p)] for p in ps] for w, ps in r["phrases"].items()})
    return r


DIGIT_PY = {"0": "ling2", "2": "er4", "3": "san1", "4": "si4", "5": "wu3", "6": "liu4", "7": "qi1", "8": "ba1", "9": "jiu3"}  # 单念的数字；1 念 yī 还是 yāo、变不变调说不准，不判


def units(text):
    """一句拆成和逐字时间同样的单位：汉字一个一个，连着的数字、字母各算一段。每个单位配上该念的拼音（汉字按上下文注音，单个数字按数字的念法；别的记 None 不判）。
    三声连读：pypinyin 只在词里变调，跨词的「管拧（guǎn nǐng → guán）」也要变，按标点断开的每一段里，连着两个三声前一个变二声；连着三个以上的三声怎么变看停顿，整串不判。"""
    from pypinyin import Style, lazy_pinyin
    out = []
    for seg in re.split(r"[，。？！、：；,.?!:;\s]+", text):
        toks = re.findall(r"[一-鿿]|\d+|[A-Za-z]+", seg)
        cjk = "".join(t for t in toks if re.fullmatch(r"[一-鿿]", t))
        py = iter(lazy_pinyin(cjk, style=Style.TONE3, neutral_tone_with_five=True, tone_sandhi=True))
        row = [(t, next(py) if re.fullmatch(r"[一-鿿]", t) else DIGIT_PY.get(t)) for t in toks]
        i = 0
        while i < len(row):
            j = i
            while j < len(row) and row[j][1] and row[j][1].endswith("3"):
                j += 1
            if j - i == 2:
                row[i] = (row[i][0], row[i][1][:-1] + "2")
            elif j - i > 2:
                for k in range(i, j - 1):
                    row[k] = (row[k][0], None)
            i = max(j, i + 1)
        out += row
    return out


def syllables(x, sr, timing):
    """逐字量走势：[{sp, ch, py, tone, f, t, last, ctx, sent}]。"""
    sys.path.insert(0, str(HERE))
    from voice import f0_track
    tr = np.array(f0_track(x, sr, hop=0.005))
    if not len(tr):
        return []
    T, F = tr[:, 0], tr[:, 1]
    words = timing["words"]
    out, k = [], 0
    for si, s in enumerate(timing.get("sentences") or []):
        us = units(s["text"])
        # 逐字时间按顺序对上这句的单位；对齐时把连着的数字并成一段的（「2、3、3，0」记成一个 2330），把几个单位并起来对
        got, i, bad = [], 0, False
        while i < len(us) and k < len(words):
            w = words[k]["text"]
            j, acc = i, ""
            while j < len(us) and len(acc) < len(w):
                acc += us[j][0]; j += 1
            if acc != w:
                bad = True; break
            got.append((words[k], us[i] if j == i + 1 else (w, None)))
            i, k = j, k + 1
        if bad or i < len(us):
            while k < len(words) and words[k]["start"] < s["end"] - 0.02:
                k += 1  # 对不齐的句子不判（宁可漏，不乱报），跳到下一句
            continue
        sel = (T >= s["start"]) & (T < s["end"]) & (F > 0)
        if sel.sum() < 20:
            continue
        med = np.median(F[sel])
        chars = "".join(u[0] for _, u in got)
        pos = 0
        for n, (w, (ch, p)) in enumerate(got):
            pos += len(ch)
            if not p:
                continue
            f = F[(T >= w["start"]) & (T < w["end"]) & (F > 0)]
            if len(f) < MIN_VOICED:
                continue
            st = 12 * np.log2(f / med)
            c = [float(np.median(seg)) for seg in np.array_split(st, 5)]
            slope = float(np.polyfit(np.linspace(0, 1, len(st)), st, 1)[0])
            out.append(dict(sp=s.get("speaker", ""), ch=ch, py=p, tone=int(p[-1]) if p[-1].isdigit() else 5, f=c + [slope, float(st.mean())],
                            t=round(w["start"], 2), last=n == len(got) - 1, ctx=chars[max(0, pos - 4):pos + 3], sent=si))
    return out


def judgeable(r):
    return r["tone"] in TONES and not r["last"] and r["ch"] not in SKIP_CHARS


def classify(rows):
    """每个说话人各求声调中心，协方差合用；给每个可判的字填 best、margin（最像的声调比该念的像多少）。"""
    J = [r for r in rows if judgeable(r)]
    if not J:
        return rows
    X = np.array([r["f"] for r in J])
    mus, resid = {}, []
    for sp in {r["sp"] for r in J}:
        for t in TONES:
            m = np.array([r["sp"] == sp and r["tone"] == t for r in J])
            if m.sum() >= 5:
                mus[(sp, t)] = X[m].mean(0)
                resid.append(X[m] - mus[(sp, t)])
    if not resid:
        return rows
    R = np.concatenate(resid)
    Si = np.linalg.inv(np.cov(R.T) + 1e-3 * np.eye(X.shape[1]))
    for r in J:
        v = np.array(r["f"])
        sc = {t: -0.5 * (v - mus[(r["sp"], t)]) @ Si @ (v - mus[(r["sp"], t)]) for t in TONES if (r["sp"], t) in mus}
        if r["tone"] not in sc:
            continue
        best = max(sc, key=sc.get)
        r["best"], r["margin"] = best, float(sc[best] - sc[r["tone"]])
    return rows


def report(rows):
    J = [r for r in rows if "margin" in r]
    acc = float(np.mean([r["best"] == r["tone"] for r in J])) if J else 0.0
    by = {}
    for r in J:
        by.setdefault((r["sp"], r["ch"], r["tone"]), []).append(r)
    systematic = []
    for (sp, ch, tone), rs in by.items():
        if len(rs) < SYSTEMATIC["min_n"]:
            continue
        others = [r["best"] for r in rs if r["best"] != tone]
        if not others:
            continue
        as_tone = max(set(others), key=others.count)
        share = others.count(as_tone) / len(rs)
        med = float(np.median([r["margin"] for r in rs]))
        if share >= SYSTEMATIC["share"] and med >= SYSTEMATIC["margin"]:
            systematic.append(dict(sp=sp, ch=ch, py=rs[0]["py"], tone=tone, heard=as_tone, n=len(rs), share=round(share, 2), margin=round(med, 1),
                                   at=[r["t"] for r in rs if r["best"] == as_tone][:6], ctx=rs[0]["ctx"]))
    single = sorted((r for r in J if r["margin"] >= SINGLE_MARGIN), key=lambda r: -r["margin"])
    chars = {f"{sp}|{ch}|{t}": dict(n=len(rs), agree=round(float(np.mean([r["best"] == t for r in rs])), 2)) for (sp, ch, t), rs in by.items()}
    return dict(judged=len(J), accuracy=round(acc, 3), systematic=sorted(systematic, key=lambda s: -s["n"] * s["share"]),
                single=[dict(sp=r["sp"], ch=r["ch"], py=r["py"], heard=r["best"], margin=round(r["margin"], 1), t=r["t"], ctx=r["ctx"]) for r in single],
                chars=chars)


def check(x, sr, timing, readings=None, label=lambda sp: ""):
    """返回 (报告, 打印用的几行)。speech_check.py 和命令行共用。"""
    load_readings(readings)
    rep = report(classify(syllables(x, sr, timing)))
    lines = []
    ok = not rep["systematic"] and not rep["single"]
    if not rep["judged"]:
        return rep, ["[建议] 声调：一个字都没判（逐字时间里没有句子，或句子都对不上），没查"]
    head = f"[{'通过' if ok else '建议'}] 声调：判了 {rep['judged']} 个字，走势和该念的声调一致约 {rep['accuracy']:.0%}（语流里分声调本来就粗，二三声最易混，只报明显的）"
    lines.append(head)
    for s in rep["systematic"]:
        lines.append(f"  整集一直念得不像{s['tone']}声{label(s['sp'])}：「{s['ch']}」（该念 {s['py']}）{s['n']} 次里 {s['share']:.0%} 最像 {s['heard']} 声，"
                     f"如「{s['ctx']}」{', '.join(f'{t:.1f}s' for t in s['at'][:4])}。单听确认；念错就改写说法，或登记读法 readings.json 后换写法")
    for s in rep["single"][:8]:
        lines.append(f"  {s['t']:.1f}s{label(s['sp'])}「{s['ctx']}」的「{s['ch']}」（该念 {s['py']}）最像 {s['heard']} 声（差 {s['margin']}），单听确认")
    return rep, lines


if __name__ == "__main__":
    import argparse
    import soundfile as sf
    ap = argparse.ArgumentParser()
    ap.add_argument("audio"); ap.add_argument("timing")
    ap.add_argument("--readings", default=str(HERE / "readings.json"))
    ap.add_argument("--json")
    a = ap.parse_args()
    x, sr = sf.read(a.audio, dtype="float32")
    x = x.mean(1) if x.ndim > 1 else x
    rep, lines = check(x, sr, json.loads(Path(a.timing).read_text(encoding="utf-8")), a.readings, lambda sp: f"（{sp}）" if sp else "")
    print("\n".join(lines))
    if a.json:
        Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
