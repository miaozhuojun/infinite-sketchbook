"""静帧审稿材料（qa/still_review.mjs 调用）：把渲好的静帧拼成每句一张图和每节一张总览图，写出 review/pack.md。
每句一张：上面大图是这句说完、画完的那一刻（和理解度测试同一帧），下面一排小图是这句从开口到画完之间的几个时刻，标着那一刻正在说的字；
总览图（qa/phrase_sheets.py）：每节一张（一节超过 12 句拆开），每格是一句说完画完那一刻的缩略图，标句号；
pack.md 开头写看图预算（以文字和总览图为主，大图最多开 MAX_FULL 张），然后是学习目标、程序已经查出来的问题、逐句的旁白原文和这句画了什么，审稿规则直接从 qa/review_rubric.md 摘进来（只维护一份）。
用法：../.venv-qa/bin/python qa/still_review.py <manifest.json>
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from cjk_font import cjk_font
from phrase_sheets import write_sheets

m = json.loads(Path(sys.argv[1]).read_text())
beats = json.loads(Path(m["beats"]).read_text())
out = Path(m["out"]) / "review"
out.mkdir(parents=True, exist_ok=True)
rubric = (Path(__file__).parent / "review_rubric.md").read_text()


def section(title):
    """从审片规则里摘一节（## 标题 到下一个 ## 之前）"""
    hit = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", rubric, re.S | re.M)
    return hit[1].strip() if hit else ""


MAIN = 1280  # 大图的长边
# 一轮审稿最多打开几张大图（每句一张的 01.jpg……和 last-*.jpg）。E03 s1 审稿人把 124 张逐张打开，881 次调用、上下文涨到三十多万，
# 吃掉内容段八成 token；s2 以文字为主、最多开 30 张，只花了 0.5%，审得一样有用（用户 2026-11-09）
MAX_FULL = 30
MAX_MINOR = 3  # 次要问题最多报几条
LABEL = cjk_font(20)
HEAD = cjk_font(24)
ROLE = {"hook": "钩子", "setup": "铺垫", "aha": "顿悟", "recap": "回收", "next": "下集"}


def wrap(d, text, font, width):
    lines, cur = [], ""
    for ch in text:
        if d.textlength(cur + ch, font=font) > width and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    return lines + ([cur] if cur else [])


def sheet(t, p, name):
    """一句一张图：标题条 + 说完画完的大图 + 一排过程小图（每张标时刻和正在说的字）"""
    big = Image.open(p["png"]).convert("RGB")
    k = MAIN / max(big.size)
    big = big.resize((round(big.width * k), round(big.height * k)), Image.LANCZOS)
    W = big.width
    n = len(p["strip"])
    tw = W // max(n, 1)
    thumbs = []
    for s in p["strip"]:
        im = Image.open(s["png"]).convert("RGB")
        thumbs.append(im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS))
    th = thumbs[0].height if thumbs else 0
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    labels = [wrap(probe, f"{s['t']:.1f}s 正在说「{s['saying']}」" if s["saying"] else f"{s['t']:.1f}s（停顿）", LABEL, tw - 12) for s in p["strip"]]
    lh = 26 * max([len(x) for x in labels] or [0]) + 8
    head = 40
    img = Image.new("RGB", (W, head + big.height + (th + lh if n else 0)), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, head], fill="#222")
    role = ROLE.get(p["role"], p["role"])
    d.text((10, 7), f"第 {p['i'] + 1} 句{f'〔{role}〕' if role else ''}  说完画完 {p['endT']:.1f}s  ·  {t['target']}  ·  试编估时", fill="white", font=HEAD)
    img.paste(big, (0, head))
    for j, (im, lab) in enumerate(zip(thumbs, labels)):
        x, y = j * tw, head + big.height
        img.paste(im, (x, y))
        d.rectangle([x, y, x + tw - 1, y + th - 1], outline="#888")
        for r, line in enumerate(lab):
            d.text((x + 6, y + th + 4 + r * 26), line, fill="#111", font=LABEL)
    img.save(out / name, quality=88)


def fmt_action(a):
    what = f"「{a['text']}」" if a["text"] else ""
    if not a["pen"]:
        return f"- {a['id']}（{a['type']}{what}）：说到「{a['at']}」{a['cue']:.1f}s 时生效"
    vis = "" if a["visible"] is None or a["visible"] >= 0.95 else f"；**说完那一刻只有 {round(a['visible'] * 100)}% 在画面里**"
    early = "；有意先写（ahead）" if a["ahead"] else ""
    return f"- {a['id']}（{a['type']}{what}）：说到「{a['at']}」{a['cue']:.1f}s，画 {a['start']:.1f}–{a['end']:.1f}s{vis}{early}"


