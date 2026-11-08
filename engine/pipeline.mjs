// 一键流水线：分镜数据 → 各画幅成片 + 检查报告 + 审片材料。
// 三层分工：每期只写数据（data/<id>.beats.json）；组件库（library/）和风格规范（style/style.json）可增长、有测试；
// 这里的关卡固定不变：能自动修的在各步骤内修（切点、限速、字号、避让、配音重试），修不了的写进报告，精确到元素和数值，进程以非零退出。
// 用法：node pipeline.mjs data/<id>.beats.json [--targets 9x16,16x9,1x1] [--out out/<目录>]（默认 out/<id>）[--draft]
// --draft：改稿时用，只配音、编译、查时间线（铅笔、安全区），不混音不渲染，几十秒出结果；定稿再去掉 --draft 跑全量
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PY_QA, PY_MLX } from './qa/pyenv.mjs';
import { GL } from './qa/gl.mjs';
import { loadStyle } from './compiler/validate.mjs';
import { isDialogue, sentenceSpeakers, turnStarts, voicesOf } from './compiler/speakers.mjs';

const beatsPath = process.argv[2];
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
// 生效的风格（默认 < 本机私有创作配置 < 这一期分镜）：画幅、发布清单也按它来，私有配置里定的「只出横版、各平台都传横版」才会生效
const styleJson = loadStyle(beats);
const DRAFT = process.argv.includes('--draft');
// 画幅：命令行 --targets 优先，其次分镜里的 targets，否则用风格规范的默认母版（9:16 + 16:9）。每个平台只传一个文件，见报告里的发布清单
const targets = arg('--targets')?.split(',') ?? beats.targets ?? styleJson.defaultTargets;
const outDir = arg('--out') ?? path.join('out', beats.id);
fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });

const stages = [];
function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: opts.cwd });
  return record(name, r.status, (r.stdout || '') + (r.stderr || ''), t0, stages);
}
// 同一步骤的异步版：各画幅的混音、渲染、检查同时跑（原来一个画幅做完才做下一个，两个画幅约 20 分钟）。结果记进这个画幅自己的列表，报告里仍按画幅顺序排
function runAsync(name, cmd, args, opts = {}, list = stages) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd: opts.cwd });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    ch.on('error', (e) => { out += String(e); });
    ch.on('close', (code) => resolve(record(name, code, out, t0, list)));
  });
}
// 一次只让一个任务进去（渲染吃满 CPU，两个画幅同时渲反而更慢；存证要读改写同一个 provenance.json）
function makeLock() { let tail = Promise.resolve(); return (fn) => { const p = tail.then(fn); tail = p.catch(() => {}); return p; }; }
function record(name, status, out, t0, list) {
  const fixes = [...out.matchAll(/^\s+(字号：.*|避让：.*|.*已自动剪掉.*|切点：.*合并.*|水印：.*不加)$/gm)].map((m) => m[1]);
  const checks = [...out.matchAll(/\[(通过|失败)\] ([^：]+)：(.*)/g)].map((m) => ({ ok: m[1] === '通过', name: m[2], detail: m[3] }));
  const problems = [...(out.match(/问题 \d+ 项：\n((?:\s+.*\n?)*)/) || [, ''])[1].trim().split('\n'), ...[...out.matchAll(/^\[错误\] (.*)$/gm)].map((m) => m[1])]
    .map((l) => l.trim()).filter(Boolean);
  const artifacts = [...out.matchAll(/^(?:设备预览|联系表|理解度测试材料|组件预览|存证)：(\S+)/gm)].map((m) => m[1]);
  const notes = [...out.matchAll(/^((?:书写声|音乐)：.*)$/gm)].map((m) => m[1]); // 混音用了哪些素材，写进报告
  // 建议：创作取舍（风格规范 gates 里的 advice 级），写进报告，不判失败
  const advice = [...(out.match(/建议 \d+ 项：\n((?:\s+.*\n?)*)/) || [, ''])[1].trim().split('\n'), ...[...out.matchAll(/^\s*\[建议\] (.*)$/gm)].map((m) => m[1])]
    .map((l) => l.trim()).filter(Boolean);
  const ok = status === 0 && checks.every((c) => c.ok) && !problems.length;
  list.push({ name, ok, secs: ((Date.now() - t0) / 1000).toFixed(1), checks, fixes, problems, advice, artifacts, notes, tail: ok ? '' : out.slice(-1500) });
  console.log(`${ok ? '✓' : '✗'} ${name}（${list.at(-1).secs}s）${fixes.length ? `  自动修正 ${fixes.length} 处` : ''}${advice.length ? `  建议 ${advice.length} 条` : ''}`);
  return ok;
}
// 没条件执行的关卡也进报告，写明原因；有未执行的关卡时，结论不写「全部通过」
function skip(name, why, list = stages) {
  list.push({ name, ok: true, skipped: why, secs: '0.0', checks: [], fixes: [], problems: [], artifacts: [], tail: '' });
  console.log(`– ${name}（未执行：${why}）`);
}

