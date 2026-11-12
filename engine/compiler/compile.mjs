// 分镜数据 + 实测旁白时间 → 时间线（单笔调度）。
// 原则：画面跟着语义走；笔画不完就让下一句旁白等（插入停顿），绝不变速、绝不两处同时落笔。
// 风格参数只来自 style/style.json；图元只来自组件库 library/；渲染前先过分镜校验（compiler/validate.mjs）。
// 用法：node compiler/compile.mjs data/<id>.beats.json --target 9x16|16x9|1x1 [--no-autofix] [--no-validate]
import './node_version.mjs'; // 先查 Node 版本；下面的 .ts 都用 await import()，版本低时先看到这条说明
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { svgPathProperties } from 'svg-path-properties';
import { loadLibrary, PENLESS } from '../library/index.mjs';
import { loadSticker } from './stickers.mjs';
import { makeKit, samplePts, offsetPath, r2, dist } from '../library/kit.mjs';
import { validateBeats, loadStyle, gateLevel, strip, breakLines, styleSubset } from './validate.mjs';
const { stickerOutline, flightTip } = await import('../src/timeline.ts');

const beatsPath = process.argv[2];
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
const style = loadStyle(beats);
const library = await loadLibrary();
if (!process.argv.includes('--no-validate')) {
  const { errors, warnings, advice: va } = validateBeats(beats, style, library);
  for (const w of warnings) console.log(`  [提醒] ${w}`);
  for (const a of va) console.log(`  [建议] ${a}`);
  if (errors.length) {
    console.log(`问题 ${errors.length} 项：\n  ` + errors.map((e) => `分镜校验：${e}`).join('\n  '));
    process.exit(1);
  }
}
// 画幅：同一份分镜按不同画幅取景（参数见风格规范 targets）。view = 屏幕上留给内容的区域；frame = 笔迹必须落在的屏幕范围
// 竖版 frame.b = 字幕上沿 − 笔身最大垂直跨度 − 余量，保证笔尖写到最低处时笔身也压不到字幕
const targetName = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : '9x16';
const TGT = style.targets[targetName];
if (!TGT) throw new Error(`未知画幅 ${targetName}`);
const FPS = style.motion.fps;
const AUTOFIX = !process.argv.includes('--no-autofix'); // 自测时关闭自动修复，验证检查本身能发现问题
const OUT_ID = `${beats.id}-${targetName}` + (AUTOFIX ? '' : '-noautofix');
const baseDir = path.dirname(beatsPath);
const timing = JSON.parse(fs.readFileSync(path.resolve(baseDir, beats.narration.timing), 'utf8'));
const PEN = beats.pen;

// 按画幅的版式覆盖：layout 的键可以是一个或多个画幅（逗号分隔），覆盖该画幅下的几何参数
for (const p of beats.phrases) for (const a of p.actions) {
  for (const [keys, ov] of Object.entries(a.layout || {})) if (keys.split(',').map((x) => x.trim()).includes(targetName)) Object.assign(a, ov);
}
// 画一个动作：组件库里的组件 + 风格规范给的颜色和线宽
const drawAction = (a) => library.get(a.type).draw(a, makeKit(a, style, library));

// ---------- 旁白时间：字 → 秒 ----------
const charTimes = []; // 去标点后每个字的 [start,end]
for (const w of timing.words) {
  const cs = [...strip(w.text)];
  cs.forEach((c, i) => charTimes.push({ c, s: w.start + ((w.end - w.start) * i) / cs.length, e: w.start + ((w.end - w.start) * (i + 1)) / cs.length }));
}
const fullText = charTimes.map((c) => c.c).join('');
let cursor = 0;
let phrases = beats.phrases.map((p) => {
  const t = strip(p.text), idx = fullText.indexOf(t, cursor);
  if (idx < 0) throw new Error(`旁白里找不到短语：${p.text}`);
  cursor = idx + t.length;
  return { ...p, i0: idx, i1: idx + t.length - 1, srcStart: charTimes[idx].s, srcEnd: charTimes[idx + t.length - 1].e };
});

// ---------- 切点：只在真正安静处切（对齐时间不准，按源音频能量找）；切不开就把两句并成一句，不在中间插停顿 ----------
const src = path.resolve('public', beats.narration.audio);
const SR = 24000;
// Remotion 自带 ffmpeg 精简过（没有 f32le），转成 16 位 WAV 再按块解析出 data
const tmpWav = path.resolve('build', `${beats.id}.src24k.wav`);
fs.mkdirSync('build', { recursive: true });
execFileSync('npx', ['remotion', 'ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', tmpWav]);
const wavBuf = fs.readFileSync(tmpWav);
let off = 12, pcm = null;
while (off + 8 <= wavBuf.length) {
  const id = wavBuf.toString('ascii', off, off + 4), size = wavBuf.readUInt32LE(off + 4);
  if (id === 'data') { const i16 = new Int16Array(wavBuf.buffer.slice(wavBuf.byteOffset + off + 8, wavBuf.byteOffset + off + 8 + size)); pcm = Float32Array.from(i16, (v) => v / 32768); break; }
  off += 8 + size + (size & 1);
}
if (!pcm) throw new Error('解析源音频 WAV 失败');
const srcDur = pcm.length / SR;
const rmsDb = (t) => {
  const a = Math.max(0, Math.round((t - 0.005) * SR)), b = Math.min(pcm.length, a + Math.round(0.01 * SR));
  let e = 0; for (let i = a; i < b; i++) e += pcm[i] * pcm[i];
  return b > a ? 10 * Math.log10(e / (b - a) + 1e-24) : -240;
};
const QUIET = -45;
function quietCut(lo, hi, prefer = 'center') {
  lo = Math.max(0, lo); hi = Math.min(srcDur, hi);
  let best = null, run = null;
  for (let t = lo; t <= hi; t += 0.005) {
    if (rmsDb(t) <= QUIET) { run = run ? { a: run.a, b: t } : { a: t, b: t }; if (!best || run.b - run.a > best.b - best.a) best = { ...run }; }
    else run = null;
  }
  if (!best) return null;
  return prefer === 'start' ? best.b : prefer === 'end' ? best.a : (best.a + best.b) / 2;
}
const merged = [];
for (const p of phrases) {
  const prev = merged[merged.length - 1];
  if (prev) {
    let cut = quietCut(prev.srcEnd - 0.12, p.srcStart + 0.12);
    // 换了说话的人不能并成一句（字幕要按人换颜色）：配音拼接时人与人之间留了停顿，切不开说明对齐偏了，就切在两句正中
    if (cut === null && (prev.speaker ?? '') !== (p.speaker ?? '')) {
      cut = (prev.srcEnd + p.srcStart) / 2;
      console.log(`  切点：「${prev.text}」|「${p.text}」换了说话的人，之间没找到静音，切在正中 ${r2(cut)}s`);
    }
    if (cut === null) {
      console.log(`  切点：「${prev.text}」|「${p.text}」之间没有静音，合并为一句（中间不插停顿）`);
      prev.text += p.text; prev.caption = (prev.caption || prev.text) + '，' + (p.caption || p.text);
      prev.actions = [...prev.actions, ...p.actions]; prev.i1 = p.i1; prev.srcEnd = p.srcEnd;
      if (p.role === 'aha' || prev.role === 'aha') prev.role = 'aha'; // 合并后顿悟角色优先保留（否则顿悟句不推近）
      if (p.focus) prev.focus = [...(prev.focus || []), ...p.focus];
      continue;
    }
    prev.cutOut = cut; p.cutIn = cut;
  }
  merged.push({ ...p });
}
phrases = merged;
phrases[0].cutIn = quietCut(phrases[0].srcStart - 0.4, phrases[0].srcStart + 0.03, 'end') ?? 0;
phrases[phrases.length - 1].cutOut = quietCut(phrases[phrases.length - 1].srcEnd - 0.03, phrases[phrases.length - 1].srcEnd + 0.8, 'start') ?? srcDur;

// ---------- 运笔限速：按"这一句时镜头实际放大倍数"换算成屏幕速度，保证笔不瞬移、每笔至少写 minStroke 秒 ----------
const M = style.motion;
const ZMAX = M.zoomMax, ZMIN = M.zoomMin;
const V_DRAW = M.drawSpeed;   // 写字时笔尖平均屏幕速度上限 px/s
const V_MOVE = M.moveSpeed;   // 抬笔移动平均屏幕速度上限 px/s（缓动峰值约 2 倍）
const MIN_STROKE = M.minStroke; // 秒（0.05 = 60 帧/秒下 3 帧）。30 帧/秒时约 1.5 帧：一笔仍跨过至少一帧、不会整笔一帧冒出来，作者盲看 30 帧/秒和 60 帧/秒看不出差别，有意按秒算
const strokeDur = (s, len, speed, z) => Math.max(
  s.kind === 'shape' ? Math.max(0.1, (0.06 + len / 1500) / speed) : Math.max(MIN_STROKE, (0.04 + (len / s.normLenRef) * 0.09) / speed),
  (len * z) / V_DRAW);
const moveDur = (d, base, z, speed = 1) => Math.max(base, (base + d / 2200) / speed, (d * z) / V_MOVE);

// ---------- 几何与版面（与时间无关）：先算笔画几何，再自动修字号和压线，最后取景 ----------
const VIEW = TGT.view;
const geo = new Map();
const allActions = phrases.flatMap((p) => p.actions);
const actionsById = new Map(allActions.map((a) => [a.id, a]));
// 贴图：图的宽高按图的比例（w 是图宽，不含白边）
const stickerOf = (a) => { const im = loadSticker(a.src); return { cx: a.cx, cy: a.cy, w: a.w, h: (a.w * im.h) / im.w, tilt: a.tilt ?? -3, href: im.href }; };
const buildOne = (a) => {
  if (a.type === 'glow' || a.type === 'off') return;
  if (a.type === 'sticker') {
    // 贴图不动笔，但版面检查（留空、压线、避让）和取景要把它当一块图形：外轮廓当成一笔「图形」放进 geo，排笔时跳过它
    // 只放外轮廓时，整个落在卡片里面的字量的是到轮廓线的距离，压在卡片上也不报（PR #66 审查）：卡片里面再铺一排横线，间距小于标签留空，
    // 落在卡片里的任何一点离最近的线都不到留空，照样算压线
    const sk = stickerOf(a), o = stickerOutline(sk), ink = (pts) => ({ kind: 'shape', color: style.palette.ink, width: style.ink.penWidth, d: 'M' + pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join(' L') });
    const rows = [], step = Math.max(6, (style.type.labelGap ?? 14) * 0.9), [p0, p1, p2, p3] = o; // 外轮廓：左上、右上、右下、左下（含胶带）
    for (let u = step / 2; u < 1; u += step / dist(p0, p3)) rows.push(ink([[p0[0] + (p3[0] - p0[0]) * u, p0[1] + (p3[1] - p0[1]) * u], [p1[0] + (p2[0] - p1[0]) * u, p1[1] + (p2[1] - p1[1]) * u]]));
    geo.set(a.id, [ink(o), ...rows]);
    return;
  }
  if (a.type === 'retrace') {
    // 回描：同一支笔沿原路径错开零点几到两个像素再描几遍（不换粗笔，不另起一块墨迹）
    const offs = style.ink.retraceOffsets.slice(0, a.passes || 2);
    geo.set(a.id, geo.get(a.target).flatMap((s) => offs.map((o) => ({ ...s, kind: 'shape', group: a.target, d: offsetPath(s.d, o) }))));
  } else if (a.type === 'text' && a.after) {
    // 接写：同一行，左对齐在前文墨迹右边，间距和同一段文字里的字距一样（公式「1×4」「+1×3」接起来像一串）；
    // 要空一格就在文字开头写空格。前文被放大、挪动后跟着重排
    const b = actionsById.get(a.after), bb = bboxOf(geo.get(a.after));
    Object.assign(a, { x: bb.x1 + style.ink.penWidth + 0.1 * Math.min(a.size, b.size), y: b.y, anchor: 'l' });
    geo.set(a.id, drawAction(a));
  } else if (a.type === 'ring') {
    // 圈出：以目标墨迹中心为圆心，半径取包围盒半对角线再留一点
    const b = bboxOf(geo.get(a.target)), r = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 12;
    geo.set(a.id, drawAction({ ...a, type: 'circle', color: a.color ?? 'accent', cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, r }));
  } else if (a.type === 'strike') {
    const ts = [a.target].flat().map((id) => actionsById.get(id)), t0 = ts[0];
    if (ts.every((t) => t.type === 'arcs' && t.cx === t0.cx && t.cy === t0.cy && t.from === t0.from && t.to === t0.to)) {
      // 划掉几道同心声波：从被划的最里一道沿半径斜穿到最外一道外面，里圈留下的弧不碰
      // （按包围盒对角线划，三道外圈弧的划线会擦到留下的那道，整组看着像被静音了）
      const rs = ts.flatMap((t) => t.radii), mid = (t0.from + t0.to) / 2, tilt = Math.min(14, Math.abs(t0.to - t0.from) * 0.3);
      const at = (r, deg) => [t0.cx + r * Math.cos((deg * Math.PI) / 180), t0.cy + r * Math.sin((deg * Math.PI) / 180)];
      geo.set(a.id, drawAction({ ...a, type: 'line', color: a.color ?? 'accent', from: at(Math.min(...rs) - 1, mid + tilt), to: at(Math.max(...rs) + 12, mid - tilt), bow: 1 }));
    } else {
      // 划掉：从目标墨迹（一组时取整体）左下到右上斜划一道，两头各出头一点。
      // 目标是「图形 + 标签」（量表的柱子和数值）时只划图形，上下不出头（审片 v10：划 7 号柱的红杠拉到「7」右上，把「7」也划掉了）
      const ink = ts.flatMap((t) => geo.get(t.id)), shapes = ink.filter((s) => s.kind === 'shape'), mixed = shapes.length && shapes.length < ink.length;
      const b = bboxOf(mixed ? shapes : ink), ex = 8, ey = mixed ? -4 : ex / 2;
      geo.set(a.id, drawAction({ ...a, type: 'line', color: a.color ?? 'accent', from: [b.x0 - ex, b.y1 + ey], to: [b.x1 + ex, b.y0 - ey], bow: 2 }));
    }
  } else geo.set(a.id, drawAction(a));
};
// 挪动或放大一个元素后，引用它的回描、划掉也要跟着重画
const rebuildWithDeps = (a) => { buildOne(a); for (const d of allActions) if ([d.target].flat().includes(a.id) || d.after === a.id) rebuildWithDeps(d); };
const rebuildAll = () => { geo.clear(); for (const a of allActions) buildOne(a); };
// 笔画采样按笔画对象缓存（同一个 d 反复采样占了编译时间的一大半；元素挪动、重画时会生成新的笔画对象，缓存自然失效）
const strokeBox = new WeakMap();
function bboxOf(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) {
    let b = strokeBox.get(s);
    if (!b || b.d !== s.d) {
      const pr = new svgPathProperties(s.d), L = pr.getTotalLength();
      b = { d: s.d, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let k = 0; k <= 12; k++) { const q = pr.getPointAtLength((L * k) / 12); b.x0 = Math.min(b.x0, q.x); b.y0 = Math.min(b.y0, q.y); b.x1 = Math.max(b.x1, q.x); b.y1 = Math.max(b.y1, q.y); }
      strokeBox.set(s, b);
    }
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}
const fitZ = (b, pad) => Math.min(VIEW.w / (b.x1 - b.x0 + 2 * pad), VIEW.h / (b.y1 - b.y0 + 2 * pad));
// 整页全景缩得很小（0.3 倍）时，纸面上留的 70px 边在屏幕上只剩 20px，最上面的字贴着 YouTube 暂停时的标题栏（E02 v6 试编）：
// 按屏幕留边算，至少 padPx 屏幕像素
const fitZScreen = (b, padPx) => { let z = fitZ(b, 70); for (let k = 0; k < 4; k++) z = fitZ(b, Math.max(70, padPx / z)); return z; };
// 全景取景：到这一句为止的全部内容
// 每句的全景取景：框住这一节到这句为止画过的东西。分了章节时，换节就从新的一块纸开始框，镜头沿纸面移过去
// （整集几分钟、好几节内容画在纸上不同的地方；一直框住全部，越往后字越小）
const computePhraseCam = () => {
  const acc = [], out = [];
  for (const p of phrases) {
    if (p.chapter) acc.length = 0;
    // 全景（camera=overview）：这句不画新东西，镜头把整集画过的所有东西都框进来（片尾：从近景慢慢拉到整张纸）。
    // 可以比 zoomMin 更远（整张纸本来就大），下限 overviewZoomMin
    if (p.camera === 'overview') {
      const all = [...geo.values()].flat();
      if (all.length) {
        const b = bboxOf(all);
        out.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: Math.max(M.overviewZoomMin ?? 0.1, Math.min(ZMAX, fitZScreen(b, 44))), overview: true });
      } else out.push(null);
      continue;
    }
    // 回看：这句不画新东西，镜头回到前面画过的那几样（片尾回顾时沿纸面一样样看回去）
    if (p.revisit?.length) {
      // 这句圈出、回描的笔画也要框进来：圈比被圈的字大一圈，只框原元素时圈会出画（E01 v9 竖版「写不完」）
      const b = bboxOf([...p.revisit, ...p.actions.map((a) => a.id)].flatMap((id) => geo.get(id) ?? []));
      out.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: Math.max(ZMIN, Math.min(ZMAX, fitZ(b, 70))), revisit: true });
      continue;
    }
    for (const a of p.actions) if (geo.has(a.id)) acc.push(...geo.get(a.id));
    // frame：这句的镜头还要把这些前面画过的元素整段框进来（同一张图分几节讲时，换节只框新画的东西，旁边的字会被切在画面边上；E02）
    for (const id of p.frame ?? []) if (geo.has(id)) acc.push(...geo.get(id));
    if (!acc.length) { out.push(null); continue; }
    const b = bboxOf(acc);
    out.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: Math.max(ZMIN, Math.min(ZMAX, fitZ(b, 70))) });
  }
  return out;
};
const phraseOf = new Map(phrases.flatMap((p, pi) => p.actions.map((a) => [a.id, pi])));
const MIN_TEXT = style.type.minScreenPx[targetName]; // 字在屏幕上的最小高度（拉丁字母主体）
const GAP = style.type.labelGap;                     // 标签与其他元素笔迹的最小净距
const GROW = style.type.maxAutoGrow;
const nextStep = (sz) => style.type.scale.find((v) => v > sz + 0.01);
const fixes = [];
// 片尾的整张纸全景（camera=overview）是看全貌的，不要求每个字都看得清；按最后一个普通取景算（不然所有字都会被放大到挤在一起）
const lastCam = (cams) => [...cams].reverse().find((c) => c && !c.overview);
const textPx = (a, cams) => a.size * Math.min(cams[phraseOf.get(a.id)]?.z ?? 1, lastCam(cams)?.z ?? 1) * 0.74;

