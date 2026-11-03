#!/usr/bin/env bash
# 隐私与产权把关：作品、真人录音、模型权重、大文件、私人信息一律不能进仓库。
# 用法：scripts/privacy_guard.sh --staged（提交前钩子，查暂存区）| --all（CI，查所有已跟踪文件）
# 私人关键词（真实姓名、邮箱、家人信息等）写在本机的 scripts/privacy_patterns.local.txt，每行一个，不进仓库。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:---staged}"
if [ "$mode" = "--all" ]; then
  files=$(git ls-files)
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
fi
[ -z "$files" ] && exit 0

fail=0
report() { echo "✗ $1"; fail=1; }

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.wav|*.mp3|*.mp4|*.mov|*.m4a|*.aac|*.flac|*.ogg|*.webm|*.mkv) report "$f：媒体文件不进仓库（作品和录音保留在本机）" ;;
  esac
  case "$f" in
    tts/ref/*|tts/models/*|tts/out/*|*/ref/boy/*) report "$f：参考音、模型或生成的配音不进仓库" ;;
    tts/voice.json) report "$f：本机音色配置不进仓库（公开的是 tts/voice.example.json）" ;;
    engine/data/*.beats.json)
      [ "$f" != "engine/data/demo.beats.json" ] && report "$f：每期分镜是作品，不进公开仓库（演示分镜只有 demo.beats.json）" ;;
    docs-private/*) report "$f：内部记录不进仓库" ;;
  esac
  if [ -f "$f" ]; then
    size=$(wc -c < "$f" | tr -d ' ')
    [ "$size" -gt 2000000 ] && report "$f：$((size / 1024))KB，超过 2MB 的文件不进仓库"
  fi
done <<< "$files"

# 私人关键词：只在本机有这份清单时检查（清单本身不进仓库）
patterns=scripts/privacy_patterns.local.txt
if [ -f "$patterns" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] || [ ! -f "$f" ] && continue
    if [ "$mode" = "--all" ]; then content=$(cat "$f"); else content=$(git show ":$f" 2>/dev/null || true); fi
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      case "$p" in \#*) continue ;; esac
      if printf '%s' "$content" | grep -qF -- "$p"; then report "$f：含私人关键词（见本机 $patterns）"; break; fi
    done < "$patterns"
  done <<< "$files"
fi

if [ "$fail" -ne 0 ]; then
  echo "隐私与产权检查没通过：上面的文件不能提交。确实需要的话，先和维护者确认。"
  exit 1
fi
echo "✓ 隐私与产权检查通过（$(printf '%s\n' "$files" | grep -c .) 个文件）"
