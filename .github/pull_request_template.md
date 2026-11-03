## 改了什么、为什么

<!-- 一两句话；关联的 Issue 写 Closes #编号 -->

## 改在哪一层

- [ ] 组件库（`engine/library/`）
- [ ] 风格规范（`engine/style/style.json`）
- [ ] 关卡：编译器的自动修正或检查（`engine/compiler/`、`engine/qa/`）
- [ ] 渲染（`engine/src/`）
- [ ] 配音、混音（`tts/`、`engine/audio/`）
- [ ] 文档、CI、其他

## 自查

- [ ] 本地跑过演示分镜：组件库测试、分镜校验、编译、铅笔与安全区检查都通过（命令见 CONTRIBUTING.md）
- [ ] 新增或改动的检查，在 `engine/qa/selftest.mjs` 里有注入缺陷的用例，并且能抓到
- [ ] 组件有改动的话，看过 `out/library/preview.png`
- [ ] 没有提交视频、音频、录音、模型、分镜作品或任何个人信息
- [ ] 文档同步更新了（ARCHITECTURE.md、README）