// 1) 字号自动补足：按本画幅最小字高，沿字号阶梯一级一级放大（不超过原字号的 maxAutoGrow 倍；放大会改变取景，迭代几轮）
let phraseCam;
for (let it = 0; it < 8; it++) {
  rebuildAll();
  phraseCam = computePhraseCam();
  let changed = false;
  for (const a of allActions) {
    if (a.type !== 'text') continue;
    a._size0 ??= a.size;
    const px = textPx(a, phraseCam);
    const up = nextStep(a.size);
    if (AUTOFIX && px < MIN_TEXT - 0.5 && up && up <= a._size0 * GROW) {
      a.size = up;
      changed = true;
    }
  }
  if (!changed) break;
}
for (const a of allActions) if (a.type === 'text' && a.size !== a._size0) fixes.push(`字号：「${a.text}」${a._size0} → ${r2(a.size)}`);

// 2) 压线自动避让：标签离其他元素太近时，在周围由近到远找一个不碰任何元素的位置挪过去
// 有意贴近的关系不查间距：标签写在图形上（on）、回描/划掉（target）、接写（after）。两段文字之间只认 after——
// 文字用 on 互相挂靠时照样要查，否则手放的接写会压住前文（实测「=7」压住「4+3+0」，因为 on 让检查跳过了它们）
// 同一行接写（after 一路接下去）的几段文字算一行：「=」「7」拆开写时，「7」和前面的「+0×2」也是同一行里的字距
const chainOf = (x) => { const c = []; for (let y = x; y?.after; y = actionsById.get(y.after)) c.push(y.after); return c; };
const related = (a, b) => {
  if (a.after === b.id || b.after === a.id || [a.target].flat().includes(b.id) || [b.target].flat().includes(a.id)) return true;
  if (chainOf(a).includes(b.id) || chainOf(b).includes(a.id)) return true;
  // 划掉算式里的一项时，划线会贴着同一行接写的前后项（审片前自查：划「=7」时离「+0×2」3px）
  const struck = (x, y) => x.type === 'strike' && [x.target].flat().some((id) => actionsById.get(id)?.after === y.id || y.after === id);
  if (struck(a, b) || struck(b, a)) return true;
  // 回描就是在原字上再描几遍：接在原字后面写的字离回描的距离就是字距（点题句加粗 ×1 后，下一句在它后面写「?」）
  const traced = (x, y) => x.type === 'retrace' && [x.target].flat().some((id) => y.after === id || actionsById.get(id)?.after === y.id);
  if (traced(a, b) || traced(b, a)) return true;
  if (a.type === 'text' && b.type === 'text') return false;
  // 同一个门槛量表的几部分（底线和门槛虚线、数值柱）本来就画在一起：base 相同就是同一个量表
  if (a.type === 'meter' && b.type === 'meter' && a.base === b.base) return true;
  // 同一个旋钮先画本体、再画「拧过」（part=turn）：圆心和半径相同就是同一个旋钮
  if (a.type === 'knob' && b.type === 'knob' && a.cx === b.cx && a.cy === b.cy && a.r === b.r) return true;
  // on 可以一层层挂：「拧过」挂在旋钮上、旋钮挂在线上，「拧过」和线也算贴着画的
  const onChain = (x) => { const c = []; for (let y = actionsById.get(x.on); y && c.length < 4; y = actionsById.get(y.on)) c.push(y.id); return c; };
  if (onChain(a).includes(b.id) || onChain(b).includes(a.id)) return true;
  return a.on === b.id || b.on === a.id || (a.on && a.on === b.on);
};
const strokeSamples = new WeakMap();
const sampleList = (list) => list.flatMap((s) => {
  const c = strokeSamples.get(s);
  if (c && c.d === s.d && c.w === s.width) return c.pts;
  const pr = new svgPathProperties(s.d), L = pr.getTotalLength(), n = Math.max(2, Math.ceil(L / 4));
  const pts = Array.from({ length: n + 1 }, (_, k) => { const q = pr.getPointAtLength((L * k) / n); return [q.x, q.y, s.width]; });
  strokeSamples.set(s, { d: s.d, w: s.width, pts });
  return pts;
});
const inkBox = (pts) => pts.reduce((b, [x, y, w]) => [Math.min(b[0], x - w / 2), Math.min(b[1], y - w / 2), Math.max(b[2], x + w / 2), Math.max(b[3], y + w / 2)], [Infinity, Infinity, -Infinity, -Infinity]);
const plain = (t) => t.replace(/_/g, '');
// 文字和文字挨着时人会连起来读：不同行要 ≥0.8 个字号；同一行（竖向重叠 ≥40%）横向要 ≥1 个字号，贴着的一侧是数字时 ≥1.5 个字号
// （设备预览和审片发现「门槛 5」「7」在同一行被读成「门槛 57」）。比例在世界坐标和屏幕上相同（镜头是等比缩放）。
const textPair = (A, pa, B, pb) => {
  const a = inkBox(pa), b = inkBox(pb);
  const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]), minH = Math.min(a[3] - a[1], b[3] - b[1]);
  const em = Math.min(A.size, B.size);
  if (oy / minH >= style.type.sameRowOverlap) {
    const [L, R] = a[0] <= b[0] ? [A, B] : [B, A], [lb, rb] = a[0] <= b[0] ? [a, b] : [b, a];
    const digit = /\d$/.test(plain(L.text)) || /^\d/.test(plain(R.text));
    const need = (digit ? style.type.sameRowDigitGapEm : style.type.sameRowGapEm) * em;
    return { margin: rb[0] - lb[2] - need, raw: rb[0] - lb[2], need, row: true };
  }
  return null;
};
const needGap = (A, B) => (A.type === 'text' && B.type === 'text' ? Math.max(GAP, style.type.labelTextGapEm * Math.min(A.size, B.size)) : GAP);
// 采样点的中线包围盒和最粗笔宽
const ptsBox = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, w = 0;
  for (const [x, y, pw] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (pw > w) w = pw; }
  return { x0, y0, x1, y1, w };
};
// 每个元素的采样点和包围盒按 geo 里的那个数组缓存（元素重画时 geo 换成新数组，缓存自然失效；笔画被原地改了 d、width 也重算）
const geoSamples = new WeakMap();
const samplesOf = (list) => {
  const c = geoSamples.get(list);
  if (c && c.sig.length === list.length && c.sig.every((v, i) => v.d === list[i].d && v.w === list[i].width)) return c;
  const pts = sampleList(list), fresh = { sig: list.map((s) => ({ d: s.d, w: s.width })), pts, box: ptsBox(pts) };
  geoSamples.set(list, fresh);
  return fresh;
};
// 一个元素到所有别的元素的最小余量。逐点两两比距离很慢（E05 一次编译 12–17 分钟，绝大部分在这里：自动避让每个挤字的标签试 192 个位置，
// 每个位置都和全集几百个元素逐点比）。两个元素中线包围盒的距离减去两边最粗的半个笔宽，是它们任意两点净距的下界；
// 下界减去要求的间距不小于 min(当前最小余量, 0) 时，这个元素既造不成压线、也不会刷新负的最小余量，跳过逐点比较（1e-6 留在少剪的一侧，防浮点误差）。
// 返回约定：best ≥ 0 只表示全都合格，这时的数值（可能是 Infinity）和 who/raw/need/row 都不可靠；best < 0 时五个字段和逐点比完全一样。
// 现在的调用方只看 best 是否 ≥ 0、负的时候才用其余字段；要拿正的余量挑位置，得先去掉这个剪枝。
const clearance = (A, pts) => {
  let best = Infinity, who = null, raw = Infinity, need = GAP, row = false;
  const ab = ptsBox(pts);
  for (const [id, list] of geo) {
    const B = actionsById.get(id);
    if (id === A.id || related(A, B)) continue;
    const sb = samplesOf(list), pb = sb.pts;
    if (B.type === 'text') {
      const tp = textPair(A, pts, B, pb);
      if (tp && tp.margin < best) { best = tp.margin; who = id; raw = tp.raw; need = tp.need; row = true; }
    }
    const ng = needGap(A, B), b = sb.box;
    const dx = Math.max(0, b.x0 - ab.x1, ab.x0 - b.x1), dy = Math.max(0, b.y0 - ab.y1, ab.y0 - b.y1);
    if (Math.hypot(dx, dy) - (ab.w + b.w) / 2 - ng >= Math.min(best, 0) + 1e-6) continue;
    for (const [bx, by, bw] of pb) for (const [ax, ay, aw] of pts) {
      const d = Math.hypot(ax - bx, ay - by) - (aw + bw) / 2;
      if (d - ng < best) { best = d - ng; who = id; raw = d; need = ng; row = false; }
    }
  }
  return { best, who, raw, need, row }; // best = 余量（≥0 才合格；≥0 时数值和其余字段不可靠，见上）
};
for (const a of allActions) {
  if (a.type !== 'text' || a.after) continue;
  const c0 = clearance(a, sampleList(geo.get(a.id)));
  if (c0.best >= 0 || !AUTOFIX) continue;
  const x0 = a.x, y0 = a.y;
  let done = false;
  for (let r = 6; r <= 72 && !done; r += 6) for (let k = 0; k < 16 && !done; k++) {
    const ang = (k / 16) * Math.PI * 2;
    a.x = x0 + r * Math.cos(ang); a.y = y0 + r * Math.sin(ang);
    const c = clearance(a, sampleList(drawAction(a)));
    if (c.best >= 0) { done = true; rebuildWithDeps(a); fixes.push(`避让：「${a.text}」离 ${c0.who} ${c0.row ? '同一行仅' : '仅'} ${r2(Math.max(0, c0.raw))}px（要求 ≥${r2(c0.need)}px），挪动 (${r2(a.x - x0)}, ${r2(a.y - y0)})`); }
  }
  if (!done) { a.x = x0; a.y = y0; }
}
phraseCam = computePhraseCam();

