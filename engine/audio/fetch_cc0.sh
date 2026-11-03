#!/usr/bin/env bash
# 下载混音用的 CC0 素材（清单见 audio/cc0_sources.json）到 assets.local/cc0/。文件不进仓库。
# 用法（在 engine 目录下）：bash audio/fetch_cc0.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dest=assets.local/cc0
mkdir -p "$dest"
python3 -c "import json; d = json.load(open('audio/cc0_sources.json')); [print(x['file'], x['url']) for k in ('pencil', 'music') for x in d[k]]" |
while read -r file url; do
  if [ -s "$dest/$file" ]; then echo "已有 $file"; continue; fi
  curl -fsSL --retry 2 -o "$dest/$file.part" "$url" && mv "$dest/$file.part" "$dest/$file" && echo "下载 $file（$(wc -c < "$dest/$file" | tr -d ' ') 字节）"
done
