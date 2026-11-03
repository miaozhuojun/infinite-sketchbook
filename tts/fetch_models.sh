#!/bin/bash
# 从 ModelScope（Qwen 官方发布）下载权重；huggingface.co 在本机不可达。
set -e
dl() { # repo
  local repo=$1 dir=models/$(basename $1)
  mkdir -p $dir
  curl -s "https://www.modelscope.cn/api/v1/models/$repo/repo/files?Recursive=true" | python3 -c "
import json,sys;[print(f['Path']) for f in json.load(sys.stdin)['Data']['Files'] if f['Type']!='tree']" | while read -r f; do
    mkdir -p "$dir/$(dirname "$f")"
    [ -s "$dir/$f" ] || curl -sfL --retry 3 -o "$dir/$f" "https://www.modelscope.cn/models/$repo/resolve/master/$f"
  done
  echo "done $repo"; du -sh $dir
}
dl Qwen/Qwen3-ForcedAligner-0.6B
dl Qwen/Qwen3-ASR-0.6B
dl Qwen/Qwen3-TTS-12Hz-1.7B-Base