// 3) 修完再查：还剩的问题报给写分镜的一方（精确到元素）
const layoutProblems = [], layoutAdvice = [];
// 按 gates 级别分流：hard 进问题（判失败），advice 进建议（只写报告）
const flagTo = (probs, adv) => (gate, msg) => (gate && gateLevel(style, gate) === 'advice' ? adv : probs).push(msg);
const layoutFlag = flagTo(layoutProblems, layoutAdvice);
for (const a of allActions) {
  if (a.type !== 'text') continue;
  const c = clearance(a, sampleList(geo.get(a.id)));
  if (c.best < 0) layoutFlag(c.raw > 0 ? 'layout.textGap' : null, `标签「${a.text}」(${a.id}) 离 ${c.who} ${c.row ? '在同一行，横向' : ''}只有 ${r2(Math.max(0, c.raw))}px（要求 ≥${r2(c.need)}px）` + (AUTOFIX ? '，自动避让 72px 内找不到空位，需要改分镜布局' : ''));
  const px = textPx(a, phraseCam);
  if (px < MIN_TEXT - 0.5) layoutFlag('type.minScreen', `标签「${a.text}」(${a.id}) 在屏幕上约 ${r2(px)}px 高，低于本画幅最小 ${MIN_TEXT}px` + (AUTOFIX ? '（已沿字号阶梯放大到上限仍不够），需要改分镜布局' : ''));
}
// 图形元素之间留空（见风格规范 type.shapeGapNote）：两个非文字元素的墨迹至少隔 shapeGapPen 个笔宽。
// 有意贴着的不查：分镜里声明的关系（on、target、after），以及箭头、线的端点接在对方身上（离它不到 connectTol）
{
  const GAP_S = style.ink.penWidth * style.type.shapeGapPen, CONNECT = style.type.connectTol;
  // 划掉、回描本来就画在别的东西上面，不查
  const ids = [...geo.keys()].filter((id) => geo.get(id).length && !['text', 'strike', 'retrace'].includes(actionsById.get(id).type));
  const pts = new Map(ids.map((id) => [id, sampleList(geo.get(id))])), box = new Map(ids.map((id) => [id, inkBox(pts.get(id))]));
  const ends = (a) => (Array.isArray(a.from) && Array.isArray(a.to) ? [a.from, a.to] : []);
  const touches = (p, list) => list.some(([x, y, w]) => Math.hypot(p[0] - x, p[1] - y) - w / 2 <= CONNECT);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const A = actionsById.get(ids[i]), B = actionsById.get(ids[j]), a = box.get(A.id), b = box.get(B.id);
    if (related(A, B) || a[0] - GAP_S > b[2] || b[0] - GAP_S > a[2] || a[1] - GAP_S > b[3] || b[1] - GAP_S > a[3]) continue;
    // 圈出（ring）是加在目标上的装饰，箭头尖碰到它不算「接上」（审片 v11：点题的红圈压在向上箭头上，被当成有意连接放过了）
    const node = (x) => x.type !== 'ring';
    if ((node(B) && ends(A).some((p) => touches(p, pts.get(B.id)))) || (node(A) && ends(B).some((p) => touches(p, pts.get(A.id))))) continue;
    let d = Infinity;
    for (const [ax, ay, aw] of pts.get(A.id)) for (const [bx, by, bw] of pts.get(B.id)) d = Math.min(d, Math.hypot(ax - bx, ay - by) - (aw + bw) / 2);
    if (d < GAP_S) layoutFlag('layout.shapeGap', `图形「${A.id}」和「${B.id}」的墨迹只隔 ${r2(Math.max(0, d))}px（要求 ≥${r2(GAP_S)}px）：不是有意贴着就挪开；有意贴着（比如描在它上面）就在分镜里用 on 声明`);
  }
}
if (fixes.length) console.log(`  版面自动修正 ${fixes.length} 处：\n    ` + fixes.join('\n    '));

// ---------- 镜头目标（与时间无关）：普通句看全景；顿悟句（role=aha 或 camera=focus）推近到这句的元素 ----------
const AHA = M.aha;
// 推近时画面边缘不能把文字切成半截（审片看到推近后左边缘只剩「4」、算式只剩「0 =7」）：
// 已写的文字要么整段在画面里，要么整段在画面外。
const textInk = new Map([...geo].map(([id, l]) => [id, l.filter((s) => s.kind === 'glyph' || s.kind === 'line')]).filter(([, l]) => l.length).map(([id, l]) => [id, bboxOf(l)]));
// 比检查更严：算"在画外"要整段越过画布边再留 6px；算"在画面里"要离画布边至少 24px（理解度测试说算式开头的 1 贴着左边缘）
// 字幕衬底也算画面边：文字整段在字幕上方才算「在画面里」（审片：推近把 x₃ 推到字幕衬底下面，只露半截）
const SUB_TOP = TGT.sub.top - style.subtitle.plate.padY;
const UI_ZONES = TGT.platforms.flatMap((pf) => style.platformUI[pf] || []).filter((z) => !z.advice); // advice 的遮挡区只在检查里给建议，不左右镜头
// 元素包围盒缓存（取景搜索要试上千个位置，每次重新采样路径太慢）；元素被重画后自动失效
const boxCache = new Map();
// 和安全区检查同一份几何：路径范围再向外扩半个笔宽（检查按实际墨迹算，取景只看路径中心线时会差几像素，推近停在字的边上）
const geoBox = (id) => {
  const l = geo.get(id), c = boxCache.get(id); if (c && c.l === l) return c.b;
  const r = bboxOf(l), hw = Math.max(0, ...l.map((s) => s.width ?? 0)) / 2, b = { x0: r.x0 - hw, y0: r.y0 - hw, x1: r.x1 + hw, y1: r.y1 + hw };
  boxCache.set(id, { l, b }); return b;
};
// 镜头停稳时（比检查再收 4px）：
//   文字要整段在取景框 frame 里（字幕衬底上方、不压平台界面），或者整段在画布外（审片：推近后左边缘只剩「4」、算式只剩「0 =7」）；
//   图形也一样整段在取景框里或整段出画（审片 E01 v1：推近后箭头只剩半截、灯泡左半被切、框角挂在画面顶上）；
//   只有分镜写了 bleed 的图形（横贯画面的路线箭头这类）可以被画布边缘裁掉，但不能停在取景框外的边距里，也不能越过取景框下沿压向字幕
const FR = TGT.frame, isTextId = (id) => textInk.has(id);
const cutTexts = (cam, pi) => {
  const S = (b) => ({ x0: (b.x0 - cam.x) * cam.z + VIEW.cx, x1: (b.x1 - cam.x) * cam.z + VIEW.cx, y0: (b.y0 - cam.y) * cam.z + VIEW.cy, y1: (b.y1 - cam.y) * cam.z + VIEW.cy });
  const L = FR.l + 4, R = FR.r - 4, T = FR.t + 4, B = Math.min(FR.b, SUB_TOP - 24) - 4, W = TGT.w, H = TGT.h;
  // 平台界面（顶部标签栏、右侧按钮列……）也算画面边：看得到的文字不能压进去（审片：推近时 ×4 ×3 ×2 落进 TikTok 顶栏）
  const underUI = (t) => UI_ZONES.some((z) => t.x1 > z.l - 8 && t.x0 < z.r + 8 && t.y1 > z.t - 8 && t.y0 < z.b + 8);
  return [...geo].filter(([id]) => phraseOf.get(id) <= pi && geo.get(id).length).filter(([id]) => {
    const t = S(geoBox(id));
    if (t.x1 <= -6 || t.x0 >= W + 6 || t.y1 <= -6 || t.y0 >= H + 6) return false; // 整段在画外
    if (isTextId(id)) return !(t.x0 >= L && t.x1 <= R && t.y0 >= T && t.y1 <= B) || underUI(t);
    if (!actionsById.get(id)?.bleed) return !(t.x0 >= L && t.x1 <= R && t.y0 >= T && t.y1 <= B);
    return t.y1 > B || (t.x0 < L && t.x0 > -6) || (t.x1 > R && t.x1 < W + 6) || (t.y0 < T && t.y0 > -6);
  });
};
const blockers = []; // 每个顿悟句推不近时挡路的元素
const focusCam = phrases.map((p, pi) => {
  if (p.role !== 'aha' && p.camera !== 'focus') return null;
  const ids = new Set([...p.actions.map((a) => a.id), ...(p.focus || [])]);
  const list = [...geo].filter(([id]) => ids.has(id)).flatMap(([, l]) => l);
  if (!list.length || !phraseCam[pi]) return null;
  // 在 [minPush, maxPush] 的推近倍数里由强到弱找：焦点整个落在取景框内（留 40px），且没有文字被画面边缘切成半截；
  // 同一倍数下取最接近"焦点居中"的位置。都不行就退回全景（全景装得下所有内容，不会切字）
  // 构图：焦点中心离取景框中心不超过 aha.maxOffCenter（占取景框宽、高的比例）。只求不切字时，为了把上面的算式整行推出画外，
  // 9x16「灯就亮！」把量表和灯挤到了画面顶上、下面三分之二空着（理解度截帧，v7 审片也指出推近焦点偏上）；这个倍数居中不了就降倍数
  const ov = phraseCam[pi], F = bboxOf(list), fr = TGT.frame, cx0 = (F.x0 + F.x1) / 2, cy0 = (F.y0 + F.y1) / 2;
  const centered = (c) => Math.abs((cx0 - c.x) * c.z) <= (AHA.maxOffCenter ?? 1) * (fr.r - fr.l) && Math.abs((cy0 - c.y) * c.z) <= (AHA.maxOffCenter ?? 1) * (fr.b - fr.t);
  const zHi = Math.min(AHA.zoomMax ?? ZMAX, ov.z * AHA.maxPush), zLo = ov.z * AHA.minPush;
  // 分镜写了 noPush：这个画幅就不推近，直接用下面的不推近取景（创作意图优先；原来只是不报建议，镜头照样推近，审片 E01 v3）
  const skipPush = (p.noPush || []).includes(targetName);
  for (let k = 0; !skipPush && k <= 8 && zHi >= zLo; k++) {
    const z = zHi - ((zHi - zLo) * k) / 8, pad = 40 / z;
    const xr = [F.x1 - (fr.r - VIEW.cx) / z + pad, F.x0 - (fr.l - VIEW.cx) / z - pad], yr = [F.y1 - (fr.b - VIEW.cy) / z + pad, F.y0 - (fr.t - VIEW.cy) / z - pad];
    if (xr[0] > xr[1] || yr[0] > yr[1]) continue; // 这个倍数下焦点装不下
    const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
    const cands = [];
    // 网格要细：既居中又不切字的位置可能只有十来像素宽（13×13 的网格会漏掉）
    const N = 40;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) cands.push({ x: xr[0] + ((xr[1] - xr[0]) * i) / N, y: yr[0] + ((yr[1] - yr[0]) * j) / N, z });
    cands.push({ x: clamp(cx0, xr), y: clamp(cy0, yr), z });
    cands.sort((a, b) => Math.hypot(a.x - cx0, a.y - cy0) - Math.hypot(b.x - cx0, b.y - cy0));
    const cam = cands.find((c) => centered(c) && !cutTexts(c, pi).length);
    if (cam) return { ...cam, push: z / ov.z };
    // 推不了时记下挡路最少的那组元素，提醒里告诉写分镜的人该挪谁
    const block = cands.filter(centered).map((c) => cutTexts(c, pi).map(([id]) => id)).sort((a, b) => a.length - b.length)[0];
    if (block && (!blockers[pi] || block.length < blockers[pi].length)) blockers[pi] = block;
  }
  // 推不近（焦点本身就占满了画面，比如一整排输入）：上一句的取景装得下就原样停住，不为顿悟拉远；装不下才用这一句的全景
  const prev = pi > 0 ? phraseCam[pi - 1] : null;
  const fits = (c) => F.x0 >= c.x + (fr.l - VIEW.cx) / c.z && F.x1 <= c.x + (fr.r - VIEW.cx) / c.z && F.y0 >= c.y + (fr.t - VIEW.cy) / c.z && F.y1 <= c.y + (fr.b - VIEW.cy) / c.z;
  return prev && prev.z >= ov.z && fits(prev) && !cutTexts(prev, pi).length ? { ...prev, push: 1 } : { ...ov, push: 1 };
});
const targetCam = phrases.map((p, pi) => focusCam[pi] ?? phraseCam[pi]);
// 顿悟句推不近：分镜没声明这个画幅可以不推近（phrase.noPush）就算问题，要改版式（审片：9x16 两个灯的顿悟都在全景里，高潮最弱）。
// 声明了的只提醒，表示写分镜的人知道并接受
for (const [pi, f] of focusCam.entries()) if (f && f.push < AHA.minPush - 1e-3) {
  const why = blockers[pi] ? `居中推近时 ${blockers[pi].join('、')} 会被切断或停在取景框边距里，要改版式给焦点四周留空，或把它们挪开` : '焦点装不下（元素太分散，可用 focus 只圈关键元素）';
  if ((phrases[pi].noPush ?? []).includes(targetName)) console.log(`  [提醒] 顿悟句「${phrases[pi].text}」只能推近 ${r2(f.push)} 倍（分镜已声明 ${targetName} 不推近）：${why}`);
  else layoutFlag('camera.ahaPush', `顿悟句「${phrases[pi].text}」推不近（${r2(f.push)} 倍）：${why}；确实不推近就在这句写 noPush: ["${targetName}"]`);
}

