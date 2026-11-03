# 无限草稿本 infinite-sketchbook

[![CI](https://github.com/miaozhuojun/infinite-sketchbook/actions/workflows/ci.yml/badge.svg)](https://github.com/miaozhuojun/infinite-sketchbook/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

把一份分镜数据，变成「一支铅笔边讲边写」的讲解短视频，同时出竖版和横版。

分工是这样的：模型负责选题、文稿和画面设计，只写数据；风格统一和表达正确交给固定的程序把关。程序自动修得了的就自动修，修不了的会精确报出是哪个元素、差多少，尽量不靠人工挑错。

## 它能做什么

- **真的在写**：中文按国标笔顺逐笔写（Make Me a Hanzi 的中线数据），字母和数字用 Hershey 单线字体，压力笔刷。一支笔、统一笔宽，书写和旁白逐词同步。
- **三层分工**：
  - 每期只写分镜 JSON；
  - 组件库可以扩展，每个组件都有测试和预览图；
  - 关卡是固定程序：分镜校验、编译时自动修正（避让、限速、取景、停笔退开……），以及二十多项检查（铅笔、镜头、字幕、平台界面遮挡、旁白完整性、响度……）。
- **检查器自测**：往一份合格的时间线和分镜里注入几十种已知缺陷，每一种都必须被检查抓到，否则就说明检查形同虚设。
- **多画幅**：竖版 9:16 给 TikTok、YouTube Shorts、X，横版 16:9 给 YouTube，方版 1:1 可选。每个画幅各有版式，自动避开各平台的界面遮挡区。
- **本地配音**（可选，需要 Apple Silicon）：
  - 用 Qwen3-TTS 克隆音色，按句生成；
  - 每句做回转识别，按拼音核对，并检查有没有掉音、时长是否合理；
  - 整段再查音色一致性。
- **混音**：真实的铅笔书写声（按每一笔截取、调形）、背景音乐、顿悟时的提示音；人声轻压缩，统一到 -16 LUFS，并做真峰值限幅。书写声和音乐是 CC0 录音，用 `engine/audio/fetch_cc0.sh` 下载；没下载时用程序合成的代替。

架构和每道关卡查什么，见 [engine/ARCHITECTURE.md](engine/ARCHITECTURE.md)。

## 快速开始：演示分镜

演示分镜不需要配音模型，配音用程序合成的提示音代替。CI 跑的也是它。

需要 Node 26 和 Python 3.12。在 `engine/` 目录下运行：

```bash
npm ci
```

```bash
python3 -m venv ../.venv-qa && ../.venv-qa/bin/python -m pip install -r requirements-qa.txt
```

```bash
../.venv-qa/bin/python qa/fixtures/demo/make_demo.py
```

```bash
node pipeline.mjs data/demo.beats.json
```

产物在 `out/demo/`：两个画幅的成片、设备预览、审片联系表和检查报告。流水线会自动找仓库根目录的 `.venv-qa`；用别的 Python 环境时，设环境变量 `PY_QA`。

演示配音是合成的提示音，所以报告里旁白检查一项写「未执行」；没有配置品牌时，水印和版权信息也写「未执行」。

## 用自己的声音配音

1. 在 `tts/` 下安装依赖：`python -m pip install -r requirements.txt`。然后用 `fetch_models.sh` 从 ModelScope 下载三个模型，约 6.3GB。
2. 把参考录音放进 `tts/ref/`，复制 `voice.example.json` 为 `voice.json` 并填写。这些都不会进仓库。
3. 在分镜的 `narration` 里写 `script`，流水线会自动生成配音、对齐，并跑各项检查。

只克隆你自己的声音，或已取得本人书面同意的声音；未成年人要监护人同意。

## 水印、版权信息与存证

复制 `engine/brand.example.json` 为 `engine/brand.local.json` 并填写。这个文件不进仓库。填好后，流水线出的每个成片都会：

- **带可见水印**：品牌名小字，半透明，每 12 秒换一个角。会压到字幕、平台界面或画面内容的位置自动跳过，安全区检查再复核一遍。
- **内嵌版权信息**：标题、作者、版权和声明写进 MP4 元数据，只改封装、不重新编码。
- **留存证**：成片的 SHA-256、生成时间、分镜指纹和引擎版本，写进交付目录的 `provenance.json`，同时追加到本机台账 `docs-private/provenance.jsonl`。

平台转码通常会丢掉元数据，所以对外靠可见水印，元数据和存证用来证明母版出处。不填品牌就都不加。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交信息用约定式提交，PR 必须通过 CI。提交前钩子会拦下媒体文件、录音、分镜作品和大文件。

## 许可与产权

- **代码**：[Apache License 2.0](LICENSE)。
- **第三方组件**：不随仓库分发，按各自许可使用，见 [NOTICE](NOTICE)。注意 Remotion 对达到规模的公司要求购买公司许可。
- **作品与品牌**：用本引擎制作的「锟仔ai科学」作品（视频、分镜、配音），以及品牌名称与形象，都不在本仓库内，保留所有权利，见 [COPYRIGHT.md](COPYRIGHT.md)。
