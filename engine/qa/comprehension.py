"""理解度测试：检验"看完能不能学懂"，不靠制作方自评。
pack：把成片按"每句话画完"的时刻抽帧，连同旁白文字和自测题（不含答案）打包，交给一个没看过备课材料的新 agent 作答；
score：按分镜里每道题的关键词组判分（每组至少命中一个同义词才算对）。
用法：
  ../.venv-qa/bin/python qa/comprehension.py pack  data/<id>.beats.json build/<id>-9x16.timeline.json out/<id>/9x16.mp4 out/<id>/comprehension
  ../.venv-qa/bin/python qa/comprehension.py score data/<id>.beats.json out/<id>/comprehension/answers.json
"""
import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

cmd = sys.argv[1]
beats = json.loads(Path(sys.argv[2]).read_text())
quiz = beats.get("quiz", [])

if cmd == "pack":
    tl = json.loads(Path(sys.argv[3]).read_text())
    video, out = sys.argv[4], Path(sys.argv[5])
    (out / "frames").mkdir(parents=True, exist_ok=True)
    lines = []
    subs = tl["subtitles"]
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
        f = out / "frames" / f"{i + 1:02d}.png"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1", "-vf", "scale=540:-1", str(f)], check=True)
        lines.append(f"{i + 1}. 旁白：「{s['text']}」 → 画面：frames/{f.name}")
    (out / "questions.json").write_text(json.dumps([{"id": i + 1, "q": q["q"]} for i, q in enumerate(quiz)], ensure_ascii=False, indent=1))
    (out / "pack.md").write_text(
        "# 理解度测试材料\n\n你是第一次看这段视频的观众，只知道下面的画面和旁白，没有其他背景知识。"
        "按顺序看完每一帧和对应旁白，然后回答 questions.json 里的问题，每题一两句中文。"
        "只能根据这里看到的内容回答，看不懂就照实说看不懂，不要猜。\n\n"
        '输出写成 answers.json：{"answers": [{"id": 1, "a": "……"}, …]}\n\n## 画面与旁白（按时间顺序）\n\n' + "\n".join(lines) + "\n")
    print(f"理解度测试材料：{out}/pack.md（{len(lines)} 帧，{len(quiz)} 题）")

elif cmd == "score":
    answers = {a["id"]: a["a"] for a in json.loads(Path(sys.argv[3]).read_text())["answers"]}
    ok = 0
    for i, q in enumerate(quiz):
        a = answers.get(i + 1, "")
        miss = [g for g in q["keywords"] if not any(k in a for k in g)]
        ok += not miss
        print(f"[{'通过' if not miss else '失败'}] 第 {i + 1} 题「{q['q']}」：答「{a}」" + (f"；缺少关键词：{' / '.join('或'.join(g) for g in miss)}" if miss else ""))
    print(f"\n理解度：{ok}/{len(quiz)}")
    sys.exit(0 if ok == len(quiz) else 1)
