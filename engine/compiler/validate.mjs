// 分镜校验（渲染前、纯静态）：一次列出全部问题，每条都精确到位置，交给写分镜的一方改。
// 错误（hard）只管机械上会坏的：组件与参数、引用、事实出处、字幕折行、平台章节规格。
// 创作取舍（叙事结构、字号阶梯、手写字号下限）按风格规范 gates 的级别，默认只给建议，不拦截。
// 用法：node compiler/validate.mjs data/<id>.beats.json
import { polyphoneIssues } from './polyphones.mjs';
import { scriptIssues } from './script_checks.mjs';
import { isDialogue, sentenceSpeakers, voicesOf } from './speakers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTINS, loadLibrary } from '../library/index.mjs';
import { CJK, glyphData, makeKit } from '../library/kit.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.resolve(ENGINE, '../..');
// 生效的风格 = 默认 style/style.json < 本机私有创作配置 style/profile.local.json（不进仓库）< 这一期分镜的 style。
// 每期分镜可以加颜色、换字号阶梯、调节奏参数，但不能改关卡级别、画幅、平台界面和章节规格（那是机械约束和平台规格）
const PROTECTED = new Set(['gates', 'targets', 'platformUI', 'chapters', 'publish']);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v; return o; };
export const loadStyle = (beats) => {
  let s = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style/style.json'), 'utf8'));
  const prof = process.env.SKETCH_PROFILE || path.join(ENGINE, 'style/profile.local.json'); // SKETCH_PROFILE：换一份创作配置（自测用）
  if (fs.existsSync(prof)) s = merge(s, JSON.parse(fs.readFileSync(prof, 'utf8')));
  if (beats?.style) s = merge(s, Object.fromEntries(Object.entries(beats.style).filter(([k]) => !PROTECTED.has(k))));
  return s;
};
// 关卡级别：gates 里写 advice 的只给建议；没列出的都是 hard
export const gateLevel = (style, id) => (style.gates?.[id] === 'advice' ? 'advice' : 'hard');
export const strip = (s) => s.replace(/[\s，。；：！？、,.;:!?"“”'‘’（）()—-]/g, '');
const SCHED_KEYS = new Set(['id', 'type', 'at', 'lead', 'on', 'after', 'layout', 'speed', 'hold', 'note', 'bleed', 'ahead']);
const ROLES = new Set(['hook', 'setup', 'aha', 'recap', 'next']);

// 估算一行字的宽度：中文全角，其余半角
export const textWidth = (text, size) => [...text].reduce((w, c) => w + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.55), 0) * size;
// 字幕断行（确定性，渲染和检查共用）：
//   - 优先断在停顿标点或空格之后，在这些断点里选让各行长短最接近的；
//   - 行首不能是收尾标点（，。、：；！？）」等），行尾不能是开头标点（（「等）——审片发现「…权重：4 / 、3、2」；
//   - 实在没有停顿断点，才在字与字之间断，仍守上面两条。
export const NO_LINE_START = /[，。、：；！？）」』”’,.!?:;)\]]/;
const NO_LINE_END = /[（「『“‘(\[]/;
const PAUSE = /[，。、：；！？,.!?:;]/;
// 词边界（按字符下标）：在词中间断行（「自己」断成「自 / 己」）比两行不等长更难读。用 Node 自带的 ICU 分词
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const wordStarts = (chars) => {
  const s = new Set([0, chars.length]);
  if (!SEG) { for (let k = 0; k <= chars.length; k++) s.add(k); return s; }
  const at = []; let cu = 0; // UTF-16 下标 → 字符下标
  chars.forEach((c, i) => { at[cu] = i; cu += c.length; });
  for (const g of SEG.segment(chars.join(''))) s.add(at[g.index]);
  return s;
};

export function breakLines(text, size, width) {
  const lines = [];
  let rest = [...text];
  while (rest.length && textWidth(rest.join(''), size) > width) {
    const starts = wordStarts(rest);
    let n = 0; // 这一行最多放得下几个字
    while (n < rest.length && textWidth(rest.slice(0, n + 1).join(''), size) <= width) n++;
    const target = rest.length / Math.ceil(textWidth(rest.join(''), size) / width); // 剩下的平均每行字数
    let best = -1, bestScore = Infinity;
    for (let k = 1; k <= n && k < rest.length; k++) {
      if (NO_LINE_START.test(rest[k]) || NO_LINE_END.test(rest[k - 1])) continue;
      // 两行字数尽量均分；标点处断行只在不太失衡时优先（审片：「每个输入，/都要乘上自己的权重：4、3、2」5 字对 15 字）
      const score = 1.5 * Math.abs(k - target) + (PAUSE.test(rest[k - 1]) || rest[k] === ' ' ? 0 : 4) + (starts.has(k) ? 0 : 20);
      if (score < bestScore) { bestScore = score; best = k; }
    }
    if (best < 0) best = n; // 整行都是标点之类的极端情况
    lines.push(rest.slice(0, best).join('').trim());
    rest = rest.slice(best);
  }
  if (rest.length) lines.push(rest.join('').trim());
  return lines.filter(Boolean);
}

function checkType(spec, v, style, ctx) {
  const t = spec.type;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(isNum);
  switch (t) {
    case 'number': return isNum(v) ? null : '应为数字';
    case 'point': return isPt(v) ? null : '应为 [x, y]';
    case 'points': return Array.isArray(v) && v.length >= 2 && v.every(isPt) ? null : '应为至少两个 [x, y] 的数组';
    case 'numbers': return Array.isArray(v) && v.length && v.every(isNum) ? null : '应为数字数组';
    case 'string': return typeof v === 'string' && v.length ? null : '应为非空字符串';
    case 'enum': return spec.values.includes(v) ? null : `只能是 ${spec.values.join(' / ')}`;
    case 'inkColor': return style.inkColors.includes(v) ? null : `「${v}」不是规范里的墨色，可用：${style.inkColors.join('、')}（不能写色值）`;
    case 'effectColor': return style.effectColors.includes(v) ? null : `「${v}」不是规范里的效果色，可用：${style.effectColors.join('、')}`;
    case 'strokeWidth': { const r = style.ink.shapeWidth; return isNum(v) && v >= r.min && v <= r.max ? null : `线宽应在 ${r.min}~${r.max}`; }
    case 'typeSize': return isNum(v) && v > 0 ? null : '应为正数'; // 是否落在字号阶梯上是创作取舍，见 validateBeats 的 type.scale
    case 'actionId': return ctx.drawnBefore.has(v) ? null : `引用的「${v}」不存在或还没画`;
    case 'actionIds': { const miss = [v].flat().filter((x) => !ctx.drawnBefore.has(x)); return [v].flat().length && !miss.length ? null : `引用的「${miss.join('、')}」不存在或还没画`; }
    default: return `未知参数类型 ${t}`;
  }
}

export function validateBeats(beats, style, reg) {
  const errors = [], warnings = [], advice = [];
  // G：创作取舍，按 gates 级别进错误或建议
  const G = (gate, where, msg) => (gateLevel(style, gate) === 'advice' ? advice : errors).push(`${where}：${msg}`);
  const E = (where, msg) => errors.push(`${where}：${msg}`);
  if (!['episode', 'segment'].includes(beats.kind)) E('kind', '应为 episode（完整一集）或 segment（片段）');
  if (!beats.narration?.audio && !beats.narration?.script) E('narration', '需要 audio（已有配音）或 script（待生成的旁白稿）');
  // 配音会按读数规则读的写法：数字后面的冒号读成「比」（实测「定在5：超过它」读成「五比超过它」）
  // reseed：听出畸变的句子换个种子重配，键必须是旁白稿里的一整句（含句末标点），值是正整数
  const sentences = (beats.narration?.script ?? '').match(/[^。？！]+[。？！]?/g) ?? [];
  for (const [t, k] of Object.entries(beats.narration?.reseed ?? {})) {
    if (!sentences.includes(t)) E('narration.reseed', `「${t}」不是旁白稿里的一整句（要连句末标点一起写）`);
    if (!Number.isInteger(k) || k < 1) E('narration.reseed', `「${t}」的偏移要写正整数`);
  }
  // tone：按句标语气，配音时按它挑候选（语气名在不在 voice.json 的 tones 里，配音时查）
  for (const [t, m] of Object.entries(beats.narration?.tone ?? {})) {
    if (!sentences.includes(t)) E('narration.tone', `「${t}」不是旁白稿里的一整句（要连句末标点一起写）`);
    if (typeof m !== 'string' || !m.trim() || m.includes('=')) E('narration.tone', `「${t}」的语气要写 voice.json 的 tones 里的名字`);
  }
  // mood：按句选情绪参考音（语气跟着内容变）。哪句用什么情绪是创作取舍，这里只查格式；情绪名在不在本机 voice.json 里，配音时查
  for (const [t, m] of Object.entries(beats.narration?.mood ?? {})) {
    if (!sentences.includes(t)) E('narration.mood', `「${t}」不是旁白稿里的一整句（要连句末标点一起写）`);
    if (typeof m !== 'string' || !m.trim() || m.includes('=')) E('narration.mood', `「${t}」的情绪要写 voice.json 的 moods 里的名字`);
  }
  for (const m of (beats.narration?.script ?? '').matchAll(/\d[：:]/g)) E('narration.script', `「${beats.narration.script.slice(Math.max(0, m.index - 4), m.index + 4)}」数字后面的冒号会被配音读成「比」，改成逗号`);
  for (const t of beats.targets ?? []) if (!style.targets[t]) E('targets', `未知画幅「${t}」，可用：${Object.keys(style.targets).join('、')}`);
  if (!Array.isArray(beats.phrases) || !beats.phrases.length) { E('phrases', '不能为空'); return { errors, warnings }; }

  // 对话（compiler/speakers.mjs）：说话的人要登记，换人要在句末
  const voices = voicesOf(beats);
  if (!isObj(voices)) E('narration.voices', '要写成 { 说话人: { voice, label, caption } }');
  else for (const [sp, v] of Object.entries(voices)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(sp)) E(`narration.voices.${sp}`, '说话人的名字用小写英文字母开头（如 dad），中文名写在 label');
    if (typeof v?.voice !== 'string' || !v.voice.endsWith('.json')) E(`narration.voices.${sp}.voice`, '要写这个人的音色配置文件（相对 tts/ 的路径，如 ref/dad/voice.dad.json）');
    if (v?.label !== undefined && (typeof v.label !== 'string' || !v.label.trim())) E(`narration.voices.${sp}.label`, '要写这个人的称呼（如「爸爸」），理解度材料和审稿材料里用');
    if (v?.caption !== undefined && !style.palette?.[v.caption]) E(`narration.voices.${sp}.caption`, `「${v.caption}」不是规范调色板里的颜色名，可用：${Object.keys(style.palette ?? {}).join('、')}`);
  }
  beats.phrases.forEach((p, i) => {
    if (p.speaker !== undefined && !(isObj(voices) && voices[p.speaker])) E(`phrases[${i}]「${(p.text || '').slice(0, 8)}」.speaker`, `「${p.speaker}」没在 narration.voices 里登记（登记音色配置、称呼和字幕颜色）`);
  });
  if (isDialogue(beats)) {
    if (!beats.narration?.script) E('narration.script', '对话要写旁白稿：配音按人分开配，要从旁白稿里分出每句是谁说的');
    else for (const msg of sentenceSpeakers(beats).problems) E('narration.script', msg);
  }

  // 章节：要么不分，要么从第一句开始分，节数在各平台都能用的范围里
  const chapterAt = beats.phrases.map((p, i) => (p.chapter ? i : -1)).filter((i) => i >= 0);
  if (chapterAt.length) {
    if (chapterAt[0] !== 0) E('phrases[0].chapter', '分了章节就要从第一句开始（YouTube 章节第一行必须是 0:00）');
    const C = style.chapters;
    if (chapterAt.length < C.minCount || chapterAt.length > C.maxCount) E('chapters', `共 ${chapterAt.length} 节，要在 ${C.minCount}–${C.maxCount} 节之间（YouTube 至少 3 节，B 站最多 10 节）`);
  }
  const ids = new Set(), drawnBefore = new Set();
  beats.phrases.forEach((p, pi) => {
    const P = `phrases[${pi}]「${(p.text || '').slice(0, 8)}」`;
    if (!p.text) E(P, '缺少 text');
    if (p.role && !ROLES.has(p.role)) E(`${P}.role`, `只能是 ${[...ROLES].join(' / ')}`);
    if (p.camera && !['focus', 'overview'].includes(p.camera)) E(`${P}.camera`, '只能是 focus（推近这句的元素）或 overview');
    if (p.frame !== undefined) {
      if (!Array.isArray(p.frame) || !p.frame.length) E(`${P}.frame`, '要列出前面画过的元素 id：这句的镜头要把它们整段框进来');
      else for (const fid of p.frame) if (!beats.phrases.slice(0, pi + 1).some((q) => (q.actions || []).some((x) => x.id === fid))) E(`${P}.frame`, `「${fid}」不是这句或前面句子里画过的元素`);
    }
    if (p.chapter !== undefined && (typeof p.chapter !== 'string' || ![...p.chapter].length || [...p.chapter].length > style.chapters.titleMax)) E(`${P}.chapter`, `节名要写，最多 ${style.chapters.titleMax} 个字（B 站分段章节标题要少于 16 个汉字）`);
    if (p.noPush !== undefined && (!Array.isArray(p.noPush) || p.noPush.some((t) => !style.targets[t]))) E(`${P}.noPush`, `只能列出画幅名，可用：${Object.keys(style.targets).join('、')}`);
    if (p.camera === 'overview' && (p.actions || []).length) E(`${P}.camera`, 'overview（整张纸全景）的句子不画新东西（actions 要空着）');
    if (p.camera === 'overview' && p.revisit) E(`${P}.camera`, 'overview 和 revisit 不能同时用');
    if (p.revisit !== undefined) {
      // 回看：镜头回到前面画过的元素，这句本身不画（片尾回顾）
      if (!Array.isArray(p.revisit) || !p.revisit.length) E(`${P}.revisit`, '要列出前面画过的元素 id');
      else for (const rid of p.revisit) if (!beats.phrases.slice(0, pi).some((q) => (q.actions || []).some((x) => x.id === rid))) E(`${P}.revisit`, `「${rid}」不是前面句子里画过的元素`);
      // 回看时可以圈出、回描、划掉已有的元素（点出这一站的重点），不画新东西
      const extra = (p.actions || []).filter((x) => !['ring', 'retrace', 'strike'].includes(x.type));
      if (extra.length) E(`${P}.revisit`, `回看的句子只能圈出、回描、划掉已有元素（ring/retrace/strike），不画新东西：${extra.map((x) => x.id).join('、')}`);
      if (p.role === 'aha' || p.camera === 'focus') E(`${P}.revisit`, '回看和推近（顿悟句、camera=focus）不能同时用');
    }
    if (p.focus) for (const fid of p.focus) if (!beats.phrases.some((q) => (q.actions || []).some((x) => x.id === fid))) E(`${P}.focus`, `「${fid}」不是分镜里的元素`);
    const st = strip(p.text || '');
    for (const a of p.actions || []) {
      const A = `${P}.${a.id || '(无 id)'}`;
      if (!a.id) { E(A, '缺少 id'); continue; }
      if (ids.has(a.id)) E(A, 'id 重复');
      ids.add(a.id);
      if (a.at === undefined || !st.includes(strip(String(a.at)))) E(`${A}.at`, `cue「${a.at}」不在这句旁白里`);
      const def = reg.get(a.type)?.meta ?? BUILTINS[a.type];
      if (!def) { E(`${A}.type`, `未知组件「${a.type}」，可用：${[...reg.keys(), ...Object.keys(BUILTINS)].join('、')}`); continue; }
      const checkParams = (obj, where, partial) => {
        for (const [k, spec] of Object.entries(def.params)) {
          if (obj[k] === undefined) { if (spec.required && !partial && !(a.after && (k === 'x' || k === 'y'))) E(`${where}.${k}`, '必填'); continue; }
          const m = checkType(spec, obj[k], style, { drawnBefore });
          if (m) E(`${where}.${k}`, m);
          else if (spec.type === 'typeSize' && !style.type.scale.includes(obj[k])) G('type.scale', `${where}.${k}`, `字号 ${obj[k]} 不在字号阶梯 [${style.type.scale.join(', ')}] 上`);
        }
        for (const k of Object.keys(obj)) if (!def.params[k] && !SCHED_KEYS.has(k)) warnings.push(`${where}.${k}：组件 ${a.type} 没有这个参数，会被忽略`);
      };
      checkParams(a, A, false);
      // 试画一次：字体里没有的字（如全角逗号）、组件画不出来的参数，在校验时就报出位置，不等编译时崩（E01 v8 的「把世界拆开，」）
      if (reg.get(a.type)) try { reg.get(a.type).draw({ ...a, x: a.x ?? 0, y: a.y ?? 0 }, makeKit(a, style, reg)); } catch (e) { E(A, `画不出来：${e.message}`); }
      // 手写汉字太小会糊（统一笔宽下笔画多的字糊成一团）：含汉字的文字/标签不得小于 type.minCjkSize，各画幅覆盖也查
      const cjkSize = (obj, where) => {
        const m = { ...a, ...obj };
        for (const [tk, sk] of [['text', 'size'], ['label', 'labelSize']]) {
          if (typeof m[tk] !== 'string' || !CJK.test(m[tk]) || m[sk] === undefined) continue;
          // 笔画越多的字要写越大：下限 = max(minCjkSize, 最多笔画数 × cjkSizePerStroke)
          const strokes = Math.max(...[...m[tk]].filter((c) => CJK.test(c)).map((c) => glyphData(c).medians.length));
          const need = Math.max(style.type.minCjkSize, strokes * (style.type.cjkSizePerStroke ?? 0));
          if (m[sk] < need) G('type.minCjk', `${where}.${sk}`, `「${m[tk]}」含汉字（最多 ${strokes} 笔），字号 ${m[sk]} 小于手写汉字下限 ${need}（笔画多的字会糊）`);
        }
      };
      cjkSize({}, A);
      for (const [keys, ov] of Object.entries(a.layout || {})) cjkSize(ov, `${A}.layout.${keys}`);
      if (a.on !== undefined && !ids.has(a.on)) E(`${A}.on`, `从属的「${a.on}」不存在或在它之后才画`);
      if (a.type === 'off') {
        const g = beats.phrases.flatMap((p) => p.actions).find((x) => x.id === a.target);
        if (g && g.type !== 'glow') E(`${A}.target`, `off 只能熄灭光晕（glow），「${a.target}」是 ${g.type}`);
      }
      // after：接在前一段文字后面写（同一行，位置由编译器按前文实际墨迹算），只能接文字
      if (a.after !== undefined) {
        const base = beats.phrases.flatMap((p) => p.actions).find((x) => x.id === a.after);
        if (a.type !== 'text' || !base || base.type !== 'text' || !drawnBefore.has(a.after)) E(`${A}.after`, `「${a.after}」必须是先写的文字，且自己也是文字`);
        for (const k of ['x', 'y', 'anchor']) if (a[k] !== undefined || Object.values(a.layout || {}).some((o) => o[k] !== undefined)) E(`${A}.${k}`, `用了 after 就不要再写 ${k}（位置由前文决定）`);
      }
      // layout 的键可以是一个或多个画幅（逗号分隔），和编译器的规则一致
      for (const [keys, ov] of Object.entries(a.layout || {})) {
        const bad = keys.split(',').map((x) => x.trim()).filter((t) => !style.targets[t]);
        if (bad.length) { E(`${A}.layout.${keys}`, `未知画幅 ${bad.join('、')}，可用：${Object.keys(style.targets).join('、')}`); continue; }
        checkParams(ov, `${A}.layout.${keys}`, true);
      }
      drawnBefore.add(a.id);
    }
  });

  // 剧集里接着上一集：第 2 集起要写明上一集结尾答应了什么（brief.fromPrev），这一集要接住（E02 v1–v3 把 E01 说好的灯泡换成了红绿灯）
  if (beats.series?.serial && (beats.series.episode ?? 1) > 1 && !beats.brief?.fromPrev) E('brief.fromPrev', `剧集「${beats.series.serialTitle ?? beats.series.serial}」第 ${beats.series.episode} 集：写明上一集结尾答应了什么（照抄上一集 next 那几句），这一集要接住`);
  // 叙事结构（创意自由，但完整一集必须有这些骨架）
  const rules = style.narrative[beats.kind] || { requireRoles: [], minQuiz: 0 };
  const roles = beats.phrases.map((p) => p.role).filter(Boolean);
  for (const r of rules.requireRoles) if (!roles.includes(r)) G('narrative.roles', 'phrases.role', `完整一集必须有 role=${r} 的句子`);
  if (rules.requireRoles.includes('hook') && beats.phrases[0].role !== 'hook') G('narrative.roles', 'phrases[0].role', '第一句必须是钩子（role=hook）');
  const quiz = beats.quiz || [];
  if (quiz.length < rules.minQuiz) G('narrative.quiz', 'quiz', `至少 ${rules.minQuiz} 道自测题`);
  quiz.forEach((q, i) => { if (!q.q || !q.a || !Array.isArray(q.keywords) || !q.keywords.length) E(`quiz[${i}]`, '需要 q（问题）、a（答案）、keywords（判分关键词组）'); });
  // 题型（用户 2026-11-06：E02 v5 理解度 5/5，可 1958 那段很多人理解不过来——题目只考复述，照抄旁白就能得分）：
  // kind 是 recall（复述）/ explain（用自己的话说清这里的东西是什么、为什么）/ transfer（换一组数、换一个情况还会不会）；
  // objective 写这道题考 brief.objectives 的第几条（从 0 起）。每条学习目标至少一道 explain 或 transfer
  const KINDS = new Set(['recall', 'explain', 'transfer']);
  quiz.forEach((q, i) => {
    if (q.kind != null && !KINDS.has(q.kind)) E(`quiz[${i}].kind`, `只能是 recall、explain、transfer`);
    if (q.objective != null && !(Number.isInteger(q.objective) && q.objective >= 0 && q.objective < (beats.brief?.objectives?.length ?? 0))) E(`quiz[${i}].objective`, `要写 brief.objectives 的下标（0 到 ${(beats.brief?.objectives?.length ?? 1) - 1}）`);
  });
  // 只管要求有自测题的作品（完整一集）；演示片段这类 minQuiz 为 0 的不查
  if (rules.minQuiz > 0) (beats.brief?.objectives ?? []).forEach((o, k) => {
    if (!quiz.some((q) => q.objective === k && (q.kind === 'explain' || q.kind === 'transfer')))
      G('narrative.quizDepth', `brief.objectives[${k}]`, `「${o.slice(0, 20)}」没有一道 explain 或 transfer 题（只考复述，照抄旁白就能答对，看不出懂没懂）：加一道，写上 kind 和 objective: ${k}`);
  });

  // 事实出处：旁白里的数字、年份、英文专有名词都要有出处，或明确标为示意数值
  // 用带标点的旁白稿（没有就用字幕）：去掉标点的句子会把「1、1、0」连读成 110；句与句之间加分隔，避免把相邻两句的数字连读（5|7 → 57）
  const narr = beats.narration?.script ?? beats.phrases.map((p) => p.caption || p.text).join('。');
  const tokens = new Set([...(narr.match(/(?<![A-Za-z_])\d+(?:\.\d+)?/g) || []), ...(narr.match(/[A-Za-z][A-Za-z-]{2,}/g) || [])]);
  const facts = beats.facts || [];
  for (const tk of tokens) if (!facts.some((f) => (f.match || []).includes(tk))) E('facts', `旁白里的「${tk}」没有出处，也没有标为示意数值（kind: example）`);
  facts.forEach((f, i) => {
    if (f.kind === 'example') return;
    if (!f.source) { E(`facts[${i}]`, '需要 source（项目内资料文件#锚点）或 kind: example'); return; }
    const [file, anchor] = f.source.split('#');
    const fp = path.resolve(PROJECT, file);
    if (!fs.existsSync(fp)) { E(`facts[${i}].source`, `找不到资料文件 ${file}`); return; }
    if (anchor && !fs.readFileSync(fp, 'utf8').includes(anchor)) E(`facts[${i}].source`, `资料文件里找不到「${anchor}」`);
  });

  // 念法：本机品牌配置（brand.local.json 的 spoken）里写了某个词怎么念（「锟仔ai科学」念「锟仔爱科学」，不是一个个字母读），
  // 旁白稿和分镜 text 就要写念法，字幕 caption 和画面上的字照旧（用户听 E01 v17：ai 被读成两个字母）
  const BRAND = path.join(ENGINE, 'brand.local.json');
  const say = fs.existsSync(BRAND) ? JSON.parse(fs.readFileSync(BRAND, 'utf8')).spoken ?? {} : {};
  for (const [w, s] of Object.entries(say)) {
    if ((beats.narration?.script ?? '').includes(w)) E('narration.script', `旁白稿里的「${w}」要写成念法「${s}」（字幕 caption 和画面上的字照旧写「${w}」）`);
    beats.phrases.forEach((p, i) => { if (p.text.includes(w)) E(`phrases[${i}].text`, `「${w}」要写成念法「${s}」，字幕写在 caption 里`); });
  }

  // 多音字：结构助词「地」这类配音模型常念错、回转识别又听不出的，旁白稿写成同音字（字幕照旧），见 compiler/polyphones.mjs
  for (const x of polyphoneIssues(beats.narration?.script ?? '')) E('narration.script', `「${x.text}」${x.why}：旁白稿写成「${x.say}」（字幕 caption 和画面上照旧写「${x.text}」）`);
  beats.phrases.forEach((p, i) => { for (const x of polyphoneIssues(p.text)) E(`phrases[${i}].text`, `「${x.text}」${x.why}：写成念法「${x.say}」，字幕写在 caption 里`); });

  // 写稿自查（compiler/script_checks.mjs）：新词当场讲清、画面上的数旁白说到、示意数值交代从哪来、开场的小故事回收、留给下一集的是个问题。
  // 只查写没写、在不在、隔了多远，默认是建议（gates 的 script.*）；brief.terms 这类引用写错了（引的半句不在旁白里）才是错误
  for (const x of scriptIssues(beats, style)) (x.gate ? G(x.gate, x.where, x.msg) : E(x.where, x.msg));

  // 字幕：这一期要出的每个画幅下不超过规定行数。画幅写了 sub.maxLines 的，编译时会在标点处把长句拆成几张，只要拆得开就不算超
  const outTargets = beats.targets ?? style.defaultTargets ?? Object.keys(style.targets);
  for (const [t, tg] of Object.entries(style.targets).filter(([t]) => outTargets.includes(t))) {
    if (tg.sub.maxLines) { // 编译时在标点处拆卡：标点之间的每一段都要放得下
      for (const p of beats.phrases) for (const piece of (p.caption || p.text).split(/[，、；：,;:]/)) {
        const n = breakLines(piece, tg.sub.size, tg.sub.width).length;
        if (n > tg.sub.maxLines) E(`字幕[${t}]`, `「${piece}」这一段标点之间要折成 ${n} 行，这个画幅一屏只放 ${tg.sub.maxLines} 行，拆不开，请拆句或加逗号`);
      }
      continue;
    }
    for (const p of beats.phrases) {
      const n = breakLines(p.caption || p.text, tg.sub.size, tg.sub.width).length;
      if (n > style.subtitle.maxLines) E(`字幕[${t}]`, `「${p.caption || p.text}」要折成 ${n} 行，超过 ${style.subtitle.maxLines} 行，请拆句`);
    }
  }
  return { errors, warnings, advice };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const beats = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { errors, warnings, advice } = validateBeats(beats, loadStyle(beats), await loadLibrary());
  for (const w of warnings) console.log(`[提醒] ${w}`);
  for (const a of advice) console.log(`[建议] ${a}`);
  for (const e of errors) console.log(`[错误] ${e}`);
  console.log(errors.length ? `分镜校验：${errors.length} 个错误` : '分镜校验：通过');
  process.exit(errors.length ? 1 : 0);
}

// 时间线里带给渲染器和混音的风格子集（编译器、组件预览共用）
export const styleSubset = (style) => ({ name: style.name, version: style.version, gates: style.gates, palette: style.palette, paper: style.paper, ink: style.ink, subtitle: style.subtitle, pencil: style.pencil, audio: style.audio, motion: style.motion, ...(style.grade ? { grade: style.grade } : {}) });
export { checkType };
