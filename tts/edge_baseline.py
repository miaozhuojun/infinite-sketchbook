"""edge-tts 免 key 基线：生成音频 + 词级时间戳，输出统一的 timing JSON。

占位音色：只用来让引擎先跑通、作为对比基线，不用于发布（edge-tts 调的是微软在线朗读接口，商用授权不明）。
用法：.venv/bin/python edge_baseline.py <文本> <输出前缀> [voice]
"""
import asyncio
import json
import sys

import edge_tts


async def main(text: str, out: str, voice: str) -> None:
    comm = edge_tts.Communicate(text, voice, rate="-8%", boundary="WordBoundary")
    words = []
    with open(out + ".mp3", "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # offset/duration 单位是 100ns
                words.append({
                    "text": chunk["text"],
                    "start": chunk["offset"] / 1e7,
                    "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                })
    timing = {"source": f"edge-tts:{voice}", "text": text, "words": words}
    with open(out + ".timing.json", "w", encoding="utf-8") as f:
        json.dump(timing, f, ensure_ascii=False, indent=1)
    print(f"{len(words)} words, last end {words[-1]['end']:.2f}s")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "zh-CN-YunxiaNeural"))
