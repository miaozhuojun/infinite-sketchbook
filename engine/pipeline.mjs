// 一键流水线：分镜数据 → 各画幅成片 + 检查报告 + 审片材料。
// 三层分工：每期只写数据（data/<id>.beats.json）；组件库（library/）和风格规范（style/style.json）可增长、有测试；
// 这里的关卡固定不变：能自动修的在各步骤内修（切点、限速、字号、避让、配音重试），修不了的写进报告，精确到元素和数值，进程以非零退出。
// 用法：node pipeline.mjs data/<id>.beats.json [--targets 9x16,16x9,1x1] [--out out/<目录>]（默认 out/<id>）[--draft]
// --draft：改稿时用，只配音、编译、查时间线（铅笔、安全区），不混音不渲染，几十秒出结果；定稿再去掉 --draft 跑全量
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PY_QA, PY_MLX } from './qa/pyenv.mjs';

const beatsPath = process.argv[2];
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const styleJson = JSON.parse(fs.readFileSync('style/style.json', 'utf8'));
const DRAFT = process.argv.includes('--draft');
// 画幅：命令行 --targets 优先，其次分镜里的 targets，否则用风格规范的默认母版（9:16 + 16:9）。每个平台只传一个文件，见报告里的发布清单
const targets = arg('--targets')?.split(',') ?? beats.targets ?? styleJson.defaultTargets;
const outDir = arg('--out') ?? path.join('out', beats.id);
fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });

const stages = [];
function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: opts.cwd });
  const out = (r.stdout || '') + (r.stderr || '');
  const fixes = [...out.matchAll(/^\s+(字号：.*|避让：.*|.*已自动剪掉.*|切点：.*合并.*|水印：.*不加)$/gm)].map((m) => m[1]);
  const checks = [...out.matchAll(/\[(通过|失败)\] ([^：]+)：(.*)/g)].map((m) => ({ ok: m[1] === '通过', name: m[2], detail: m[3] }));
  const problems = [...(out.match(/问题 \d+ 项：\n((?:\s+.*\n?)*)/) || [, ''])[1].trim().split('\n'), ...[...out.matchAll(/^\[错误\] (.*)$/gm)].map((m) => m[1])]
    .map((l) => l.trim()).filter(Boolean);
  const artifacts = [...out.matchAll(/^(?:设备预览|联系表|理解度测试材料|组件预览|存证)：(\S+)/gm)].map((m) => m[1]);
  const notes = [...out.matchAll(/^((?:书写声|音乐)：.*)$/gm)].map((m) => m[1]); // 混音用了哪些素材，写进报告
  // 建议：创作取舍（风格规范 gates 里的 advice 级），写进报告，不判失败
  const advice = [...(out.match(/建议 \d+ 项：\n((?:\s+.*\n?)*)/) || [, ''])[1].trim().split('\n'), ...[...out.matchAll(/^\s*\[建议\] (.*)$/gm)].map((m) => m[1])]
    .map((l) => l.trim()).filter(Boolean);
  const ok = r.status === 0 && checks.every((c) => c.ok) && !problems.length;
  stages.push({ name, ok, secs: ((Date.now() - t0) / 1000).toFixed(1), checks, fixes, problems, advice, artifacts, notes, tail: ok ? '' : out.slice(-1500) });
  console.log(`${ok ? '✓' : '✗'} ${name}（${stages.at(-1).secs}s）${fixes.length ? `  自动修正 ${fixes.length} 处` : ''}${advice.length ? `  建议 ${advice.length} 条` : ''}`);
  return ok;
}
// 没条件执行的关卡也进报告，写明原因；有未执行的关卡时，结论不写「全部通过」
function skip(name, why) {
  stages.push({ name, ok: true, skipped: why, secs: '0.0', checks: [], fixes: [], problems: [], artifacts: [], tail: '' });
  console.log(`– ${name}（未执行：${why}）`);
}

// 0. 组件库与分镜：先确认工具可靠、数据合规，再花时间渲染
const libOk = run('组件库测试', 'node', ['library/test.mjs', '--preview']);
run('墨迹叠色检查（交叠处不发黑、红压灰仍是红）', 'node', ['qa/ink_check.mjs']);
const beatsOk = run('分镜校验（组件、风格、叙事、事实出处、字幕）', 'node', ['compiler/validate.mjs', beatsPath]);

