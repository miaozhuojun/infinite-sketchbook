"""声音包校准（VOICE_PIPELINE.md 第一步的第 3 小步）：用固定的校准稿，拿这个声音包试配（不按语气挑），
量出这个声音的基准——中位音区、语速、长期平均频谱、基础响度、回声、噪声、每句音色——写进 voice.json 的 pack，
再写一个试听文件给用户盲听。用户认可后，每集都用这一套。
用法：.venv-mlx/bin/python calibrate_voice.py <声音包目录>（build_voice.py 的输出） [--apply]
  --apply：把 ref 换成声音包的主参考、pack 基准写进 voice.json（换声音包前先听过试听文件）
"""
import argparse, json, re, subprocess, sys, tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from voice import HERE, load_voice, echo_ms, pause_points, active_level_db, ltas, voiced_flatness, prosody

CALIB = ("今天，我们来看看一个东西是怎么运转的。你猜，它为什么会自己动起来？哇，原来是这样！先看第一步，再看第二步。"
         "要是我们把它拆开，会发生什么呢？想把每一种情况都写清楚，几乎是不可能的。这就是今天最重要的一个秘密。"
         "别着急，我们一步一步来。下一次，我们来造一个会自己拿主意的小机器！好了，今天就讲到这里。")

ap = argparse.ArgumentParser(); ap.add_argument("pack"); ap.add_argument("--apply", action="store_true"); a = ap.parse_args()
pack = Path(a.pack).resolve(); main = pack / "main.wav"
raw = json.loads((HERE / "voice.json").read_text(encoding="utf-8"))
tmpv = dict(raw, ref=str(main.relative_to(HERE)), candidates=1, pack={}, spectralMatchDb=0, sentenceLevelDb=0, moods={}, fallbackMood=None)
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
    json.dump(tmpv, f, ensure_ascii=False); vpath = f.name
out = pack / "calib"
r = subprocess.run([sys.executable, "qwen_clone.py", CALIB, str(out), "--voice", vpath], cwd=HERE)
if r.returncode:
    raise SystemExit("校准稿没配出来，看上面的报错")
t = json.loads(Path(str(out) + ".timing.json").read_text(encoding="utf-8")); x, sr = sf.read(str(out) + ".wav", dtype="float64")
rows = []
for s in t["sentences"]:
    seg = x[int(s["start"] * sr):int(s["end"] * sr)]
    ws = [dict(w, start=w["start"] - s["start"], end=w["end"] - s["start"]) for w in t["words"] if s["start"] - 1e-3 <= w["start"] and w["end"] <= s["end"] + 1e-3]
    rows.append({"text": s["text"], **prosody(seg, sr, ws), "echo": echo_ms(seg, sr, pause_points(ws)), "level": active_level_db(seg, sr),
                 "flat": voiced_flatness(seg, sr), "ltas": ltas(seg, sr).tolist()})
plain = [q for q in rows if not q["text"].endswith(("？", "！"))]
base = {"baseF0": round(float(np.median([q["f0"] for q in plain])), 1), "baseRate": round(float(np.median([q["rate"] for q in plain])), 2),
        "ltas": [round(v, 2) for v in np.median([q["ltas"] for q in rows], 0)], "main": str(main.relative_to(HERE)),
        "calibration": {"echoMedianMs": round(float(np.median([q["echo"] for q in rows]))), "echoMaxMs": round(float(max(q["echo"] for q in rows))),
                        "levelSpreadDb": round(float(max(q["level"] for q in rows) - min(q["level"] for q in rows)), 1),
                        "flatMedian": round(float(np.median([q["flat"] for q in rows])), 3)}}
json.dump({"base": base, "rows": rows}, open(pack / "calibration.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(base["calibration"], ensure_ascii=False), "baseF0", base["baseF0"], "baseRate", base["baseRate"])
print(f"试听：{out}.wav")
if a.apply:
    raw["ref"] = base["main"]; raw["pack"] = base
    # 掉嗓子下限跟着声音包走：这个声音自己的基准音区 × 0.62（原来按真人录音 316Hz 定的 196Hz，换成音区低一些的声音包后，长句句末正常的下降都会被拦）
    raw["pitchFloorHz"] = round(0.62 * base["baseF0"])
    (HERE / "voice.json").write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已写进 voice.json：ref → 声音包主参考，pack 基准")
