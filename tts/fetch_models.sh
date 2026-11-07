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
# 第二把量音色的尺子 CAM++（3D-Speaker，Apache-2.0；sherpa-onnx 转的 ONNX，28MB）：旁白检查「像这个孩子」「相邻两句接得上」和 consistency.py 用它
mkdir -p models/campplus
[ -s models/campplus/campplus_zh-cn_16k.onnx ] || curl -sfL --retry 3 -o models/campplus/campplus_zh-cn_16k.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
echo "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11  models/campplus/campplus_zh-cn_16k.onnx" | shasum -a 256 -c
