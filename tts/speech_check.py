"""旁白完整性检查（每项都能失败，失败即非零退出）。ASR 回转会按上下文"脑补"半个字，所以不能只看字错率。
检查：
  0. 音色一致性：成片旁白的说话人嵌入与真人录音质心的相似度不低于 voice.json 的下限（防止音色漂移或误用别的配音）。
  1. 拼接切点：时间线里每段旁白的入点/出点，在源音频上必须落在安静处（10ms 窗 ≤ -45 dBFS）。
  2. 吞字：配音时逐句对齐的逐字时间映射到成片旁白，每个字时长 ≥ 50ms，且能量不低于中位数 18 dB 以上。
  3. 断音/爆音：两侧都在发声的 ≥5ms 全零段（字中间掉音）不得出现，不得有相邻采样突跳。
  4. 总混可懂度：带书写声和音乐的总混，ASR 回转字错率 ≤ 2%。
另有一项只给建议、不判失败：语气起伏（句内起伏和句间音区变化，和 voice.json 里按真人录音标定的值比）。
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
sim = similarity(_tts, x0, sr0, voice)
check("音色一致性", sim >= voice["minSimilarity"], f"与真人录音相似度 {sim:.3f}（下限 {voice['minSimilarity']}）")

# 0b. 掉嗓子：浊音连续 60ms 以上掉到这个人最低自然音高以下（用户两次听出「学会」畸变就是这个，配音生成时已经拦一次，这里在拼好的成片旁白上再查一遍）
floor = voice.get("pitchFloorHz", 0)
timing0 = json.loads((root / "data" / beats["narration"]["timing"]).resolve().read_text())
# 每句在成片旁白上的范围 = 这句配音（timing 的 sentences）切出来的所有片段，从第一段开头到最后一段结尾。
# 片段在句间停顿中间切开，起止会伸出这句配音 0.2 秒左右，所以按重叠最多归句（只认「完全落在句内」的话一个都对不上）
def sentence_ranges():
    S = timing0.get("sentences", [])
    overlap = lambda c, s: min(c["srcOut"], s["end"]) - max(c["srcIn"], s["start"])
    owner = [max(range(len(S)), key=lambda k: overlap(c, S[k])) if S else None for c in tl["audioClips"]]
    for k in range(len(S)):
        cs = [c for c, o in zip(tl["audioClips"], owner) if o == k]
        if cs:
            yield k, min(c["at"] for c in cs), max(c["at"] + c["srcOut"] - c["srcIn"] for c in cs)


if floor:
    # 按句量：判断「听得见的部分」要拿这一句自己的响度做参照，和配音时逐句自检一致；拿整段旁白做参照时，
    # 一句话里偏轻的嘎裂声在单句里算听不见、在整段里又算进去，同一处一边过一边不过（E01 v7「主」）。
    ranges = [(a, b) for _, a, b in sentence_ranges()] or [(0.0, len(x0) / sr0)]  # 旧的 timing 没有 sentences：整段量
    drops = [(a + s0, b + s0, f) for s0, s1 in ranges for a, b, f in pitch_drops(x0[int(s0 * sr0):int(s1 * sr0)], sr0, floor)]
    def phrase_at(t):
        c = next((c for c in tl["audioClips"] if c["at"] <= t < c["at"] + c["srcOut"] - c["srcIn"]), None)
        return f"「{c['phrase'][:10]}」" if c else ""
    check("没有掉嗓子", not drops, f"{len(drops)} 处：" + "；".join(f"{a:.2f}–{b:.2f}s{phrase_at(a)} 低到 {f:.0f}Hz" for a, b, f in drops[:5]) + f"（下限 {floor}Hz）" if drops else f"浊音都在这个声音的最低自然音高 {floor}Hz 以上")

# 0c. 语气起伏（建议，不判失败：语气是创作取舍）：在源配音上逐句量，和这个孩子真实说话比。
#     句内起伏 = 浊音基频 5%–95% 分位差几个半音；句间变化 = 各句音区（中位基频）的标准差。念课文式的配音两项都偏小
from voice import pitch_range_st, pitch_median_hz
if voice.get("pitchRangeSt") or voice.get("registerSpreadSt"):
    xs, xsr = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    tm = json.loads((root / "data" / beats["narration"]["timing"]).resolve().read_text())
    P = r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]"
    ranges, regs, k = [], [], 0
    for sent in [t for t in re.findall(r"[^。？！]+[。？！]?", tm["text"]) if re.sub(P, "", t)]:
        n, got, a = len(re.sub(P, "", sent)), 0, None
        while got < n and k < len(tm["words"]):
            w = tm["words"][k]; a = w["start"] if a is None else a; b = w["end"]; got += len(w["text"]); k += 1
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
max_flat = voice.get("maxFlatMedian", 0)
if max_flat:
    from voice import voiced_flatness
    xs1, ssr1 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans1 = timing0.get("sentences") or [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    fl = sorted(((voiced_flatness(xs1[int(s["start"] * ssr1):int(s["end"] * ssr1)], ssr1), s["text"]) for s in spans1), reverse=True)
    med_fl = float(np.median([v for v, _ in fl]))
    check("说话时没有沙沙声", med_fl <= max_flat, f"{len(fl)} 句浊音谱平坦度中位 {med_fl:.3f}（上限 {max_flat}；真人录音约 0.03–0.045），最高的：" + "、".join(f"「{t[:8]}」{v:.3f}" for v, t in fl[:3]))

# 0f. 每句都是同一个人：源配音逐句的说话人嵌入和整集平均的余弦相似度，最低的一句不低于 minConsistency。
#     按句生成时音色会一句一句地飘（用户听 E01 v15：像几个人你一句我一句）；整段的「音色一致性」只看平均，看不出来
min_cons = voice.get("minConsistency", 0)
if min_cons:
    from voice import embedding as spk_emb
    xs2, ssr2 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans2 = timing0.get("sentences") or [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    E = []
    for s2 in spans2:
        e = spk_emb(_tts, xs2[int(s2["start"] * ssr2):int(s2["end"] * ssr2)].astype(np.float32), ssr2); E.append(e / np.linalg.norm(e))
    cen = np.mean(E, 0); cen /= np.linalg.norm(cen)
    cs = sorted(((float(e @ cen), s2["text"]) for e, s2 in zip(E, spans2)))
    check("每句都是同一个人", cs[0][0] >= min_cons, f"{len(cs)} 句和整集平均音色的相似度最低 {cs[0][0]:.3f}（下限 {min_cons}），中位 {np.median([c for c, _ in cs]):.3f}；最不像的：" + "、".join(f"「{t[:8]}」{c:.3f}" for c, t in cs[:3]))

# 0g/0h. 回声一致、基础响度一致（VOICE_PIPELINE.md）：在源配音上逐句量。用户听 E01 v16：一句有回音一句没有、句与句音量不一样
max_echo, max_spread = voice.get("maxEcho", 0), voice.get("maxLevelSpreadDb", 0)
if max_echo or max_spread:
    from voice import echo_ms, pause_points, active_level_db
    xs3, ssr3 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans3 = timing0.get("sentences") or [{"text": c["phrase"], "start": c["srcIn"], "end": c["srcOut"]} for c in tl["audioClips"]]
    ec, lv = [], []
    for s3 in spans3:
        seg = xs3[int(s3["start"] * ssr3):int(s3["end"] * ssr3)]
        ec.append((echo_ms(seg, ssr3, pause_points(timing0["words"], s3["start"], s3["end"])), s3["text"]))
        lv.append((active_level_db(seg, ssr3), s3["text"]))
    if max_echo:
        ec.sort(reverse=True)
        check("每句没有回声", ec[0][0] <= max_echo, f"{len(ec)} 句停顿处衰减 20dB 的时间最长 {ec[0][0]:.0f}ms（上限 {max_echo}；干声约 60–90ms），中位 {np.median([e for e, _ in ec]):.0f}ms；最长的：" + "、".join(f"「{t[:8]}」{e:.0f}ms" for e, t in ec[:3]))
    if max_spread:
        lv.sort()
        sp = lv[-1][0] - lv[0][0]
        check("每句基础音量一致", sp <= max_spread, f"{len(lv)} 句基础响度最响和最轻差 {sp:.1f}dB（上限 {max_spread}dB）：最轻「{lv[0][1][:8]}」{lv[0][0]:.1f}dB，最响「{lv[-1][1][:8]}」{lv[-1][0]:.1f}dB")

# 0j. 没有破音：成片旁白里音高突然跳 14 半音以上、又不是八度的地方（voice.py 的 pitch_breaks），不超过 maxBreaks 处。
#     用户听 E02 v3「好几处声音畸变」：E02 每分钟 1.9 处、E01 0.3 处，原来的检查一项都没报
if "maxBreaks" in voice:
    from voice import pitch_breaks
    xs5, ssr5 = mono(root / "public" / tl["narration"])
    bk5 = pitch_breaks(xs5, ssr5)
    near = lambda t: next((c["phrase"][:10] for c in tl["audioClips"] if c["at"] <= t <= c["at"] + c["srcOut"] - c["srcIn"]), "")
    check("没有破音", len(bk5) <= voice["maxBreaks"], f"{len(bk5)} 处（上限 {voice['maxBreaks']}）" + ("：" + "；".join(f"{t:.2f}s「{near(t)}」跳 {j:.0f} 半音" for t, j in bk5[:6]) if bk5 else ""))

# 0i. 连贯（建议，不拦）：句与句之间音高重新起头多大、语速稳不稳、成片里句间长停顿有几处，和上一集（voice.json 的 flowBaseline）比。
#     用户 2026-11-06：E02 要比 E01 更连贯流畅自然，要有一套一集比一集好的机制（VOICE_PIPELINE.md「连贯」）
if voice.get("flowBaseline"):
    from voice import prosody
    xs4, ssr4 = mono(root / "public" / tl.get("source", beats["narration"]["audio"]))
    spans4 = timing0.get("sentences") or []
    pr4 = []
    for s4 in spans4:
        ws4 = [dict(w, start=w["start"] - s4["start"], end=w["end"] - s4["start"]) for w in timing0["words"] if s4["start"] - 1e-3 <= w["start"] and w["end"] <= s4["end"] + 1e-3]
        if ws4:
            pr4.append(prosody(xs4[int(s4["start"] * ssr4):int(s4["end"] * ssr4)], ssr4, ws4))
    resets = [abs(12 * np.log2(b["start"] / a["endf0"])) for a, b in zip(pr4, pr4[1:]) if a["endf0"] and b["start"]]
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
script = re.sub(r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]", "", timing["text"])
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
    hyp = re.sub(r"[，。；：！？、,.;:!?\"“”'‘’（）()—\s-]", "", asr.generate(str(root / "public" / tl["audio"]), language="Chinese").text)
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

print(f"\n旁白检查失败 {len(fails)} 项")
sys.exit(1 if fails else 0)
