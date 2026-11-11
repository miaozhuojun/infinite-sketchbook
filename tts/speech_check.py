"""旁白完整性检查（每项都能失败，失败即非零退出）。ASR 回转会按上下文"脑补"半个字，所以不能只看字错率。
检查：
  0. 音色一致性：成片旁白的说话人嵌入与真人录音质心的相似度不低于 voice.json 的下限（防止音色漂移或误用别的配音）。
  1. 拼接切点：时间线里每段旁白的入点/出点，在源音频上必须落在安静处（10ms 窗 ≤ -45 dBFS）。
  2. 吞字：配音时逐句对齐的逐字时间映射到成片旁白，每个字时长 ≥ 50ms，且能量不低于中位数 18 dB 以上。
  3. 断音/爆音：两侧都在发声的 ≥5ms 全零段（字中间掉音）不得出现，不得有相邻采样突跳。
  4. 总混可懂度：带书写声和音乐的总混，ASR 回转字错率 ≤ 2%。
另有几项只给建议、不判失败：语气起伏（句内起伏和句间音区变化，和 voice.json 里按真人录音标定的值比）、声调（tone_check.py，每个字的走势和该念的声调比）。
用法：.venv-mlx/bin/python speech_check.py <timeline.json> [engine 根目录]
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from mlx_audio.stt import load as load_stt

tl_path = Path(sys.argv[1])
root = Path(sys.argv[2]) if len(sys.argv) > 2 else tl_path.parent.parent
tl = json.loads(tl_path.read_text())
beats = json.loads((root / "data" / f"{tl.get('beatsId', tl['id'])}.beats.json").read_text())
fails = []


def check(name, ok, detail):
    print(f"[{'通过' if ok else '失败'}] {name}：{detail}")
    if not ok:
        fails.append(name)


def mono(path):
    x, sr = sf.read(path, dtype="float64")
    return (x.mean(1) if x.ndim > 1 else x), sr


def db(seg):
    return 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12) if len(seg) else -240.0


# 0. 音色一致性（放在最前：别的检查依赖对齐，换错音频时可能先出错）
sys.path.insert(0, str(Path(__file__).parent))
from mlx_audio.tts.utils import load_model
from voice import load_voice, similarity, pitch_drops
voice = load_voice()
x0, sr0 = mono(root / "public" / tl["narration"])
_tts = load_model(str(Path(__file__).parent / "models/Qwen3-TTS-12Hz-1.7B-Base"))  # 只载一次，后面每句音色一致也用它（原来载两遍）
timing0 = json.loads((root / "data" / beats["narration"]["timing"]).resolve().read_text())
# 每句在成片旁白上的范围：这句配音（timing 的 sentences）在源配音上的起止，经过每个片段映射到成片上（sentence_map.py）。
# 原来按「片段归句」，一个片段含两句时短的那句没有范围（E05 132 句里 18 句），按句的检查查不到它，点名也落到同一片段的另一句上
from sentence_map import sentence_spans, sentence_at
_spans = sentence_spans(tl["audioClips"], timing0.get("sentences", []))
def sentence_ranges():
    yield from _spans


# 对话（engine/compiler/speakers.mjs）：一集里不止一个人说话时，和声音有关的检查按人分开查，各用各的音色配置（分镜 narration.voices）；
# 拼接、吞字、断音、可懂度这些查整条旁白的不变。原来爸爸的句子拿孩子的标准查（掉嗓子、不是同一个人、语速），点名后流水线还用孩子的声音把它重配了
VOICES = (beats.get("narration") or {}).get("voices") or {}
voices = {"": voice, **{sp: load_voice(Path(__file__).parent / v["voice"]) for sp, v in VOICES.items()}}
SP = [s.get("speaker", "") for s in timing0.get("sentences", [])]  # 每句是谁说的（dialogue.py 拼接时记的）
speakers = [sp for sp in voices if sp in SP] or [""]
dialogue = len(speakers) > 1
who = lambda sp: f"（{VOICES[sp].get('label', sp)}）" if sp else ("（主讲）" if dialogue else "")
mine = lambda sp, k: not dialogue or SP[k] == sp  # 第 k 句是不是这个人说的
for sp in speakers:
    v = voices[sp]
    xv = np.concatenate([x0[int(a * sr0):int(b * sr0)] for k, a, b in sentence_ranges() if SP[k] == sp]) if dialogue else x0
    sim = similarity(_tts, xv, sr0, v)
    check("音色一致性" + who(sp), sim >= v["minSimilarity"], f"与{'真人录音' if not sp else '这个人的参考音'}相似度 {sim:.3f}（下限 {v['minSimilarity']}）")

# 0b. 掉嗓子：浊音连续 60ms 以上掉到这个人最低自然音高以下（用户两次听出「学会」畸变就是这个，配音生成时已经拦一次，这里在拼好的成片旁白上再查一遍）
# 掉嗓子、破音落在的时刻：最后归到句子，写进 <时间线>.revoice.json，流水线据此给这几句自动换种子重配一轮（不用人手动 reseed）。
# E02 v5：配音那边拼好后查过没问题，成片旁白（48k、插了停顿、片段两头 3ms 淡入淡出）上又查出一句掉嗓子
# 点名按时刻落到具体句子（sentence_at）：(时刻, 往哪边看)。收音硬切属于前一句（往前看），起音硬切属于后一句（往后看），其余看时刻本身
revoice_at = []
def phrase_at(t, side=0.0):
    k = sentence_at(t, _spans, side)
    if k is not None:
        return f"「{timing0['sentences'][k]['text'][:10]}」"
    c = next((c for c in tl["audioClips"] if c["at"] <= t <= c["at"] + c["srcOut"] - c["srcIn"]), None)  # 旧的 timing 没有 sentences：报片段
    return f"「{c['phrase'][:10]}」" if c else ""


for sp in speakers:
    floor = voices[sp].get("pitchFloorHz", 0)  # 成年人的声音不查（写 0）：基频跟踪是按童声 90–600Hz 设的
    if not floor:
        continue
    # 按句量：判断「听得见的部分」要拿这一句自己的响度做参照，和配音时逐句自检一致；拿整段旁白做参照时，
    # 一句话里偏轻的嘎裂声在单句里算听不见、在整段里又算进去，同一处一边过一边不过（E01 v7「主」）。
    ranges = [(a, b) for k, a, b in sentence_ranges() if mine(sp, k)] or ([] if dialogue else [(0.0, len(x0) / sr0)])  # 旧的 timing 没有 sentences：整段量
    drops = [(a + s0, b + s0, f) for s0, s1 in ranges for a, b, f in pitch_drops(x0[int(s0 * sr0):int(s1 * sr0)], sr0, floor)]
    revoice_at.extend((a, 0.0) for a, _, _ in drops)
    check("没有掉嗓子" + who(sp), not drops, f"{len(drops)} 处：" + "；".join(f"{a:.2f}–{b:.2f}s{phrase_at(a)} 低到 {f:.0f}Hz" for a, b, f in drops[:5]) + f"（下限 {floor}Hz）" if drops else f"浊音都在这个声音的最低自然音高 {floor}Hz 以上")

# 0c. 语气起伏（建议，不判失败：语气是创作取舍）：在源配音上逐句量，和这个孩子真实说话比。
#     句内起伏 = 浊音基频 5%–95% 分位差几个半音；句间变化 = 各句音区（中位基频）的标准差。念课文式的配音两项都偏小
from voice import pitch_range_st, pitch_median_hz
if voice.get("pitchRangeSt") or voice.get("registerSpreadSt"):
    xs, xsr = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    tm = json.loads((root / "data" / beats["narration"]["timing"]).resolve().read_text())
    P = r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]"
    ranges, regs, k = [], [], 0
    for si, sent in enumerate([t for t in re.findall(r"[^。？！]+[。？！]?", tm["text"]) if re.sub(P, "", t)]):
        n, got, a = len(re.sub(P, "", sent)), 0, None
        while got < n and k < len(tm["words"]):
            w = tm["words"][k]; a = w["start"] if a is None else a; b = w["end"]; got += len(w["text"]); k += 1
        if not mine("", si):
            continue  # 对话：只量主讲（标定的是主讲真人说话的起伏）
        seg = xs[int(a * xsr):int(b * xsr)]
        r = pitch_range_st(seg, xsr)
        if r is not None:
            ranges.append((r, sent)); regs.append(pitch_median_hz(seg, xsr))
    if ranges:
        med_r = float(np.median([r for r, _ in ranges]))
        spread = float(np.std(12 * np.log2(np.array(regs) / np.median(regs))))
        need_r, need_s = voice.get("pitchRangeSt", 0), voice.get("registerSpreadSt", 0)
        flat = sorted(ranges)[:3]
        ok = med_r >= need_r and spread >= need_s
        print(f"[{'通过' if ok else '建议'}] 语气有起伏：{len(ranges)} 句，句内起伏中位 {med_r:.1f} 个半音（这个孩子真实说话 ≥{need_r}），"
              f"句间音区变化 {spread:.1f} 个半音（真实 ≥{need_s}）" + ("" if ok else "；最平的：" + "、".join(f"「{t[:12]}」{r:.1f}" for r, t in flat)
              + "。可以在分镜 narration.mood 里按句指定情绪参考音"))

# 0d. 背景干净：每句旁白的 DNSMOS BAK（背景噪声分，1–5，越高越干净）不低于 voice.json 的 minBak。
#     用户听 E01 v7「说话时有明显背景噪音」，音色相似度、谐噪比、电平都看不出来；BAK 按句排，最差的几句（「那怎么办？」2.66）明显比别的句子脏
min_bak = voice.get("minBak", 0)
if min_bak:
    # 在源配音上量（和配音生成时拼好的整段是同一个文件）。DNSMOS 对短片段很敏感：同一句挪 5 个采样 BAK 能差 0.2–0.3，
    # 9 秒窗挪 37 个采样能差 0.8，单句、单窗都当不了关卡；全片 9 秒窗的中位数稳定（挪动只差 ±0.05），
    # 用它拦「整条配音都脏」（比如参考音有底噪）。个别句子偏脏在配音生成时逐句筛（takeMinBak）
    from dnsmos import score as dnsmos_score
    xs0, ssr0 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    _, bw0 = dnsmos_score(xs0, ssr0, jitter=1)
    med_b = float(np.median(bw0))
    check("背景干净", med_b >= min_bak, f"整条配音 DNSMOS BAK 9 秒窗中位 {med_b:.2f}（下限 {min_bak}），10% 分位 {np.percentile(bw0, 10):.2f}")

# 0e. 说话时没有沙沙声：在源配音上逐句量浊音谱平坦度（voice.py 的 voiced_flatness），全片中位数不高于 maxFlatMedian。
#     用户听 E01 v7–v14「一开口就有背景噪声、说完就没」：那几版中位 0.128，听着干净的 0.083，真人录音 0.03–0.045
for sp in speakers:
    max_flat = voices[sp].get("maxFlatMedian", 0)
    if not max_flat:
        continue
    from voice import voiced_flatness
    xs1, ssr1 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans1 = [s for k, s in enumerate(timing0["sentences"]) if mine(sp, k)] if timing0.get("sentences") else [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    fl = sorted(((voiced_flatness(xs1[int(s["start"] * ssr1):int(s["end"] * ssr1)], ssr1), s["text"]) for s in spans1), reverse=True)
    med_fl = float(np.median([v for v, _ in fl]))
    check("说话时没有沙沙声" + who(sp), med_fl <= max_flat, f"{len(fl)} 句浊音谱平坦度中位 {med_fl:.3f}（上限 {max_flat}；真人录音约 0.03–0.045），最高的：" + "、".join(f"「{t[:8]}」{v:.3f}" for v, t in fl[:3]))

# 0f. 每句都是同一个人：源配音逐句的说话人嵌入和整集平均的余弦相似度，最低的一句不低于 minConsistency。
#     按句生成时音色会一句一句地飘（用户听 E01 v15：像几个人你一句我一句）；整段的「音色一致性」只看平均，看不出来
for sp in speakers:
    min_cons = voices[sp].get("minConsistency", 0)
    if not min_cons:
        continue
    from voice import embedding as spk_emb
    xs2, ssr2 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans2 = [s for k, s in enumerate(timing0["sentences"]) if mine(sp, k)] if timing0.get("sentences") else [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    E = []
    for s2 in spans2:
        e = spk_emb(_tts, xs2[int(s2["start"] * ssr2):int(s2["end"] * ssr2)].astype(np.float32), ssr2); E.append(e / np.linalg.norm(e))
    cen = np.mean(E, 0); cen /= np.linalg.norm(cen)
    cs = sorted(((float(e @ cen), s2["text"]) for e, s2 in zip(E, spans2)))
    check("每句都是同一个人" + who(sp), cs[0][0] >= min_cons, f"{len(cs)} 句和整集平均音色的相似度最低 {cs[0][0]:.3f}（下限 {min_cons}），中位 {np.median([c for c, _ in cs]):.3f}；最不像的：" + "、".join(f"「{t[:8]}」{c:.3f}" for c, t in cs[:3]))

# 0g/0h. 回声一致、基础响度一致（VOICE_PIPELINE.md）：在源配音上逐句量。用户听 E01 v16：一句有回音一句没有、句与句音量不一样
max_spread = voice.get("maxLevelSpreadDb", 0)
if any(voices[sp].get("maxEcho", 0) for sp in speakers) or max_spread:
    from voice import echo_ms, pause_points, active_level_db
    xs3, ssr3 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans3 = timing0.get("sentences") or [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    ec_all, lv = [], []
    for k3, s3 in enumerate(spans3):
        seg = xs3[int(s3["start"] * ssr3):int(s3["end"] * ssr3)]
        ec_all.append((echo_ms(seg, ssr3, pause_points(timing0["words"], s3["start"], s3["end"])), s3["text"], k3))
        lv.append((active_level_db(seg, ssr3), s3["text"]))
    for sp in speakers:
        max_echo = voices[sp].get("maxEcho", 0)
        ec = sorted(((e, t) for e, t, k3 in ec_all if not timing0.get("sentences") or mine(sp, k3)), reverse=True)
        if not max_echo or not ec:
            continue
        check("每句没有回声" + who(sp), ec[0][0] <= max_echo, f"{len(ec)} 句停顿处衰减 20dB 的时间最长 {ec[0][0]:.0f}ms（上限 {max_echo}；干声约 60–90ms），中位 {np.median([e for e, _ in ec]):.0f}ms；最长的：" + "、".join(f"「{t[:8]}」{e:.0f}ms" for e, t in ec[:3]))
    if max_spread:
        lv.sort()
        spread_db = lv[-1][0] - lv[0][0]  # 对话也全片一起比：各人的句子都统一到同一个 sentenceLevelDb
        check("每句基础音量一致", spread_db <= max_spread, f"{len(lv)} 句基础响度最响和最轻差 {spread_db:.1f}dB（上限 {max_spread}dB）：最轻「{lv[0][1][:8]}」{lv[0][0]:.1f}dB，最响「{lv[-1][1][:8]}」{lv[-1][0]:.1f}dB")

# 0j. 没有破音：成片旁白里音高突然跳 14 半音以上、又不是八度的地方（voice.py 的 pitch_breaks），不超过 maxBreaks 处。
#     用户听 E02 v3「好几处声音畸变」：E02 每分钟 1.9 处、E01 0.3 处，原来的检查一项都没报
if any("maxBreaks" in voices[sp] for sp in speakers):
    from voice import pitch_breaks
    xs5, ssr5 = mono(root / "public" / tl["narration"])
    bk_all = pitch_breaks(xs5, ssr5)
    near = lambda t: phrase_at(t)[1:-1]
    spk_at = lambda t: SP[k] if (k := sentence_at(t, _spans)) is not None else ""
for sp in speakers:
    if "maxBreaks" not in voices[sp]:
        continue
    bk5 = [(t, j) for t, j in bk_all if not dialogue or spk_at(t) == sp]
    if len(bk5) > voices[sp]["maxBreaks"]:
        revoice_at.extend((t, 0.0) for t, _ in bk5)
    check("没有破音" + who(sp), len(bk5) <= voices[sp]["maxBreaks"], f"{len(bk5)} 处（上限 {voices[sp]['maxBreaks']}）" + ("：" + "；".join(f"{t:.2f}s「{near(t)}」跳 {j:.0f} 半音" for t, j in bk5[:6]) if bk5 else ""))

# 0i. 连贯（建议，不拦）：句与句之间音高重新起头多大、语速稳不稳、成片里句间长停顿有几处，和上一集（voice.json 的 flowBaseline）比。
#     用户 2026-11-06：E02 要比 E01 更连贯流畅自然，要有一套一集比一集好的机制（VOICE_PIPELINE.md「连贯」）
if voice.get("flowBaseline"):
    from voice import prosody
    xs4, ssr4 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans4 = timing0.get("sentences") or []
    pr4 = []
    for k4, s4 in enumerate(spans4):
        if not mine("", k4):
            continue  # 对话：只量主讲（flowBaseline 是主讲一个人讲的那几集量的）
        ws4 = [dict(w, start=w["start"] - s4["start"], end=w["end"] - s4["start"]) for w in timing0["words"] if s4["start"] - 1e-3 <= w["start"] and w["end"] <= s4["end"] + 1e-3]
        if ws4:
            pr4.append((k4, prosody(xs4[int(s4["start"] * ssr4):int(s4["end"] * ssr4)], ssr4, ws4)))
    # 句首重新起头只比紧挨着的两句：中间隔着别人的话，主讲是在回答，重新起头是应该的
    resets = [abs(12 * np.log2(b["start"] / a["endf0"])) for (ka, a), (kb, b) in zip(pr4, pr4[1:]) if kb == ka + 1 and a["endf0"] and b["start"]]
    pr4 = [q for _, q in pr4]
    rates = np.array([q["rate"] for q in pr4])
    cl = tl["audioClips"]
    gaps = [cl[i + 1]["at"] - (cl[i]["at"] + cl[i]["srcOut"] - cl[i]["srcIn"]) for i in range(len(cl) - 1)]
    longp = sum(g > 1.5 for g in gaps)
    bl = voice["flowBaseline"]
    cmp = lambda now, before, fmt: f"{fmt.format(now)}（{bl['episode']} {fmt.format(before)}，{'好些' if now < before else '没变好'}）"
    if resets and len(rates):
        print("  [建议] 说话连贯：" + "；".join([
            f"句首比上一句句尾高出的音高中位 {cmp(float(np.median(resets)), bl['resetMedianSt'], '{:.1f}')} 半音",
            f"90% 分位 {cmp(float(np.percentile(resets, 90)), bl['resetP90St'], '{:.1f}')}",
            f"语速波动 {cmp(float(rates.std() / rates.mean()), bl['rateCv'], '{:.2f}')}",
            f"句间停顿超过 1.5 秒 {cmp(longp, bl['longPauses'], '{}')} 处（共 {len(gaps)} 处）"]))

# 0j. 声调（建议，不拦）：每个字的基频走势和按上下文该念的声调比（tone_check.py）。回转识别按上下文写字，
#     「拧（nǐng）」念成 níng 也照样写回「拧」，拼音比对查不出声调错（用户听 E03 样片：前半段有读错的）
from tone_check import check as tone_check_run
xs5, ssr5 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
try:
    print("\n".join(tone_check_run(xs5, ssr5, timing0, Path(__file__).parent / "readings.json", who)[1]))
except Exception as e:  # 只给建议的检查，自己出错也不能把旁白检查拦下
    print(f"[建议] 声调检查没跑成：{e!r}")

# 1. 拼接切点
src, ssr = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
w = int(0.01 * ssr)
bad = []
for c in tl["audioClips"]:
    a, b = int(c["srcIn"] * ssr), min(len(src), int(c["srcOut"] * ssr))
    e_in, e_out = db(src[a:a + w]), db(src[max(0, b - w):b])
    if e_in > -45:
        bad.append(f"「{c['phrase'][:6]}」入点 {c['srcIn']:.2f}s {e_in:.0f}dB")
    if e_out > -45 and b < len(src):
        bad.append(f"「{c['phrase'][:6]}」出点 {c['srcOut']:.2f}s {e_out:.0f}dB")
check("拼接切点落在静音处", not bad, "；".join(bad) if bad else f"{len(tl['audioClips'])} 段全部安静")

# 2. 吞字：不在成片上重新对齐（对齐器会把句末的字压成 0ms，实测「改成1呢」的「呢」；也会把真吞掉的字摊到邻字的声音上）。
#    用配音时按句对齐、并经回转核对过的逐字时间（timing.json），按时间线的片段映射到成片旁白上，直接量每个字的时长和响度。
narr = str(root / "public" / tl["narration"])
x, sr = mono(narr)
timing = json.loads((root / "data" / beats["narration"]["timing"]).resolve().read_text())
from voice import said_text
script = said_text(timing["text"])  # 先换念法再去标点（「1、1、0」不连成 110），和配音生成同一个口径
items = []
for c in tl["audioClips"]:
    for w in timing["words"]:
        if w["start"] >= c["srcIn"] - 1e-3 and w["end"] <= c["srcOut"] + 1e-3:
            t0, t1 = c["at"] + w["start"] - c["srcIn"], c["at"] + w["end"] - c["srcIn"]
            items.append({"text": w["text"], "t0": t0, "t1": t1})
from voice import weak_chars
med, weak = weak_chars(x, sr, items)
weak = [msg for _, msg in weak]
check("没有吞字", not weak, "；".join(weak[:8]) + (f" 等 {len(weak)} 处" if len(weak) > 8 else "") if weak else f"{len(items)} 个字（配音时逐句对齐的时间映射到成片），能量中位 {med:.0f}dB")
# 2b. 拼接完整性：成片里每段旁白必须和源配音对应片段一致（只差整体增益）。
#     逐 10ms 比较能量包络，源里在发声、成片里却明显变弱 = 有声音丢了（切错、拼错、被抹掉都会暴露）
def env(sig, rate):
    h = int(0.01 * rate)
    return np.array([db(sig[i:i + h]) for i in range(0, len(sig) - h + 1, h)])


lost = []
for c in tl["audioClips"]:
    s_seg = src[int(c["srcIn"] * ssr):int(c["srcOut"] * ssr)]
    f_seg = x[int(c["at"] * sr):int((c["at"] + c["srcOut"] - c["srcIn"]) * sr)]
    es, ef = env(s_seg, ssr), env(f_seg, sr)
    n = min(len(es), len(ef))
    es, ef = es[:n], ef[:n]
    voiced = es > -40
    if voiced.sum() < 5:
        continue
    gain = np.median(ef[voiced] - es[voiced])
    drop = voiced & (ef - es - gain < -10)
    drop[:1] = drop[-1:] = False  # 首尾 5ms 淡入淡出不算
    if drop.sum() >= 2:
        k = int(np.argmax(drop))
        lost.append(f"「{c['phrase'][:6]}」@{c['at'] + k * 0.01:.2f}s 起 {int(drop.sum()) * 10}ms 比源音频弱 10dB 以上")
check("拼接后声音完整", not lost, "；".join(lost) if lost else f"{len(tl['audioClips'])} 段与源配音一致")

# 3. 断音 / 爆音：≥5ms 的全零段，只有"两侧 20ms 都在发声（> -40dB）"才算字中间掉音
#   （TTS 在停顿处本来就输出全零，对齐的字范围常会多划进停顿，不能一律算断音）
#   句与句的接缝处（两段配音首尾相接、中间没插停顿）留下的是配音自带的句间静音，不是字中间掉音，跳过（E01 第 27/28 句）
z = np.abs(x) < 1e-7
joints = [c["at"] for c in tl["audioClips"][1:]]
dropouts, i = [], 0
while i < len(z):
    if z[i]:
        j = i
        while j < len(z) and z[j]:
            j += 1
        if j - i >= int(0.005 * sr):
            w2 = int(0.02 * sr)
            at_joint = any(i / sr - 0.01 <= jt <= j / sr + 0.01 for jt in joints)
            if not at_joint and db(x[max(0, i - w2):i]) > -40 and db(x[j:j + w2]) > -40:
                dropouts.append(f"{i / sr:.2f}s({(j - i) / sr * 1000:.0f}ms)")
        i = j
    else:
        i += 1
jumps = int((np.abs(np.diff(x)) > 0.5).sum())
check("发声中无断音/爆音", not dropouts and jumps == 0, f"字中间掉音 {len(dropouts)} 处{('：' + '、'.join(dropouts)) if dropouts else ''}，突跳 {jumps} 处")

# 4. 总混可懂度
if tl.get("audio"):
    asr = load_stt(str(Path(__file__).parent / "models/Qwen3-ASR-0.6B"))
    from voice import read_numbers
    # 分块识别（qwen_clone.py 的整段回转一样）：十分钟的总混一次识别会整段漏掉（E03 v2 漏了约 90 秒）。
    # 在旁白片段之间的停顿正中切成不超过 30 秒的几块，块里几句照样拼着识别
    xm, srm = sf.read(str(root / "public" / tl["audio"]), dtype="float32")
    clips = sorted(tl["audioClips"], key=lambda c: c["at"])
    cuts, start = [0.0], clips[0]["at"] if clips else 0.0
    for a_, b_ in zip(clips, clips[1:]):
        if b_["at"] + b_["srcOut"] - b_["srcIn"] - start > 30.0:
            cuts.append((a_["at"] + a_["srcOut"] - a_["srcIn"] + b_["at"]) / 2); start = b_["at"]
    cuts.append(len(xm) / srm)
    import tempfile
    parts = []
    for c0, c1 in zip(cuts, cuts[1:]):
        with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
            sf.write(tf.name, xm[int(c0 * srm):int(c1 * srm)], srm)
            parts.append(asr.generate(tf.name, language="Chinese").text)
    hyp = said_text("".join(parts))
    from pypinyin import lazy_pinyin  # 按拼音比：同音字不算错（成/乘），读错的音仍算错
    DIG = str.maketrans("0123456789", "零一二三四五六七八九")
    from voice import read_numbers
    r = lazy_pinyin(read_numbers(script.lower()), errors=lambda x: list(x))
    h = lazy_pinyin(read_numbers(hyp.lower()), errors=lambda x: list(x))
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    cer = d[len(h)] / max(1, len(r))
    check("总混可懂度", cer <= 0.02, f"拼音错误率 {cer:.3f}" + ("" if cer <= 0.02 else f"，识别为：{hyp}"))

# 0k. 起音收音不硬切：声音从纯静音 2ms 里就起到 -35dB 以上，或者说着说着一下子断成纯静音（voice.py 的 hard_edges）。
#     用户听 E02 v5「1:20 有个突兀的声音」：「权重越大」的「权」2ms 里从静音跳到 -20dB，剪开头串进来的字时切在了发声处
from voice import hard_edges, art_rate
he = hard_edges(x0, sr0)
# 时刻落到具体句子：收音硬切往前看、起音硬切往后看（E05 558 秒「回到那三条规则。」句尾收音硬切，原来按整个片段点名，换种子换成了同一片段里的「第二条说……」）
EDGE_SIDE = {"收": -0.02, "起": 0.02}
revoice_at.extend((t, EDGE_SIDE.get(k, 0.0)) for k, t, _ in he)
check("起音收音不硬切", not he, f"{len(he)} 处：" + "；".join(f"{t:.2f}s{phrase_at(t, EDGE_SIDE.get(k, 0.0))}{k}音 {d:.0f}dB" for k, t, d in he[:6]) if he else "每个字头字尾都是渐起渐落")

# 0l. 语速一致：每句只算嘴在动的时间的语速（voice.py 的 art_rate），离这个声音的语速 rate.target 不超过 rate.maxDev。
#     用户听 E02 v5「有的地方突然加快语速，语速要基本保持一致，情绪、音调可以随内容自然变化」：各句 3.1–5.0 字/秒，相邻两句差到 20%
for spk in speakers:
    RATE = voices[spk].get("rate") or {}
    if not (RATE.get("target") and timing0.get("sentences")):
        continue
    rates = []
    for k, sp in enumerate(timing0["sentences"]):
        ws = [w for w in timing0["words"] if sp["start"] - 0.01 <= w["start"] < sp["end"] + 0.01]
        if ws and mine(spk, k) and sum(len(w["text"]) for w in ws) >= RATE.get("minChars", 3):  # 一两个字的句子（「哦。」）量不出语速
            rates.append((k, art_rate(ws), sp))
    off = [(k, r, sp) for k, r, sp in rates if abs(r / RATE["target"] - 1) > RATE.get("maxDev", 0.10)]
    for k, r, sp in off:
        revoice_at.extend((a + 0.01, 0.0) for kk, a, b in sentence_ranges() if kk == k)
    rs = [r for _, r, _ in rates]
    check("语速一致" + who(spk), not off, (f"{len(off)} 句离 {RATE['target']} 字/秒超过 {RATE.get('maxDev', 0.10):.0%}：" + "；".join(f"「{sp['text'][:10]}」{r:.2f}" for _, r, sp in off[:6]) + "；")
          * bool(off) + f"全片每句 {min(rs):.2f}–{max(rs):.2f} 字/秒，波动 {np.std(rs) / np.mean(rs):.2f}")

# 0m. 像同一个人在自然地说话（VOICE_PIPELINE.md「像同一个人」）。用户听 E02 v13：「每句话的声音都存在微小差异（包括音色、快慢、音量），
#     给人一种不是同一个人在自然的说话的感觉」。音色用 CAM++（campplus.py）量：0f 用的 Qwen3 嵌入在同一个声音和别人的声音之间只差 0.987 对 0.932，
#     又是生成时挑候选的那把尺子；CAM++ 是 0.78 对 0.16。
#     - 像这个孩子（关卡）：整集各句 CAM++ 嵌入的平均和声音包比。两轮盲听用户都选了 E02 v13（0.60），没选「只用说话人嵌入」的新配法（0.42）。
#     - 相邻两句接得上、整集不越说越偏（建议）：相邻两句的音色、响度、语速差，后三分之一对前三分之一的漂移。这几项变好的配法（新配法相邻音色差
#       0.10、v13 0.20；v13 只加语速拉齐和响度统一）盲听都没赢过 v13，所以只报数、不拦，留着看下一集比上一集。
for spk in speakers:
    SS = voices[spk].get("sameSpeaker") or {}
    if not (SS and timing0.get("sentences")):
        continue
    import campplus
    from consistency import lufs as _lufs
    if not campplus.MODEL.exists():
        check("像这个孩子" + who(spk), False, f"缺 CAM++ 模型 {campplus.MODEL}（tts/fetch_models.sh 会下载）")
    else:
        xs6, ssr6 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
        K6 = [k for k in range(len(timing0["sentences"])) if mine(spk, k)]  # 这个人说的句子（在全片里的下标）
        sp6 = [timing0["sentences"][k] for k in K6]
        segs6 = [xs6[int(s["start"] * ssr6):int(s["end"] * ssr6)] for s in sp6]
        ws6 = [[w for w in timing0["words"] if s["start"] - 0.01 <= w["start"] < s["end"] + 0.01] for s in sp6]
        min_sec = SS.get("minSec", 1.5)  # 太短的句子（「它看三件事。」1.4 秒）说话人嵌入本来就抖，不拿来比音色
        cam = [campplus.embedding(g, ssr6) if len(g) >= min_sec * ssr6 else None for g in segs6]
        ok_c = [c for c in cam if c is not None]
        nm = lambda v: v / np.linalg.norm(v)
        if SS.get("minIdentity") and ok_c:
            P6 = campplus.embedding(*sf.read(str(Path(__file__).parent / voices[spk]["ref"]), dtype="float32"))
            ident6 = float(nm(np.mean(ok_c, 0)) @ P6)
            per6 = sorted((float(c @ P6), sp6[k]["text"]) for k, c in enumerate(cam) if c is not None)
            check(("像这个孩子" if not spk else "像这个人") + who(spk), ident6 >= SS["minIdentity"], f"整集 CAM++ 平均对声音包 {ident6:.3f}（下限 {SS['minIdentity']}{'' if spk else '；E02 v13 0.58'}）；最不像的："
                  + "、".join(f"「{t[:8]}」{v:.2f}" for v, t in per6[:3]))
        L6 = [_lufs(g, ssr6) for g in segs6]
        R6 = [art_rate(w) if w else 0.0 for w in ws6]
        bad6, pairs = [], []
        for k in range(len(sp6) - 1):
            if K6[k + 1] != K6[k] + 1:
                continue  # 中间隔着别人的话：一问一答，重新起头
            msg = []
            if cam[k] is not None and cam[k + 1] is not None:
                d = 1 - float(cam[k] @ cam[k + 1]); pairs.append(d)
                if d > SS.get("maxPairTimbre", 9):
                    msg.append(f"音色差 {d:.2f}（上限 {SS['maxPairTimbre']}）")
            if abs(L6[k] - L6[k + 1]) > SS.get("maxPairLu", 99):
                msg.append(f"响度差 {abs(L6[k] - L6[k + 1]):.1f} LU（上限 {SS['maxPairLu']}）")
            if R6[k] and R6[k + 1] and abs(R6[k] / R6[k + 1] - 1) > SS.get("maxPairRate", 9):
                msg.append(f"语速差 {abs(R6[k] / R6[k + 1] - 1):.0%}（上限 {SS['maxPairRate']:.0%}）")
            if msg:
                bad6.append((k, msg))
        med6 = float(np.median(pairs)) if pairs else 0.0
        ok6 = not bad6 and med6 <= SS.get("maxMedianTimbre", 9)
        print(f"[{'通过' if ok6 else '建议'}] 相邻两句接得上{who(spk)}：" + (f"{len(bad6)} 处接不上：" + "；".join(f"「{sp6[k]['text'][:8]}」→「{sp6[k + 1]['text'][:8]}」" + "、".join(m) for k, m in bad6[:5]) + "；") * bool(bad6)
              + f"相邻两句 CAM++ 音色距离中位 {med6:.3f}（上限 {SS.get('maxMedianTimbre', '—')}{'' if spk else '；E02 v13 0.24'}）、90% 分位 {np.percentile(pairs, 90) if pairs else 0:.3f}，"
              f"响度相邻差最大 {max(abs(a - b) for a, b in zip(L6, L6[1:])):.1f} LU，语速相邻差最大 {max((abs(a / b - 1) for a, b in zip(R6, R6[1:]) if a and b), default=0):.0%}")
        # 整集不越说越偏：后三分之一和前三分之一比（一次配长段时越说越低、越说越快、越说越响就是它）
        n6 = len(sp6); t6 = max(1, n6 // 3)
        f06 = [pitch_median_hz(g, ssr6) or 0 for g in segs6]
        reg = lambda ks: float(np.mean([12 * np.log2(f06[k]) for k in ks if f06[k]])) if any(f06[k] for k in ks) else 0.0
        first, last = range(t6), range(n6 - t6, n6)
        dr_st = reg(last) - reg(first)
        dr_lu = float(np.mean([L6[k] for k in last]) - np.mean([L6[k] for k in first]))
        rr = lambda ks: float(np.mean([R6[k] for k in ks if R6[k]] or [1.0]))
        dr_rate = rr(last) / rr(first) - 1
        cf = [cam[k] for k in first if cam[k] is not None]; cl = [cam[k] for k in last if cam[k] is not None]
        dr_cam = 1 - float(nm(np.mean(cf, 0)) @ nm(np.mean(cl, 0))) if cf and cl else 0.0
        drift_bad = [m for m, bad in [(f"音区 {dr_st:+.1f} 半音（上限 ±{SS.get('maxDriftSt')}）", abs(dr_st) > SS.get("maxDriftSt", 99)),
                                      (f"响度 {dr_lu:+.1f} LU（上限 ±{SS.get('maxDriftLu')}）", abs(dr_lu) > SS.get("maxDriftLu", 99)),
                                      (f"语速 {dr_rate:+.0%}（上限 ±{SS.get('maxDriftRate', 9):.0%}）", abs(dr_rate) > SS.get("maxDriftRate", 9)),
                                      (f"音色 {dr_cam:.3f}（上限 {SS.get('maxDriftTimbre')}）", dr_cam > SS.get("maxDriftTimbre", 9))] if bad]
        if n6 >= 15:  # 对话里只说几句的人（爸爸 10 句）拿前后三分之一比没有意义
            print(f"[{'通过' if not drift_bad else '建议'}] 整集不越说越偏{who(spk)}：后三分之一比前三分之一：" + ("；".join(drift_bad) if drift_bad else
                  f"音区 {dr_st:+.1f} 半音、响度 {dr_lu:+.1f} LU、语速 {dr_rate:+.0%}、音色（CAM++ 平均）{dr_cam:.3f}"))

rv_path = Path(sys.argv[1]).with_suffix(".revoice.json")
rv = sorted({timing0["sentences"][k]["text"] for t, side in revoice_at if (k := sentence_at(t, _spans, side)) is not None}) if timing0.get("sentences") else []
if rv:
    rv_path.write_text(json.dumps(rv, ensure_ascii=False, indent=1))
    print(f"要换种子重配的句子：{len(rv)} 句（{rv_path.name}）")
elif rv_path.exists():
    rv_path.unlink()
print(f"\n旁白检查失败 {len(fails)} 项")
sys.exit(1 if fails else 0)
