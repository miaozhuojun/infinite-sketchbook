"""理解度测试：检验"看完能不能学懂"，不靠制作方自评。
pack：把成片按"每句话画完"的时刻抽帧，连同旁白文字和自测题（不含答案）按节打包，交给一个没看过备课材料的新 agent 作答；
      它扮零基础观众，每看完一节先写这一节讲了什么、哪里没跟上，再往下看，最后答题，并列出所有没看懂的地方；
      每节一张总览图（qa/phrase_sheets.py），测试者先读旁白、看总览图，要靠画面才懂的地方再开单张；
      第三个参数也可以是静帧目录（qa/still_review.mjs 按 times 给的时刻渲好的 01.png、02.png……）：没配音、没渲整片时，在试编时间线上先测
times：打印每句该截哪一帧（秒），静帧审稿按它渲染，和成片截帧同一个算法
score：按分镜里每道题的关键词组判分（每组至少命中一个同义词才算对）；没看懂的地方里，视频没说下一集再讲、又会让人跟不上后面的，
       一处就不过——片尾留的悬念可以，一头雾水不行（用户 2026-11-06：E02 v5 理解度 5/5，可 1958 那段很多人理解不过来）。
用法：
  ../.venv-qa/bin/python qa/comprehension.py pack  data/<id>.beats.json build/<id>-9x16.timeline.json out/<id>/9x16.mp4 out/<id>/comprehension
  ../.venv-qa/bin/python qa/comprehension.py pack  data/<id>.beats.json build/_dry-<id>-16x9.timeline.json <静帧目录> out/<id>/stills/comprehension
  ../.venv-qa/bin/python qa/comprehension.py times data/<id>.beats.json build/<id>-16x9.timeline.json
  ../.venv-qa/bin/python qa/comprehension.py score data/<id>.beats.json out/<id>/comprehension/answers.json
"""
import json
import subprocess
import sys
from pathlib import Path

cmd = sys.argv[1]
beats = json.loads(Path(sys.argv[2]).read_text())
quiz = beats.get("quiz", [])


def merged_subs(tl):
    """一句旁白的字幕可能在标点处拆成几段（maxLines），拆出来的后段带 join：先并回一句一条，再和分镜的句子一一对上。
    原来直接按下标配对，拆过的片子句子和字幕错位，帧截错时刻，后面的句子（片尾回顾）整段丢掉"""
    subs = []
    for s in tl["subtitles"]:
        if s.get("join") and subs:
            subs[-1] = {**subs[-1], "text": subs[-1]["text"] + "，" + s["text"], "t1": s["t1"]}
        else:
            subs.append(dict(s))
    if len(subs) != len(tl["report"]["phrases"]):
        sys.exit(f"字幕并回后 {len(subs)} 条，分镜 {len(tl['report']['phrases'])} 句，对不上，理解度材料不可信")
    return subs


def speaker_text(s):
    """对话：不是主讲说的句子前面写上是谁说的。这个人第一次开口那句，编译器已经在字幕前面写了称呼（compiler/compile.mjs 的 intro），
    不再加一遍（原来写成「爸爸：爸爸：跟我一样」，屏幕上的字幕是对的）"""
    who = f"{s['label']}：" if s.get("label") else ""
    return s["text"] if s["text"].startswith(who) else who + s["text"]


def frame_times(tl):
    """每句截哪一刻（秒）：[(句子下标, 时刻, 字幕原文)]"""
    subs, out = merged_subs(tl), []
    for i, (p, s) in enumerate(zip(tl["report"]["phrases"], subs)):
        # 这一句的事都发生完（画完、灯亮或灯灭的效果走完、铅笔让开）之后、下一句开始之前截一帧。
        # 只看画完会截早：理解度测试看到「灯就亮」那帧灯还没亮、「灯就不亮」那帧灯还亮着
        # 画完（+0.2s，字幕还在）和灯亮灯灭这类效果走完，取晚的那个；下一句开始前截住。
        # 只有效果、没画东西的句子（「灯就亮！」）原来按字幕开头截，灯才亮了 14%
        effects = [a["end"] + 0.15 for a in tl["report"]["actions"] if a["phrase"] == i and not a["pen"]]
        nxt = subs[i + 1]["t0"] if i + 1 < len(subs) else tl["duration"]
        lo = max(p["drawEnd"] + 0.2, s["t0"] + 0.3, *effects)
        # 也不截在字幕淡出里（最后 0.12 秒，渲染端按这个淡出）：理解度测试看到字幕条发白、对比度很低
        t = min(lo, nxt - 0.1, s["t1"] - 0.15, tl["duration"] - 0.05)
        # 截在铅笔飞行途中，笔会盖住它路过的字（理解度测试把「7 超过了 5」那帧飞过「+0×2」的笔读成停在「0」上）。
        # 落在抬笔移动里就挪到落地之后；字幕撤掉前落不了地，就提前到起飞那一刻（笔还在刚画完的地方），但不早于字幕出现和效果走完。
        # 挪后不越过这句字幕的结尾：最后一句的笔飞出画外要很久，挪到落地时字幕早没了（理解度测试：最后一帧没有字幕）
        fly = next((m for m in tl["penTrack"] if m["kind"] == "move" and m["t0"] <= t < m["t1"]), None)
        if fly and fly["t1"] + 0.02 <= min(nxt - 0.1, s["t1"] - 0.15, tl["duration"] - 0.05):
            t = fly["t1"] + 0.02
        elif fly and fly["t0"] + 0.02 >= max([s["t0"] + 0.3, *effects]):
            t = fly["t0"] + 0.02
        out.append((i, t, speaker_text(s)))
    return out