// 0. 组件库与分镜：先确认工具可靠、数据合规，再花时间渲染
const libOk = run('组件库测试', 'node', ['library/test.mjs', '--preview']);
run('墨迹叠色检查（交叠处不发黑、红压灰仍是红）', 'node', ['qa/ink_check.mjs']);
const beatsOk = run('分镜校验（组件、风格、叙事、事实出处、字幕）', 'node', ['compiler/validate.mjs', beatsPath]);

// 1. 配音：分镜里写了旁白稿就每次都按稿生成（内置回转检查、开头多字修剪、换种子重试）。
// 配音按句缓存，没改的句子直接复用；稿子和配音设置都没变时整步跳过（见下）。这样音频一定和当前的稿子对得上，不会拿旧音频配新稿
const audioPath = path.join('public', beats.narration.audio || '');
// 配音没配出来就停在这里：后面的编译、渲染、旁白检查都会拿上一版的配音去做，白跑几分钟，报告还会误导（E01 v17 实测）
let voiceOk = true;
// 合成提示音（演示分镜，narration.synthetic）不走克隆配音，音频由夹具脚本生成
if (beatsOk && beats.narration.script && !beats.narration.synthetic) {
  const base = path.resolve('../tts/out', path.basename(audioPath, path.extname(audioPath)));
  // 自动换种子（见文末）：成片旁白检查点名的句子，偏移记在配音目录的 <id>.autoreseed.json，比分镜里手写的 reseed 优先，以后每次都用
  const autoReseed = fs.existsSync(base + '.autoreseed.json') ? JSON.parse(fs.readFileSync(base + '.autoreseed.json', 'utf8')) : {};
  // 对话（compiler/speakers.mjs）：每个说话的人只拿自己说的句子、用自己的音色配置去配（narration.voices），再按旁白稿的顺序拼回一条（tts/dialogue.py）。
  // 换种子、语气、情绪也只交给说这句的人；一段话的开头（上一句是别人说的）不和上一句凑成一段配。
  // 原来整条旁白都交给主讲的声音配：E02 父子对话样稿里，旁白检查点名爸爸的句子后，流水线用孩子的声音把它们重配了两轮
  const dialogue = isDialogue(beats), sents = dialogue ? sentenceSpeakers(beats).sentences : [];
  const speakers = dialogue ? ['', ...Object.keys(voicesOf(beats))].filter((sp) => sents.some((s) => s.speaker === sp)) : [''];
  const partOf = (sp) => (dialogue ? `${base}.${sp || 'main'}` : base);
  const whoSays = (sp) => (sp ? voicesOf(beats)[sp].label ?? sp : '主讲');
  const argsOf = (sp) => {
    const keep = (t) => !dialogue || sents.some((s) => s.speaker === sp && s.text === t);
    const pick = (o, flag) => Object.entries(o ?? {}).filter(([t]) => keep(t)).flatMap(([t, k]) => [flag, `${t}=${k}`]);
    return ['qwen_clone.py', dialogue ? sents.filter((s) => s.speaker === sp).map((s) => s.text).join('') : beats.narration.script, partOf(sp),
      ...(sp ? ['--voice', voicesOf(beats)[sp].voice] : []),
      ...pick({ ...(beats.narration.reseed ?? {}), ...autoReseed }, '--reseed'), ...pick(beats.narration.mood, '--mood'), ...pick(beats.narration.tone, '--tone'),
      ...(dialogue ? turnStarts(sents).filter(keep).flatMap((t) => ['--turn', t]) : [])];
  };
  const voiceArgs = dialogue ? speakers.map(argsOf) : argsOf('');
  // 配音没变就不重跑（用户 2026-11-06：E02 做了快十个小时）：旁白稿、语气、换种子、配音配置和配音程序都和上次配成功时一样，
  // 音频和逐字时间也都在，就直接用上次的。全走缓存时配音这一步也要 3–10 分钟（逐句复查缓存、整段回转识别、拼好后的复查），改版面的那几轮白等
  const keyFiles = ['voice.json', 'qwen_clone.py', 'voice.py', ...(dialogue ? ['dialogue.py', ...speakers.filter(Boolean).map((sp) => voicesOf(beats)[sp].voice)] : [])];
  const voiceKey = createHash('sha1').update(JSON.stringify([voiceArgs, ...keyFiles.map((f) => (fs.existsSync(path.resolve('../tts', f)) ? fs.readFileSync(path.resolve('../tts', f), 'utf8') : ''))])).digest('hex');
  const keyFile = base + '.voicekey', sameVoice = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === voiceKey && fs.existsSync(base + '.wav') && fs.existsSync(base + '.timing.json');
  const missing = dialogue ? speakers.filter(Boolean).map((sp) => voicesOf(beats)[sp].voice).filter((f) => !fs.existsSync(path.resolve('../tts', f))) : [];
  if (PY_MLX && missing.length) { voiceOk = false; stages.push({ name: '配音生成', ok: false, secs: '0.0', checks: [], fixes: [], artifacts: [], tail: '', problems: [`没有音色配置 ${missing.join('、')}（narration.voices 里写的，相对 tts/）`] }); }
  else if (PY_MLX && sameVoice) { skip('配音生成', '旁白稿、语气、换种子、配音配置和程序都和上次配成功时一样，直接用上次的配音'); fs.copyFileSync(base + '.wav', audioPath); }
  else if (PY_MLX && !dialogue) { if (voiceOk = run('配音生成（按句缓存）', PY_MLX, voiceArgs, { cwd: '../tts' })) { fs.copyFileSync(base + '.wav', audioPath); fs.writeFileSync(keyFile, voiceKey); } }
  else if (PY_MLX) {
    voiceOk = speakers.every((sp) => run(`配音生成（${whoSays(sp)}，按句缓存）`, PY_MLX, argsOf(sp), { cwd: '../tts' }));
    if (voiceOk) {
      fs.writeFileSync(base + '.order.json', JSON.stringify(sents, null, 1));
      voiceOk = run('对话拼接（按旁白稿顺序）', PY_MLX, ['dialogue.py', base, base + '.order.json', ...speakers.flatMap((sp) => ['--part', `${sp}=${partOf(sp)}`])], { cwd: '../tts' });
    }
    if (voiceOk) { fs.copyFileSync(base + '.wav', audioPath); fs.writeFileSync(keyFile, voiceKey); }
  }
  else if (fs.existsSync(audioPath)) skip('配音生成', `没有本地配音环境（PY_MLX），沿用已有的 ${audioPath}，没核对它和当前稿子是否一致`);
  else stages.push({ name: '配音生成', ok: false, secs: '0.0', checks: [], fixes: [], artifacts: [], tail: '',
    problems: [`没有音频 ${audioPath}，也没有本地配音环境（PY_MLX）：在 tts/ 装好配音环境，或把音频放到这个位置`] });
}

