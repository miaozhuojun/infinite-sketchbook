// 分镜数据 + 实测旁白时间 → 时间线（单笔调度）。
// 原则：画面跟着语义走；笔画不完就让下一句旁白等（插入停顿），绝不变速、绝不两处同时落笔。
// 风格参数只来自 style/style.json；图元只来自组件库 library/；渲染前先过分镜校验（compiler/validate.mjs）。
// 用法：node compiler/compile.mjs data/<id>.beats.json --target 9x16|16x9|1x1 [--no-autofix] [--no-validate]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { svgPathProperties } from 'svg-path-properties';
import { loadLibrary } from '../library/index.mjs';
import { makeKit, samplePts, offsetPath, r2, dist } from '../library/kit.mjs';
import { validateBeats, loadStyle, strip, breakLines, styleSubset } from './validate.mjs';

const beatsPath = process.argv[2];
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
const style = loadStyle();
const library = await loadLibrary();
if (!process.argv.includes('--no-validate')) {
  const { errors, warnings } = validateBeats(beats, style, library);
  for (const w of warnings) console.log(`  [提醒] ${w}`);
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
    const cut = quietCut(prev.srcEnd - 0.12, p.srcStart + 0.12);
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

// ---------- 运笔限速：按"这一句时镜头实际放大倍数"换算成屏幕速度，60fps 下保证笔不瞬移、每笔至少 4 帧 ----------
const M = style.motion;
const ZMAX = M.zoomMax, ZMIN = M.zoomMin;
const V_DRAW = M.drawSpeed;   // 写字时笔尖平均屏幕速度上限 px/s
const V_MOVE = M.moveSpeed;   // 抬笔移动平均屏幕速度上限 px/s（缓动峰值约 2 倍）
const MIN_STROKE = M.minStroke; // 60fps 下 3 帧
const strokeDur = (s, len, speed, z) => Math.max(
  s.kind === 'shape' ? Math.max(0.1, (0.06 + len / 1500) / speed) : Math.max(MIN_STROKE, (0.04 + (len / s.normLenRef) * 0.09) / speed),
  (len * z) / V_DRAW);
const moveDur = (d, base, z, speed = 1) => Math.max(base, (base + d / 2200) / speed, (d * z) / V_MOVE);

// ---------- 几何与版面（与时间无关）：先算笔画几何，再自动修字号和压线，最后取景 ----------
const VIEW = TGT.view;
const geo = new Map();
const allActions = phrases.flatMap((p) => p.actions);
const actionsById = new Map(allActions.map((a) => [a.id, a]));
const buildOne = (a) => {
  if (a.type === 'glow' || a.type === 'off') return;
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
      // 划掉：从目标墨迹（一组时取整体）左下到右上斜划一道，两头各出头一点
      const b = bboxOf(ts.flatMap((t) => geo.get(t.id))), ex = 8;
      geo.set(a.id, drawAction({ ...a, type: 'line', color: a.color ?? 'accent', from: [b.x0 - ex, b.y1 + ex / 2], to: [b.x1 + ex, b.y0 - ex / 2], bow: 2 }));
    }
  } else geo.set(a.id, drawAction(a));
};
// 挪动或放大一个元素后，引用它的回描、划掉也要跟着重画
const rebuildWithDeps = (a) => { buildOne(a); for (const d of allActions) if ([d.target].flat().includes(a.id) || d.after === a.id) rebuildWithDeps(d); };
const rebuildAll = () => { geo.clear(); for (const a of allActions) buildOne(a); };
function bboxOf(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) {
    const pr = new svgPathProperties(s.d), L = pr.getTotalLength();
    for (let k = 0; k <= 12; k++) { const q = pr.getPointAtLength((L * k) / 12); x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  }
  return { x0, y0, x1, y1 };
}
const fitZ = (b, pad) => Math.min(VIEW.w / (b.x1 - b.x0 + 2 * pad), VIEW.h / (b.y1 - b.y0 + 2 * pad));
// 全景取景：到这一句为止的全部内容
const computePhraseCam = () => {
  const acc = [], out = [];
  for (const p of phrases) {
    for (const a of p.actions) if (geo.has(a.id)) acc.push(...geo.get(a.id));
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
const textPx = (a, cams) => a.size * Math.min(cams[phraseOf.get(a.id)]?.z ?? 1, cams[cams.length - 1]?.z ?? 1) * 0.74;

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
const related = (a, b) => {
  if (a.after === b.id || b.after === a.id || [a.target].flat().includes(b.id) || [b.target].flat().includes(a.id)) return true;
  // 划掉算式里的一项时，划线会贴着同一行接写的前后项（审片前自查：划「=7」时离「+0×2」3px）
  const struck = (x, y) => x.type === 'strike' && [x.target].flat().some((id) => actionsById.get(id)?.after === y.id || y.after === id);
  if (struck(a, b) || struck(b, a)) return true;
  // 回描就是在原字上再描几遍：接在原字后面写的字离回描的距离就是字距（点题句加粗 ×1 后，下一句在它后面写「?」）
  const traced = (x, y) => x.type === 'retrace' && [x.target].flat().some((id) => y.after === id || actionsById.get(id)?.after === y.id);
  if (traced(a, b) || traced(b, a)) return true;
  if (a.type === 'text' && b.type === 'text') return false;
  // 同一个门槛量表的几部分（底线和门槛虚线、数值柱）本来就画在一起：base 相同就是同一个量表
  if (a.type === 'meter' && b.type === 'meter' && a.base === b.base) return true;
  return a.on === b.id || b.on === a.id || (a.on && a.on === b.on);
};
const sampleList = (list) => list.flatMap((s) => {
  const pr = new svgPathProperties(s.d), L = pr.getTotalLength(), n = Math.max(2, Math.ceil(L / 4));
  return Array.from({ length: n + 1 }, (_, k) => { const q = pr.getPointAtLength((L * k) / n); return [q.x, q.y, s.width]; });
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
const clearance = (A, pts) => {
  let best = Infinity, who = null, raw = Infinity, need = GAP, row = false;
  for (const [id, list] of geo) {
    const B = actionsById.get(id);
    if (id === A.id || related(A, B)) continue;
    const pb = sampleList(list);
    if (B.type === 'text') {
      const tp = textPair(A, pts, B, pb);
      if (tp && tp.margin < best) { best = tp.margin; who = id; raw = tp.raw; need = tp.need; row = true; }
    }
    const ng = needGap(A, B);
    for (const [bx, by, bw] of pb) for (const [ax, ay, aw] of pts) {
      const d = Math.hypot(ax - bx, ay - by) - (aw + bw) / 2;
      if (d - ng < best) { best = d - ng; who = id; raw = d; need = ng; row = false; }
    }
  }
  return { best, who, raw, need, row }; // best = 余量（≥0 才合格）
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
const layoutProblems = [];
for (const a of allActions) {
  if (a.type !== 'text') continue;
  const c = clearance(a, sampleList(geo.get(a.id)));
  if (c.best < 0) layoutProblems.push(`标签「${a.text}」(${a.id}) 离 ${c.who} ${c.row ? '在同一行，横向' : ''}只有 ${r2(Math.max(0, c.raw))}px（要求 ≥${r2(c.need)}px）` + (AUTOFIX ? '，自动避让 72px 内找不到空位，需要改分镜布局' : ''));
  const px = textPx(a, phraseCam);
  if (px < MIN_TEXT - 0.5) layoutProblems.push(`标签「${a.text}」(${a.id}) 在屏幕上约 ${r2(px)}px 高，低于本画幅最小 ${MIN_TEXT}px` + (AUTOFIX ? '（已沿字号阶梯放大到上限仍不够），需要改分镜布局' : ''));
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
    if (ends(A).some((p) => touches(p, pts.get(B.id))) || ends(B).some((p) => touches(p, pts.get(A.id)))) continue;
    let d = Infinity;
    for (const [ax, ay, aw] of pts.get(A.id)) for (const [bx, by, bw] of pts.get(B.id)) d = Math.min(d, Math.hypot(ax - bx, ay - by) - (aw + bw) / 2);
    if (d < GAP_S) layoutProblems.push(`图形「${A.id}」和「${B.id}」的墨迹只隔 ${r2(Math.max(0, d))}px（要求 ≥${r2(GAP_S)}px）：不是有意贴着就挪开；有意贴着（比如描在它上面）就在分镜里用 on 声明`);
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
const UI_ZONES = TGT.platforms.flatMap((pf) => style.platformUI[pf] || []);
// 元素包围盒缓存（取景搜索要试上千个位置，每次重新采样路径太慢）；元素被重画后自动失效
const boxCache = new Map();
const geoBox = (id) => { const l = geo.get(id), c = boxCache.get(id); if (c && c.l === l) return c.b; const b = bboxOf(l); boxCache.set(id, { l, b }); return b; };
// 镜头停稳时（比检查再收 4px）：
//   文字要整段在取景框 frame 里（字幕衬底上方、不压平台界面），或者整段在画布外（审片：推近后左边缘只剩「4」、算式只剩「0 =7」）；
//   图形可以被画布边缘裁掉（推近时画面边上的旧内容本来就会被推出去），但不能停在取景框外的边距里，也不能越过取景框下沿压向字幕
//   （审片 v9：推近把标题推出画、下划线还挂在顶边；灯泡越过取景框下沿，坐在字幕板上）
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
  for (let k = 0; k <= 8 && zHi >= zLo; k++) {
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
for (const [pi, f] of focusCam.entries()) if (f && f.push < AHA.minPush - 1e-3) console.log(`  [提醒] 顿悟句「${phrases[pi].text}」只能推近 ${r2(f.push)} 倍：` + (blockers[pi] ? `居中推近时 ${blockers[pi].join('、')} 会被切断或停在取景框边距里，可改版式给焦点四周留空，或把它们挪开` : '焦点装不下（元素太分散，可用 focus 只圈关键元素）'));

// ---------- 单笔调度（函数化：画面拖尾时自动给该动作提速再排一次） ----------
// 画面右边外面的一个点（世界坐标）：在给出的每个镜头下都看不到，用来让笔暂时离开画面
const offRight = (cams, y) => { const cs = cams.filter(Boolean); return cs.length ? [Math.max(...cs.map((c) => c.x + (TGT.w + 260 - VIEW.cx) / c.z)), y] : null; };
const runsOf = (frames) => frames.reduce((r, f) => { const l = r.at(-1); if (l && f === l[1] + 1) l[1] = f; else r.push([f, f]); return r; }, []);
const OFF = [4000, 0]; // 画外（世界坐标极远处），任何画幅下都看不到
function schedule(boost) {
  const strokes = [], penTrack = [], effects = [], audioClips = [], report = { phrases: [], actions: [] };
  let T = PEN.leadIn, penFree = 0, penPos = OFF, release = 0; // release：顿悟句后，下一句最早落笔时刻（镜头停够 holdAfter、拉远走完大半之后）
  phrases.forEach((p, pi) => {
    const next = phrases[pi + 1];
    const clipIn = p.cutIn, clipOut = p.cutOut;
    const toTL = (srcT) => T + (srcT - clipIn);
    audioClips.push({ phrase: p.text, at: r2(T), srcIn: clipIn, srcOut: clipOut });
    const audioStart = T, audioEnd = T + (clipOut - clipIn), phraseStartFree = penFree;
    for (const a of p.actions) {
      const cueIdx = fullText.indexOf(strip(a.at), p.i0);
      if (cueIdx < 0 || cueIdx > p.i1) throw new Error(`${a.id} 的 cue「${a.at}」不在短语「${p.text}」里`);
      const cue = toTL(charTimes[cueIdx].s);
      if (a.type === 'off') {
        const e = effects.find((x) => x.id === a.target);
        Object.assign(e, { t2: cue, t3: cue + 0.6 });
        report.actions.push({ id: a.id, type: a.type, phrase: pi, cue: r2(cue), start: r2(cue), end: r2(cue + 0.6), lag: 0, pen: false });
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
      const z = Math.max(targetCam[pi]?.z ?? 1, targetCam[pi - 1]?.z ?? 0);
      const first = new svgPathProperties(ss[0].d).getPointAtLength(0);
      const fromPos = penPos === OFF ? [first.x + 1000, first.y - 350] : penPos; // 首次入画：从右上方画外进来，不划过字幕区
      const travel = moveDur(dist(fromPos, [first.x, first.y]), 0.12, z);
      let t = Math.max(cue - (a.lead ?? PEN.cueLead), penFree + travel, release); // lead：允许个别动作提前于旁白开写（如开场标题）
      // 要停一会儿时先退开：笔尖往右下（笔身朝向）退一点，别压着刚写的东西；退开的点不出取景框
      // ---- 落笔前等多久、在哪儿等：停笔不压正在讲的东西（审片：笔停在刚写的「0」、刚画的灯、x₁ 的下标上） ----
      // 等不到 0.5 秒就原地等；再久就在候选位置里挑：原地、当前位置四周、下一笔起点四周、等得够久时还有画面外。
      // 代价：笔身压到文字、刚画完的那个元素、当前推近的焦点，记 100；压到别的墨迹记 1。
      // 画面里的位置必须在下一镜里看得到（不被镜头推出去），画面外只在画面里每个位置都会压到要紧东西时才用。
      const PK = style.pencil.park, fr = TGT.frame, cam = targetCam[pi] ?? { x: VIEW.cx, y: VIEW.cy, z: 1 };
      const st = [first.x, first.y], wait = t - penFree;
      if (penPos === OFF || wait - travel < PK.minRest) {
        if (penPos !== OFF && t - travel > penFree) penTrack.push({ kind: 'rest', t0: penFree, t1: t - travel, at: penPos });
        penTrack.push({ kind: 'move', t0: t - travel, t1: t, from: fromPos, to: st });
      } else {
        const drawn = new Set(strokes.map((s) => s.action)), lastId = strokes.at(-1)?.action;
        const focusIds = new Set([pi, pi - 1].filter((q) => q >= 0 && focusCam[q]).flatMap((q) => [...phrases[q].actions.map((x) => x.id), ...(phrases[q].focus || [])]));
        const protect = [...drawn].filter((id) => textInk.has(id) || id === lastId || focusIds.has(id)).map((id) => (textInk.has(id) && id !== lastId && !focusIds.has(id) ? textInk.get(id) : bboxOf(geo.get(id))));
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
        const views = [targetCam[pi - 1], focusCam[pi - 1], cam].filter(Boolean);
        const inNext = (q) => views.every((c) => { const sx = (q[0] - c.x) * c.z + VIEW.cx, sy = (q[1] - c.y) * c.z + VIEW.cy; return sx > fr.l + 40 && sx < fr.r - 200 && sy > fr.t + 40 && sy < fr.b - 200; });
        const around = (o) => [[0, 0], [1, 1], [1.4, 0], [1, -0.7], [0, 1.3], [-0.8, 1.1], [2, 2], [2.4, 0], [0, 2.4], [-1.6, 2], [2, -1.2]].map(([dx, dy]) => [o[0] + (dx * PK.dist) / z, o[1] + (dy * PK.dist) / z]);
        // 再加一张覆盖整个取景框的粗网格：内容密的地方（16x9 左边一列输入、声波、权重），这两处四周笔身朝右下都会压到字，
        // 只在附近找就只能挑「压得最少」的；有时间的话应该去空白处等
        const grid = [];
        for (let gx = 0; gx <= 6; gx++) for (let gy = 0; gy <= 4; gy++) {
          const sx = fr.l + 60 + ((fr.r - 260 - fr.l - 60) * gx) / 6, sy = fr.t + 60 + ((fr.b - 260 - fr.t - 60) * gy) / 4;
          grid.push([cam.x + (sx - VIEW.cx) / cam.z, cam.y + (sy - VIEW.cy) / cam.z]);
        }
        const cands = [...around(penPos), ...around(st), ...grid].filter(inNext).map((q) => ({ q, c: cost(q) + dist(q, penPos) / 400 }));
        const off = offRight([targetCam[pi - 1], targetCam[pi], focusCam[pi - 1]], penPos[1]);
        if (off) cands.push({ q: off, c: 60, off: true });
        // 时间够不够：过去、至少停 0.2 秒、再回到下一笔起点
        const fits = ({ q }) => penFree + moveDur(dist(penPos, q), 0.12, z) + 0.2 <= t - moveDur(dist(q, st), 0.12, z);
        const best = cands.filter(fits).sort((x, y) => x.c - y.c)[0];
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
        strokes.push({ ...s, id: `${a.id}#${si}`, action: a.id, group: s.group ?? a.id, len: r2(len), t0: r2(t), t1: r2(t + dur) });
        penTrack.push({ kind: 'down', t0: t, t1: t + dur, stroke: idx });
        t += dur;
        penPos = [en.x, en.y];
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
    } else release = 0;
    T = nextT;
  });
  return { strokes, penTrack, effects, audioClips, report, penFree, penPos };
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
const { strokes, penTrack, effects, audioClips, report } = sched;
let { penFree, penPos } = sched;
const problems = [...layoutProblems];
for (const x of trailOf(sched)) problems.push(`「${actionsById.get(x.id).text ?? actionsById.get(x.id).label}」(${x.id}) ${x.late ? `在这句旁白说完后才起笔（${x.start}s，句末 ${x.audioEnd}s）` : `书写只有 ${Math.round(x.share * 100)}% 和本句旁白重叠（要求 ≥${M.textOverlapMin * 100}%）`}，需要把它提到更早的词上或拆句`);

// ---------- 压力采样：渲染端用 perfect-freehand 生成变宽笔迹，笔尖位置也取自同一组点（见 library/kit.mjs） ----------
for (const s of strokes) s.pts = samplePts(s);

// ---------- 镜头关键帧：普通句在第一笔前移到全景；顿悟句在提示词前 lead 秒推近到位，停留 ≥hold 秒；结尾回到全景 ----------
const camera = [];
const pushMove = (t0, t1, to, focus) => {
  const prev = camera.length ? camera[camera.length - 1] : null;
  const from = prev ? prev.to : to;
  if (prev && Math.abs(from.z - to.z) < 0.01 && Math.hypot(from.x - to.x, from.y - to.y) < 8) return;
  if (prev && t0 < prev.t1) { const d = prev.t1 - t0; t0 += d; t1 += d; } // 不和上一段镜头移动重叠
  camera.push({ t0: r2(t0), t1: r2(t1), from, to, ...(focus ? { focus } : {}) });
};
phrases.forEach((p, pi) => {
  const tc = targetCam[pi];
  // 这句没有笔画（比如结尾回收句只说不画）也要移到自己的取景：从句子开头起移
  const first = strokes.find((s) => p.actions.some((a) => a.id === s.action)) ?? { t0: report.phrases[pi].at + (focusCam[pi] ? 0 : M.cameraMove[0]) };
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
    const t0 = Math.max(Math.min(cue - AHA.lead, first.t0) - AHA.moveDur, holdUntil, prevDraw);
    pushMove(t0, t0 + AHA.moveDur, tc, [...new Set([...p.actions.map((a) => a.id), ...(p.focus || [])])]); // 推近镜头记下焦点元素（安全区检查用）
  } else {
    // 普通句：镜头在第一笔前 cameraMove[0] 秒起移、第一笔后 cameraMove[1] 秒到位（边写边稳住）。
    // 顿悟后的第一句例外：要从推近的取景拉回来，第一笔可能远在画外（实测划 ×4 时还在画面外），所以第一笔前就要拉远到位
    const lead = focusCam[pi - 1] ? M.cameraMove[0] + M.cameraMove[1] : M.cameraMove[0];
    const t0 = Math.max(first.t0 - lead, holdUntil);
    pushMove(t0, t0 + M.cameraMove[0] + M.cameraMove[1], tc);
  }
});
// 两次普通（非推近）镜头移动挨得太近（间隔不到 minCameraGap 秒）就合并成一次，直接移到后一次的取景
// （审片：29.4–31.7s 连着两次重新取景，中间只停稳 0.4 秒，镜头显得忙）
for (let i = camera.length - 1; i > 0; i--) {
  const a = camera[i - 1], b = camera[i];
  if (!a.focus && !b.focus && b.t0 - a.t1 < M.minCameraGap) { a.to = b.to; a.t1 = b.t1; camera.splice(i, 1); }
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
const camAt = (t) => { let c = camera[0].from; for (const m of camera) { if (t >= m.t1) c = m.to; else if (t > m.t0) { const u = (t - m.t0) / (m.t1 - m.t0), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; c = { x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e, z: m.from.z + (m.to.z - m.from.z) * e }; } } return c; };
for (const s of strokes) {
  const c = camAt(s.t1), pr = new svgPathProperties(s.d);
  for (let k = 0; k <= 12; k++) {
    const q = pr.getPointAtLength((s.len * k) / 12);
    const sx = (q.x - c.x) * c.z + VIEW.cx, sy = (q.y - c.y) * c.z + VIEW.cy;
    if (sx < TGT.frame.l || sx > TGT.frame.r || sy < TGT.frame.t || sy > TGT.frame.b) { problems.push(`镜头外：${s.id} 在 ${r2(s.t1)}s 屏幕(${r2(sx)},${r2(sy)})`); break; }
  }
}

const end = Math.max(audioEndAll, penFree + 0.8, lastCamEnd + M.finalOverviewHold) + PEN.tail;
const exitTo = [penPos[0] + 1200, penPos[1] - 400]; // 从右上方离场，不划过字幕区
const exitDur = moveDur(1270, 0.5, 1);
penTrack.push({ kind: 'move', t0: penFree, t1: penFree + exitDur, from: penPos, to: exitTo });
penTrack.push({ kind: 'rest', t0: penFree + exitDur, t1: end + 1, at: exitTo });

// ---------- 自检（可失败） ----------
const downs = penTrack.filter((s) => s.kind === 'down').sort((a, b) => a.t0 - b.t0);
for (let i = 1; i < downs.length; i++) if (downs[i].t0 < downs[i - 1].t1 - 1e-6) problems.push(`两处同时落笔：${strokes[downs[i - 1].stroke].id} / ${strokes[downs[i].stroke].id}`);
for (const a of report.actions) if (a.lag > M.maxLag) problems.push(`画面落后旁白 ${a.lag}s：${a.id}（上限 ${M.maxLag}s）`);
for (const p of report.phrases) {
  if (p.insertedPause > M.maxPause) problems.push(`「${p.text}」后要等画面 ${p.insertedPause}s（上限 ${M.maxPause}s），旁白和画面没对上，需要拆句或减画`);
  else if (p.role !== 'aha' && p.insertedPause > M.maxPauseNonAha) problems.push(`「${p.text}」后停顿 ${p.insertedPause}s：长停顿应留给顿悟句（非顿悟句上限 ${M.maxPauseNonAha}s），需要把画面分到前后句或减画`);
}
// 叙事节奏（完整一集）：钩子要在开头几秒内出现，两个顿悟之间不能隔太久
const NR = style.narrative[beats.kind] || {};
if (NR.hookWithin !== undefined) {
  const hi = phrases.findIndex((p) => p.role === 'hook');
  if (hi >= 0 && report.phrases[hi].at > NR.hookWithin) problems.push(`钩子在 ${report.phrases[hi].at}s 才出现（要求 ${NR.hookWithin}s 内）`);
  const ahas = [0, ...phrases.map((p, i) => (p.role === 'aha' ? report.phrases[i].at : null)).filter((x) => x !== null)];
  for (let i = 1; i < ahas.length; i++) if (ahas[i] - ahas[i - 1] > NR.maxAhaGap) problems.push(`${r2(ahas[i - 1])}s 到 ${r2(ahas[i])}s 之间 ${r2(ahas[i] - ahas[i - 1])}s 没有顿悟点（上限 ${NR.maxAhaGap}s）`);
}

// 字幕：说完后若这句的画面还在画，字幕停留到画完（不晚于下一句字幕出现），避免画面和字幕脱节
const subtitles = phrases.map((p, i) => {
  const t0 = audioClips[i].at, spoken = t0 + (p.srcEnd - p.cutIn) + 0.35;
  const hold = style.subtitle.holdWhileDrawing ? report.phrases[i].drawEnd + 0.3 : spoken;
  const nextT0 = i + 1 < phrases.length ? audioClips[i + 1].at - 0.05 : Infinity;
  return { text: p.caption || p.text, lines: breakLines(p.caption || p.text, TGT.sub.size, TGT.sub.width), t0, t1: r2(Math.min(nextT0, Math.max(spoken, hold))) };
});

// narration：每个画幅插的停顿不同，拼好的旁白也各存一份
const out = {
  id: OUT_ID, target: targetName, canvas: { w: TGT.w, h: TGT.h, fps: FPS }, fps: FPS, durationInFrames: Math.ceil(end * FPS), duration: r2(end),
  narration: `audio/${OUT_ID}.narration.wav`, source: beats.narration.audio, beatsId: beats.id, audioClips, strokes, penTrack, effects, camera, view: { cx: VIEW.cx, cy: VIEW.cy }, frame: TGT.frame, sub: TGT.sub,
  subtitles, style: styleSubset(style),
  platforms: TGT.platforms, platformUI: Object.fromEntries(TGT.platforms.map((pf) => [pf, style.platformUI[pf]])),
  report: { ...report, problems, fixes },
};
// ---------- 可见水印：品牌名小字，每 every 秒换到下一个候选位置（风格规范 watermark.slots），换位时淡出淡入 ----------
// 这段时间里会压到字幕、平台界面或已开始画的内容的位置就跳过；整段都找不到，就对半拆开再找（最多两次），还找不到这一小段就不加，记进自动修正。
// 文字取自本机 brand.local.json（不进仓库），没有这个文件就不加水印
{
  const WM = style.watermark, slots = WM?.slots?.[targetName];
  const brand = fs.existsSync('brand.local.json') ? JSON.parse(fs.readFileSync('brand.local.json', 'utf8')) : null;
  if (brand?.watermark?.text && slots?.length) {
    const { cameraAt, subtitleBox, watermarkBox, boxesOverlap, strokeScreenBox } = await import('../src/timeline.ts');
    const wm = { text: brand.watermark.text, size: WM.size[targetName], opacity: WM.opacity, fade: WM.fade, margin: WM.margin, spans: [] };
    // 和安全区检查同样每 0.1 秒看一次，框再多留 4px，保证检查一定过
    const clashes = (slot, t0, t1) => {
      const box = watermarkBox(wm, slot, WM.margin + 4);
      if (UI_ZONES.some((z) => boxesOverlap(box, z))) return true;
      if (subtitles.some((s) => s.t0 < t1 && s.t1 > t0 && boxesOverlap(box, subtitleBox(out, s.lines)))) return true;
      for (let i = 0; t0 + i * 0.1 <= t1 + 1e-6; i++) {
        const t = t0 + i * 0.1, c = cameraAt(camera, t);
        if (strokes.some((s) => s.t0 <= t && boxesOverlap(box, strokeScreenBox(out, s, c)))) return true;
      }
      return false;
    };
    let k = 0; // 轮换到第几个候选位置
    const place = (t0, t1, depth) => {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[(k + i) % slots.length];
        if (!clashes(slot, t0, t1)) return void wm.spans.push({ t0: r2(t0), t1: r2(t1), ...slot });
      }
      if (depth < 2) { const m = (t0 + t1) / 2; place(t0, m, depth + 1); place(m, t1, depth + 1); return; }
      const msg = `水印：${r2(t0)}–${r2(t1)}s 每个候选位置都会压到字幕、平台界面或内容，这一段不加`;
      fixes.push(msg), console.log(`  ${msg}`);
    };
    for (let t = 0; t < end - 1e-6; t += WM.every, k++) place(t, Math.min(end, t + WM.every), 0);
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
  const STEP = P.turnPerFrame, K = Math.round((P.maxAngle - P.minAngle) / STEP) + 1, ang = (k) => P.minAngle + k * STEP;
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
  const cost = (f, k) => (feasible(f, k) ? 0 : 1000) + Math.abs(ang(k) - a0s[f]);
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
console.log(problems.length ? `问题 ${problems.length} 项：\n  ` + problems.join('\n  ') : '自检：无同时落笔、无出镜头、无严重落后、文字跟住旁白、版面无压线且字号达标');
if (problems.length) process.exitCode = 1;
