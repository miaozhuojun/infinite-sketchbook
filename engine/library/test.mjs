// 组件库测试（新组件入库前必须通过）+ 效果预览。
// 每个组件用 meta.example：说明齐全、示例参数合规、画两次逐字节一致、笔画路径合法且有长度、坐标都是有限数、不超出声明范围。
// 预览：所有组件用成片同一个渲染器画在一张图上（build/library-preview.timeline.json → out/library/preview.png），供审美把关。
// 用法：node library/test.mjs [--preview]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { svgPathProperties } from 'svg-path-properties';
import { loadLibrary } from './index.mjs';
import { makeKit, samplePts, CJK, glyphData } from './kit.mjs';
import { loadStyle, checkType, styleSubset } from '../compiler/validate.mjs';

const style = loadStyle();
const lib = await loadLibrary();
const fails = [];
const F = (name, msg) => fails.push(`${name}：${msg}`);
const X_KEYS = ['cx', 'x', 'x0', 'x1'], Y_KEYS = ['cy', 'y', 'top', 'base'];
const shift = (ex, dx, dy) => {
  const o = structuredClone(ex);
  for (const k of X_KEYS) if (typeof o[k] === 'number') o[k] += dx;
  for (const k of Y_KEYS) if (typeof o[k] === 'number') o[k] += dy;
  for (const k of ['from', 'to']) if (Array.isArray(o[k])) o[k] = [o[k][0] + dx, o[k][1] + dy];
  if (Array.isArray(o.span)) o.span = o.span.map((v) => v + dx); // 量表的门槛线左右端（x）
  if (Array.isArray(o.points)) o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  return o;
};

