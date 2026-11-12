// 讲义插图：把时间线里每一节画完那一刻的纸面导成矢量图（SVG），给讲义、印刷用（用户 2026-11-09：每集出一份讲义 PDF，每节一张整页大图，日后出书）。
// 不经过渲染：笔迹直接取时间线里的几何，和成片同一套画法：成片用 mono（每一笔按 perfect-freehand 沿采样点生成轮廓，儿童手写的样子），
// --ink kai 改用楷体字形轮廓（和渲染器的 kai 模式一样：有 kai 数据的笔画都用它），
// 所以放多大都清楚。纸色和方格照风格规范；铅笔、字幕、水印、镜头都不要。
// 每一节一张：取这一节画的笔画的范围（四周留白 pad），把到这一节结束时已画在这个范围里的笔画都画上（这一节接着上一节那块纸画时，前面画的也在）；
// 光晕按那一刻亮着的画。另出一张全集纸面 all.svg。
// 用法：node compiler/figures.mjs build/<id>-<画幅>.timeline.json --out <目录> [--pad 80] [--ink mono|kai]
import './node_version.mjs'; // 先查 Node 版本
import fs from 'node:fs';
import path from 'node:path';
import { getStroke } from 'perfect-freehand';
const { STICKER, stickerCard, stickerOutline, stickerTapes } = await import('../src/timeline.ts'); // .ts 用 await import：Node 版本低时先看到上面那条说明

const args = process.argv.slice(2);
const tlPath = args[0], opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
if (!tlPath) { console.error('用法：node compiler/figures.mjs <timeline.json> --out <目录> [--pad 80]'); process.exit(2); }
const tl = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
const outDir = opt('--out', path.join('out', `${tl.beatsId ?? tl.id}-figures`)), PAD = Number(opt('--pad', 80)), INK = opt('--ink', 'mono');
fs.mkdirSync(outDir, { recursive: true });
const st = tl.style;

const avg = (a, b) => (a + b) / 2, f2 = (v) => v.toFixed(2);
function outlinePath(pts) { // 和 src/Sketch.tsx 的 outlinePath 一样
  if (pts.length < 4) return '';
  let d = `M${f2(pts[0][0])},${f2(pts[0][1])} Q${f2(pts[1][0])},${f2(pts[1][1])} ${f2(avg(pts[1][0], pts[2][0]))},${f2(avg(pts[1][1], pts[2][1]))} T`;
  for (let i = 2; i < pts.length - 1; i++) d += `${f2(avg(pts[i][0], pts[i + 1][0]))},${f2(avg(pts[i][1], pts[i + 1][1]))} `;
  return d + 'Z';
}
const inkPath = (s) => INK === 'kai' && s.kai
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
// 贴图的外轮廓也算进每节插图的范围（不切半截）
const stickerBoxes = (tl.stickers ?? []).map((k) => { const o = stickerOutline(k), xs = o.map((q) => q[0]), ys = o.map((q) => q[1]); return { id: k.id, t1: k.t1, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } }; });

function svg(b, tEnd, title) {
  const x = b.x0 - PAD, y = b.y0 - PAD, w = b.x1 - b.x0 + 2 * PAD, h = b.y1 - b.y0 + 2 * PAD, g = st.paper.gridSize;
  const shown = strokes.filter((s) => s.t1 <= tEnd + 1e-6 && hit(s.box, { x0: x, y0: y, x1: x + w, y1: y + h }));
  const fx = (tl.effects ?? []).filter((e) => e.t1 <= tEnd + 1e-6 && (e.t2 === undefined || e.t2 > tEnd));
  const view = { x0: x, y0: y, x1: x + w, y1: y + h };
  const sk = (tl.stickers ?? []).filter((k) => k.t1 <= tEnd + 1e-6 && hit(stickerBoxes.find((q) => q.id === k.id).box, view)); // 贴图（被依赖那一集的封面），按落定的样子画；不在这张图范围里的不嵌（一张就几百 KB）
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
${sk.map((k) => { const { W, H } = stickerCard(k), b = STICKER.border * k.w;
    const tapes = stickerTapes(k).map((p) => `<rect x="${f2(p.x - p.w / 2)}" y="${f2(p.y - p.h / 2)}" width="${f2(p.w)}" height="${f2(p.h)}" fill="${k.tape}" opacity="0.78" transform="rotate(${p.ang} ${f2(p.x)} ${f2(p.y)})"/>`).join('');
    return `<g transform="translate(${f2(k.cx)} ${f2(k.cy)}) rotate(${k.tilt})"><rect x="${f2(-W / 2)}" y="${f2(-H / 2)}" width="${f2(W)}" height="${f2(H)}" rx="3" fill="${k.card}"/><image href="${k.href}" x="${f2(-W / 2 + b)}" y="${f2(-H / 2 + b)}" width="${f2(k.w)}" height="${f2(k.h)}" preserveAspectRatio="xMidYMid slice"/>${tapes}</g>`;
  }).join('\n')}
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
  const glow = (tl.effects ?? []).filter((e) => e.t1 <= tEnd + 1e-6 && (e.t2 === undefined || e.t2 > tEnd)).map((e) => ({ x0: e.cx - e.r, y0: e.cy - e.r, x1: e.cx + e.r, y1: e.cy + e.r }));
  let b = union([...mine.map((s) => s.box), ...stickerBoxes.filter((k) => k.t1 > c.t && k.t1 <= tEnd + 1e-6).map((k) => k.box)]);
  for (let k = 0; k < 10; k++) { // 一直放到不再切到任何笔画、光晕为止
    const pad = { x0: b.x0 - PAD, y0: b.y0 - PAD, x1: b.x1 + PAD, y1: b.y1 + PAD };
    const nb = union([b, ...strokes.filter((s) => s.t1 <= tEnd + 1e-6 && hit(s.box, pad)).map((s) => s.box), ...glow.filter((g) => hit(g, pad)), ...stickerBoxes.filter((k) => k.t1 <= tEnd + 1e-6 && hit(k.box, pad)).map((k) => k.box)]);
    if (nb.x0 === b.x0 && nb.y0 === b.y0 && nb.x1 === b.x1 && nb.y1 === b.y1) break;
    b = nb;
  }
  fs.writeFileSync(path.join(outDir, file), svg(b, tEnd, c.title));
  index.push({ n: i + 1, title: c.title, file, t0: c.t, t1: tEnd });
});
fs.writeFileSync(path.join(outDir, 'all.svg'), svg(union([...strokes.map((s) => s.box), ...stickerBoxes.map((k) => k.box)]), tl.duration, tl.id));
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ timeline: path.basename(tlPath), figures: index, all: 'all.svg' }, null, 1));
console.log(`讲义插图：${index.length} 节 + 全集纸面 → ${outDir}`);
