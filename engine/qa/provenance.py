"""成片的版权信息与存证：把品牌和版权声明写进 MP4 元数据（只改封装，不重新编码），再记下成片的 SHA-256、时间和生成它的引擎版本；
片中贴了素材（贴视频、不是封面的贴图）的，每个素材的出处、许可和文件指纹也记进去。
存证写两处：交付目录里的 provenance.json（随成片交付），和本机台账 docs-private/provenance.jsonl（不进仓库，留作出处证明）。
品牌信息取自本机 brand.local.json；没有这个文件时流水线不调用这一步。
用法：../.venv-qa/bin/python qa/provenance.py data/<id>.beats.json build/<id>-<画幅>.timeline.json out/<id>/<画幅>.mp4
"""
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

beats_path, tl_path, video = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
brand = json.loads(Path("brand.local.json").read_text(encoding="utf-8"))
beats = json.loads(beats_path.read_text(encoding="utf-8"))
tl = json.loads(tl_path.read_text(encoding="utf-8"))
FF = imageio_ffmpeg.get_ffmpeg_exe()
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
LEDGER = Path(__file__).resolve().parents[2] / "docs-private" / "provenance.jsonl"


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def engine_rev():
    try:
        rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, check=True).stdout.strip()
        return rev + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


# 1. 写入元数据：标题、作者、版权、声明、创建时间（MP4 的 ©nam / ©ART / cprt / ©cmt）
meta = {
    "title": beats.get("title") or beats.get("brief", {}).get("question") or beats["id"],
    "artist": brand["name"],
    "copyright": brand["copyright"],
    "comment": brand["notice"],
    "creation_time": now.isoformat().replace("+00:00", "Z"),
}
tmp = video.with_name(video.stem + ".stamping.mp4")
args = [FF, "-y", "-loglevel", "error", "-i", str(video), "-map", "0", "-c", "copy"]
for k, v in meta.items():
    args += ["-metadata", f"{k}={v}"]
subprocess.run(args + ["-movflags", "+faststart", str(tmp)], check=True)
os.replace(tmp, video)

# 2. 读回来核对（检查可失败）
dump = subprocess.run([FF, "-loglevel", "error", "-i", str(video), "-f", "ffmetadata", "-"], capture_output=True, text=True, check=True).stdout
got = dict(line.split("=", 1) for line in dump.splitlines() if "=" in line and not line.startswith(";"))
missing = [k for k in ("title", "artist", "copyright", "comment") if got.get(k) != meta[k]]
print(f"[{'失败' if missing else '通过'}] 内嵌版权信息：" + (f"读回来缺少或不一致：{'、'.join(missing)}" if missing else f"artist={got['artist']}；copyright={got['copyright']}"))

# 3. 存证：交付目录里的 provenance.json（同一文件的旧记录被替换）+ 本机台账（只追加）
rec = {
    "time": now.isoformat(), "id": tl["id"], "target": tl["target"], "file": os.path.relpath(video.resolve()), "bytes": video.stat().st_size,
    "sha256": sha256(video), "duration": tl["duration"], "beatsSha256": sha256(beats_path), "style": tl["style"]["version"],
    "engine": engine_rev(), "brand": brand["name"], "copyright": brand["copyright"],
}
# 片中贴的别人的、或自己另做的素材（贴视频、不是封面的贴图）：出处、许可和贴进去的那个文件的指纹，一起记进存证
clip_sha = {k["src"].split("/", 1)[1]: k["sha"] for k in tl.get("clips") or []}  # src 是 clips/<文件名>（文件名可以带子目录）
media = [{"file": m, "license": f.get("license"), "origin": f.get("origin"), **({"author": f["author"]} if f.get("author") else {}),
          **({"evidence": f["source"]} if f.get("source") else {}), **({"sha256": clip_sha[m]} if m in clip_sha else {})}
         for f in beats.get("facts") or [] for m in ([f["media"]] if isinstance(f.get("media"), str) else f.get("media") or [])]
if media:
    rec["media"] = media
book = video.parent / "provenance.json"
recs = [r for r in (json.loads(book.read_text(encoding="utf-8")) if book.exists() else []) if r["file"] != rec["file"]]
book.write_text(json.dumps(recs + [rec], ensure_ascii=False, indent=1), encoding="utf-8")
LEDGER.parent.mkdir(parents=True, exist_ok=True)
with open(LEDGER, "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
print(f"存证：{book}（SHA-256 {rec['sha256'][:16]}…，本机台账 {LEDGER.name}）")
sys.exit(1 if missing else 0)