if cmd == "times":
    tl = json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps([{"i": i, "t": round(t, 3), "frame": int(t * tl["fps"])} for i, t, _ in frame_times(tl)]))

elif cmd == "pack":
    tl = json.loads(Path(sys.argv[3]).read_text())
    video, out = Path(sys.argv[4]), Path(sys.argv[5])
    (out / "frames").mkdir(parents=True, exist_ok=True)
    stills = video.is_dir()  # 静帧目录：按 times 的时刻渲好的 01.png……（试编时间线上测，没有成片）
    lines = []  # (句子下标, 开口时刻, pack.md 里的一行)
    for i, t, text in frame_times(tl):
        f = out / "frames" / f"{i + 1:02d}.png"
        if stills:
            from PIL import Image
            im = Image.open(video / f"{i + 1:02d}.png").convert("RGB")
            im.resize((540, round(im.height * 540 / im.width)), Image.LANCZOS).save(f)
        else:
            import imageio_ffmpeg
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=540:-1", str(f)], check=True)
        lines.append((i, tl["report"]["phrases"][i]["at"], f"{i + 1}. 旁白：「{text}」 → 画面：frames/{f.name}"))
    (out / "questions.json").write_text(json.dumps([{"id": i + 1, "q": q["q"]} for i, q in enumerate(quiz)], ensure_ascii=False, indent=1))
    # 按节分组：每看完一节先写这一节讲了什么、哪里没跟上，再往下看——一次看完全部再答题，跳得太快的地方察觉不到
    chs = tl.get("chapters") or [{"t": 0, "title": "全片"}]
    segs = []
    for k, c in enumerate(chs):
        t1 = chs[k + 1]["t"] if k + 1 < len(chs) else 1e9
        segs.append([(i, l) for i, at, l in lines if c["t"] - 0.01 <= at < t1 - 0.01])
    # 每节一张总览图（一节超过 12 句拆开，qa/phrase_sheets.py）：先看一节的全貌，看不清、要靠图才懂的地方再开单张，不用每张都打开
    from phrase_sheets import write_sheets
    sheets = write_sheets([{"n": i + 1, "png": out / "frames" / f"{i + 1:02d}.png", "chapter": f"第 {k + 1} 节：{chs[k]['title']}" if j == 0 else None}
                           for k, seg in enumerate(segs) for j, (i, _) in enumerate(seg)], out)
    body = []
    for k, seg in enumerate(segs):
        if seg:
            ns = {i + 1 for i, _ in seg}
            mine = [f"`{name}`（第 {a}–{z} 句）" for name, _, a, z in sheets if a in ns]
            body += [f"### 第 {k + 1} 节：{chs[k]['title']}", "", f"总览图：{'、'.join(mine)}", "", *[l for _, l in seg], "",
                     f"（看完这一节，先在 checkpoints 里写下第 {k + 1} 节讲了什么、哪里没跟上，再往下看。）", ""]
    # 剧集的第 2 集起：测试者也没看过前几集（E02 v6：「不背规则」，没看过上一集的人不知道规则是什么）
    serial = beats.get("series", {}).get("serial") and (beats.get("series", {}).get("episode") or 1) > 1
    prior = "这是一个系列里的一集，前面几集你都没看过：视频里提到「上一集」的东西，只按这一集里交代的来理解。" if serial else ""
    (out / "pack.md").write_text(
        "# 理解度测试材料\n\n"
        "你是第一次看这段视频的普通观众：零基础，不懂编程，不知道感知机、神经网络这些词，没见过打孔卡片和老式计算机。"
        + prior +
        "你只知道下面的画面和旁白。视频里没讲的，不要用你自己知道的东西补上；要靠猜、或者跳得太快没跟上，就照实说。\n\n"
        "怎么看：每一节先读旁白，再看这一节的总览图（`sheet-01.jpg`……，每格是一句说完、画完的那一刻，左上角红底数字是句号）。"
        "总览图上看不清、而这句要靠画面才懂的时候，再打开 frames/ 里那一句的单张；不用每张都打开。\n\n"
        "做法：\n"
        "1. 一节一节往下看，每看完一节，先在 checkpoints 里写这一节讲了什么（一两句）、哪里没跟上，再看下一节，不要先翻到后面。\n"
        "2. 全部看完后，回答 questions.json 里的问题，每题一两句中文。\n"
        "3. 在 unclear 里列出所有不是一看就懂的地方，每条写：where（第几帧或哪一节）、what（哪里不懂）、"
        "later（视频有没有明确说这个下一集再讲，true/false）、state（四选一："
        "「没懂」＝看完也不知道这里在讲什么；「靠猜」＝视频没交代，是你自己猜、或者靠一行小字、靠后面的内容倒推才补上的；"
        "「后来才懂」＝当时没懂，过一会儿视频自己讲明白了；「想多知道」＝看懂了，只是好奇想多了解）。"
        "按一个零基础观众的感受填，不要因为你自己能推出来就填「后来才懂」或「想多知道」。没有就写空列表。\n\n"
        '输出写成 answers.json：{"checkpoints": [{"chapter": 1, "summary": "……", "unclear": "……或空"}, …], '
        '"answers": [{"id": 1, "a": "……"}, …], "unclear": [{"where": "……", "what": "……", "later": false, "state": "靠猜"}, …]}\n\n'
        "## 画面与旁白（按时间顺序，分节）\n\n" + "\n".join(body) + "\n")
    print(f"理解度测试材料：{out}/pack.md（{len(lines)} 帧、{len(chs)} 节、总览图 {len(sheets)} 张，{len(quiz)} 题）")

