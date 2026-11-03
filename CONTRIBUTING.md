# 参与贡献

先读 [engine/ARCHITECTURE.md](engine/ARCHITECTURE.md)。本项目分三层：

- 每期只写数据；
- 组件库可以扩展；
- 关卡（风格规范、编译器、各项检查）是固定程序，改动要格外谨慎。

## 提交流程

1. 从 `main` 拉分支，分支名用 `类型/简述`，例如 `fix/pencil-park`、`feat/ring-builtin`。
2. 启用提交前钩子（只需一次）：`git config core.hooksPath .githooks`。钩子会拦下媒体文件、录音、分镜作品和大文件，再对改动的脚本做语法检查。
3. 提交信息用[约定式提交](https://www.conventionalcommits.org/zh-hans/)：`类型(范围): 中文描述`。
   - 类型：`feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
   - 范围：`compiler`、`library`、`style`、`qa`、`tts`、`audio`、`render`、`ci` 等。
   - 例：`fix(compile): 推近取景不再把文字切成半截`。
4. 开 PR 到 `main`，按模板填写。CI 全绿、维护者审过之后，用 squash 合并，PR 标题就是合并后的提交信息。
5. `main` 受保护：不能直接推送，必须经过 PR，CI 必须通过。

## 每层的要求

- **组件库**（`engine/library/components/`）：
  - 组件是纯函数，`meta` 要写清说明、参数和示例；
  - `node library/test.mjs --preview` 要全过，并看一眼预览图。
- **风格规范**（`engine/style/style.json`）：改了以后，所有已有分镜都要重跑流水线；演示分镜由 CI 自动跑。
- **关卡**（编译器的自动修正、`engine/qa/` 下的检查）：
  - 每条新检查都要在 `engine/qa/selftest.mjs` 里配一个注入缺陷的用例，证明它真能抓到；
  - 自动修正和检查要用同一份几何定义（`engine/src/timeline.ts`）。
- **配音**（`tts/`）：
  - 不提交任何录音、参考音或模型；
  - 音色配置只提交 `voice.example.json` 这种示例。

## 本地检查

在 `engine/` 目录下运行。演示分镜不需要配音模型，CI 跑的就是这些。Python 环境的准备见 [README](README.md#快速开始演示分镜)。

```bash
../.venv-qa/bin/python qa/fixtures/demo/make_demo.py
```

```bash
node library/test.mjs && node compiler/validate.mjs data/demo.beats.json
```

```bash
node compiler/compile.mjs data/demo.beats.json --target 9x16 && node qa/pencil_check.mjs build/demo-9x16.timeline.json && node qa/safezone_check.mjs build/demo-9x16.timeline.json
```

```bash
node compiler/gen-compositions.mjs && npm run typecheck
```

```bash
node qa/selftest.mjs build/demo-9x16.timeline.json
```

全流程（混音、渲染、成片检查）跑 `node pipeline.mjs data/demo.beats.json`，CI 里是单独的一项。改了关卡，再用你手上真人配音的分镜跑一遍自测，旁白类的注入只有那时才会执行。

## 不接受的内容

- 任何视频、音频、录音、模型权重，以及每期的分镜作品。演示分镜 `engine/data/demo.beats.json` 除外。
- 任何人的个人信息。
- 未经本人同意克隆的声音。

产权说明见 [COPYRIGHT.md](COPYRIGHT.md)。