// 1. 配音：分镜里写了旁白稿就每次都按稿生成（内置回转检查、开头多字修剪、换种子重试）。
// 配音按句缓存，没改的句子直接复用，所以每次跑也只多十几秒；这样音频一定和当前的稿子对得上，不会拿旧音频配新稿
const audioPath = path.join('public', beats.narration.audio || '');
// 合成提示音（演示分镜，narration.synthetic）不走克隆配音，音频由夹具脚本生成
if (beatsOk && beats.narration.script && !beats.narration.synthetic) {
  const base = path.resolve('../tts/out', path.basename(audioPath, path.extname(audioPath)));
  if (PY_MLX) { if (run('配音生成（按句缓存）', PY_MLX, ['qwen_clone.py', beats.narration.script, base, ...Object.entries(beats.narration.reseed ?? {}).flatMap(([t, k]) => ['--reseed', `${t}=${k}`])], { cwd: '../tts' })) fs.copyFileSync(base + '.wav', audioPath); }
  else if (fs.existsSync(audioPath)) skip('配音生成', `没有本地配音环境（PY_MLX），沿用已有的 ${audioPath}，没核对它和当前稿子是否一致`);
  else stages.push({ name: '配音生成', ok: false, secs: '0.0', checks: [], fixes: [], artifacts: [], tail: '',
    problems: [`没有音频 ${audioPath}，也没有本地配音环境（PY_MLX）：在 tts/ 装好配音环境，或把音频放到这个位置`] });
}

// 2. 各画幅：编译 → 混音 → 渲染 → 写版权信息与存证 → 检查 → 设备预览
// 本机配置了品牌（brand.local.json，不进仓库）才加水印、写版权信息、记存证；没配置就在报告里写明
const branded = fs.existsSync('brand.local.json');
if (libOk && beatsOk && !branded) skip('水印、版权信息与存证', '本机没有配置品牌（brand.local.json）');
if (libOk && beatsOk) {
  const compiled = targets.filter((t) => run(`[${t}] 编译（时间线、版面、镜头）`, 'node', ['compiler/compile.mjs', beatsPath, '--target', t]));
  spawnSync('node', ['compiler/gen-compositions.mjs']);
  if (DRAFT) {
    for (const t of compiled) {
      const tl = `build/${beats.id}-${t}.timeline.json`;
      run(`[${t}] 铅笔与运笔检查`, 'node', ['qa/pencil_check.mjs', tl]);
      run(`[${t}] 平台安全区检查`, 'node', ['qa/safezone_check.mjs', tl]);
    }
    skip('混音、渲染、画面检查、旁白检查、预览与审片材料', '草稿模式（--draft）');
  }
  for (const t of DRAFT ? [] : compiled) {
    const id = `${beats.id}-${t}`, tl = `build/${id}.timeline.json`, video = path.join(outDir, `${t}.mp4`);
    if (!run(`[${t}] 混音`, PY_QA, ['audio/mix.py', tl])) continue;
    if (!run(`[${t}] 渲染`, 'npx', ['remotion', 'render', 'src/index.ts', id, video, '--log=error'])) continue;
    if (branded) run(`[${t}] 版权信息与存证`, PY_QA, ['qa/provenance.py', beatsPath, tl, video]);
    run(`[${t}] 画面检查`, PY_QA, ['qa/qa.py', tl, video, id]);
    run(`[${t}] 铅笔与运笔检查`, 'node', ['qa/pencil_check.mjs', tl]);
    run(`[${t}] 平台安全区检查`, 'node', ['qa/safezone_check.mjs', tl]);
    run(`[${t}] 设备预览`, PY_QA, ['qa/device_preview.py', tl, video, path.join(outDir, `preview_${t}.png`)]);
    run(`[${t}] 审片联系表`, PY_QA, ['qa/contact_sheet.py', video, path.join(outDir, 'review')]);
    if (t === compiled[0]) {
      const noSpeech = beats.narration.synthetic ? '配音是合成提示音，没有人声可查' : PY_MLX ? null : '没有本地配音环境（PY_MLX）';
      if (noSpeech) skip(`[${t}] 旁白检查`, noSpeech);
      else run(`[${t}] 旁白检查`, PY_MLX, ['speech_check.py', path.resolve(tl), path.resolve('.')], { cwd: '../tts' });
      if ((beats.quiz || []).length) run(`[${t}] 理解度测试材料`, PY_QA, ['qa/comprehension.py', 'pack', beatsPath, tl, video, path.join(outDir, 'comprehension')]);
    }
  }
}

