"""混音：旁白 + 铅笔书写声（按每一笔生成）+ 背景音乐（人声出现时自动压低）+ 顿悟点音效 → 统一响度。
书写声和音乐优先用真实的 CC0 录音（风格规范 audio.pencilSamples、audio.music.track，文件由 audio/fetch_cc0.sh 下载到 assets.local/cc0/，不进仓库）；
没有这些文件时退回程序合成，并在输出里写明。随机数固定，同一份时间线和素材每次混出来一样。
用法：../.venv-qa/bin/python audio/mix.py build/<id>.timeline.json
"""
import json
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
from scipy.signal import filtfilt, resample_poly
import soundfile as sf

SR = 48000
tl_path = Path(sys.argv[1])
tl = json.loads(tl_path.read_text())
N = int(tl["duration"] * SR) + SR
rng = np.random.default_rng(20261103)
meter = pyln.Meter(SR)
AU = tl["style"]["audio"]  # 电平与音乐参数来自风格规范


def bandpass(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    # 柔和斜率：两侧用余弦过渡一个倍频程
    g = np.clip((np.log2(f + 1e-9) - np.log2(lo / 2)) / 1.0, 0, 1) * np.clip((np.log2(hi * 2) - np.log2(f + 1e-9)) / 1.0, 0, 1)
    return np.fft.irfft(X * np.sin(g * np.pi / 2) ** 2, len(x))


def set_lufs(x, target):
    cur = meter.integrated_loudness(x)
    return x * 10 ** ((target - cur) / 20) if np.isfinite(cur) else x


def compress(x, c):
    """人声轻压缩：10ms RMS 电平超过阈值的部分按比例压低；增益曲线零相位平滑（离线处理，相当于有预读，不会冲过头）"""
    win = int(c["window"] * SR)
    lvl = 10 * np.log10(uniform_filter1d(x ** 2, win) + 1e-12)
    gr = maximum_filter1d(np.maximum(0, lvl - c["threshold"]) * (1 - 1 / c["ratio"]), win)
    a = np.exp(-1 / (c["tau"] * SR))
    return x * 10 ** (-filtfilt([1 - a], [1, -a], gr) / 20)


def limit(x, ceil_db, look):
    """真峰值限幅：4 倍过采样估峰，预读窗口内取最小增益再均值平滑（窗口嵌套，峰值处的增益不会高于所需）"""
    pk = np.abs(resample_poly(x, 4, 1))[: 4 * len(x)].reshape(-1, 4).max(1)
    g = np.minimum(1, 10 ** (ceil_db / 20) / np.maximum(pk, 1e-12))
    w = int(look * SR)
    return x * uniform_filter1d(minimum_filter1d(g, 2 * w + 1), w + 1)


# ---------- 旁白：按时间线把源配音各片段逐采样放到新位置（只插停顿，不变速），3ms 淡入淡出，统一到 -16 LUFS ----------
import subprocess
import imageio_ffmpeg
src48 = Path("build") / f"{tl['beatsId']}.src48k.wav"
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", "public/" + tl["source"], "-ac", "1", "-ar", str(SR), str(src48)], check=True)
src, _ = sf.read(src48, dtype="float64")
voice = np.zeros(N)
fade = int(0.003 * SR)
for c in tl["audioClips"]:
    seg = src[int(round(c["srcIn"] * SR)):int(round(c["srcOut"] * SR))].copy()
    seg[:fade] *= np.linspace(0, 1, fade)
    seg[-fade:] *= np.linspace(1, 0, fade)
    i = int(round(c["at"] * SR))
    voice[i:i + len(seg)] += seg[: max(0, N - i)]
voice = voice * 10 ** ((AU["voiceLufs"] - meter.integrated_loudness(voice)) / 20)
sf.write("public/" + tl["narration"], voice.astype(np.float32), SR)

ASSETS = Path("assets.local/cc0")


def load(name):
    """读一份素材，转成单声道 48kHz；没有这个文件返回 None。"""
    p = ASSETS / name if name else None
    if not p or not p.exists():
        return None
    x, sr = sf.read(p, dtype="float64")
    x = x.mean(axis=1) if x.ndim > 1 else x
    g = np.gcd(SR, sr)
    return resample_poly(x, SR // g, sr // g)


def stroke_env(n, press_pts):
    """一笔的包络：起笔、收笔各一小段渐入渐出，中间跟着这一笔的压力曲线。"""
    pr = np.array(press_pts)
    press = np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(pr)), pr)
    env = np.ones(n)
    att, rel = min(n // 3, int(0.006 * SR)), min(n // 3, int(0.02 * SR))
    env[:att] = np.linspace(0, 1, att) ** 2
    env[-rel:] = np.linspace(1, 0, rel) ** 2
    return env, press


# ---------- 铅笔书写声：优先用真实录音（CC0）。每一笔从录音里「正在写」的地方截一段，按这一笔的长度、压力调形 ----------
pencil = [y for y in (load(n) for n in AU.get("pencilSamples", [])) if y is not None]

# （v1 用连续白噪声，用户反馈"太大、太假"；改为颗粒式合成并大幅降低电平）
pools = []
for y in pencil:
    e = np.sqrt(np.maximum(uniform_filter1d(y ** 2, int(0.02 * SR)), 0))  # 重采样后的录音在静音处滤波会出极小的负数，开方成 NaN，整份录音就找不到「正在写」的段
    pools.append((y, e > e.max() * 10 ** (-25 / 20)))  # 20ms 包络高于峰值 -25dB 算「正在写」
grains = np.zeros(N)   # 颗粒冲激
rub = np.zeros(N)      # 纸面摩擦底噪
real = np.zeros(N)     # 真实录音拼出来的书写声
for s in tl["strokes"] if pools else []:
    a, b = int(s["t0"] * SR), int(s["t1"] * SR)
    n = b - a
    if n < 64:
        continue
    y, on = pools[rng.integers(len(pools))]
    st = 0
    for _ in range(30):  # 找一段八成以上都在写的
        st = int(rng.integers(0, max(1, len(y) - n)))
        if on[st:st + n].mean() > 0.8:
            break
    seg = np.resize(y[st:st + n], n)  # 录音比这一笔短时循环补齐
    env, press = stroke_env(n, [p[2] for p in s["pts"]])
    real[a:b] += seg * env * press * 10 ** (rng.normal(0, 2) / 20)
for s in tl["strokes"] if not pools else []:
    a, b = int(s["t0"] * SR), int(s["t1"] * SR)
    n = b - a
    if n < 64:
        continue
    speed = s["len"] / max(1e-3, s["t1"] - s["t0"])
    sp = np.clip(speed / 700, 0.3, 1.6)
    # 把该笔的压力曲线拉伸到采样长度
    pr = np.array([p[2] for p in s["pts"]])
    press = np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(pr)), pr)
    env = np.ones(n)
    att, rel = min(n // 3, int(0.006 * SR)), min(n // 3, int(0.02 * SR))
    env[:att] = np.linspace(0, 1, att) ** 2
    env[-rel:] = np.linspace(1, 0, rel) ** 2
    rate = (350 + 650 * sp) * press               # 每秒颗粒数，随速度和压力变化
    hits = rng.random(n) < rate / SR
    amps = rng.gamma(2.0, 0.5, n) * hits * env * press
    grains[a:b] += amps * rng.choice([-1, 1], n)
    rub[a:b] += rng.standard_normal(n) * env * press * 0.12 * sp
# 每个颗粒是一个约 1ms 的衰减小噪声脉冲（纸纤维的"嚓"）
kt = np.arange(int(0.0012 * SR)) / SR
kernel = rng.standard_normal(len(kt)) * np.exp(-kt / 0.00035)
L = len(grains) + len(kernel)
grains = np.fft.irfft(np.fft.rfft(grains, L) * np.fft.rfft(kernel, L), L)[:N]
foley = bandpass(real, 300, 12000) if pools else bandpass(grains, 2500, 9000) + bandpass(rub, 900, 3200)
print(f"书写声：{'CC0 录音 ' + str(len(pools)) + ' 份（' + '、'.join(AU.get('pencilSamples', [])) + '）' if pools else '程序合成（没有 assets.local/cc0/ 里的录音，见 audio/fetch_cc0.sh）'}")

# ---------- 背景音乐：优先用风格规范指定的 CC0 曲目（不够长就循环，接缝处交叉淡化）；没有文件时用下面的合成占位 ----------
track = load(AU["music"].get("track"))


def looped(y, n, xf=int(1.5 * SR)):
    out = y.copy()
    while len(out) < n:
        k = min(xf, len(y) // 4)
        r = np.linspace(0, 1, k)
        out = np.concatenate([out[:-k], out[-k:] * (1 - r) + y[:k] * r, y[k:]])
    return out[:n]


# 合成占位：F 大调 I–vi–IV–V，80 BPM，低音 + 高音区拨弦琶音，加简单混响
def tone(freq, dur, partials=((1, 1.0), (2, 0.35), (3, 0.12)), decay=1.2, attack=0.006):
    t = np.arange(int(dur * SR)) / SR
    y = sum(amp * np.sin(2 * np.pi * freq * k * t) * np.exp(-t * decay * k) for k, amp in partials)
    y[: int(attack * SR)] *= np.linspace(0, 1, int(attack * SR))
    return y


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


def add(buf, i, y):
    i = max(0, i)
    n = min(len(y), len(buf) - i)
    if n > 0:
        buf[i:i + n] += y[:n]


beat = 60 / AU["music"]["bpm"]
chords = AU["music"]["progression"]  # 默认 F, Dm, Bb, C（低音 + 三个上方音）
music = np.zeros(N + 4 * SR)
bar = 0
t = 0.0
while t < tl["duration"] + 2:
    ch = chords[bar % 4]
    for k in (0, 2):  # 低音：每小节第 1、3 拍
        i = int((t + k * beat) * SR)
        y = tone(midi(ch[0] - 12), 2 * beat, ((1, 1.0), (2, 0.25)), decay=1.4, attack=0.03) * 0.9
        add(music, i, y)
    arp = [ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 24, ch[3] + 12, ch[2] + 12, ch[3] + 12]
    for k, m in enumerate(arp):  # 八分音符琶音，轻微的人性化时值与力度
        if rng.random() < 0.18:
            continue
        i = int((t + k * beat / 2 + rng.normal(0, 0.008)) * SR)
        y = tone(midi(m), 1.6, decay=2.6) * rng.uniform(0.25, 0.42)
        add(music, i, y)
    t += 4 * beat
    bar += 1
ir_t = np.arange(int(1.4 * SR)) / SR
ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 4.2)
ir[0] = 6.0
wet = np.fft.irfft(np.fft.rfft(music, len(music) + len(ir)) * np.fft.rfft(ir, len(music) + len(ir)))[: len(music)]
music = (music + 0.18 * wet / (np.abs(wet).max() + 1e-9) * np.abs(music).max())[:N]
music = bandpass(looped(track, N) if track is not None else music, 70, 9000)
print(f"音乐：{AU['music'].get('track') + '（CC0）' if track is not None else '程序合成占位（没有 assets.local/cc0/ 里的曲目，见 audio/fetch_cc0.sh）'}")
fade = np.ones(N)
fi, fo = int(0.8 * SR), int(1.5 * SR)
fade[:fi] = np.linspace(0, 1, fi)
end = int(tl["duration"] * SR)
fade[end - fo:end] = np.linspace(1, 0, fo)
fade[end:] = 0
# 休止：风格规范 audio.music.rest 列出的章节里音乐淡出，只留人声和笔声；下一节开头再淡入（用在要专心听的核心推理段）
rest = AU["music"].get("rest", [])
chap = tl.get("chapters", [])
unknown = [r for r in rest if r not in {c["title"] for c in chap}]
if unknown:
    sys.exit(f"audio.music.rest 里的章节不存在：{'、'.join(unknown)}（现有：{'、'.join(c['title'] for c in chap)}）")
rf = int(AU["music"].get("restFade", 3.0) * SR)
for i, c in enumerate(chap):
    if c["title"] not in rest:
        continue
    a, b = int(c["t"] * SR), int((chap[i + 1]["t"] if i + 1 < len(chap) else tl["duration"]) * SR)
    g = np.ones(N)
    g[a:b] = 0
    g[max(0, a - rf):a] = np.linspace(1, 0, a - max(0, a - rf))  # 在节前淡完，换节时已经静了
    g[b:min(N, b + rf)] = np.linspace(0, 1, min(N, b + rf) - b)
    fade *= g
if rest:
    print(f"音乐休止：{'、'.join(rest)}")
music *= fade

# 人声出现时把音乐压低（侧链式闪避），用旁白片段时间表，平滑过渡
duck_db = np.full(N, 0.0)
clips = sorted((c["at"], c["at"] + c["srcOut"] - c["srcIn"]) for c in tl["audioClips"])
for a, b in clips:
    duck_db[int(a * SR):int(b * SR)] = AU["duckDb"]
# 句间停顿短于 duckHoldGap 秒时音乐不回升：每个小停顿里音乐都冒上来，听着像说话时有背景噪音（用户听 E01 v7；DNSMOS 说话段最差窗 1.76 → 2.60）
hold = AU.get("duckHoldGap", 0)
for (a0, b0), (a1, b1) in zip(clips, clips[1:]):
    if a1 - b0 < hold:
        duck_db[int(b0 * SR):int(a1 * SR)] = AU["duckDb"]
k = int(0.25 * SR)
duck_db = uniform_filter1d(duck_db, k, mode="constant")  # 0.25 秒滑动平均（和 np.convolve 同结果，快几百倍：原来一个画幅要 42 秒）
music *= 10 ** (duck_db / 20)
foley_duck = 10 ** (duck_db * AU["foleyDuck"] / 20)  # 说话时书写声也让一让（约 -6dB）


# ---------- 顿悟点音效：灯亮时一声轻"叮" ----------
chime = np.zeros(N)
for e in tl["effects"]:
    i = int(e["t0"] * SR)
    y = tone(midi(84), 2.0, ((1, 1.0), (2.76, 0.4), (5.4, 0.15)), decay=1.6, attack=0.002)
    add(chime, i, y)

# ---------- 电平：人声轻压缩，各轨相对人声定好，再整体做响度标准化 + 真峰值限幅 ----------
# （旁白文件 tl.narration 保留未压缩版本：旁白检查要拿它和源配音逐段比对）
voice = set_lufs(compress(voice, AU["voiceComp"]), AU["voiceLufs"])
v_l = meter.integrated_loudness(voice)
foley = set_lufs(foley, v_l + AU["foleyRel"])   # 书写声：轻，只作质感
music = set_lufs(music, v_l + AU["musicRel"])   # 音乐：垫底（闪避前的整体水平）
chime = set_lufs(chime, v_l + AU["chimeRel"])
mix = voice + foley * foley_duck + music + chime
for _ in range(2):  # 限幅会让响度略降，归一再限一次即收敛
    mix = limit(set_lufs(mix, AU["voiceLufs"]), AU["truePeak"], AU["limiterLook"])
out = f"audio/{tl['id']}.mix.wav"
sf.write("public/" + out, mix.astype(np.float32), SR)
for name, x in [("旁白", voice), ("书写声", foley), ("音乐", music), ("音效", chime), ("总混", mix)]:
    print(f"{name}: {meter.integrated_loudness(x):6.1f} LUFS")
tl["audio"] = out
tl_path.write_text(json.dumps(tl))
print(f"写出 public/{out}")