// ---------- 单笔调度（函数化：画面拖尾时自动给该动作提速再排一次） ----------
// 画面右边外面的一个点（世界坐标）：在给出的每个镜头下都看不到，用来让笔暂时离开画面
const offRight = (cams, y) => { const cs = cams.filter(Boolean); return cs.length ? [Math.max(...cs.map((c) => c.x + (TGT.w + 260 - VIEW.cx) / c.z)), y] : null; };
const runsOf = (frames) => frames.reduce((r, f) => { const l = r.at(-1); if (l && f === l[1] + 1) l[1] = f; else r.push([f, f]); return r; }, []);
const OFF = [4000, 0]; // 画外（世界坐标极远处），任何画幅下都看不到
function schedule(boost) {
  const strokes = [], penTrack = [], effects = [], stickers = [], audioClips = [], report = { phrases: [], actions: [] };
  let T = PEN.leadIn, penFree = 0, penPos = OFF, release = 0, penPhrase = 0, penAway = false, awayUntil = 0; // awayUntil：回看时退场的那段移动走完的时刻（不进 penFree）
  // release：顿悟句后，下一句最早落笔时刻（镜头停够 holdAfter、拉远走完大半之后）；penPhrase：铅笔最后在哪一句落过笔
  phrases.forEach((p, pi) => {
    const next = phrases[pi + 1];
    const clipIn = p.cutIn, clipOut = p.cutOut;
    const toTL = (srcT) => T + (srcT - clipIn);
    audioClips.push({ phrase: p.text, at: r2(T), srcIn: clipIn, srcOut: clipOut });
    const audioStart = T, audioEnd = T + (clipOut - clipIn), phraseStartFree = penFree;
    // 回看（片尾回顾）：这句镜头飞回前面某一节，铅笔不写。原来笔就停在最后写字的地方，镜头一飞，它在屏幕上被拖着扫过字幕区和画面边
    // （E06 试编：回顾第一句镜头往右上飞、最后一句飞回来，笔尖各贴着字幕和抖音按钮列过去一次）。
    // 改成：一段连着不动笔的句子（从这句回看起，到下一句动笔之前）只退一次场：镜头真的要移、笔又在上一镜或这一镜里看得见时，
    // 笔先退到这一段每一镜（连同下一句动笔那一镜）的右边外面，停在那里；下一句动笔时从那里和镜头一起飞进来。
    // 回看句自己圈出、回描、划掉的（E02 第 63–65 句）不退场，照原来的做法和镜头同起同落。
    // 回看镜头是普通缓动（x、y、z 同一个插值），offRight 在每一镜里都离右边 260px 以上，两镜之间插值出来的镜头也看不见这个点
    const moves = (a, b) => a && b && (Math.hypot(a.x - b.x, a.y - b.y) >= 8 || Math.abs(a.z - b.z) >= 0.01);
    if (p.revisit?.length && penPos !== OFF && !penAway && !p.actions.some((a) => !PENLESS.has(a.type)) && moves(targetCam[pi - 1], targetCam[pi])) {
      const reach = (style.pencil.length + style.pencil.halfWidth) * style.pencil.scale * (Math.min(TGT.w, TGT.h) / 1080) + 40; // 笔身伸出笔尖多远
      const seen = (c) => { const sx = (penPos[0] - c.x) * c.z + VIEW.cx, sy = (penPos[1] - c.y) * c.z + VIEW.cy, m = reach * c.z; return sx > -m && sx < TGT.w + m && sy > -m && sy < TGT.h + m; };
      let k = pi; while (k < phrases.length && !phrases[k].actions.some((a) => !PENLESS.has(a.type))) k++; // 下一句动笔的
      const cams = targetCam.slice(pi - 1, Math.min(k, phrases.length - 1) + 1).filter(Boolean);
      if ([targetCam[pi - 1], targetCam[pi]].filter(Boolean).some(seen)) {
        // 镜头起飞前就水平退出去（和镜头一起走时，镜头起步快、笔是对称缓动，笔在屏幕上先往下掉，竖穿字幕区：E06 试编 838.9 秒）。
        // 退到的点在这一段每一镜的右边外面，高度不变；起点取「这句开口前退完」和「上一笔写完」里晚的那个
        const off = offRight(cams, penPos[1]);
        const z = Math.max(...cams.map((c) => c.z)), d = moveDur(dist(penPos, off), 0.12, z);
        const t0 = Math.max(penFree, T - d - 0.1);
        if (t0 > penFree + 1e-6) penTrack.push({ kind: 'rest', t0: penFree, t1: t0, at: penPos });
        penTrack.push({ kind: 'move', t0, t1: t0 + d, from: penPos, to: off, exit: true });
        penPos = off; penAway = true; awayUntil = t0 + d; // 不改 penFree：看不见的退场不该让旁白停下来等它
      }
    }
    // 一支笔按提示词在旁白里出现的先后来写（同一个词上的按分镜里的顺序）：分镜里排反了，后说到的先写，先说到的要等它写完
    // （E02 v5「就把权重，像拧旋钮一样」把旋钮排在「权重」标签前面，标签落后 3.3 秒）
    const cueAt = (a) => fullText.indexOf(strip(a.at), p.i0);
    const ordered = p.actions.map((a, k) => [a, k]).sort(([a, i], [b, j]) => (cueAt(a) - cueAt(b)) || i - j).map(([a]) => a);
    for (const a of ordered) {
      const cueIdx = fullText.indexOf(strip(a.at), p.i0);
      if (cueIdx < 0 || cueIdx > p.i1) throw new Error(`${a.id} 的 cue「${a.at}」不在短语「${p.text}」里`);
      const cue = toTL(charTimes[cueIdx].s);
      if (a.type === 'off') {
        const e = effects.find((x) => x.id === a.target);
        Object.assign(e, { t2: cue, t3: cue + 0.6 });
        report.actions.push({ id: a.id, type: a.type, phrase: pi, cue: r2(cue), start: r2(cue), end: r2(cue + 0.6), lag: 0, pen: false });
        continue;
      }
      if (a.type === 'sticker') {
        // 贴图：提示词那一刻开始落下，0.5 秒放好（style.sticker.drop）；铅笔不去画它
        const SK = style.sticker ?? {}, drop = SK.drop ?? 0.5;
        stickers.push({ id: a.id, ...stickerOf(a), t0: r2(cue), t1: r2(cue + drop), card: SK.card ?? '#fbf8f1', tape: SK.tape ?? '#e6d7ad', shade: style.palette.shade });
        report.actions.push({ id: a.id, type: a.type, phrase: pi, cue: r2(cue), start: r2(cue), end: r2(cue + drop), lag: 0, pen: false });
        continue;
      }
      if (a.type === 'glow') {
        effects.push({ ...a, color: style.palette[a.color], t0: cue, t1: cue + 0.7 });
        report.actions.push({ id: a.id, type: a.type, phrase: pi, cue: r2(cue), start: r2(cue), end: r2(cue + 0.7), lag: 0, pen: false });
        continue;
      }
      const ss = geo.get(a.id);
      const speed = (a.speed || 1) * (boost.get(a.id) || 1);
      // 这一句里镜头可能正从上一句的取景过渡过来，取两者较大的放大倍数
      // 从铅笔上次落笔的那句到这句，镜头可能一直停在某次推近上（中间隔着不画的句子），取这段里最大的放大倍数；
      // 只看这句和上一句时，隔一句的推近（1.5 倍）被漏掉，铅笔挪位按 1.25 倍算快了，屏幕上一帧跳 63px（E01 v4 9:16）
      const z = Math.max(...targetCam.slice(Math.min(penPhrase, pi), pi + 1).map((c) => c?.z ?? 1), targetCam[pi - 1]?.z ?? 0);
      const first = new svgPathProperties(ss[0].d).getPointAtLength(0);
      // 回看之后：镜头停在前面某一节，铅笔还留在最后写字的地方（多半在这一镜画外）。按原处起飞，镜头和笔从不同的地方出发，
      // 半路笔会扫过画面下沿和字幕（E01 v8 竖版）。笔不在回看镜头里时，就当它在这一镜右上方画外，从那里和镜头一起飞
      // 回看时退到画外的笔（penAway）：回看之后不管隔了几句不画的，第一笔都照这条从这一镜右上方画外飞进来
      const backFromAway = pi > 0 && (phrases[pi - 1].revisit?.length || penAway);
      if (penPos !== OFF && backFromAway && !penAway && a === ordered.find((x) => !PENLESS.has(x.type))) {
        const rc = targetCam[pi - 1], sx = (penPos[0] - rc.x) * rc.z + VIEW.cx, sy = (penPos[1] - rc.y) * rc.z + VIEW.cy;
        // 画外的入场点：右边外面 260px（原来是 rc.x + 1000/rc.z，取景中心偏左的横版 view.cx 815 时它落在画面里，屏幕 x 1815）
        if (sx < 0 || sx > TGT.w || sy < 0 || sy > TGT.h) { penPos = [rc.x + (TGT.w + 260 - VIEW.cx) / rc.z, rc.y - 350 / rc.z]; penAway = true; }
      }
      // 全片第一笔：片子一开头笔就在纸上落笔处，不先从画外飞进来（审片 E01 v9：飞进来要 0.76 秒，开场钩子的灯晚亮）
      const opening = penPos === OFF && !strokes.length && cue - (a.lead ?? PEN.cueLead) < 1;
      const fromPos = opening ? [first.x, first.y] : penPos === OFF ? [first.x + 1000, first.y - 350] : penPos; // 首次入画：从右上方画外进来，不划过字幕区
      const travel = opening ? 0 : moveDur(dist(fromPos, [first.x, first.y]), 0.12, z);
      let t = Math.max(cue - (a.lead ?? PEN.cueLead), Math.max(penFree, awayUntil) + travel, release); // lead：允许个别动作提前于旁白开写（如开场标题）
      // 要停一会儿时先退开：笔尖往右下（笔身朝向）退一点，别压着刚写的东西；退开的点不出取景框
      // ---- 落笔前等多久、在哪儿等：停笔不压正在讲的东西（审片：笔停在刚写的「0」、刚画的灯、x₁ 的下标上） ----
      // 等不到 0.5 秒就原地等；再久就在候选位置里挑：原地、当前位置四周、下一笔起点四周、等得够久时还有画面外。
      // 代价：笔身压到文字、刚画完的那个元素、当前推近的焦点，记 100；压到别的墨迹记 1。
      // 画面里的位置必须在下一镜里看得到（不被镜头推出去），画面外只在画面里每个位置都会压到要紧东西时才用。
      const PK = style.pencil.park, fr = TGT.frame, cam = targetCam[pi] ?? { x: VIEW.cx, y: VIEW.cy, z: 1 };
      const st = [first.x, first.y], wait = t - penFree;
      // 换节：飞到另一块纸面上。不先停（停的地方就是刚写完的东西，笔身压着它），手一空就起飞；
      // 镜头和这段飞行同起同落、同一条缓动曲线，笔在屏幕上就是从原处直线滑到落笔处，不会先冲出取景划过字幕（E01 实测）
      // 回看之后的第一句也按换节飞：镜头停在前面某处，笔要和镜头一起飞到新位置（不然镜头还在回程，笔已落在画外）
      const flight = penPos !== OFF && (p.chapter || backFromAway) && a === ordered.find((x) => !PENLESS.has(x.type));
      // 上一句是顿悟句时，镜头要先停够再走（release 减去拉远那段），笔也等到那时再起飞；飞行至少 chapterMoveMin 秒，前一句太短就晚一点落笔。
      // 也不早于上一句说完（最多提前 motion.takeoffEarly 秒）：原来笔一空就起飞，上一句最后一笔落在句中时，句尾还在讲、镜头已经飞到下一节，
      // 观众对着空纸听完上一句（审片 E05 v1：五处提前离场，205 秒那处空纸 7 秒；E04 复盘同一类）
      const prevEnd = pi > 0 ? report.phrases[pi - 1].audioEnd - (M.takeoffEarly ?? 0.3) : 0;
      const takeoff = flight ? Math.max(penFree, awayUntil, release ? release - M.cameraMove[0] - M.cameraMove[1] : 0, prevEnd) : 0;
      // 飞得远时按距离放慢：屏幕上不超过 flightSpeed px/s（审片 v8：回顾第一次回看 2.6 秒平移约 6500px，是普通换节的 3 倍快）
      // 距离取笔和镜头里飞得远的那个：镜头是在两个取景中心之间飞，常比笔飞得远（审片 v9：进尾卡那次镜头平均 1350–1455px/s，超过上限）
      const camFar = targetCam[pi - 1] && targetCam[pi] ? Math.hypot(targetCam[pi].x - targetCam[pi - 1].x, targetCam[pi].y - targetCam[pi - 1].y) : 0;
      const flyDur = Math.max(M.chapterMoveMin ?? 0, (Math.max(dist(fromPos, st), camFar) * z) / (M.flightSpeed ?? V_MOVE));
      // 不早于 takeoff 起飞：飞行时长取镜头飞行和笔自己移过去里长的那个（只按 flyDur 算时，笔移得更久就会提前起飞，绕过句末约束）
      if (flight) t = Math.max(t, takeoff + Math.max(flyDur, travel));
      // 起飞后离落笔还早（提示词在句尾）：按正常时长飞到，到了先停着等，不把整句都拉成一次慢吞吞的飞行（审片 v10：回顾第一站飞了 6.3 秒）
      const slack = flight ? t - takeoff - Math.max(flyDur, travel) : 0;
      // 停笔的舒适框（屏幕）：左、上离取景框 40px，右、下给朝右下伸的笔身留 200px（16:9 取景框下沿紧挨字幕，只看取景框时笔尖还在框里、笔身已经压上字幕，审 #68）
      const comfy = { l: fr.l + 40, r: fr.r - 200, t: fr.t + 40, b: fr.b - 200 };
      const outBy = ([x, y]) => [comfy.l - x, x - comfy.r, comfy.t - y, y - comfy.b].map((v) => Math.max(0, v)); // 左、右、上、下各出框多少
      // 换节飞行从 a 飞到 b：笔尖比两头多出舒适框多少像素（0 = 没有比两头更出框）。镜头从上一镜飞到这一镜，同起同落（src/timeline.ts 的 flightTip）。
      // 两头都在框里，中途也可能出框：镜头起步快、笔是对称缓动，笔在屏幕上先往飞行的反方向偏，推近时还被往外推
      // （E06 试编：第 8 节收尾时笔退到右上角，下一节在右下方、镜头 0.8 → 1.15 倍，起飞 1.3 秒后笔尖到了画面最上沿，铅笔怎么转都出画）。
      // 每条边各自比两头：落笔处本来就贴着下沿时，飞行可以和它一样低，不能更低。起点在画布外的（回看时退到画外、从画外飞进来）不管。
      // 前提：镜头这段就是从上一镜飞到这一镜、和笔同起同落、缓动是 motion.easeAccel。连着两句顿悟时镜头起飞可能晚于笔（holdUntil）、
      // 被相邻镜头合并时终点会变，这里都按同起同落估；真出了画布或压上字幕，编译末尾的铅笔角度规划照样报出来
      const flightEx = (a, b) => {
        const c0 = targetCam[pi - 1];
        if (!c0) return 0;
        const at = (u) => flightTip(a, b, c0, cam, u, VIEW, M.easeAccel), s0 = at(0);
        if (s0[0] < 0 || s0[0] > TGT.w || s0[1] < 0 || s0[1] > TGT.h) return 0;
        const e0 = outBy(s0), e1 = outBy(at(1)), lim = e0.map((v, k) => Math.max(v, e1[k]));
        let ex = 0;
        for (let i = 1; i < 32; i++) { const o = outBy(at(i / 32)); for (let k = 0; k < 4; k++) ex = Math.max(ex, o[k] - lim[k]); }
        return ex;
      };
      // 换节飞行至少飞 flyDur 秒，笔在这段时间里按屏幕上不超过 flightSpeed 能飞多远：停笔挪到反方向太远，飞行就超速了（审 #68）
      const flyFar = Math.max(dist(fromPos, st), camFar, (flyDur * (M.flightSpeed ?? V_MOVE)) / z) + 1;
      // 停笔等的地方：笔身别压文字、刚画完的元素和推近焦点，等的位置在这几个取景里都看得到（views）
      // until/goal：停到什么时候、停完去哪（默认停到这一笔落笔、去落笔处；等上一句说完再起飞时停到起飞、不用回来）
      // fly：换节前后停笔时接下来（或刚才）那段飞行。{ ex(q)：从 q 起飞或飞到 q 多出舒适框多少，near(q)：飞行不超过 flyFar，stay：不挪时的 ex }
      const pickRest = (from, freeAt, views, allowOff = true, until = t, goal = st, fly = null) => {
        // 贴好的封面也算画过的东西，而且和文字一样要护着：笔身不压在封面上
        const drawn = new Set([...strokes.map((s) => s.action), ...stickers.map((k) => k.id)]), lastId = strokes.at(-1)?.action, stuck = new Set(stickers.map((k) => k.id));
        const focusIds = new Set([pi, pi - 1].filter((q) => q >= 0 && focusCam[q]).flatMap((q) => [...phrases[q].actions.map((x) => x.id), ...(phrases[q].focus || [])]));
        const protect = [...drawn].filter((id) => textInk.has(id) || id === lastId || focusIds.has(id) || stuck.has(id)).map((id) => (textInk.has(id) && id !== lastId && !focusIds.has(id) ? textInk.get(id) : bboxOf(geo.get(id))));
        const other = [...drawn].map((id) => bboxOf(geo.get(id)));
        // 铅笔随镜头缩放，所以它在世界坐标里的长度是常数（不随 z 变）
        const kk = style.pencil.scale * (Math.min(TGT.w, TGT.h) / 1080), Lw = style.pencil.length * kk, hw = style.pencil.halfWidth * kk + 8, ra = (style.pencil.base * Math.PI) / 180;
        // 笔停着时也会随运笔方向和镜头移动转几度（实测转了 4°，笔身就从空白处扫到「1×4」上），所以按自然角度 ±6° 都算一遍取最坏的
        const cost = (tip) => Math.max(...[-6, 0, 6].map((da) => {
          const a = ra + (da * Math.PI) / 180;
          let c = 0;
          for (let i = 3; i <= 16; i++) { // 跳过笔尖那段锥（前 20%），和铅笔检查一致
            const x = tip[0] + Math.cos(a) * Lw * (i / 16), y = tip[1] + Math.sin(a) * Lw * (i / 16), hit = (b) => x > b.x0 - hw && x < b.x1 + hw && y > b.y0 - hw && y < b.y1 + hw;
            c += protect.some(hit) ? 100 : other.some(hit) ? 1 : 0;
          }
          return c;
        }));
        // 等的这段时间里镜头可能推近再拉回（上一句是顿悟）：停的位置在这几个取景里都要看得到，
        // 只看下一镜的话，推近时笔会被镜头拖着滑出画面边（实测 9x16「灯就亮！」推近时笔停在 ×4 旁被推出上边）
        const inNext = (q) => views.every((c) => { const sx = (q[0] - c.x) * c.z + VIEW.cx, sy = (q[1] - c.y) * c.z + VIEW.cy; return sx > comfy.l && sx < comfy.r && sy > comfy.t && sy < comfy.b; });
        const around = (o) => [[0, 0], [1, 1], [1.4, 0], [1, -0.7], [0, 1.3], [-0.8, 1.1], [2, 2], [2.4, 0], [0, 2.4], [-1.6, 2], [2, -1.2]].map(([dx, dy]) => [o[0] + (dx * PK.dist) / z, o[1] + (dy * PK.dist) / z]);
        // 再加一张覆盖整个取景框的粗网格：内容密的地方（16x9 左边一列输入、声波、权重），这两处四周笔身朝右下都会压到字，
        // 只在附近找就只能挑「压得最少」的；有时间的话应该去空白处等
        const grid = [], gc = views.at(-1) ?? cam; // 网格铺在最后一个取景上（普通停笔、换节落地都是这一句的取景；等起飞时是上一句的）
        for (let gx = 0; gx <= 6; gx++) for (let gy = 0; gy <= 4; gy++) {
          const sx = fr.l + 60 + ((fr.r - 260 - fr.l - 60) * gx) / 6, sy = fr.t + 60 + ((fr.b - 260 - fr.t - 60) * gy) / 4;
          grid.push([gc.x + (sx - VIEW.cx) / gc.z, gc.y + (sy - VIEW.cy) / gc.z]);
        }
        const cands = [...around(from), ...(goal ? around(goal) : []), ...grid].filter((q) => inNext(q) && (!fly || fly.near(q))).map((q) => ({ q, c: cost(q) + dist(q, from) / 400 }));
        const off = allowOff ? offRight([targetCam[pi - 1], targetCam[pi], focusCam[pi - 1]], from[1]) : null;
        if (off) cands.push({ q: off, c: 60, off: true });
        // 时间够不够：过去、至少停 0.2 秒、再回到下一笔起点
        const fits = ({ q }) => freeAt + moveDur(dist(from, q), 0.12, z) + 0.2 <= until - (goal ? moveDur(dist(q, goal), 0.12, z) : 0);
        const pool = cands.filter(fits);
        if (!fly) return pool.sort((x, y) => x.c - y.c)[0];
        // 换节前后：先在飞行不多出舒适框的位置里挑代价最小的；一个都没有时挑多出最少、而且比不挪好的；还没有就不挪（原地起飞、直接落在落笔处）
        for (const x of pool) x.ex = fly.ex(x.q);
        const clean = pool.filter((x) => x.ex <= 1);
        if (clean.length) return clean.sort((x, y) => x.c - y.c)[0];
        return pool.filter((x) => x.ex < fly.stay - 1).sort((x, y) => x.ex - y.ex || x.c - y.c)[0];
      };
      // 换节要等上一句说完才起飞（见 takeoff）：等够 minRest 秒就先退到不压东西的地方停着，从那里起飞（原来手一空就飞，不用等）。
      // 只在笔上一句刚写过、还在原处时停：上一句是不画的回看时笔已被当成在画外（penAway），上一句不画时取景也还没到那一镜
      // 停的位置还要看接下来的飞行（flightEx、flyFar）：从那里飞到落笔处，笔尖不比两头更出舒适框，飞行也不超速
      let flyFrom = fromPos;
      const flyT0 = flight ? takeoff : 0;
      if (flight && penPhrase === pi - 1 && !penAway && targetCam[pi - 1] && flyT0 - penFree >= PK.minRest) {
        const best = pickRest(penPos, penFree, [targetCam[pi - 1], focusCam[pi - 1]].filter(Boolean), false, flyT0, null,
          { ex: (q) => flightEx(q, st), near: (q) => dist(q, st) <= flyFar, stay: flightEx(penPos, st) });
        if (best && dist(best.q, penPos) > 2) {
          const go = moveDur(dist(penPos, best.q), 0.12, z);
          penTrack.push({ kind: 'move', t0: penFree, t1: penFree + go, from: penPos, to: best.q });
          penTrack.push({ kind: 'rest', t0: penFree + go, t1: flyT0, at: best.q });
          flyFrom = best.q;
        }
      }
      if (flight && slack > 1) {
        // 飞到新纸面上先找空白处停着（审片 v11：落在要圈的「写不完」上等了 3 秒，笔身压着「不完」），快到提示词再挪到落笔处
        // 飞过去的路上同样要看（只看落地那一镜时，中途会被甩出去）；不挪就是直接落在落笔处
        const best = pickRest(st, takeoff + flyDur, [cam], false, t, st, { ex: (q) => flightEx(flyFrom, q), near: (q) => dist(flyFrom, q) <= flyFar, stay: flightEx(flyFrom, st) });
        const land = best ? best.q : st, back = best ? moveDur(dist(land, st), 0.12, z) : 0;
        penTrack.push({ kind: 'move', t0: takeoff, t1: takeoff + flyDur, from: flyFrom, to: land, chapter: true, phrase: pi });
        penTrack.push({ kind: 'rest', t0: takeoff + flyDur, t1: t - back, at: land });
        if (back > 0.01) penTrack.push({ kind: 'move', t0: t - back, t1: t, from: land, to: st });
      } else if (penPos === OFF || wait - travel < PK.minRest || flight) {
        if (penPos !== OFF && t - travel > penFree && !flight) penTrack.push({ kind: 'rest', t0: penFree, t1: t - travel, at: penPos });
        penTrack.push({ kind: 'move', t0: flight ? flyT0 : t - travel, t1: t, from: flyFrom, to: st, ...(flight ? { chapter: true, phrase: pi } : {}) });
      } else {
        const best = pickRest(penPos, penFree, [targetCam[pi - 1], focusCam[pi - 1], cam].filter(Boolean));
        if (!best) {
          if (t - travel > penFree) penTrack.push({ kind: 'rest', t0: penFree, t1: t - travel, at: penPos });
          penTrack.push({ kind: 'move', t0: t - travel, t1: t, from: penPos, to: st });
        } else {
          const go = moveDur(dist(penPos, best.q), 0.12, z), back = moveDur(dist(best.q, st), 0.12, z);
          if (go > 0.01) penTrack.push({ kind: 'move', t0: penFree, t1: penFree + go, from: penPos, to: best.q });
          penTrack.push({ kind: 'rest', t0: penFree + go, t1: t - back, at: best.q });
          if (back > 0.01) penTrack.push({ kind: 'move', t0: t - back, t1: t, from: best.q, to: st });
        }
      }
      const start = t;
      ss.forEach((s, si) => {
        const props = new svgPathProperties(s.d), len = props.getTotalLength();
        const st = props.getPointAtLength(0), en = props.getPointAtLength(len);
        if (si > 0) {
          const lift = moveDur(dist(penPos, [st.x, st.y]), M.liftBase, z, speed); // 相邻笔画间抬笔约 2 帧
          penTrack.push({ kind: 'move', t0: t, t1: t + lift, from: penPos, to: [st.x, st.y] });
          t += lift;
        }
        const dur = strokeDur(s, len, speed, z);
        const idx = strokes.length;
        strokes.push({ ...s, id: `${a.id}#${si}`, action: a.id, group: s.group ?? a.id, len: r2(len), t0: r2(t), t1: r2(t + dur), ...(a.bleed ? { bleed: true } : {}) });
        penTrack.push({ kind: 'down', t0: t, t1: t + dur, stroke: idx });
        t += dur;
        penPos = [en.x, en.y];
        penPhrase = pi; penAway = false;
      });
      penFree = t;
      report.actions.push({ id: a.id, type: a.type, phrase: pi, cue: r2(cue), start: r2(start), end: r2(t), lag: r2(start - cue), pen: true, audioStart: r2(audioStart), audioEnd: r2(audioEnd), speed: r2(speed) });
    }
    // 下一句旁白：片段首尾相接（切点在静音里，自然间隔已含在片段内）vs 等这句画完再停一拍
    const natural = audioEnd;
    const waitDraw = penFree + (p.hold ?? PEN.defaultHold);
    // 顿悟句说完多停一拍再往下讲（审片：顿悟句后旁白没有停顿，信息来不及消化）
    const nextT = next ? Math.max(natural + (focusCam[pi] ? AHA.pauseAfter ?? 0 : 0), waitDraw) : natural;
    report.phrases.push({ text: p.text, role: p.role || '', at: r2(T), audioDur: r2(clipOut - clipIn), audioEnd: r2(audioEnd), drawEnd: r2(penFree), insertedPause: r2(Math.max(0, waitDraw - natural)) });
    // 顿悟句之后，下一句等镜头拉远走完再落笔。拉远从「推近到位后停够 hold」和「说完后停够 holdAfter」中较晚的那个开始；
    // 推近到位时刻按这句最早的提示词估（短句「灯就亮！」推近到位比句子结束还晚，只按说完算会提前落笔、画到画面外）
    if (focusCam[pi]) {
      const cues = report.actions.filter((x) => x.phrase === pi).map((x) => x.cue);
      const arrive = Math.max(cues.length ? Math.min(...cues) - AHA.lead : audioStart, phraseStartFree + AHA.moveDur);
      release = Math.max(arrive + AHA.hold, audioEnd + AHA.holdAfter) + M.cameraMove[0] + M.cameraMove[1];
    } else if (p.revisit?.length) {
      // 回看：镜头移到位、这句说完，下一句才起飞（release 减去一次普通移动就是起飞时刻，见 takeoff）
      release = Math.max(penFree + AHA.hold, T + Math.max(M.cameraMove[0] + M.cameraMove[1], M.chapterMoveMin ?? 0) + AHA.hold, audioEnd + AHA.holdAfter) + M.cameraMove[0] + M.cameraMove[1];
    } else release = 0;
    T = nextT;
  });
  // 回看时退了场、之后再没动笔（回顾一路讲到片尾）：笔已经停在整段每一镜的画外，片尾不用再离场（awayAt 记它什么时候到的）
  return { strokes, penTrack, effects, stickers, audioClips, report, penFree, penPos, awayAt: penAway && awayUntil > 0 ? awayUntil : null };
}
// 写字要跟着旁白：文字类动作（文字、带标签的量表）必须在本句说完前起笔，且书写时间至少一半和本句旁白重叠
// （审片发现「门槛 5」「7」都是旁白说完后才写）。不满足时先给该动作提速重排（不插静音），提到上限仍不行再报给分镜。
const TEXTY = new Set(['text', 'meter']);
const trailOf = (r) => r.report.actions.filter((x) => x.pen && TEXTY.has(x.type) && (x.type !== 'meter' || actionsById.get(x.id).label)).map((x) => {
  const ov = Math.max(0, Math.min(x.end, x.audioEnd) - Math.max(x.start, x.audioStart)), share = ov / Math.max(1e-6, x.end - x.start);
  return { ...x, share, late: x.start > x.audioEnd };
}).filter((x) => x.late || x.share < M.textOverlapMin);
const boost = new Map();
let sched = schedule(boost);
for (let it = 0; it < 8 && AUTOFIX; it++) {
  const bad = trailOf(sched);
  let changed = false;
  for (const x of bad) {
    const b = boost.get(x.id) || 1;
    if (b < M.maxSpeedBoost - 1e-6) { boost.set(x.id, Math.min(M.maxSpeedBoost, b * 1.2)); changed = true; }
  }
  if (!changed) break;
  sched = schedule(boost);
}
for (const [id, b] of boost) fixes.push(`提速：${id} 书写加快到 ${r2(b)} 倍（让文字和旁白同步）`), console.log(`  提速：${id} 书写加快到 ${r2(b)} 倍（让文字和旁白同步）`);
const { strokes, penTrack, effects, stickers, audioClips, report } = sched;
let { penFree, penPos } = sched;
const awayAt = sched.awayAt;
const problems = [...layoutProblems], advice = [...layoutAdvice], flag = flagTo(problems, advice);
// 写出来的字，旁白要在同一句里说到：写在别的句子里、要过一秒多才说到的，就是音画不同步（用户看 E02 v5「开头有点音画不同步」：
// 「上一集说好了……」时先写了「规则」、还划掉了，旁白下一句「它不背规则」才说到）。有意先写的（比如先抛个词再解释），动作上写 ahead: true
{
  const cjkOf = (t) => String(t ?? '').replace(/[^\u4e00-\u9fff]/g, '');
  for (const a of sched.report.actions) {
    const act = actionsById.get(a.id), p = phrases[a.phrase];
    if (!act || act.type !== 'text' || act.ahead || !p) continue;
    // 只查整段都是汉字的字（「天黑×4」这种带符号的标注是回指前面说过的东西）；写的时候（这句说完前）已经说过的也不算先写
    const w = cjkOf(act.text);
    if (w.length < 2 || w.length !== String(act.text).replace(/[\s，。、？！?!]/g, '').length) continue;
    // 同一句里写得比说早：「1958年，美国科学家罗森布拉特」在「美国科学家」上就写「罗森布拉特」，比说到早 1.1 秒（审片 E02 v6）
    const own = fullText.indexOf(w, p.i0);
    if (own >= 0 && own <= p.i1 && !fullText.slice(0, p.i0).includes(w)) {
      const saidOwn = sched.report.phrases[a.phrase].at + (charTimes[own].s - p.cutIn);
      if (saidOwn - a.start > 0.8) flag('sync.early', `「${act.text}」(${a.id}) 比旁白说到它早写了 ${r2(saidOwn - a.start)}s：提示词改成「${w}」或它前面紧挨的词；有意先写就在这个动作上写 ahead: true`);
      continue;
    }
    if (fullText.slice(0, p.i1 + 1).includes(w)) continue;
    const idx = fullText.indexOf(w, p.i1 + 1), k = idx < 0 ? -1 : phrases.findIndex((q) => q.i0 <= idx && idx <= q.i1);
    if (k < 0) continue;
    const said = sched.report.phrases[k].at + (charTimes[idx].s - phrases[k].cutIn);
    if (said - a.start > 1.0) flag('sync.ahead', `「${act.text}」(${a.id}) 在「${p.text.slice(0, 12)}」这句就写了，旁白到「${phrases[k].text.slice(0, 12)}」才说到（早 ${r2(said - a.start)}s）：挪到说到它的那句的词上；有意先写就在这个动作上写 ahead: true`);
  }
}
for (const x of trailOf(sched)) flag('sync.trail', `「${actionsById.get(x.id).text ?? actionsById.get(x.id).label}」(${x.id}) ${x.late ? `在这句旁白说完后才起笔（${x.start}s，句末 ${x.audioEnd}s）` : `书写只有 ${Math.round(x.share * 100)}% 和本句旁白重叠（要求 ≥${M.textOverlapMin * 100}%）`}，需要把它提到更早的词上或拆句`);