const previewStrokes = [];
let cell = 0;
for (const [name, c] of lib) {
  const m = c.meta;
  for (const k of ['title', 'desc', 'params', 'example']) if (!m[k]) F(name, `meta 缺少 ${k}`);
  if (!m.example) continue;
  for (const [k, spec] of Object.entries(m.params)) {
    if (m.example[k] === undefined) { if (spec.required) F(name, `示例缺少必填参数 ${k}`); continue; }
    const msg = checkType(spec, m.example[k], style, { drawnBefore: new Set() });
    if (msg) F(name, `示例参数 ${k}：${msg}`);
  }
  const a = { id: `test-${name}`, type: name, ...m.example };
  let s1, s2;
  try { s1 = c.draw(structuredClone(a), makeKit(a, style, lib)); s2 = c.draw(structuredClone(a), makeKit(a, style, lib)); }
  catch (e) { F(name, `画图出错：${e.message}`); continue; }
  if (!Array.isArray(s1) || !s1.length) { F(name, '没有画出任何笔画'); continue; }
  if (JSON.stringify(s1) !== JSON.stringify(s2)) F(name, '同样参数画两次结果不同（不确定性）');
  const ext = m.extent?.(m.example);
  s1.forEach((s, i) => {
    if (!['shape', 'line', 'glyph'].includes(s.kind)) F(name, `第 ${i} 笔 kind=${s.kind} 不合法`);
    if (!/^#[0-9a-f]{6}$/i.test(s.color) || !Object.values(style.palette).includes(s.color)) F(name, `第 ${i} 笔颜色 ${s.color} 不在风格规范里`);
    if (!(s.width > 0 && Number.isFinite(s.width))) F(name, `第 ${i} 笔线宽 ${s.width} 不合法`);
    let pr;
    try { pr = new svgPathProperties(s.d); } catch { F(name, `第 ${i} 笔路径无法解析`); return; }
    const L = pr.getTotalLength();
    if (!(L > 1)) F(name, `第 ${i} 笔长度 ${L}，太短或为空`);
    for (let q = 0; q <= 10; q++) {
      const p = pr.getPointAtLength((L * q) / 10);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { F(name, `第 ${i} 笔有非有限坐标`); break; }
      if (ext && (p.x < ext[0] || p.y < ext[1] || p.x > ext[2] || p.y > ext[3])) { F(name, `第 ${i} 笔超出声明范围 (${p.x.toFixed(1)},${p.y.toFixed(1)})`); break; }
    }
  });
  // 文字类：同一段文字里相邻字形的墨迹（含笔宽）之间要有看得见的空隙，≥ 0.03 个字号
  // （审片发现下标 1 被后面的 × 压住；统一笔宽后 w₁=4 的下标 1 和 = 贴在一起读成 WF=4）。示例和 meta.cases 都查
  if (s1.some((s) => s.gi !== undefined)) {
    for (const ex of [m.example, ...(m.cases || [])]) {
      const ca = { id: `test-${name}`, type: name, ...ex };
      let st;
      try { st = c.draw(structuredClone(ca), makeKit(ca, style, lib)); } catch (e) { F(name, `「${ex.text}」画图出错：${e.message}`); continue; }
      const box = new Map();
      for (const s of st) {
        const pr = new svgPathProperties(s.d), L = pr.getTotalLength(), b = box.get(s.gi) ?? [Infinity, Infinity, -Infinity, -Infinity];
        for (let q = 0; q <= 24; q++) { const p = pr.getPointAtLength((L * q) / 24); b[0] = Math.min(b[0], p.x - s.width / 2); b[1] = Math.min(b[1], p.y - s.width / 2); b[2] = Math.max(b[2], p.x + s.width / 2); b[3] = Math.max(b[3], p.y + s.width / 2); }
        box.set(s.gi, b);
      }
      const gis = [...box.keys()].sort((x, y) => x - y), subs = new Set(st.filter((s) => s.sub).map((s) => s.gi));
      for (let i = 1; i < gis.length; i++) {
        const A = box.get(gis[i - 1]), B = box.get(gis[i]);
        // 下标后面的字形要多留：下标低、后面的运算符高，看着像顶上去（审片：w₁= 读起来像 WF=）
        const need = (subs.has(gis[i - 1]) ? 0.1 : 0.03) * ex.size;
        const gap = B[0] - A[2], oy = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
        if ((oy > 0 || subs.has(gis[i - 1])) && gap < need) F(name, `「${ex.text}」(${ex.size}) 第 ${gis[i - 1]} 和第 ${gis[i]} 个字形墨迹间隙 ${gap.toFixed(1)}px（要求 ≥${need.toFixed(1)}px）`);
      }
    }
  }
  // 一支笔：同一个组件画出来的每一笔线宽都一样（审片 v9：带权连线描三遍，看起来是粗、中、细三根）
  // 图形笔画之间、文字笔画之间各自同一线宽；风格写了 ink.textWidthBySize 时小字下笔轻一点，文字可以比图形细（审片 E02 v5）
  for (const group of [s1.filter((s) => s.kind === 'shape'), s1.filter((s) => s.kind !== 'shape')]) {
    const ws = new Set(group.map((s) => s.width)); if (ws.size > 1) F(name, `线宽不统一：${[...ws].join('、')}（一支笔，所有笔画同一线宽）`);
  }
  // 预览：4 列网格，每格 440×330，组件画在格子中上，下方写组件中文名（已经报错的组件不画，免得坏数据让整个测试崩掉、报不出错）
  if (fails.some((f) => f.startsWith(`${name}：`))) { cell++; continue; }
  const col = cell % 4, row = Math.floor(cell / 4), cx = 240 + col * 440, cy = 190 + row * 330;
  // 预览画典型用法（meta.preview，多组参数一起画）；没有就画示例。整组按实际墨迹挪进自己的格子（左右各留 20px），
  // 也离画布边 ≥40px（审片 v9：「门槛 5」伸进了左边旋钮那一格，手写文字示例贴着画布左边）
  const exs = m.preview ?? [m.example], drawAll = (dx) => exs.flatMap((ex, j) => { const pa = { id: `pv-${name}-${j}`, type: name, ...shift(ex, cx + dx, cy) }; return c.draw(structuredClone(pa), makeKit(pa, style, lib)).map((s, i) => ({ ...s, id: `${pa.id}#${i}` })); });
  const xsOf = (list) => list.flatMap((s) => { const pr = new svgPathProperties(s.d), L = pr.getTotalLength(); return Array.from({ length: 9 }, (_, q) => pr.getPointAtLength((L * q) / 8).x); });
  const xs0 = xsOf(drawAll(0)), lo = Math.max(cx - 200, 40), hi = cx + 200, w = Math.max(...xs0) - Math.min(...xs0);
  const dx = w > hi - lo ? lo + (hi - lo - w) / 2 - Math.min(...xs0) : Math.max(0, lo - Math.min(...xs0)) - Math.max(0, Math.max(...xs0) - hi);
  if (w > 440 - 40) F(name, `预览宽 ${Math.round(w)}px，超出一格（400px），示例改小一点`);
  previewStrokes.push(...drawAll(dx));
  const title = m.title.replace(/\s*Σ/, ''), strokes = Math.max(0, ...[...title].filter((c) => CJK.test(c)).map((c) => glyphData(c).medians.length));
  const need = Math.max(style.type.minCjkSize, strokes * style.type.cjkSizePerStroke); // 和分镜校验同一条规则：笔画多的字要写大
  const la = { id: `pv-label-${name}`, type: 'text', text: title, x: cx, y: cy + 128, size: style.type.scale.find((v) => v >= need) };
  lib.get('text').draw(la, makeKit(la, style, lib)).forEach((s, i) => previewStrokes.push({ ...s, id: `${la.id}#${i}` }));
  cell++;
}

console.log(fails.length ? `组件测试：${fails.length} 项失败\n  ` + fails.join('\n  ') : `组件测试：${lib.size} 个组件全部通过（${[...lib.keys()].join('、')}）`);

if (process.argv.includes('--preview') && !fails.length) {
  const rows = Math.ceil(cell / 4), W = 1920, H = Math.max(1080, rows * 330 + 60);
  // 起止时间都在第 0 帧之前 = 已经画完
  const strokes = previewStrokes.map((s) => ({ ...s, action: s.id.split('#')[0], len: 1, t0: -1, t1: -0.5, pts: samplePts(s) }));
  const tl = {
    id: 'library-preview', target: 'preview', canvas: { w: W, h: H, fps: 60 }, fps: 60, durationInFrames: 1, duration: 0.02,
    narration: '', strokes, penTrack: [{ kind: 'rest', t0: 0, t1: 1, at: [99999, 0] }], effects: [],
    camera: [{ t0: 0, t1: 0, from: { x: W / 2, y: H / 2, z: 1 }, to: { x: W / 2, y: H / 2, z: 1 } }], view: { cx: W / 2, cy: H / 2 },
    sub: { cx: W / 2, top: H, size: 40, width: W }, subtitles: [], style: styleSubset(style), platforms: [],
  };
  fs.mkdirSync('build', { recursive: true }); // 刚克隆的仓库里还没有 build/
  fs.writeFileSync('build/library-preview.timeline.json', JSON.stringify(tl));
  execFileSync('node', ['compiler/gen-compositions.mjs'], { stdio: 'inherit' });
  fs.mkdirSync('out/library', { recursive: true });
  execFileSync('npx', ['remotion', 'still', 'src/index.ts', 'library-preview', 'out/library/preview.png', '--frame=0', '--log=error'], { stdio: 'inherit' });
  console.log('组件预览：out/library/preview.png');
}
process.exit(fails.length ? 1 : 0);