elif cmd == "score":
    doc = json.loads(Path(sys.argv[3]).read_text())
    answers = {a["id"]: a["a"] for a in doc["answers"]}
    ok = 0
    for i, q in enumerate(quiz):
        a = answers.get(i + 1, "")
        miss = [g for g in q["keywords"] if not any(k in a for k in g)]
        ok += not miss
        print(f"[{'通过' if not miss else '失败'}] 第 {i + 1} 题「{q['q']}」：答「{a}」" + (f"；缺少关键词：{' / '.join('或'.join(g) for g in miss)}" if miss else ""))
    print(f"\n理解度：{ok}/{len(quiz)}")
    # 看不懂的地方：视频说了下一集讲的是悬念（可以），没说、又会让人跟不上后面的是一头雾水（不过）；其余只列出来
    unclear = doc.get("unclear")
    lost = []
    if unclear is None:
        print("没看懂的地方：答卷里没有 unclear（旧材料或测试者漏写），这一项没查")
    else:
        # 「会不会让你跟不上后面」这种问法测不出来：测试者是 AI，没懂也能照着旁白把题答对，总说「不影响」（用新材料重测 E02 v5：
        # 它写了「从灯跳到卡片太突然……只能猜」，却标成不影响）。改成按理解程度分档，「没懂」「靠猜」又不是留给下一集的就不过
        lost = [u for u in unclear if not u.get("later") and (u.get("state") in ("没懂", "靠猜") or u.get("blocks"))]
        for u in unclear:
            tag = "悬念（视频说了下一集讲）" if u.get("later") else f"跟不上（{u.get('state', '?')}）" if u in lost else f"记下（{u.get('state', '?')}）"
            print(f"[{'失败' if u in lost else '记下'}] {tag}：{u.get('where', '')} {u.get('what', '')}")
        print(f"没看懂的地方：{len(unclear)} 处，其中没懂或靠猜、又不是留给下一集的 {len(lost)} 处")
    for c in doc.get("checkpoints") or []:
        if str(c.get("unclear") or "").strip() not in ("", "无", "没有", "空"):
            print(f"  第 {c.get('chapter')} 节没跟上：{c.get('unclear')}")
    sys.exit(0 if ok == len(quiz) and not lost else 1)
