"""设备预览：把成片关键帧放进对应设备/平台的模拟框里（叠上近似的平台界面），给审片 agent 和人看。
9:16 → 手机竖屏（TikTok/Shorts 界面）；16:9 → 笔记本（YouTube 播放器）；1:1 → X 信息流卡片。
遮挡区取自风格规范 platformUI（时间线里带着），和安全区检查用的是同一份数据。界面是示意，不是平台截图。
用法：../.venv-qa/bin/python qa/device_preview.py build/<id>.timeline.json <video.mp4> <out.png>
"""
import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw

from cjk_font import cjk_font as font

tl = json.loads(Path(sys.argv[1]).read_text())
video, out = sys.argv[2], Path(sys.argv[3])
FF = imageio_ffmpeg.get_ffmpeg_exe()
W, H = tl["canvas"]["w"], tl["canvas"]["h"]

# 关键帧：每句话画完的时刻（取 3 个有代表性的：前段、中段、结尾全景）
ends = [p["drawEnd"] for p in tl["report"]["phrases"]]
picks = sorted({ends[len(ends) // 4], ends[len(ends) * 2 // 3], tl["duration"] - 0.6})


def grab(t):
    tmp = out.parent / f"_dp_{t:.2f}.png"
    subprocess.run([FF, "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1", str(tmp)], check=True)
    im = Image.open(tmp).convert("RGB")
    tmp.unlink()
    return im


def overlay_ui(im, scale):
    """把平台遮挡区画成半透明深色块 + 文字标注（和安全区检查同一份数据）。"""
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for pf, zones in (tl.get("platformUI") or {}).items():
        for z in zones:
            box = [z["l"] * scale, z["t"] * scale, z["r"] * scale, z["b"] * scale]
            d.rectangle(box, fill=(20, 20, 20, 70), outline=(255, 255, 255, 110))
            d.text((box[0] + 6, box[1] + 4), f"{pf}·{z['name']}", fill=(255, 255, 255, 200), font=font(max(11, int(13 * scale / 0.4))))
    return Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")


def phone(frame):
    s = 0.4
    scr = overlay_ui(frame.resize((int(W * s), int(H * s))), s)
    pad, r = 18, 46
    body = Image.new("RGB", (scr.width + pad * 2, scr.height + pad * 2), (24, 24, 26))
    mask = Image.new("L", body.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *body.size], r, fill=255)
    body.paste(scr, (pad, pad))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle([body.width / 2 - 55, pad + 8, body.width / 2 + 55, pad + 34], 13, fill=(10, 10, 10))  # 灵动岛
    canvas = Image.new("RGB", body.size, (235, 235, 238))
    canvas.paste(body, (0, 0), mask)
    return canvas


def laptop(frame):
    s = 0.5
    scr = overlay_ui(frame.resize((int(W * s), int(H * s))), s)
    d = ImageDraw.Draw(scr)
    d.rectangle([0, scr.height - 6, scr.width * 0.42, scr.height - 2], fill=(230, 33, 23))  # 进度条示意
    lid = Image.new("RGB", (scr.width + 36, scr.height + 40), (30, 30, 32))
    lid.paste(scr, (18, 20))
    base = Image.new("RGB", (lid.width + 120, 22), (190, 192, 196))
    canvas = Image.new("RGB", (base.width, lid.height + base.height), (235, 235, 238))
    canvas.paste(lid, (60, 0))
    canvas.paste(base, (0, lid.height))
    return canvas


# X 卡片上的账号名取本机品牌配置（engine/brand.local.json，不进仓库）；没有就用占位名
_brand = Path(__file__).resolve().parents[1] / "brand.local.json"
BRAND = json.loads(_brand.read_text(encoding="utf-8"))["name"] if _brand.exists() else "@your_channel"


def x_card(frame):
    s = 0.5
    vid = overlay_ui(frame.resize((int(W * s), int(H * s))), s)
    card = Image.new("RGB", (vid.width + 40, vid.height + 150), (255, 255, 255))
    d = ImageDraw.Draw(card)
    d.ellipse([20, 18, 60, 58], fill=(200, 200, 205))
    d.text((72, 20), BRAND, fill=(15, 20, 25), font=font(18))
    d.text((72, 44), (tl["subtitles"][0]["text"] if tl.get("subtitles") else "")[:24], fill=(60, 70, 80), font=font(16))
    mask = Image.new("L", vid.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *vid.size], 16, fill=255)
    card.paste(vid, (20, 80), mask)
    d.text((24, vid.height + 96), "回复 9     转发 32     喜欢 128", fill=(100, 110, 120), font=font(16))
    return card


def phone_held(frame):
    """竖握手机刷到横版（抖音信息流）：画面按屏宽缩小放在屏幕中间一条，右下是按钮列、底下是账号和文案。
    屏幕按 390×844（iPhone 14 的逻辑像素）画，就是审片说的「390px 宽」：这时画面上的字有多大一眼就能看出来。"""
    sw, sh = 390, 844
    vid = frame.resize((sw, int(sw * H / W)))
    scr = Image.new("RGB", (sw, sh), (12, 12, 14))
    top = (sh - vid.height) // 2
    scr.paste(vid, (0, top))
    d = ImageDraw.Draw(scr)
    # 遮挡区：和安全区检查同一份数据（视频坐标），换算到屏幕上
    for pf, zones in (tl.get("platformUI") or {}).items():
        for z in zones:
            if not z.get("advice"):
                continue
            box = [z["l"] * sw / W, top + z["t"] * vid.height / H, z["r"] * sw / W, top + z["b"] * vid.height / H]
            d.rectangle(box, fill=None, outline=(255, 255, 255))
    for i in range(4):  # 按钮列示意（头像、点赞、评论、分享），在画面右边往下延伸
        cy = int(sh * 0.40) + i * 62
        d.ellipse([sw - 40, cy - 16, sw - 8, cy + 16], outline=(240, 240, 240), width=2)
    d.text((14, sh - 120), BRAND if BRAND.startswith("@") else f"@{BRAND}", fill=(240, 240, 240), font=font(15))
    d.text((14, sh - 96), (tl["subtitles"][0]["text"] if tl.get("subtitles") else "")[:18], fill=(220, 220, 220), font=font(13))
    pad, r = 12, 40
    body = Image.new("RGB", (sw + pad * 2, sh + pad * 2), (24, 24, 26))
    body.paste(scr, (pad, pad))
    mask = Image.new("L", body.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *body.size], r, fill=255)
    canvas = Image.new("RGB", body.size, (235, 235, 238))
    canvas.paste(body, (0, 0), mask)
    return canvas


make = {"9x16": phone, "16x9": laptop, "1x1": x_card}[tl["target"]]
shots = [make(grab(t)) for t in picks]
# 16:9 也发抖音这类竖屏信息流时（时间线的平台里有 *-feed-16x9），加一格竖握手机看横版的样子（中段那一帧）
if tl["target"] == "16x9" and any(pf.endswith("-feed-16x9") for pf in tl.get("platforms", [])):
    shots.append(phone_held(grab(picks[len(picks) // 2])))
gap = 30
sheet = Image.new("RGB", (sum(s.width for s in shots) + gap * (len(shots) + 1), max(s.height for s in shots) + 90), (235, 235, 238))
d = ImageDraw.Draw(sheet)
d.text((gap, 20), f"{tl['id']} · 设备预览（界面遮挡区为示意，数据同安全区检查） · 帧：{'、'.join(f'{t:.1f}s' for t in picks)}", fill=(40, 40, 45), font=font(22))
x = gap
for s in shots:
    sheet.paste(s, (x, 70))
    x += s.width + gap
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
print(f"设备预览：{out}")
