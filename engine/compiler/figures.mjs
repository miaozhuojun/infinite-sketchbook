// 讲义插图：把时间线里每一节画完那一刻的纸面导成矢量图（SVG），给讲义、印刷用（用户 2026-11-09：每集出一份讲义 PDF，每节一张整页大图，日后出书）。
// 不经过渲染：笔迹直接取时间线里的几何（和成片同一套：楷体字形用 kai 轮廓，其余笔画按 perfect-freehand 和成片一样的参数生成轮廓），
// 所以放多大都清楚。纸色和方格照风格规范；铅笔、字幕、水印、镜头都不要。
// 每一节一张：取这一节画的笔画的范围（四周留白 pad），把到这一节结束时已画在这个范围里的笔画都画上（这一节接着上一节那块纸画时，前面画的也在）；
// 光晕按那一刻亮着的画。另出一张全集纸面 all.svg。
// 用法：node compiler/figures.mjs build/<id>-<画幅>.timeline.json --out <目录> [--pad 80]
import fs from 'node:fs';
import path from 'node:path';
import { getStroke } from 'perfect-freehand';

const args = process.argv.slice(2);
const tlPath = args[0], opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
if (!tlPath) { console.error('用法：node compiler/figures.mjs <timeline.json> --out <目录> [--pad 80]'); process.exit(2); }
const tl = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
const outDir = opt('--out', path.join('out', `${tl.beatsId ?? tl.id}-figures`)), PAD = Number(opt('--pad', 80));
fs.mkdirSync(outDir, { recursive: true });
const st = tl.style;

const avg = (a, b) => (a + b) / 2, f2 = (v) => v.toFixed(2);
function outlinePath(pts) { // 和 src/Sketch.tsx 的 outlinePath 一样
  if (pts.length < 4) return '';
  let d = `M${f2(pts[0][0])},${f2(pts[0][1])} Q${f2(pts[1][0])},${f2(pts[1][1])} ${f2(avg(pts[1][0], pts[2][0]))},${f2(avg(pts[1][1], pts[2][1]))} T`;
  for (let i = 2; i < pts.length - 1; i++) d += `${f2(avg(pts[i][0], pts[i + 1][0]))},${f2(avg(pts[i][1], pts[i + 1][1]))} `;
  return d + 'Z';
}
const inkPath = (s) => s.kind === 'glyph' && s.kai
  ? `<g transform="${s.kai.gt}"><path d="${s.kai.outline}"/></g>`
  : `<path d="${outlinePath(getStroke(s.pts, { size: s.width * st.ink.freehand.sizeScale, thinning: st.ink.freehand.thinning, smoothing: st.ink.freehand.smoothing, streamline: 0, simulatePressure: false, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 }, last: true }))}"/>`;

// 每一笔的范围：用采样点（pts）加半个笔宽；楷体字形的 pts 也是它的中线，够用
const box = (s) => {
  const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]), w = s.width;
  return { x0: Math.min(...xs) - w, y0: Math.min(...ys) - w, x1: Math.max(...xs) + w, y1: Math.max(...ys) + w };
};
const union = (bs) => bs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const strokes = tl.strokes.filter((s) => s.pts?.length).map((s) => ({ ...s, box: box(s) }));

function svg(b, tEnd, title) {
  const x = b.x0 - PAD, y = b.y0 - PAD, w = b.x1 - b.x0 + 2 * PAD, h = b.y1 - b.y0 + 2 * PAD, g = st.paper.gridSize;
  const shown = strokes.filter((s) => s.t1 <= tEnd + 1e-6 && hit(s.box, { x0: x, y0: y, x1: x + w, y1: y + h }));
  const fx = (tl.effects ?? []).filter((e) => e.t1 <= tEnd + 1e-6 && (e.t2 === undefined || e.t2 > tEnd));
  // 同一种墨色的笔画合成一层再整体上透明度（和成片一样，交叉处不叠黑）；墨色在最下
  const layers = new Map([[st.palette.ink, []]]);
  for (const s of shown) { if (!layers.has(s.color)) layers.set(s.color, []); layers.get(s.color).push(s); }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)}" width="${Math.round(w)}" height="${Math.round(h)}">
<title>${title.replace(/[<&]/g, '')}</title>
<defs>
<pattern id="grid" width="${g}" height="${g}" patternUnits="userSpaceOnUse" x="10" y="18"><path d="M${g} 0H0V${g}" fill="none" stroke="${st.palette.grid}" stroke-width="1.1" opacity="${st.paper.gridOpacity}"/></pattern>
${fx.map((e) => `<radialGradient id="g-${e.id}"><stop offset="0" stop-color="${e.color}" stop-opacity="0.7"/><stop offset="0.5" stop-color="${e.color}" stop-opacity="0.28"/><stop offset="1" stop-color="${e.color}" stop-opacity="0"/></radialGradient>`).join('\n')}
</defs>
<rect x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" fill="${st.palette.paper}"/>
<rect x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" fill="url(#grid)"/>
${fx.map((e) => `<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}" fill="url(#g-${e.id})"/>` + (e.rays ?? []).map((deg) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r), a = e.r * 0.5, bb = e.r * 0.75;
    return `<line x1="${f2(e.cx + a * c)}" y1="${f2(e.cy + a * sn)}" x2="${f2(e.cx + bb * c)}" y2="${f2(e.cy + bb * sn)}" stroke="${e.color}" stroke-width="${f2(e.r * 0.07)}" stroke-linecap="round" opacity="0.9"/>`;
  }).join('')).join('\n')}
${[...layers].filter(([, l]) => l.length).map(([color, l]) => `<g fill="${color}" opacity="${st.ink.opacity}">\n${l.map(inkPath).join('\n')}\n</g>`).join('\n')}
</svg>\n`;
}

const chapters = tl.chapters?.length ? tl.chapters : [{ title: tl.id, t: 0 }];
const index = [];
chapters.forEach((c, i) => {
  const tEnd = chapters[i + 1]?.t ?? tl.duration;
  const mine = strokes.filter((s) => s.t1 > c.t && s.t1 <= tEnd + 1e-6);
  if (!mine.length) return;
  const file = `${String(i + 1).padStart(2, '0')}.svg`;
  // 范围再放一圈：这一节的范围切到了前面画的东西（比如上一节写的标签），就把它整段框进来，不切半截
  const b0 = union(mine.map((s) => s.box)), b = union([b0, ...strokes.filter((s) => s.t1 <= tEnd + 1e-6 && hit(s.box, { x0: b0.x0 - PAD, y0: b0.y0 - PAD, x1: b0.x1 + PAD, y1: b0.y1 + PAD })).map((s) => s.box)]);
  fs.writeFileSync(path.join(outDir, file), svg(b, tEnd, c.title));
  index.push({ n: i + 1, title: c.title, file, t0: c.t, t1: tEnd });
});
fs.writeFileSync(path.join(outDir, 'all.svg'), svg(union(strokes.map((s) => s.box)), tl.duration, tl.id));
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ timeline: path.basename(tlPath), figures: index, all: 'all.svg' }, null, 1));
console.log(`讲义插图：${index.length} 节 + 全集纸面 → ${outDir}`);
