// 组件共用的工具：确定性随机、手绘抖动、平滑路径、字形数据。组件只能通过 makeKit 拿到颜色和线宽（来自风格规范）。
import { createRequire } from 'node:module';
import { svgPathProperties } from 'svg-path-properties';

const require = createRequire(import.meta.url);
export const hershey = require('hersheytext');
export const glyphData = (ch) => require(`hanzi-writer-data/${ch}.json`);
export const CJK = /[㐀-鿿]/;

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; }
export const r2 = (n) => Math.round(n * 100) / 100;
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Catmull-Rom → 三次贝塞尔，得到顺滑的手写曲线
export function smoothPath(pts) {
  if (pts.length < 3) return 'M' + pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join(' L');
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return d;
}
export const polyPath = (pts) => 'M' + pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join(' L');

// 沿折线插值加密，再加低频抖动，模拟手的不稳定
export function wobble(pts, amp, rnd, step = 18) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(pts[pts.length - 1]);
  const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
  return out.map((p, i) => {
    const t = i / Math.max(1, out.length - 1);
    const e = Math.sin(Math.PI * t); // 两端贴住，中间抖
    return [p[0] + amp * e * Math.sin(ph1 + t * 5.1), p[1] + amp * e * Math.sin(ph2 + t * 4.3)];
  });
}

// 每个动作一套工具：随机种子由动作 id 决定（同一分镜重复编译结果逐字节一致），颜色和线宽来自风格规范。
// 线宽默认是"一支笔"的笔宽 style.ink.penWidth；组件内需要写字时用 k.text(...)（同一个文字组件，同一支笔）
export function makeKit(a, style, library) {
  const rnd = mulberry32(hashStr(a.id));
  const color = style.palette[a.color || 'ink'];
  const width = a.width ?? style.ink.penWidth;
  const S = (pts, smooth = true) => ({ kind: 'shape', color, width, d: smooth ? smoothPath(pts) : polyPath(pts) });
  let n = 0;
  const text = (p) => {
    if (!library) throw new Error('组件内写字需要把组件库传给 makeKit');
    const ta = { ...p, id: `${a.id}~t${n++}`, type: 'text', color: p.color ?? a.color };
    return library.get('text').draw(ta, makeKit(ta, style, library));
  };
  return { rnd, color, width, S, text, style, smoothPath, polyPath, wobble, r2, dist, hershey, glyphData, CJK };
}

// 沿法线把路径整体平移 delta 像素（回描、带权连线的多遍描线都用它：同一支笔多描几遍，而不是换粗笔）
export function offsetPath(d, delta) {
  const pr = new svgPathProperties(d), L = pr.getTotalLength(), n = Math.max(4, Math.ceil(L / 4));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = (L * i) / n, p = pr.getPointAtLength(u);
    const a = pr.getPointAtLength(Math.max(0, u - 2)), b = pr.getPointAtLength(Math.min(L, u + 2));
    const tx = b.x - a.x, ty = b.y - a.y, m = Math.hypot(tx, ty) || 1;
    pts.push([p.x - (ty / m) * delta, p.y + (tx / m) * delta]);
  }
  return smoothPath(pts);
}

// 压力采样：渲染端用 perfect-freehand 生成变宽笔迹，笔尖位置也取自同一组点（编译器与组件预览共用）
const smooth01 = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
export function samplePts(s) {
  const pr = new svgPathProperties(s.d), L = pr.getTotalLength(), n = Math.max(2, Math.ceil(L / 2.5));
  const rnd = mulberry32(hashStr(s.id));
  const ph = rnd() * 6.28;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, q = pr.getPointAtLength(L * u);
    const pressure = 0.42 + 0.5 * smooth01(0, 0.16, u) - 0.22 * smooth01(0.82, 1, u) + 0.05 * Math.sin(ph + u * 9);
    pts.push([r2(q.x), r2(q.y), Math.round(pressure * 100) / 100]);
  }
  return pts;
}
