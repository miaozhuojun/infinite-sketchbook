"""对话：几个人各自配好的旁白（qwen_clone.py 的输出），按旁白稿的顺序拼回一条（engine/compiler/speakers.mjs）。
每句按配音时记下的起止（timing 的 sentences）整段取出，句内的声音和停顿一点不动；一句前后的静音不到 gap/2 的补足，
所以同一个人连着说的几句和配音时一样，换人的地方也是 gap 秒停顿。逐字时间跟着平移，每句记上是谁说的。
用法：.venv-mlx/bin/python dialogue.py <输出前缀> <顺序 json> --part <说话人>=<那个人配音的输出前缀> [--part ...] [--gap 0.4]
顺序 json：[{"text": 句子, "speaker": 说话人（主讲为 ""）}, ...]，和旁白稿逐句一一对应。
"""
import argparse
import json
import re

import numpy as np
import soundfile as sf

PUNCT = r"[\s，。；：！？、,.;:!?\"“”'‘’（）()—-]"

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("order")
ap.add_argument("--part", action="append", default=[], help="说话人=输出前缀（主讲写成 =前缀）")
ap.add_argument("--gap", type=float, default=0.4)
args = ap.parse_args()

order = json.load(open(args.order, encoding="utf-8"))
parts = {}
for p in args.part:
    who, base = p.split("=", 1)
    t = json.load(open(base + ".timing.json", encoding="utf-8"))
    x, sr = sf.read(base + ".wav", dtype="float32")
    parts[who] = {"t": t, "x": x.mean(1) if x.ndim > 1 else x, "sr": sr, "next": 0}
srs = {p["sr"] for p in parts.values()}
if len(srs) != 1:
    raise SystemExit(f"各人配音的采样率不一样：{srs}")
sr = srs.pop()
half = args.gap / 2

pieces, words, sents, t = [], [], [], 0.0
for k, o in enumerate(order):
    who = o.get("speaker", "")
    if who not in parts:
        raise SystemExit(f"第 {k + 1} 句「{o['text']}」是「{who or '主讲'}」说的，没有给这个人的配音（--part）")
    P = parts[who]
    S = P["t"]["sentences"]
    j = P["next"]
    if j >= len(S) or S[j]["text"].strip() != o["text"].strip():
        raise SystemExit(f"第 {k + 1} 句「{o['text']}」和「{who or '主讲'}」配音里的第 {j + 1} 句「{S[j]['text'] if j < len(S) else '（没有了）'}」对不上")
    P["next"] = j + 1
    s = S[j]
    # 按字的起点归句：句末最后一个字的终点常比句子终点晚几十毫秒（E03「大模型」的「型」晚 25ms），按终点卡会把它丢掉
    ws = [dict(w, end=min(w["end"], s["end"])) for w in P["t"]["words"] if s["start"] - 1e-3 <= w["start"] < s["end"]]
    if not ws:
        raise SystemExit(f"「{o['text']}」在配音的逐字时间里没有字")
    a, b = int(round(s["start"] * sr)), int(round(s["end"] * sr))
    seg = P["x"][a:b]
    lead = max(0, int(round((half - (ws[0]["start"] - s["start"])) * sr)))
    tail = max(0, int(round((half - (s["end"] - ws[-1]["end"])) * sr)))
    seg = np.concatenate([np.zeros(lead, np.float32), seg, np.zeros(tail, np.float32)])
    off = t + lead / sr - s["start"]
    words += [dict(w, start=round(w["start"] + off, 3), end=round(w["end"] + off, 3)) for w in ws]
    sents.append({"text": s["text"], "start": round(t, 3), "end": round(t + len(seg) / sr, 3), **({"speaker": who} if who else {})})
    pieces.append(seg)
    t += len(seg) / sr

left = {who or "主讲": len(P["t"]["sentences"]) - P["next"] for who, P in parts.items() if P["next"] < len(P["t"]["sentences"])}
if left:
    raise SystemExit(f"有人的配音没用完：{left}（顺序 json 和各人的旁白稿对不上）")
full = np.concatenate(pieces)
sf.write(args.out + ".wav", full, sr)
main = parts.get("", next(iter(parts.values())))["t"]
text = "".join(o["text"] for o in order)
json.dump({"source": "对话：" + "、".join(f"{w or '主讲'} {sum(1 for o in order if o.get('speaker', '') == w)} 句" for w in parts) + f"，各自 qwen_clone 配好后按旁白稿顺序拼接（dialogue.py，换人处停顿 {args.gap}s）",
           "text": text, "ref_text": main.get("ref_text"), "words": words, "sentences": sents},
          open(args.out + ".timing.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
got, want = "".join(w["text"] for w in words), re.sub(PUNCT, "", text)
if re.sub(PUNCT, "", got) != want:
    raise SystemExit("拼好后逐字时间的字和旁白稿对不上")
print(f"对话拼好：{len(order)} 句、{len(words)} 个字、{len(full) / sr:.2f}s → {args.out}.wav")
