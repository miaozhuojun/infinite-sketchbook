#!/bin/bash
# 并行下载单个 ModelScope 仓库（与 fetch_models.sh 相同逻辑）
repo=$1; dir=models/$(basename $repo); mkdir -p $dir
curl -s "https://www.modelscope.cn/api/v1/models/$repo/repo/files?Recursive=true" | python3 -c "
import json,sys;[print(f['Path']) for f in json.load(sys.stdin)['Data']['Files'] if f['Type']!='tree']" | while read -r f; do
  mkdir -p "$dir/$(dirname "$f")"
  [ -s "$dir/$f" ] || curl -sfL --retry 3 -o "$dir/$f" "https://www.modelscope.cn/models/$repo/resolve/master/$f"
done
echo "done $repo"; du -sh $dir