// 3. 报告
const failed = stages.filter((s) => !s.ok), skipped = stages.filter((s) => s.skipped);
const nAdvice = stages.reduce((n, s) => n + (s.advice?.length ?? 0), 0);
const verdict = (failed.length ? `未通过（${failed.length} 个步骤失败）` : skipped.length ? `已执行的程序关卡全部通过，${skipped.length} 项未执行` : '程序关卡全部通过')
  + (nAdvice ? `；另有 ${nAdvice} 条创作建议（不拦截，按需采纳）` : '');
const lines = [`# ${beats.id} 流水线报告`, '', `结果：**${verdict}**　画幅：${targets.join('、')}`, ''];
for (const s of stages) {
  lines.push(s.skipped ? `## – ${s.name}（未执行：${s.skipped}）` : `## ${s.ok ? '✓' : '✗'} ${s.name}（${s.secs}s）`);
  for (const f of s.fixes) lines.push(`- 自动修正：${f}`);
  for (const c of s.checks) lines.push(`- ${c.ok ? '通过' : '**失败**'} ${c.name}：${c.detail}`);
  for (const p of s.problems) lines.push(`- **待改**：${p}`);
  for (const a of s.advice ?? []) lines.push(`- 建议：${a}`);
  for (const a of s.artifacts) lines.push(`- 产物：${a}`);
  for (const n of s.notes ?? []) lines.push(`- ${n}`);
  if (s.tail) lines.push('', '```', s.tail, '```');
  lines.push('');
}
const produced = targets.filter((t) => fs.existsSync(path.join(outDir, `${t}.mp4`)));
lines.push('## 发布清单（每个平台只传一个文件）', '', '| 平台 | 上传文件 | 画幅 |', '|---|---|---|');
for (const [pf, prefs] of Object.entries(styleJson.publish)) {
  if (pf === 'note') continue;
  const t = prefs.find((x) => produced.includes(x));
  lines.push(`| ${pf} | ${t ? `\`${outDir}/${t}.mp4\`` : '（本期没出合适画幅）'} | ${t ?? '—'} |`);
}
lines.push('');
// 章节：同一份节名和起点，按各平台自己的章节功能给（进度条不画进视频；目前只支持风格规范 chapters.platforms 里的 YouTube、抖音、B 站）
const tl0 = targets.map((t) => `build/${beats.id}-${t}.timeline.json`).find((f) => fs.existsSync(f));
const chapters = tl0 ? JSON.parse(fs.readFileSync(tl0, 'utf8')).chapters ?? [] : [];
if (chapters.length) {
  const dur = (t) => { const f = `build/${beats.id}-${t}.timeline.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).duration : 0; };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  lines.push('## 章节（发布时填进各平台自己的章节功能）', '');
  for (const [pf, info] of Object.entries(styleJson.chapters.platforms)) {
    const t = styleJson.publish[pf]?.find((x) => produced.includes(x)), d = t ? dur(t) : 0;
    lines.push(`**${pf}**（${t ?? '本期没出合适画幅'}，${info.where}）`);
    if (!t) { lines.push(''); continue; }
    if (d < info.minVideoSec) { lines.push(`- 这一期 ${mmss(d)}，${pf} 要求视频长于 ${mmss(info.minVideoSec)} 才能设章节，本期不设。`, ''); continue; }
    // 不同画幅插的停顿不同，起点按这个平台用的那个画幅算
    const own = JSON.parse(fs.readFileSync(`build/${beats.id}-${t}.timeline.json`, 'utf8')).chapters;
    lines.push('```', ...own.map((c) => `${mmss(c.t)} ${c.title}`), '```', '');
  }
}
lines.push('## 接下来（程序判断不了的）',
  '- 独立审片：按 `qa/review_rubric.md`，材料是设备预览、联系表、组件库预览；每条问题标明该在哪一层修。',
  `- 理解度测试：把 \`${outDir}/comprehension/pack.md\` 交给没看过备课材料的新 agent 作答，再运行 \`qa/comprehension.py score\`。`,
  '- 人耳：音色、语气、书写声和音乐是否舒服。', '');
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ id: beats.id, targets, ok: !failed.length, skipped: skipped.map((s) => s.name), stages }, null, 1));
console.log(`\n${failed.length ? '✗' : '✓'} ${verdict}，报告：${path.join(outDir, 'report.md')}`);
process.exit(failed.length ? 1 : 0);