// 2. 各画幅：编译 → 混音 → 渲染 → 写版权信息与存证 → 检查 → 设备预览
// 本机配置了品牌（brand.local.json，不进仓库）才加水印、写版权信息、记存证；没配置就在报告里写明
const branded = fs.existsSync('brand.local.json');
if (!voiceOk) skip('编译、渲染与成片检查', '配音生成没通过，没有和当前稿子对得上的配音（见上面「配音生成」）');
if (libOk && beatsOk && voiceOk && !branded) skip('水印、版权信息与存证', '本机没有配置品牌（brand.local.json）');
if (libOk && beatsOk && voiceOk) {
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
  // 各画幅一条链同时跑：渲染一次只渲一个（renderLock），一个画幅渲完做检查时，下一个画幅已经在渲了
  const renderLock = makeLock(), bookLock = makeLock();
  const chain = async (t, L) => {
    const id = `${beats.id}-${t}`, tl = `build/${id}.timeline.json`, video = path.join(outDir, `${t}.mp4`);
    const R = (name, cmd, args, opts) => runAsync(`[${t}] ${name}`, cmd, args, opts, L);
    if (!await R('混音', PY_QA, ['audio/mix.py', tl])) return;
    if (!await renderLock(() => R('渲染', 'npx', ['remotion', 'render', 'src/index.ts', id, video, '--log=error', ...(GL ? [`--gl=${GL}`] : [])]))) return;
    if (branded) await bookLock(() => R('版权信息与存证', PY_QA, ['qa/provenance.py', beatsPath, tl, video]));
    // 旁白检查每个画幅都跑：各画幅的旁白是分别拼、分别混的（用户在横版里听出的畸变，原来只查竖版）
    const noSpeech = beats.narration.synthetic ? '配音是合成提示音，没有人声可查' : PY_MLX ? null : '没有本地配音环境（PY_MLX）';
    // 成片出来以后的检查互不依赖，一起跑
    await Promise.all([
      R('画面检查', PY_QA, ['qa/qa.py', tl, video, id]),
      R('铅笔与运笔检查', 'node', ['qa/pencil_check.mjs', tl]),
      R('平台安全区检查', 'node', ['qa/safezone_check.mjs', tl]),
      R('设备预览', PY_QA, ['qa/device_preview.py', tl, video, path.join(outDir, `preview_${t}.png`)]),
      R('审片联系表', PY_QA, ['qa/contact_sheet.py', video, path.join(outDir, 'review')]),
      noSpeech ? skip(`[${t}] 旁白检查`, noSpeech, L) : R('旁白检查', PY_MLX, ['speech_check.py', path.resolve(tl), path.resolve('.')], { cwd: '../tts' }),
      t === compiled[0] && (beats.quiz || []).length ? R('理解度测试材料', PY_QA, ['qa/comprehension.py', 'pack', beatsPath, tl, video, path.join(outDir, 'comprehension')]) : null,
    ]);
  };
  const lists = Object.fromEntries(compiled.map((t) => [t, []]));
  await Promise.all((DRAFT ? [] : compiled).map((t) => chain(t, lists[t])));
  // 报告里按画幅、按步骤的固定顺序排（同时跑时完成先后不定）
  const ORDER = ['混音', '渲染', '版权信息与存证', '画面检查', '铅笔与运笔检查', '平台安全区检查', '设备预览', '审片联系表', '旁白检查', '理解度测试材料'];
  const rank = (s) => ORDER.findIndex((k) => s.name.endsWith(`] ${k}`));
  for (const t of compiled) stages.push(...lists[t].sort((a, b) => rank(a) - rank(b)));
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
// 文件名写成和本报告同一文件夹里的相对名字：版本目录（out/<id>-vN/）是整个复制出来的，写死 out/<id>/ 会在清理工作目录后指向不存在的文件
lines.push('## 发布清单（每个平台只传一个文件，文件和本报告在同一个文件夹）', '', '| 平台 | 上传文件 | 画幅 |', '|---|---|---|');
for (const [pf, prefs] of Object.entries(styleJson.publish)) {
  if (pf === 'note' || !prefs.length) continue; // 空列表：这个平台不发
  const t = prefs.find((x) => produced.includes(x));
  lines.push(`| ${pf} | ${t ? `\`${t}.mp4\`` : '（本期没出合适画幅）'} | ${t ?? '—'} |`);
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
// 自动换种子重配：没过的只有旁白检查，且它点名了掉嗓子、破音、硬切、语速不对的句子（<时间线>.revoice.json），就给这几句换种子、整条重跑，最多两轮。
// 配音那边拼好后已经查过一遍，可成片旁白（重采样、插停顿、片段淡入淡出）上偶尔还会查出来（E02 v5），原来要人手动写 reseed 再跑
const round = Number(process.env.PIPE_REVOICE ?? 0);
const revoice = [...new Set(targets.flatMap((t) => { const f = `build/${beats.id}-${t}.timeline.revoice.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; }))];
if (failed.length && revoice.length && round < 2 && PY_MLX && failed.every((s) => s.name.includes('旁白检查'))) {
  const f = path.resolve('../tts/out', path.basename(audioPath, path.extname(audioPath))) + '.autoreseed.json';
  const auto = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  for (const sent of revoice) auto[sent] = Math.max(auto[sent] ?? 0, beats.narration.reseed?.[sent] ?? 0) + 1;
  fs.writeFileSync(f, JSON.stringify(auto, null, 1));
  console.log(`\n↻ 旁白检查点名 ${revoice.length} 句（掉嗓子、破音、硬切或语速不对），换种子重配后整条重跑（第 ${round + 1} 轮，最多 2 轮）：${revoice.map((x) => `「${x.slice(0, 12)}」`).join('')}`);
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, PIPE_REVOICE: String(round + 1) } });
  process.exit(r.status ?? 1);
}
process.exit(failed.length ? 1 : 0);