// ---------- 压力采样：渲染端用 perfect-freehand 生成变宽笔迹，笔尖位置也取自同一组点（见 library/kit.mjs） ----------
for (const s of strokes) s.pts = samplePts(s);
// 轨迹空档补齐：排程偶尔在两段之间留下空档（回看、只说不画的句子前后），笔在那段时间没有位置，渲染端会让它一帧闪出画外
// （审片 E02 v9：全片 4 处）。按时间排好，空档里补一段停笔，停在上一段的终点
{
  penTrack.sort((a, b) => a.t0 - b.t0);
  const endOf = (sg) => (sg.kind === 'move' ? sg.to : sg.kind === 'rest' ? sg.at : strokes[sg.stroke].pts.at(-1).slice(0, 2));
  for (let i = penTrack.length - 1; i > 0; i--) {
    const prevEnd = Math.max(...penTrack.slice(0, i).map((x) => x.t1)), gap = penTrack[i].t0 - prevEnd;
    if (gap > 1e-3) {
      // 空档里让笔滑到下一段的起点，不停在原处（停在原处常常压着刚画的东西，审片 E02 v11：3 处压了 1.5 秒）；起点就是原处时才原地停
      const last = penTrack.slice(0, i).reduce((m, x) => (x.t1 > m.t1 ? x : m)), nx = penTrack[i];
      const from = endOf(last), to = nx.kind === 'move' ? nx.from : nx.kind === 'rest' ? nx.at : strokes[nx.stroke].pts[0].slice(0, 2);
      penTrack.splice(i, 0, Math.hypot(to[0] - from[0], to[1] - from[1]) > 2 ? { kind: 'move', t0: prevEnd, t1: nx.t0, from, to } : { kind: 'rest', t0: prevEnd, t1: nx.t0, at: from });
    }
  }
}