b = beats.get("brief", {})
sheet_glob = "`sheet-01.jpg`、`sheet-02.jpg`……" if len(m["targets"]) == 1 else "`sheet-<画幅>-01.jpg`、`sheet-<画幅>-02.jpg`……"
L = [f"# 静帧审稿材料：{m['id']}", "",
     f"这是内容定稿前的审稿：没有配音、没有渲整片。时间按每秒 {m['rate']} 个字估出来（全片约 {m['seconds']} 秒），真配音后会差几秒；画面是在这份试编时间线上渲的静帧，没有声音、没有运动。",
     "你是独立审稿人，和制作无关，只读不改。只看这个目录里的东西。", "",
     "这个目录里有三种图：",
     f"- 总览图（{sheet_glob}）：每节一张（一节超过 12 句就拆成几张），每格是一句说完、画完的那一刻，左上角红底数字是句号。",
     "- 每句的大图（`01.jpg`、`02.jpg`……，编号就是句号）：上面大图是这句说完、画完的那一刻；下面一排小图是这句从开口到画完之间的几个时刻，每张标着那一刻正在说的字。",
     "- 每个画幅一张整片最后一帧（`last-<画幅>.jpg`）。", "",
     "## 怎么看（先读这一节：看图有预算）", "",
     "1. 先读文字：下面「逐句」里每句的旁白原文、这句画了什么、几点开口几点画完，还有程序已经查出来的问题。讲法、例子、前后接不接得上、字和旁白同不同步，大多从文字就能判断。",
     f"2. 再看总览图（{sheet_glob}，一节一张）：版面、画面和旁白是不是一回事、有没有东西出画、留白和重心，从这里看。",
     f"3. 每句的大图和最后一帧只在两种时候打开：核对上一轮提的问题改好没有；文字或总览图上看出疑似阻断、重要的问题，要打开确认。**整轮最多打开 {MAX_FULL} 张**，不要逐张打开全部"
     + "（E03：一位审稿人把 124 张逐张打开，用掉内容段八成 token，并没有多查出问题）。在 review.json 的 coverage 里写上你打开了哪几张。",
     f"4. issues 只写阻断和重要问题，次要的最多挑 {MAX_MINOR} 条最影响观看的；挑剔的小毛病不报。打分仍按下面的评分锚点，按你看到的全部问题打。", "",
     "## 这一期要教什么（brief）", ""]
for k, name in [("question", "回答的问题"), ("audience", "面向"), ("fromPrev", "接着上一集")]:
    if b.get(k):
        L.append(f"- {name}：{b[k]}")
L += [f"- 学习目标 {i + 1}：{o}" for i, o in enumerate(b.get("objectives", []))]
if b.get("next"):
    L.append(f"- 留给下一集：{b['next']}")
L += ["", "## 程序已经查出来的（不用再报，除非你认为比程序判的更严重）", ""]
if m["validateAdvice"]:
    L += ["分镜校验和写稿自查的建议：", *[f"- {x}" for x in m["validateAdvice"]], ""]
for t in m["targets"]:
    if t["problems"]:
        L += [f"[{t['target']}] 试编查出的问题（机械上坏了，制作方必须改）：", *[f"- {x}" for x in t["problems"]], ""]
    if t["advice"]:
        L += [f"[{t['target']}] 试编的建议（时间是估的，「落后」「停顿」以真配音为准）：", *[f"- {x}" for x in t["advice"]], ""]
if not m["validateAdvice"] and not any(t["problems"] or t["advice"] for t in m["targets"]):
    L += ["（没有）", ""]
if m.get("prev"):
    prev = json.loads(Path(m["prev"]).read_text())
    L += ["## 上一轮的审稿结果（先逐条标 previous：改好了 / 改了一半 / 没改）", "", "```json", json.dumps(prev.get("issues", []), ensure_ascii=False, indent=1), "```", ""]

for t in m["targets"]:
    stem = "sheet" if len(m["targets"]) == 1 else f"sheet-{t['target']}"
    titles = [c["title"] for c in t["chapters"]]
    sheets = write_sheets([{"n": p["i"] + 1, "png": p["png"], "chapter": p["chapter"] and f"第 {titles.index(p['chapter']) + 1 if p['chapter'] in titles else '?'} 节：{p['chapter']}"}
                           for p in t["phrases"]], out, stem, f"  ·  {t['target']}")
    at_first = {a: (name, a, z) for name, _, a, z in sheets}
    L += [f"## 逐句（{t['target']}，{t['canvas']['w']}×{t['canvas']['h']}，约 {t['duration']:.0f} 秒）", ""]
    chs = t["chapters"]
    for p in t["phrases"]:
        name = f"{p['i'] + 1:02d}.jpg" if len(m["targets"]) == 1 else f"{p['i'] + 1:02d}-{t['target']}.jpg"
        sheet(t, p, name)
        if p["chapter"]:
            k = next((j for j, c in enumerate(chs) if c["title"] == p["chapter"]), None)
            L += [f"### 第 {k + 1 if k is not None else '?'} 节：{p['chapter']}", ""]
        if p["i"] + 1 in at_first:
            sname, a, z = at_first[p["i"] + 1]
            L += [f"总览图：`{sname}`（第 {a}–{z} 句）", ""]
        role = ROLE.get(p["role"], p["role"])
        cam = {"overview": "；镜头拉到全景，这句不画", "revisit": "；镜头回看前面画过的东西"}.get(p["camera"], "")
        L.append(f"**{p['i'] + 1}.**{f'〔{role}〕' if role else ''}「{p['text']}」 → `{name}`（开口 {p['at']:.1f}s，说完 {p['audioEnd']:.1f}s，画完 {p['drawEnd']:.1f}s{cam}）")
        L += [fmt_action(a) for a in p["actions"]] or ["- （这句不画新东西）"]
        L.append("")
    last = f"last-{t['target']}.jpg"
    im = Image.open(t["lastPng"]).convert("RGB")
    k = MAIN / max(im.size)
    im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS).save(out / last, quality=88)
    L += [f"整片最后一帧：`{last}`", ""]

L += ["## 审稿规则（摘自 qa/review_rubric.md）", "", "### 静帧审稿", "", section("静帧审稿"), "", "### 评分锚点", "", section("评分锚点"), "", "### 每条问题的写法", "", section("每条问题的写法"), ""]
(out / "pack.md").write_text("\n".join(L) + "\n")
n = sum(len(t["phrases"]) for t in m["targets"])
print(f"审稿材料：{out}/pack.md（{n} 句，每句一张图；总览图 {len(list(out.glob('sheet*.jpg')))} 张）")
