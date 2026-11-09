// 静帧审稿：内容先行。稿子和分镜在静帧上打磨到位，理解度测试和审稿都在配音、渲整片之前做（用户 2026-11-06：
// 「每次发布流程很漫长主要花在了视频制作后期，但前期对内容的打磨是不够的」——E02 v6 以后查出来的几乎都是讲法和画面的问题，可每查出一处都要重配音、重渲整片才能再测）。
// 一条命令：分镜校验 → 试编（按语速估时间，不配音）→ 按每句画完的时刻渲静帧（不带声音）→ 出两份材料：
//   <out>/comprehension/：理解度测试材料，和 comprehension.py pack 同一个格式（frames/、questions.json、pack.md），交给一个没看过分镜的新 agent；
//   <out>/review/：审稿材料（审片规则里和声音无关的部分：教学、画面和旁白是不是一回事、字与旁白是否同步、版面、吸引力），交给另一个新 agent。
// 用法：node qa/still_review.mjs data/<id>.beats.json [--out out/<id>-s<N>] [--rate 字每秒] [--targets 16x9,9x16] [--prev <上一轮的 review.json>]
//   --out：默认 out/<id>/stills；每轮审稿换一个目录（out/<id>-s1、-s2……），下一轮把上一轮的 review.json 用 --prev 带上，审稿人逐条标改好没有
// 时间是估的（试编），「落后」「停顿」以真配音为准；声音、语气、运动是否流畅，留给配音和整片之后的最后一次全量审片。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dryLayout } from '../compiler/dry_layout.mjs';
import { renderTimelineStills } from './stills.mjs';
import { PY_QA } from './pyenv.mjs';
import { cameraAt } from '../src/timeline.ts';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.now(), secs = () => ((Date.now() - T0) / 1000).toFixed(0);
const argv = process.argv.slice(2), arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const beatsPath = path.resolve(argv[0] ?? '');
if (!argv[0] || !fs.existsSync(beatsPath)) { console.error('用法：node qa/still_review.mjs data/<id>.beats.json [--out 目录] [--rate 字每秒] [--targets 16x9] [--prev review.json]'); process.exit(2); }
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
const outDir = path.resolve(arg('--out') ?? path.join(ENGINE, 'out', beats.id, 'stills'));
const prev = arg('--prev') ? path.resolve(arg('--prev')) : null;
process.chdir(ENGINE);

// 1. 分镜校验：有错误就编不了，停在这里；建议（含写稿自查）带进审稿材料，审稿人不用再报
const v = spawnSync('node', ['compiler/validate.mjs', beatsPath], { encoding: 'utf8' });
const vout = (v.stdout || '') + (v.stderr || '');
const tagged = (tag) => vout.split('\n').filter((l) => l.startsWith(`[${tag}] `)).map((l) => l.slice(tag.length + 3));
if (v.status !== 0) { console.log(vout); console.log('✗ 分镜校验没过，先改掉上面的错误'); process.exit(1); }
console.log(`✓ 分镜校验（${secs()}s）${tagged('建议').length ? `  建议 ${tagged('建议').length} 条` : ''}`);