// ---------- 镜头关键帧：普通句在第一笔前移到全景；顿悟句在提示词前 lead 秒推近到位，停留 ≥hold 秒；结尾回到全景 ----------
const camera = [], newChapter = new Set(); // newChapter：换节的那次镜头移动，不和前一次合并
const pushMove = (t0, t1, to, focus) => {
  const prev = camera.length ? camera[camera.length - 1] : null;
  const from = prev ? prev.to : to;
  if (prev && Math.abs(from.z - to.z) < 0.01 && Math.hypot(from.x - to.x, from.y - to.y) < 8) return;
  if (prev && t0 < prev.t1) { const d = prev.t1 - t0; t0 += d; t1 += d; } // 不和上一段镜头移动重叠
  camera.push({ t0: r2(t0), t1: r2(t1), from, to, ...(focus ? { focus } : {}), ...(style.motion.easeAccel && style.motion.easeAccel !== 0.5 ? { accel: style.motion.easeAccel } : {}) }); // 缓动形状：style.motion.easeAccel（风格 0.7.0）
};
phrases.forEach((p, pi) => {
  const tc = targetCam[pi];
  // 这句没有笔画（比如结尾回收句只说不画）也要移到自己的取景：从句子开头起移
  // 这句第一样新东西出现的时刻：第一笔，或者贴图开始落下（贴图的提示词在第一笔前面时，镜头要先到，PR #66 审查）
  const t0s = [strokes.find((s) => p.actions.some((a) => a.id === s.action))?.t0, ...stickers.filter((k) => p.actions.some((a) => a.id === k.id)).map((k) => k.t0)].filter((x) => x != null);
  const first = t0s.length ? { t0: Math.min(...t0s) } : { t0: report.phrases[pi].at + (focusCam[pi] ? 0 : M.cameraMove[0]) };
  if (!tc || !first) return;
  if (!camera.length) { camera.push({ t0: 0, t1: 0, from: tc, to: tc }); return; }
  // 顿悟后至少停留：推近到位后 hold 秒，且这句说完后 holdAfter 秒，才离开
  const prev = camera[camera.length - 1];
  const holdUntil = focusCam[pi - 1] ? Math.max(prev.t1 + AHA.hold, report.phrases[pi - 1].audioEnd + AHA.holdAfter) : -Infinity;
  if (focusCam[pi]) {
    const cues = report.actions.filter((x) => x.phrase === pi).map((x) => x.cue);
    const cue = cues.length ? Math.min(...cues) : report.phrases[pi].at;
    // 上一句还在写的时候不推近：一推，正在写的那行和铅笔会被推到画面边缘、压上字幕（实测 16:9 最后一次推近）
    const prevDraw = pi > 0 ? report.phrases[pi - 1].drawEnd : 0;
    const focusIds = [...new Set([...p.actions.map((a) => a.id), ...(p.focus || [])])]; // 推近镜头记下焦点元素（安全区检查用）
    // 一节以顿悟句开头（或回看之后接顿悟句）：镜头要飞到另一块纸面，和铅笔的换节飞行同起同落，直接落在推近的取景上。
    // 按推近只走 AHA.moveDur 秒时，E02 v4 进第 5 节 1.3 秒平移约 2500px，机器 0.4 秒就出画，之后对着空纸等笔飞到 1.6 秒（审片）
    // 笔这句在换节飞（换节、回看之后、回看时退场后飞回来）就和它同起同落：认笔轨迹上的标记，判断只留在排笔那一处
    const fly = penTrack.find((m) => m.chapter && m.phrase === pi) ?? ((p.chapter || phrases[pi - 1]?.revisit?.length) && penTrack.find((m) => m.chapter && Math.abs(m.t1 - first.t0) < 0.02));
    if (fly && fly.t1 - Math.max(fly.t0, holdUntil) > 0.3) { pushMove(Math.max(fly.t0, holdUntil), fly.t1, tc, focusIds); newChapter.add(camera[camera.length - 1]); }
    else {
      const t0 = Math.max(Math.min(cue - AHA.lead, first.t0) - AHA.moveDur, holdUntil, prevDraw);
      pushMove(t0, t0 + AHA.moveDur, tc, focusIds);
    }
  } else {
    // 普通句：镜头在第一笔前 cameraMove[0] 秒起移、第一笔后 cameraMove[1] 秒到位（边写边稳住）。
    // 顿悟后的第一句例外：要从推近的取景拉回来，第一笔可能远在画外（实测划 ×4 时还在画面外），所以第一笔前就要拉远到位
    // 换节：镜头和铅笔的飞行同起同落（见排程里的 flight）
    const lead = focusCam[pi - 1] ? M.cameraMove[0] + M.cameraMove[1] : M.cameraMove[0];
    // 笔这句在换节飞（换节、回看之后、回看时退场后飞回来）就和它同起同落：认笔轨迹上的标记，判断只留在排笔那一处
    const fly = penTrack.find((m) => m.chapter && m.phrase === pi) ?? ((p.chapter || phrases[pi - 1]?.revisit?.length) && penTrack.find((m) => m.chapter && Math.abs(m.t1 - first.t0) < 0.02));
    if (fly && fly.t1 - Math.max(fly.t0, holdUntil) > 0.3) pushMove(Math.max(fly.t0, holdUntil), fly.t1, tc);
    else if (tc.overview) {
      // 全景：连着几句都是 overview 时只走一次——从第一句开头起，一直在动、不在中途停，到最后一句说完时拉到整张纸。
      // 风格里写了 overviewMaxSec 时最多走这么久，落在这段时间里最后一句说完的地方，之后停在整张纸上（用户看 E01 v17：39 秒拉完稍慢）
      if (phrases[pi - 1]?.camera !== 'overview') {
        let last = pi;
        while (phrases[last + 1]?.camera === 'overview') last++;
        const t0 = Math.max(report.phrases[pi].at, holdUntil), cap = t0 + (M.overviewMaxSec ?? Infinity);
        const ends = report.phrases.slice(pi, last + 1).map((q) => q.audioEnd), end = ends.at(-1) <= cap ? ends.at(-1) : ends.filter((e) => e <= cap).at(-1) ?? cap;
        const t1 = Math.max(t0 + M.cameraMove[0] + M.cameraMove[1], end);
        pushMove(t0, t1, tc);
        camera[camera.length - 1].curve = 'glide';
        newChapter.add(camera[camera.length - 1]);
      }
    } else if (tc.revisit) {
      // 回看：从句子开头起移，走得和换节一样从容（距离往往有好几屏，按普通取景的 1.6 秒走会晃）；不和前后合并
      const t0 = Math.max(report.phrases[pi].at, holdUntil);
      const from = camera[camera.length - 1].to, far = Math.hypot(tc.x - from.x, tc.y - from.y) * Math.max(tc.z, from.z);
      pushMove(t0, t0 + Math.max(M.cameraMove[0] + M.cameraMove[1], M.chapterMoveMin ?? 0, far / (M.flightSpeed ?? V_MOVE)), tc);
      newChapter.add(camera[camera.length - 1]);
    } else { const t0 = Math.max(first.t0 - lead, holdUntil); pushMove(t0, t0 + M.cameraMove[0] + M.cameraMove[1], tc); }
    if (p.chapter && camera.length > 1) newChapter.add(camera[camera.length - 1]);
  }
});
// 两次普通（非推近）镜头移动挨得太近（间隔不到 minCameraGap 秒）就合并成一次，直接移到后一次的取景
// （审片：29.4–31.7s 连着两次重新取景，中间只停稳 0.4 秒，镜头显得忙）
for (let i = camera.length - 1; i > 0; i--) {
  const a = camera[i - 1], b = camera[i];
  // 换节那次不合并：合并后前一句还没写完镜头就往下一节走了（E01 实测 16:9 第一节最后画的灯框出了画）
  // 换节那次也不吞并后一次：吞并后镜头比铅笔晚一秒多到位，飞行途中笔先冲到字幕上（E01 9:16 第 4 节）
  if (!a.focus && !b.focus && !newChapter.has(b) && !newChapter.has(a) && b.t0 - a.t1 < M.minCameraGap) { a.to = b.to; a.t1 = b.t1; camera.splice(i, 1); }
}
// 结尾回到全景，让观众看到整张图
const lastAudio = audioClips[audioClips.length - 1];
const audioEndAll = lastAudio.at + (lastAudio.srcOut - lastAudio.srcIn);
const fullCam = phraseCam[phraseCam.length - 1];
if (focusCam[phrases.length - 1]) {
  const t0 = Math.max(penFree + 0.2, camera[camera.length - 1].t1 + AHA.hold, report.phrases[phrases.length - 1].audioEnd + AHA.holdAfter);
  pushMove(t0, t0 + 1.0, fullCam);
}
const lastCamEnd = camera[camera.length - 1].t1;
// 自检：每一笔画完的时刻都在取景框内
// 和渲染端 src/timeline.ts 的 camLerp 同一套插值（glide：中间匀速、两头各 1.5 秒缓起缓停、缩放按对数）
// 和渲染端 src/timeline.ts 的 glideAt 同一个公式：绕两头取景里屏幕位置相同的纸面点缩放，起始画面里的东西只往它靠、不出画
const glideAt = (f, t, e) => { const z = f.z * Math.pow(t.z / f.z, e); if (Math.abs(t.z - f.z) < 1e-6) return { x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e, z };
  const px = (t.x * t.z - f.x * f.z) / (t.z - f.z), py = (t.y * t.z - f.y * f.z) / (t.z - f.z); return { x: px + (f.x - px) * f.z / z, y: py + (f.y - py) * f.z / z, z }; };
const glideE = (u, dur) => { const r = Math.min(0.45, 1.5 / Math.max(dur, 1e-6)), k = 1 / (2 * r * (1 - r)); return u < r ? u * u * k : u > 1 - r ? 1 - (1 - u) * (1 - u) * k : (u - r / 2) / (1 - r); };
const camAt = (t) => { let c = camera[0].from; for (const m of camera) { if (t >= m.t1) c = m.to; else if (t > m.t0) { const u = (t - m.t0) / (m.t1 - m.t0); if (m.curve === 'glide') c = glideAt(m.from, m.to, glideE(u, m.t1 - m.t0)); else { const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; c = { x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e, z: m.from.z + (m.to.z - m.from.z) * e }; } } } return c; };
// 贴图落定时，外轮廓（含胶带）也要在取景框里
for (const k of stickers) {
  const c = camAt(k.t1);
  for (const [x, y] of stickerOutline(k)) {
    const sx = (x - c.x) * c.z + VIEW.cx, sy = (y - c.y) * c.z + VIEW.cy;
    if (sx < TGT.frame.l || sx > TGT.frame.r || sy < TGT.frame.t || sy > TGT.frame.b) { problems.push(`镜头外：贴图 ${k.id} 在 ${r2(k.t1)}s 屏幕(${r2(sx)},${r2(sy)})`); break; }
  }
}
for (const s of strokes) {
  const c = camAt(s.t1), pr = new svgPathProperties(s.d);
  for (let k = 0; k <= 12; k++) {
    const q = pr.getPointAtLength((s.len * k) / 12);
    const sx = (q.x - c.x) * c.z + VIEW.cx, sy = (q.y - c.y) * c.z + VIEW.cy;
    if (sx < TGT.frame.l || sx > TGT.frame.r || sy < TGT.frame.t || sy > TGT.frame.b) { problems.push(`镜头外：${s.id} 在 ${r2(s.t1)}s 屏幕(${r2(sx)},${r2(sy)})`); break; }
  }
}

