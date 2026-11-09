"""按句的总览图：每节一张（一节超过 12 句就拆成几张），每格是一句说完画完那一刻的缩略图，左上角标句号。
给静帧审稿和理解度测试的 agent 先看全局用：大图一张张打开太费 token（E03 s1：一个审稿 agent 把 124 张大图逐张打开，
881 次调用、上下文涨到三十多万，吃掉内容段八成 token；s2 以文字为主、最多开 30 张大图，只花了 0.5%，审得一样有用）。
still_review.py 和 comprehension.py pack 调用；只出图，不改每句的大图。
"""
from PIL import Image, ImageDraw

from cjk_font import cjk_font

PER = 12  # 一张最多几句
SHEET_W = 1600  # 一张总览图的宽（缩略图按列数均分）
HEAD = 40
NUM = cjk_font(30)
TITLE = cjk_font(24)


def groups(items):
    """items：[{n: 句号（从 1 起）, png, chapter: 这句开了新的一节就是节名，否则 None}]，按节分组，每组至多 PER 句。
    返回 [(节名或 None, 这节第几张, 这节共几张, [item…])]"""
    chs, cur = [], None
    for it in items:
        if it.get("chapter") or cur is None:
            cur = (it.get("chapter"), [])
            chs.append(cur)
        cur[1].append(it)
    out = []
    for title, its in chs:
        parts = [its[k:k + PER] for k in range(0, len(its), PER)]
        out += [(title, j + 1, len(parts), p) for j, p in enumerate(parts)]
    return out


def write_sheets(items, out_dir, stem="sheet", note=""):
    """写出 <stem>-01.jpg、<stem>-02.jpg……，返回 [(文件名, 节名, 第一句号, 最后一句号)]。先删同名的旧图（这一轮句子变少时不留上一轮的）"""
    for old in out_dir.glob(f"{stem}-[0-9][0-9].jpg"):
        old.unlink()
    made = []
    for k, (title, j, n, its) in enumerate(groups(items)):
        first = Image.open(its[0]["png"])
        cols = 6 if first.height > first.width else 4
        tw = SHEET_W // cols
        th = round(first.height * tw / first.width)
        rows = -(-len(its) // cols)
        part = f"（{j}/{n}）" if n > 1 else ""
        head = f"{title}{part}  ·  " if title else ""
        head = f"{head}第 {its[0]['n']}–{its[-1]['n']} 句  ·  每句说完画完那一刻{note}"
        # 不满一行时按用到的列数收窄，但标题条要放得下整行标题（节名长、只有一两格时不截字）
        img = Image.new("RGB", (max(min(cols, len(its)) * tw, round(TITLE.getlength(head)) + 20), HEAD + rows * th), "white")
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, img.width, HEAD], fill="#222")
        d.text((10, 7), head, fill="white", font=TITLE)
        for i, it in enumerate(its):
            im = Image.open(it["png"]).convert("RGB").resize((tw, th), Image.LANCZOS)
            x, y = (i % cols) * tw, HEAD + (i // cols) * th
            img.paste(im, (x, y))
            d.rectangle([x, y, x + tw - 1, y + th - 1], outline="#888")
            label = str(it["n"])
            w = d.textlength(label, font=NUM)
            d.rectangle([x, y, x + w + 16, y + 40], fill="#c0392b")
            d.text((x + 8, y + 3), label, fill="white", font=NUM)
        name = f"{stem}-{k + 1:02d}.jpg"
        img.save(out_dir / name, quality=85)
        made.append((name, title, its[0]["n"], its[-1]["n"]))
    return made