// 2. 试编：按语速造假时间编译每个画幅，再跑安全区和铅笔检查
const dry = dryLayout(beatsPath, { rate: arg('--rate') ? Number(arg('--rate')) : undefined, keep: true, targets: arg('--targets')?.split(',') });
const tmp = fs.mkdtempSync(path.join(ENGINE, 'build', '_still-review-'));
// 走到哪一步停下都把试编文件和临时静帧清掉（process.exit 不走 finally）
const finish = (code) => { dry.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
try {
  for (const t of dry.targets) console.log(`${t.ok ? '✓' : '✗'} [${t.target}] 试编（${secs()}s）${t.problems.length ? `  问题 ${t.problems.length} 项` : ''}${t.advice.length ? `  建议 ${t.advice.length} 条` : ''}`);
  const bad = dry.targets.filter((t) => !t.compiled);
  if (bad.length) { for (const t of bad) console.log(`[${t.target}] 编译失败：\n  ${t.problems.join('\n  ')}`); finish(1); }

  // 3. 每个画幅要渲哪些帧：每句画完的那一刻（和理解度测试同一个算法，见 comprehension.py times），外加这句从开口到画完之间的几帧（看字和旁白是否同步）
  const chars = dry.words; // 旁白源音频上的每个字（试编估的）
  const jobs = [], manifest = { beats: beatsPath, id: beats.id, rate: dry.rate, seconds: Math.round(dry.seconds), out: outDir, prev, validateAdvice: tagged('建议'), validateNotes: tagged('提醒'), targets: [] };
  const comps = {};
  for (const t of dry.targets) {
    const tl = JSON.parse(fs.readFileSync(t.timeline, 'utf8')), comp = `t${t.target.replace(/\W/g, '_')}`;
    comps[comp] = t.timeline;
    const tr = spawnSync(PY_QA, ['qa/comprehension.py', 'times', beatsPath, t.timeline], { encoding: 'utf8' });
    if (tr.status !== 0) { console.log(tr.stdout + tr.stderr); finish(1); }
    const ends = JSON.parse(tr.stdout);
    const dir = path.join(tmp, t.target);
    fs.mkdirSync(path.join(dir, 'end'), { recursive: true });
    // 某一刻正在说的几个字（试编估的时间）：按句找到这一刻落在哪段旁白里，换算到源音频上的时间，往后取 5 个字
    const saying = (time) => {
      const c = tl.audioClips.find((a) => time >= a.at && time < a.at + (a.srcOut - a.srcIn));
      if (!c) return '';
      const src = c.srcIn + (time - c.at);
      let k = chars.findIndex((w) => w.start > src) - 1;
      if (k < -1) k = chars.length - 1;
      k = Math.max(0, k);
      const inClip = chars.filter((w, j) => j >= k && w.start < c.srcOut).slice(0, 5);
      return inClip.map((w) => w.text).join('');
    };
    const actions = new Map(beats.phrases.flatMap((p) => p.actions ?? []).map((a) => [a.id, a]));
    const strokesOf = Map.groupBy(tl.strokes, (s) => s.action);
    // 一个元素此刻在画面里露出多少（按笔画外框算）：这句画的东西在它说完那一刻不在画面里，旁白说到它时观众看不到
    const shown = (id, time) => {
      const ss = (strokesOf.get(id) ?? []).filter((s) => s.t0 <= time);
      if (!ss.length) return null;
      const c = cameraAt(tl.camera, time);
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const s of ss) for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const sx = (x) => (x - c.x) * c.z + tl.view.cx, sy = (y) => (y - c.y) * c.z + tl.view.cy;
      const [l, r, tp, b] = [sx(x0), sx(x1), sy(y0), sy(y1)], area = Math.max(1, (r - l) * (b - tp));
      const iw = Math.max(0, Math.min(r, tl.canvas.w) - Math.max(l, 0)), ih = Math.max(0, Math.min(b, tl.canvas.h) - Math.max(tp, 0));
      return (iw * ih) / area;
    };
    const subs = tl.subtitles.reduce((a, s) => (s.join && a.length ? (a[a.length - 1] = { ...a.at(-1), text: `${a.at(-1).text}，${s.text}`, t1: s.t1 }, a) : [...a, { ...s }]), []);
    const phrases = tl.report.phrases.map((rp, i) => {
      const bp = beats.phrases[i], end = ends[i], clip = tl.audioClips[i];
      const a = clip.at, b = Math.max(rp.audioEnd, rp.drawEnd, a + 0.6), span = b - a;
      const n = span < 1.2 ? 1 : Math.min(4, Math.max(2, Math.ceil(span / 1.8)));
      const strip = Array.from({ length: n }, (_, k) => {
        const time = +(a + ((k + 0.5) * span) / n).toFixed(2), f = path.join(dir, `${String(i + 1).padStart(2, '0')}_${k}.png`);
        jobs.push({ comp, frame: Math.floor(time * tl.fps), out: f });
        return { t: time, png: f, saying: saying(time) };
      });
      const png = path.join(dir, 'end', `${String(i + 1).padStart(2, '0')}.png`);
      jobs.push({ comp, frame: end.frame, out: png });
      const acts = tl.report.actions.filter((x) => x.phrase === i).map((x) => {
        const src = actions.get(x.id) ?? {};
        const vis = x.pen ? shown(x.id, end.t) : null;
        return { id: x.id, type: x.type, text: src.text ?? src.label ?? null, at: src.at ?? null, cue: x.cue, start: x.start, end: x.end, pen: x.pen, ahead: !!src.ahead, visible: vis === null ? null : +vis.toFixed(2) };
      });
      // 对话：写上是谁说的。这个人第一次开口那句，编译器已经在字幕前面写了称呼（compiler/compile.mjs 的 intro），不再加一遍（原来写成「爸爸：爸爸：跟我一样」）
      const said = subs[i]?.text ?? bp.caption ?? bp.text, who = subs[i]?.label ? `${subs[i].label}：` : '';
      return { i, text: said.startsWith(who) ? said : who + said,
       role: bp.role ?? '', chapter: bp.chapter ?? null, camera: bp.camera ?? (bp.revisit ? 'revisit' : null), at: a, audioEnd: rp.audioEnd, drawEnd: rp.drawEnd, insertedPause: rp.insertedPause, endT: end.t, png, strip, actions: acts };
    });
    // 全片最后一帧（整张纸）：看全局版式、片尾停在哪
    const lastPng = path.join(dir, 'last.png');
    jobs.push({ comp, frame: tl.durationInFrames - 1, out: lastPng });
    manifest.targets.push({ target: t.target, timeline: t.timeline, canvas: tl.canvas, duration: tl.duration, chapters: tl.chapters ?? [], problems: t.problems, advice: t.advice, endsDir: path.join(dir, 'end'), lastPng, phrases });
  }
  console.log(`… 渲染 ${jobs.length} 张静帧`);
  await renderTimelineStills(comps, jobs);
  console.log(`✓ 静帧（${secs()}s）`);

  // 4. 两份材料：审稿（全部画幅）、理解度（第一个画幅，和流水线一样）
  // 只清这两份材料自己的子目录（--out 写错成流水线的工作目录时，不会把成片一起删掉）
  for (const d of ['review', 'comprehension']) fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
  const rv = spawnSync(PY_QA, ['qa/still_review.py', path.join(tmp, 'manifest.json')], { encoding: 'utf8' });
  process.stdout.write(rv.stdout || ''); if (rv.status !== 0) { console.log(rv.stderr); finish(1); }
  if ((beats.quiz ?? []).length) {
    const t = manifest.targets[0];
    const cp = spawnSync(PY_QA, ['qa/comprehension.py', 'pack', beatsPath, t.timeline, t.endsDir, path.join(outDir, 'comprehension')], { encoding: 'utf8' });
    process.stdout.write(cp.stdout || ''); if (cp.status !== 0) { console.log(cp.stderr); finish(1); }
  } else console.log('– 理解度测试材料：分镜里没有自测题（quiz），不出');
  const nProb = dry.targets.reduce((n, t) => n + t.problems.length, 0);
  console.log(`\n${nProb ? '✗' : '✓'} 静帧审稿材料已出（${secs()}s）：${path.relative(process.cwd(), outDir)}/${nProb ? `；试编还有 ${nProb} 项要改（见 review/pack.md 开头）` : ''}`);
  console.log('接下来（两个都另起新 agent，制作方不自评）：');
  console.log(`- 审稿：只把 ${path.relative(process.cwd(), path.join(outDir, 'review'))}/ 交给审稿 agent，照 pack.md 写 review.json`);
  // 理解度起两个测试者、「没懂」「靠猜」取并集：同一份材料测试者之间差得比材料之间还大（E02 v13 四次都是 10/10，靠猜 0、4、1、3 处，找到的是同一批问题、归档不同）
  if ((beats.quiz ?? []).length) console.log(`- 理解度：把 ${path.relative(process.cwd(), path.join(outDir, 'comprehension'))}/ 拷两份，交给两个新 agent（只看各自那一份），各写 answers.json，每份跑 ../.venv-qa/bin/python qa/comprehension.py score ${path.relative(process.cwd(), beatsPath)} <那一份>/answers.json，「没懂」「靠猜」取并集`);
  finish(0);
} catch (e) {
  console.error(e);
  finish(1);
}