const endBody = Math.max(audioEndAll, penFree + 0.8, lastCamEnd + M.finalOverviewHold) + PEN.tail;
// 片尾参考资料卡：正片说完以后单独停几秒，列出这一集用到的资料（facts 的 cite，按第一次出现的顺序去重），
// 再加分镜 endCard.lines 里的几行（比如讲义怎么领）。每一集都有：写了 cite 就自动生成；endCard: false 关掉。
// 卡片是屏幕层（不随镜头），整张纸色底盖住画面，画在取景框里（不进平台界面）。字号按画幅短边算
const endCard = (() => {
  const EC = style.endCard ?? {}, B = beats.endCard ?? {};
  if (beats.endCard === false) return null;
  const refs = [...new Set((beats.facts ?? []).flatMap((f) => (Array.isArray(f.cite) ? f.cite : f.cite ? [f.cite] : [])).map(String))];
  const lines = (B.lines ?? []).map(String);
  if (!refs.length && !lines.length) return null;
  const sec = Math.max(1, B.sec ?? EC.sec ?? 5), k = Math.min(TGT.w, TGT.h) / 1080;
  // 字号：按折行后的总行数放得下取景框（卡片排在取景框宽 84%、高 80% 里，行高 1.35，条目间距 0.55 行；半角字约半个字宽）
  const F = TGT.frame, boxW = (F.r - F.l) * 0.84, boxH = (F.b - F.t) * 0.8, items = [...refs.map((r, i) => `${i + 1}. ${r}`), ...lines];
  const width = (t) => [...t].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 0.55 : 1), 0);
  const need = (sz) => (refs.length ? 1.5 * 1.35 + 0.55 : 0) + items.reduce((a, t) => a + Math.ceil((width(t) * sz) / (boxW - sz * 1.2)) * 1.35 + 0.55, 0);
  let size = Math.round((EC.size ?? 36) * k);
  while (size > 16 && need(size) * size > boxH) size--;
  return { t0: r2(endBody), t1: r2(endBody + sec), fade: EC.fade ?? 0.6, title: refs.length ? B.title ?? EC.title ?? '参考资料' : B.title ?? '', refs, lines, size, titleSize: Math.round(size * 1.5) };
})();
const end = endCard ? endCard.t1 : endBody;
// 离场：写完最后一笔，抬笔沿压过内容最少的方向出画，最后整支笔都在画外（审片 v9：原来按世界坐标往右上挪 1200，
// 16x9 镜头拉远后推不出画面，笔扫过算式和灯，停在右缘直到片尾）。候选方向不往下走，免得划过字幕
const exitTo = (() => {
  const c = camAt(penFree), later = [c, ...camera.filter((m) => m.t1 > penFree).map((m) => m.to)];
  const S = ([x, y], k = c) => [(x - k.x) * k.z + VIEW.cx, (y - k.y) * k.z + VIEW.cy], Wd = ([x, y]) => [(x - VIEW.cx) / c.z + c.x, (y - VIEW.cy) / c.z + c.y];
  const tip = S(penPos), reach = (style.pencil.length + style.pencil.halfWidth) * style.pencil.scale * (Math.min(TGT.w, TGT.h) / 1080) * Math.max(...later.map((k) => k.z)) + 60;
  const boxes = strokes.map((s) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of s.pts) { const [u, v] = S([x, y]); b[0] = Math.min(b[0], u); b[1] = Math.min(b[1], v); b[2] = Math.max(b[2], u); b[3] = Math.max(b[3], v); } return { b, w: s.kind === 'shape' ? 1 : 3 }; });
  const r = (style.pencil.base * Math.PI) / 180, L = reach - 60;
  const cost = ([tx, ty]) => {
    let n = 0;
    for (let k = 1; k <= 24; k++) {
      const x = tip[0] + ((tx - tip[0]) * k) / 24, y = tip[1] + ((ty - tip[1]) * k) / 24;
      for (let u = 0; u <= 1; u += 0.25) { const px = x + Math.cos(r) * L * u, py = y + Math.sin(r) * L * u; for (const { b, w } of boxes) if (px > b[0] && px < b[2] && py > b[1] && py < b[3]) n += w; }
    }
    return n + Math.hypot(tx - tip[0], ty - tip[1]) / 400;
  };
  const cands = [[TGT.w + reach, tip[1] - 300], [TGT.w + reach, tip[1]], [tip[0] + 300, -reach], [tip[0], -reach], [-reach, tip[1] - 300], [-reach, tip[1]]];
  const best = cands.map((q) => [q, cost(q)]).sort((a, b) => a[1] - b[1])[0][0];
  // 之后镜头还会拉远的话，离场点在每个镜头位置上都要看不到：不够远就沿同一方向再走远
  let w = Wd(best);
  for (let k = 0; k < 6 && later.some((cam) => { const [x, y] = S(w, cam); return x > -reach && x < TGT.w + reach && y > -reach && y < TGT.h + reach; }); k++) w = [penPos[0] + (w[0] - penPos[0]) * 1.5, penPos[1] + (w[1] - penPos[1]) * 1.5];
  return w;
})();
if (awayAt != null) penTrack.push({ kind: 'rest', t0: awayAt, t1: end + 1, at: penPos }); // 已经在画外，停到片尾
else {
  const exitDur = moveDur(Math.hypot(exitTo[0] - penPos[0], exitTo[1] - penPos[1]), 0.5, camAt(penFree).z);
  penTrack.push({ kind: 'move', t0: penFree, t1: penFree + exitDur, from: penPos, to: exitTo });
  penTrack.push({ kind: 'rest', t0: penFree + exitDur, t1: end + 1, at: exitTo });
}

// ---------- 自检（可失败） ----------
const downs = penTrack.filter((s) => s.kind === 'down').sort((a, b) => a.t0 - b.t0);
for (let i = 1; i < downs.length; i++) if (downs[i].t0 < downs[i - 1].t1 - 1e-6) problems.push(`两处同时落笔：${strokes[downs[i - 1].stroke].id} / ${strokes[downs[i].stroke].id}`);
for (const a of report.actions) if (a.lag > M.maxLag) flag('sync.lag', `画面落后旁白 ${a.lag}s：${a.id}（上限 ${M.maxLag}s）`);
for (const p of report.phrases) {
  if (p.insertedPause > M.maxPause) flag('pace.pause', `「${p.text}」后要等画面 ${p.insertedPause}s（上限 ${M.maxPause}s），旁白和画面没对上，需要拆句或减画`);
  else if (p.role !== 'aha' && p.insertedPause > M.maxPauseNonAha) flag('pace.pause', `「${p.text}」后停顿 ${p.insertedPause}s：长停顿应留给顿悟句（非顿悟句上限 ${M.maxPauseNonAha}s），需要把画面分到前后句或减画`);
}
// 说完了还在写（sync.silent）：一句旁白说完以后，笔还要再写多久（这句最后一笔写完 − 这句说完）。
// 有意的停顿（hold、顿悟后停稳）不算在里面：那时笔已经停了。超过 motion.maxSilentWrite 秒，观众就是在静音里看笔补写——
// E03 v2 全量审片的两条重要都是它（6 秒、5.3 秒），报告里早有数字，只是混在一百多条建议里，整片渲完、审完才被当回事。
// 默认只给建议；作者要「旁白和书写同步」时在私有配置里把 sync.silent 设成 hard，草稿就停在渲染之前
const SILENT = M.maxSilentWrite ?? 3;
for (const p of report.phrases) {
  const s = (p.drawEnd ?? 0) - (p.audioEnd ?? 0);
  if (s > SILENT) flag('sync.silent', `「${p.text.slice(0, 16)}」说完后还要等画面 ${r2(s)}s（笔在写、在走或等镜头；上限 ${SILENT}s）：观众在静音里看笔补写。把画分到前一句、拆句，或加半句旁白`);
}
// 叙事节奏（完整一集）：钩子要在开头几秒内出现，两个顿悟之间不能隔太久
const NR = style.narrative[beats.kind] || {};
if (NR.hookWithin !== undefined) {
  const hi = phrases.findIndex((p) => p.role === 'hook');
  if (hi >= 0 && report.phrases[hi].at > NR.hookWithin) flag('narrative.hook', `钩子在 ${report.phrases[hi].at}s 才出现（要求 ${NR.hookWithin}s 内）`);
  const ahas = [0, ...phrases.map((p, i) => (p.role === 'aha' ? report.phrases[i].at : null)).filter((x) => x !== null)];
  for (let i = 1; i < ahas.length; i++) if (ahas[i] - ahas[i - 1] > NR.maxAhaGap) flag('narrative.ahaGap', `${r2(ahas[i - 1])}s 到 ${r2(ahas[i])}s 之间 ${r2(ahas[i] - ahas[i - 1])}s 没有顿悟点（上限 ${NR.maxAhaGap}s）`);
}

// 字幕：说完后若这句的画面还在画，字幕停留到画完（不晚于下一句字幕出现），避免画面和字幕脱节
// 一屏最多几行（画幅的 sub.maxLines，没写就不限）：超了就在标点处拆成几张，各在这一段开口时出现。
// 手机竖着刷到横版时字幕要大（64 号），两行会压进播放器底部的进度条，所以横版一屏只放一行（用户 2026-11-05 定各平台统一发横版）
const splitCaption = (text) => {
  if (!TGT.sub.maxLines || breakLines(text, TGT.sub.size, TGT.sub.width).length <= TGT.sub.maxLines) return [text];
  const cuts = [...text.matchAll(/[，、；：,;:]/g)].map((m) => m.index + 1).filter((k) => k < text.length);
  if (!cuts.length) return [text];
  const mid = [...text].length / 2, k = cuts.reduce((a, c) => (Math.abs(c - mid) < Math.abs(a - mid) ? c : a));
  return [...splitCaption(text.slice(0, k)), ...splitCaption(text.slice(k))];
};
const introduced = new Set(); // 对话：已经开过口、字幕写过称呼的说话人
const subtitles = phrases.flatMap((p, i) => {
  const t0 = audioClips[i].at, spoken = t0 + (p.srcEnd - p.cutIn) + 0.35;
  const hold = style.subtitle.holdWhileDrawing ? report.phrases[i].drawEnd + 0.3 : spoken;
  const nextT0 = i + 1 < phrases.length ? audioClips[i + 1].at - 0.05 : Infinity;
  const cap = p.caption || p.text, t1 = r2(Math.min(nextT0, Math.max(spoken, hold)));
  const parts = splitCaption(cap);
  // 每张从它第一个字开口时出现：字幕和念法可以不同（「ai」念「爱」），按去标点后的字数比例对到旁白的字上
  const n = strip(cap).length, m = p.i1 - p.i0 + 1;
  let done = 0;
  const starts = parts.map((x) => { const at = t0 + (charTimes[p.i0 + Math.min(m - 1, Math.round((done / n) * m))].s - p.cutIn); done += strip(x).length; return Math.max(t0, at); });
  // 同一句拆出的几张首尾相接、换卡时不淡出淡入（join：接着上一张；joinNext：下一张接着它）。审片 E01 v20：淡出淡入让一句话中间字幕闪一下
  // 对话：不是主讲说的句子，字幕带上说话的人（称呼给审稿和理解度材料用，颜色给渲染用；compiler/speakers.mjs）。
  // 这个人第一次开口的那张字幕前面写上称呼（「爸爸：」），静音刷到的人也知道换了人（独立审片：只有一种没解释过的蓝色字幕）；labelFirst: false 关掉
  const v = p.speaker ? beats.narration.voices?.[p.speaker] : null;
  const who = v ? { speaker: p.speaker, ...(v.label ? { label: v.label } : {}), ...(v.caption ? { color: style.palette[v.caption] } : {}) } : {};
  const intro = v?.label && v.labelFirst !== false && !introduced.has(p.speaker) ? `${v.label}：` : '';
  if (p.speaker) introduced.add(p.speaker);
  return parts.map((x, k) => ({ text: (k ? '' : intro) + x.replace(/[，、；：,;:]$/, ''), lines: breakLines((k ? '' : intro) + x.replace(/[，、；：,;:]$/, ''), TGT.sub.size, TGT.sub.width), t0: r2(k ? starts[k] : t0), t1: k + 1 < parts.length ? r2(starts[k + 1]) : t1,
    ...(k ? { join: true } : {}), ...(k + 1 < parts.length ? { joinNext: true } : {}), ...who }));
});

// narration：每个画幅插的停顿不同，拼好的旁白也各存一份
// 章节：每节从它第一句旁白开口的时刻算起，第一节从 0 秒算（YouTube 章节第一行必须是 0:00）
const chapters = phrases.map((p, i) => (p.chapter ? { title: p.chapter, t: i === 0 ? 0 : r2(report.phrases[i].at) } : null)).filter(Boolean);
chapters.forEach((c, i) => {
  const len = (chapters[i + 1]?.t ?? end) - c.t;
  if (len < style.chapters.minSec) problems.push(`第 ${i + 1} 节「${c.title}」只有 ${r2(len)} 秒（每节至少 ${style.chapters.minSec} 秒，YouTube 章节的下限）`);
});
const out = {
  id: OUT_ID, target: targetName, canvas: { w: TGT.w, h: TGT.h, fps: FPS }, fps: FPS, durationInFrames: Math.ceil(end * FPS), duration: r2(end),
  narration: `audio/${OUT_ID}.narration.wav`, source: beats.narration.audio, beatsId: beats.id, audioClips, strokes, penTrack, effects, ...(stickers.length ? { stickers } : {}), camera, view: { cx: VIEW.cx, cy: VIEW.cy }, frame: TGT.frame, sub: TGT.sub,
  subtitles, chapters, style: styleSubset(style), ...(endCard ? { endCard } : {}),
  platforms: TGT.platforms, platformUI: Object.fromEntries(TGT.platforms.map((pf) => [pf, style.platformUI[pf]])),
  report: { ...report, problems, advice, fixes },
};
// ---------- 可见水印：品牌名小字，每 every 秒换到下一个候选位置（风格规范 watermark.slots），换位时淡出淡入 ----------
// 这段时间里会压到字幕、平台界面或已开始画的内容的位置就跳过；整段都找不到，就对半拆开再找（最多两次），还找不到这一小段就不加，记进自动修正。
// 文字取自本机 brand.local.json（不进仓库），没有这个文件就不加水印
{
  const WM = style.watermark, slots = WM?.slots?.[targetName];
  const brand = fs.existsSync('brand.local.json') ? JSON.parse(fs.readFileSync('brand.local.json', 'utf8')) : null;
  if (brand?.watermark?.text && slots?.length) {
    const { cameraAt, subtitleBox, watermarkBox, watermarkSampleTimes, boxesOverlap, strokeScreenBox, stickerInk } = await import('../src/timeline.ts');
    const stickerInks = stickers.map(stickerInk); // 水印也不压贴图
    const wm = { text: brand.watermark.text, size: WM.size[targetName], opacity: WM.opacity, fade: WM.fade, margin: WM.margin, contentMargin: WM.contentMargin, spans: [] };
    // 和安全区检查同样每 0.1 秒看一次，框再多留 4px，保证检查一定过
    const clashes = (slot, t0, t1) => {
      const box = watermarkBox(wm, slot, WM.margin + 4), far = watermarkBox(wm, slot, WM.contentMargin + 4);
      if (UI_ZONES.some((z) => boxesOverlap(box, z))) return true;
      if (subtitles.some((s) => s.t0 < t1 && s.t1 > t0 && boxesOverlap(box, subtitleBox(out, s.lines)))) return true;
      for (const t of watermarkSampleTimes(t0, t1)) {
        const c = cameraAt(camera, t);
        if ([...strokes, ...stickerInks].some((s) => s.t0 <= t && boxesOverlap(far, strokeScreenBox(out, s, c)))) return true;
      }
      return false;
    };
    let k = 0; // 轮换到第几个候选位置
    const place = (t0, t1, depth) => {
      t0 = r2(t0); t1 = r2(t1); // 先按存进时间线的精度取整再查：原来查的是没取整的 t1，存的是取整后的，安全区检查正好在多出来的那几毫秒里撞上内容（E03：118.8s）
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[(k + i) % slots.length];
        if (!clashes(slot, t0, t1)) return void wm.spans.push({ t0, t1, ...slot });
      }
      if (depth < 2) { const m = (t0 + t1) / 2; place(t0, m, depth + 1); place(m, t1, depth + 1); return; }
      const msg = `水印：${r2(t0)}–${r2(t1)}s 每个候选位置都会压到字幕、平台界面或内容，这一段不加`;
      fixes.push(msg), console.log(`  ${msg}`);
    };
    // 换位时刻：每 every 秒一次，在前后 swapWindow 秒里挑——优先落在两句旁白之间的停顿里，并避开顿悟句（见 watermark.swapNote）
    const ahaWin = report.phrases.filter((p) => p.role === 'aha').map((p) => [p.at - WM.fade, p.audioEnd + AHA.holdAfter + WM.fade]);
    const pauses = report.phrases.slice(0, -1).map((p, i) => [p.audioEnd, report.phrases[i + 1].at]).filter(([a, b]) => b > a);
    // 片尾镜头停在整张纸上、也不再落笔以后，画面上只剩水印会动，这时不换位（审片 E01 v18：228s 静止整板上水印淡出淡入）
    const stillFrom = Math.max(...camera.map((m) => m.t1), ...out.strokes.map((s) => s.t1), 0) - WM.fade;
    const okAt = (t) => !ahaWin.some(([a, b]) => t > a && t < b) && t < stillFrom;
    const swaps = [];
    for (let t = WM.every; t < end - WM.fade * 2; t += WM.every) {
      const near = (lst) => lst.filter((x) => Math.abs(x - t) <= WM.swapWindow && okAt(x) && x > (swaps.at(-1) ?? 0) + WM.fade * 2 && x < end - WM.fade * 2).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      const grid = Array.from({ length: Math.round((WM.swapWindow * 2) / 0.1) + 1 }, (_, i) => r2(t - WM.swapWindow + i * 0.1));
      const inPause = near(grid.filter((x) => pauses.some(([a, b]) => x >= a && x <= b)));
      const b = inPause ?? near(grid);
      if (b !== undefined) swaps.push(b);
    }
    const cuts = [0, ...swaps, end];
    for (let i = 0; i + 1 < cuts.length; i++, k++) place(cuts[i], cuts[i + 1], 0);
    // 相邻两段落在同一位置就合并，不白白淡出淡入
    wm.spans = wm.spans.reduce((a, s) => { const l = a.at(-1); if (l && l.t1 === s.t0 && l.x === s.x && l.y === s.y && l.anchor === s.anchor) l.t1 = s.t1; else a.push(s); return a; }, []);
    out.watermark = wm;
    console.log(`  水印：「${wm.text}」${wm.spans.length} 段，轮换 ${new Set(wm.spans.map((s) => `${s.x},${s.y}`)).size} 个位置`);
  }
}
// 铅笔姿态曲线（逐帧，存进时间线，渲染按帧号直接读）：
//   sway：运笔方向，高斯平滑；lift：抬笔量，高斯平滑；
//   edge：靠近画布边缘或字幕时，为了让整支笔留在画内、不压字幕而需要的转角。逐帧求最小转角，再做"限速包络"
//   （每帧最多转 turnPerFrame 度，且提前转到位），保证不晃也不出画（审片发现方版铅笔被右边缘切掉）。
{
  const { penAt, cameraAt, pencilScale, pencilBodyPts, pencilFootprint, subtitleBox, inBox, isFlight, SUB_MARGIN } = await import('../src/timeline.ts');
  const P = style.pencil;
  const nF = Math.ceil(end * FPS), sway = new Float64Array(nF), lift = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    const t = f / FPS, a = penAt(out, t - 0.04), b = penAt(out, t + 0.04);
    const dx = b.x - a.x, dy = b.y - a.y, m = Math.hypot(dx, dy);
    sway[f] = m > 1e-6 ? (Math.min(1, m / 20) * dy) / m : 0;
    lift[f] = penAt(out, t).lift;
  }
  const gauss = (arr, sigmaSec) => {
    const sg = sigmaSec * FPS, R = Math.ceil(sg * 3), k = [];
    for (let i = -R; i <= R; i++) k.push(Math.exp(-(i * i) / (2 * sg * sg)));
    const ks = k.reduce((x, y) => x + y, 0);
    return Array.from(arr, (_, f) => { let v = 0; for (let i = -R; i <= R; i++) v += arr[Math.min(nF - 1, Math.max(0, f + i))] * k[i + R]; return Math.round((v / ks) * 1000) / 1000; });
  };
  const swayS = gauss(sway, P.swaySigma);
  // 和铅笔检查用同一份几何（src/timeline.ts），字幕框再多留 4px 余量；抬笔量按最大值算（影子错开最多），保证检查一定过
  const subBoxAt = (t) => {
    const s = subtitles.find((x) => t >= x.t0 && t < x.t1);
    return s ? subtitleBox(out, s.lines, SUB_MARGIN + 4) : null;
  };
  const ok = (tip, ang, sc, sb, edges = true) => {
    const pose = { x: tip.x, y: tip.y, ang, sc, lift: 0.5 }, mg = P.edgeMargin;
    if (edges && pencilBodyPts(out, pose).some(([x, y]) => x < mg || x > TGT.w - mg || y < mg || y > TGT.h - mg)) return false;
    return !(sb && pencilFootprint(out, pose).some((q) => inBox(sb, q)));
  };
  const flights = out.penTrack.filter((m) => isFlight(out, m));
  // 铅笔角度轨迹。每帧可行的角度（整支笔在画布内、笔身和影子不压字幕）是若干区间，不是"转够就行"的门槛：
  // 转多了一样会压到别处（实测方版为避开右边缘多转的角度把笔转进了字幕）。所以用动态规划，在可行角度里
  // 找一条转得慢（每帧 turnPerFrame 度，必要时两倍）、离自然角度最近的轨迹；哪一帧没有可行角度，就报给分镜。
  // turnPerFrame 和下面的每帧上限都是按 60 帧/秒定的「每 1/60 秒」，换成这条时间线的每帧（30 帧/秒时每帧可以转两倍）：转得多快按秒算，和铅笔检查一致
  // K 向下取整：最大格点不超过 maxAngle（15、25 帧/秒时步长除不尽）
  const PF = 60 / FPS, STEP = P.turnPerFrame * PF, K = Math.floor((P.maxAngle - P.minAngle) / STEP + 1e-6) + 1, ang = (k) => P.minAngle + k * STEP;
  const a0s = new Float64Array(nF), feas = new Array(nF).fill(null); // feas[f]：null = 任何角度都行；否则按 1° 采样的可行表
  for (let f = 0; f < nF; f++) {
    const t = f / FPS, cam = cameraAt(camera, t), p = penAt(out, t);
    a0s[f] = P.base + P.swing * swayS[f];
    const tip = { x: (p.x - cam.x) * cam.z + VIEW.cx, y: (p.y - cam.y) * cam.z + VIEW.cy };
    if (tip.x < 0 || tip.x > TGT.w || tip.y < 0 || tip.y > TGT.h) continue; // 笔尖在画外不管
    // 入画/出画途中笔身本来就有一截在画外，不管出画；但不压字幕照样要管（停笔改成可以移出画面后，实测飞出时横穿字幕）
    const flying = flights.some((m) => t >= m.t0 && t <= m.t1);
    const sc = pencilScale(out, cam.z), sb = subBoxAt(t), reach = (P.length + P.halfWidth) * sc + 40; // 笔加影子够得着的最远距离
    const subDist = sb ? Math.hypot(Math.max(sb.l - tip.x, 0, tip.x - sb.r), Math.max(sb.t - tip.y, 0, tip.y - sb.b)) : Infinity;
    if ((flying || (tip.x > reach && tip.x < TGT.w - reach && tip.y > reach && tip.y < TGT.h - reach)) && subDist > reach) continue; // 哪个角度都碰不到边和字幕
    feas[f] = Uint8Array.from({ length: Math.ceil(P.maxAngle - P.minAngle) + 1 }, (_, d) => (ok(tip, P.minAngle + d, sc, sb, !flying) ? 1 : 0));
  }
  const feasible = (f, k) => { const row = feas[f]; if (!row) return true; const a = k * STEP; return row[Math.floor(a)] && row[Math.min(row.length - 1, Math.ceil(a))]; };
  // 写字和移动时，笔身尽量不压别的元素已写出的字（审片 v9：16x9 画声波时笔身横压 x₁、x₂ 和「×3」）：
  // 每帧按 2° 采样，数各角度下笔身（不算笔尖那段锥）压进已写文字的采样点，每点记 pencil.coverCost 的代价。
  // 试过把图形也算进来（记半点）：e02 的 9x16 反而多出两段超过 1 秒的压字，所以只算文字
  const txt = strokes.filter((s) => s.kind !== 'shape').map((s) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of s.pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); } return { b, a: s.action, t1: s.t1, w: 2 }; });
  const cover = new Array(nF).fill(null), CS = 2;
  for (let f = 0; f < nF; f++) {
    const t = f / FPS, cam = cameraAt(camera, t), p = penAt(out, t);
    const tip = { x: (p.x - cam.x) * cam.z + VIEW.cx, y: (p.y - cam.y) * cam.z + VIEW.cy };
    if (tip.x < 0 || tip.x > TGT.w || tip.y < 0 || tip.y > TGT.h) continue;
    const sc = pencilScale(out, cam.z), reach = (P.length + P.halfWidth) * sc, down = out.penTrack.find((sg) => sg.kind === 'down' && t >= sg.t0 && t < sg.t1);
    const self = down ? strokes[down.stroke].action : null, pad = 4;
    const near = txt.filter((q) => q.t1 <= t && q.a !== self).map(({ b, w }) => [(b[0] - cam.x) * cam.z + VIEW.cx - pad, (b[1] - cam.y) * cam.z + VIEW.cy - pad, (b[2] - cam.x) * cam.z + VIEW.cx + pad, (b[3] - cam.y) * cam.z + VIEW.cy + pad, w])
      .filter((b) => b[2] > tip.x - reach && b[0] < tip.x + reach && b[3] > tip.y - reach && b[1] < tip.y + reach);
    if (!near.length) continue;
    const cone = 0.2 * P.length * sc;
    cover[f] = Uint8Array.from({ length: Math.floor((P.maxAngle - P.minAngle) / CS) + 1 }, (_, d) => {
      const a = P.minAngle + d * CS, r = (a * Math.PI) / 180;
      let n = 0;
      for (const [x, y] of pencilBodyPts(out, { x: tip.x, y: tip.y, ang: a, sc, lift: 0.3 })) {
        if ((x - tip.x) * Math.cos(r) + (y - tip.y) * Math.sin(r) < cone) continue;
        const hit = near.filter((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]);
        if (hit.length) n += Math.max(...hit.map((b) => b[4]));
      }
      return Math.min(255, n);
    });
  }
  const coverAt = (f, k) => (cover[f] ? cover[f][Math.min(cover[f].length - 1, Math.round((k * STEP) / CS))] / 2 : 0); // 表里存的是半点数
  const cost = (f, k) => (feasible(f, k) ? 0 : 1000) + Math.abs(ang(k) - a0s[f]) + (P.coverCost ?? 0) * coverAt(f, k);
  let D = Float64Array.from({ length: K }, (_, k) => cost(0, k)), D2 = new Float64Array(K);
  const back = new Int8Array(nF * K);
  // 平常每帧最多转一步（turnPerFrame）；赶不及时允许转两步，但要付代价，只在必要时用。
  // 抬笔在画面上大段移动时（手在挪位置），转得快一点是自然的：最多 travelTurnSteps 步，超出一步的部分照样付代价
  // （实测 16:9 开头：x₃ 圆底贴着字幕要放平到 17° 以下，1.1 秒后到右边缘画灯又要立到 45° 以上，写字时的转速赶不及）
  // 「这一帧和上一帧都在抬笔移动」才放宽（和铅笔检查的判法一致）
  const movingAt = (t) => out.penTrack.some((sg) => sg.kind === 'move' && t >= sg.t0 && t < sg.t1);
  const moving = Uint8Array.from({ length: nF }, (_, f) => (f > 0 && movingAt(f / FPS) && movingAt((f - 1) / FPS) ? 1 : 0));
  for (let f = 1; f < nF; f++) {
    const maxD = moving[f] ? P.travelTurnSteps : 2;
    for (let k = 0; k < K; k++) {
      let best = Infinity, bk = 0;
      for (let d = -maxD; d <= maxD; d++) {
        const j = k + d;
        if (j < 0 || j >= K) continue;
        const v = D[j] + (Math.abs(d) >= 2 ? 2 * (Math.abs(d) - 1) : 0);
        if (v < best) { best = v; bk = d; }
      }
      D2[k] = best + cost(f, k);
      back[f * K + k] = bk;
    }
    [D, D2] = [D2, D];
  }
  const path = new Int32Array(nF);
  let k = D.indexOf(Math.min(...D));
  for (let f = nF - 1; f >= 0; f--) { path[f] = k; if (f > 0) k += back[f * K + k]; }
  // 不受约束、离自然角度不到一步的帧直接用自然角度（不量化）
  const edge = Array.from(path, (k, f) => (!feas[f] && Math.abs(ang(k) - a0s[f]) <= STEP ? 0 : Math.round((ang(k) - a0s[f]) * 100) / 100));
  // 在自然角度（不量化）和规划角度（按 turnPerFrame 量化）之间切换的那一帧会多跳最多一步：再按检查的上限压一遍每帧转角
  // （每 1/60 秒：写字、停笔 ≤0.45°，抬笔移动 ≤0.95°，比检查的 0.5°、1° 各留一点余量；按帧率乘 PF）
  for (let f = 1; f < nF; f++) {
    const lim = (moving[f] ? 0.95 : 0.45) * PF, prev = a0s[f - 1] + edge[f - 1], cur = a0s[f] + edge[f];
    if (Math.abs(cur - prev) > lim) edge[f] = Math.round((prev + Math.sign(cur - prev) * lim - a0s[f]) * 100) / 100;
  }
  const stuck = [...path.keys()].filter((f) => !feasible(f, path[f]));
  for (const [a, b] of runsOf(stuck)) problems.push(`铅笔：${r2(a / FPS)}–${r2(b / FPS)}s 笔尖离画面边缘或字幕太近，转到 ${P.minAngle}°~${P.maxAngle}° 都避不开（会出画或压字幕），需要把这里的内容往画面中间挪`);
  out.pencil = { sway: swayS, lift: gauss(lift, P.liftSigma), edge };
  const turned = edge.filter((v) => Math.abs(v) > 0.5).length;
  if (turned) fixes.push(`铅笔：${r2(turned / FPS)}s 内靠近边缘或字幕时自动转角（最大 ${r2(Math.max(...edge.map(Math.abs)))}°）`), console.log(`  铅笔：${r2(turned / FPS)}s 内靠近边缘或字幕时自动转角（最大 ${r2(Math.max(...edge.map(Math.abs)))}°）`);
}
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(`build/${OUT_ID}.timeline.json`, JSON.stringify(out));

// 旁白拼接在 audio/mix.py 里按采样点精确完成（Remotion 自带 ffmpeg 删减过，做不了逐采样淡入淡出）

console.log(`[${OUT_ID}] 时长 ${r2(end)}s，${strokes.length} 笔，${audioClips.length} 段旁白`);
for (const p of report.phrases) console.log(`  「${p.text}」 @${p.at}s 插停顿 ${p.insertedPause}s`);
// 建议（创作取舍，不判失败）先打，问题（机械上坏了）后打：流水线按「问题 N 项」判失败、按「建议 N 项」写进报告
if (advice.length) console.log(`建议 ${advice.length} 项：\n  ` + advice.join('\n  '));
console.log(problems.length ? `问题 ${problems.length} 项：\n  ` + problems.join('\n  ') : '自检：无同时落笔、无出镜头、文字没有压在一起、铅笔不出画不压字幕');
if (problems.length) process.exitCode = 1;
