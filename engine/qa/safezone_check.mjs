// 平台安全区检查（每项都能失败）：本画幅对应平台（见风格规范 targets.*.platforms）的界面遮挡区里，
//   1. 任何一段字幕都不能落进去；
//   2. 任何一笔内容（画完后，在之后每个镜头位置上）都不能落进去。铅笔是临时经过的，不算。
//      推近镜头（顿悟）只查焦点元素：推近时画面边缘的旧内容本来就会被推出画外、经过界面区域，观众此刻看的是焦点。
//   3. 镜头停稳时不切字、不留残边：每次镜头到位后，这一镜里看得到的
//      文字要么整段在取景框 frame 里（字幕衬底上方、不压平台界面），要么整段在画布外（审片：推近后左边缘只剩「4」、算式只剩「0 =7」）；
//      图形可以被画布边缘裁掉，但不能停在取景框外的边距里，也不能越过取景框下沿压向字幕
//      （审片 v9：推近把标题推出画、下划线还挂在顶边；灯泡越过取景框下沿、坐在字幕板上）。
//   4. 镜头停稳时内容不进字幕区：任何画出来的元素都不能有一部分落在字幕上沿到画布底那一条里（压在字幕衬底底下只露一半，像污渍）
//   5. 推近时焦点在画面中部：顿悟推近停稳时，焦点中心离取景框中心不超过 aha.maxOffCenter（占取景框宽、高的比例）
//      （理解度截帧：推近「灯就亮」时量表和灯挤在画面顶上，下面三分之二是空纸）
//   6. 水印避开字幕、平台界面和内容：每一段水印显示期间（每 0.1 秒看一次），离平台界面、正在显示的字幕至少 margin 像素，离已开始画的内容至少 contentMargin 像素
//   7. 水印换位避开顿悟句：水印淡出、换位、淡入的时刻不落在顿悟句里（从开口到说完再停 aha.holdAfter 秒，前后各留 fade 秒）（审片 v9：60 秒那次换位正好撞上灯灭）
// 用法：node qa/safezone_check.mjs build/<id>.timeline.json
import fs from 'node:fs';
import { svgPathProperties } from 'svg-path-properties';
import { cameraAt, subtitleBox, watermarkBox, boxesOverlap, strokeScreenBox } from '../src/timeline.ts';

const tl = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fails = [];
const check = (name, ok, detail) => { console.log(`[${ok ? '通过' : '失败'}] ${name}：${detail}`); if (!ok) fails.push(name); };
const zones = Object.entries(tl.platformUI || {}).flatMap(([pf, zs]) => (zs || []).map((z) => ({ ...z, pf })));
const inZone = (x, y) => zones.find((z) => x > z.l && x < z.r && y > z.t && y < z.b);

const subHits = [];
for (const s of tl.subtitles) {
  const box = subtitleBox(tl, s.lines); // 含字幕衬底
  for (const z of zones) if (box.l < z.r && box.r > z.l && box.t < z.b && box.b > z.t) subHits.push(`「${s.text}」压进 ${z.pf} 的${z.name}`);
}
check('字幕避开平台界面', !subHits.length, subHits.length ? subHits.slice(0, 5).join('；') : `${tl.subtitles.length} 段字幕都不在 ${[...new Set(zones.map((z) => z.pf))].join('、') || '（无平台）'} 的遮挡区里`);

const camEnds = [...new Set([...tl.camera.map((m) => m.t1), tl.duration - 0.01])].sort((a, b) => a - b);
const focusAt = (t) => { let f = null; for (const m of tl.camera) if (m.t1 <= t + 1e-6) f = m.focus ?? null; return f; }; // 已到位的镜头是不是推近镜头
const contentHits = [];
for (const s of tl.strokes) {
  const pr = new svgPathProperties(s.d), L = pr.getTotalLength();
  const times = [s.t1, ...camEnds.filter((t) => t > s.t1)];
  for (const t of times) {
    const f = t === s.t1 ? null : focusAt(t);
    if (f && !f.includes(s.action)) continue;
    const c = cameraAt(tl.camera, t);
    let hit = null;
    for (let k = 0; k <= 10 && !hit; k++) {
      const q = pr.getPointAtLength((L * k) / 10);
      const z = inZone((q.x - c.x) * c.z + tl.view.cx, (q.y - c.y) * c.z + tl.view.cy);
      if (z) hit = z;
    }
    if (hit) { contentHits.push(`${s.id} 在 ${t.toFixed(2)}s 落进 ${hit.pf} 的${hit.name}`); break; }
  }
}
// 每个元素已画部分的包围盒（第 3、4 项共用）
const allBox = new Map();
for (const s of tl.strokes) {
  const pr = new svgPathProperties(s.d), L = pr.getTotalLength(), b = allBox.get(s.action) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, t0: Infinity };
  for (let k = 0; k <= 8; k++) { const q = pr.getPointAtLength((L * k) / 8); b.x0 = Math.min(b.x0, q.x); b.y0 = Math.min(b.y0, q.y); b.x1 = Math.max(b.x1, q.x); b.y1 = Math.max(b.y1, q.y); }
  b.t0 = Math.min(b.t0, s.t0);
  allBox.set(s.action, b);
}
const textIds = new Set(tl.strokes.filter((s) => s.kind === 'glyph' || s.kind === 'line').map((s) => s.action));
const bleedIds = new Set(tl.strokes.filter((s) => s.bleed).map((s) => s.action)); // 分镜声明可以被画布边缘裁掉的图形（横贯画面的路线箭头）
// 3. 元素不被切断：在每个镜头到位时刻看每个元素的屏幕范围，取景框 frame 内（没有 frame 的旧时间线按画布算）
const cuts = [], FR = tl.frame ?? { l: 0, r: tl.canvas.w, t: 0, b: tl.canvas.h };
tl.camera.forEach((m, i) => {
  const until = tl.camera[i + 1]?.t0 ?? tl.duration, c = m.to, W = tl.canvas.w, H = tl.canvas.h;
  for (const [id, b] of allBox) {
    if (b.t0 >= until) continue; // 这一镜结束前还没开始画
    const x0 = (b.x0 - c.x) * c.z + tl.view.cx, x1 = (b.x1 - c.x) * c.z + tl.view.cx, y0 = (b.y0 - c.y) * c.z + tl.view.cy, y1 = (b.y1 - c.y) * c.z + tl.view.cy;
    const subTop = tl.subtitles.length ? tl.sub.top - (tl.style?.subtitle?.plate?.padY ?? 0) : H; // 字幕衬底也算画面边
    const underUI = zones.some((z) => x1 > z.l && x0 < z.r && y1 > z.t && y0 < z.b); // 平台界面也算画面边
    const B = Math.min(FR.b, subTop), outside = x1 <= 0 || x0 >= W || y1 <= 0 || y0 >= H;
    if (outside) continue;
    // 文字和图形都要整段在取景框里或整段出画（审片 E01 v1：推近后箭头半截、灯泡半个、框角挂在边上）；
    // 分镜写了 bleed 的图形可以被画布边缘裁掉，但不能停在边距里、越过取景框下沿
    const inFrame = x0 >= FR.l && x1 <= FR.r && y0 >= FR.t && y1 <= B;
    const bad = textIds.has(id) ? !inFrame || underUI
      : !bleedIds.has(id) ? !inFrame
      : y1 > B || (x0 < FR.l && x0 > 0) || (x1 > FR.r && x1 < W) || (y0 < FR.t && y0 > 0);
    if (bad) cuts.push(`${id} 在 ${m.t1.toFixed(2)}s ${textIds.has(id) ? '是文字，没有整段在取景框里' : bleedIds.has(id) ? '停在取景框外的边距里或越过了取景框下沿' : '是图形，没有整段在取景框里'}（屏幕 ${x0.toFixed(0)}–${x1.toFixed(0)} × ${y0.toFixed(0)}–${y1.toFixed(0)}，取景框 ${FR.l}–${FR.r} × ${FR.t}–${FR.b}），也没有整段出画`);
  }
});
// 4. 镜头停稳时内容不进字幕区：任何已画的元素都不能有一部分落在字幕衬底那一条（字幕上沿到画布底）里
const inSub = [];
if (tl.subtitles.length) tl.camera.forEach((m, i) => {
  const until = tl.camera[i + 1]?.t0 ?? tl.duration, c = m.to, subTop = tl.sub.top - (tl.style?.subtitle?.plate?.padY ?? 0);
  for (const [id, b] of allBox) {
    if (b.t0 >= until) continue;
    const x0 = (b.x0 - c.x) * c.z + tl.view.cx, x1 = (b.x1 - c.x) * c.z + tl.view.cx, y0 = (b.y0 - c.y) * c.z + tl.view.cy, y1 = (b.y1 - c.y) * c.z + tl.view.cy;
    if (x1 > 0 && x0 < tl.canvas.w && y1 > subTop && y0 < tl.canvas.h) inSub.push(`${id} 在 ${m.t1.toFixed(2)}s 有一部分落进字幕区（屏幕 y ${y0.toFixed(0)}–${y1.toFixed(0)}，字幕上沿 ${subTop.toFixed(0)}）`);
  }
});
// 5. 推近时焦点在画面中部（焦点范围和编译器一致：焦点元素的全部笔画）
const offC = [], maxOff = tl.style?.motion?.aha?.maxOffCenter, fr = tl.frame;
if (maxOff !== undefined && fr) for (const m of tl.camera) {
  if (!m.focus || !((m.to.push ?? 1) > 1.001)) continue;
  const pts = tl.strokes.filter((s) => m.focus.includes(s.action)).flatMap((s) => s.pts);
  if (!pts.length) continue;
  const fx = (Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[0]))) / 2, fy = (Math.min(...pts.map((q) => q[1])) + Math.max(...pts.map((q) => q[1]))) / 2;
  const dx = ((fx - m.to.x) * m.to.z) / (fr.r - fr.l), dy = ((fy - m.to.y) * m.to.z) / (fr.b - fr.t);
  if (Math.abs(dx) > maxOff + 1e-3 || Math.abs(dy) > maxOff + 1e-3) offC.push(`${m.t1.toFixed(2)}s 推近 ${(m.to.push ?? 1).toFixed(2)} 倍，焦点中心偏离取景框中心 横 ${(dx * 100).toFixed(0)}%、竖 ${(dy * 100).toFixed(0)}%（上限 ${(maxOff * 100).toFixed(0)}%）`);
}
// 6. 水印（只有配置了品牌的时间线才有）
const wm = tl.watermark, wmHits = [];
for (const sp of wm?.spans ?? []) {
  const box = watermarkBox(wm, sp, wm.margin), at = `${sp.t0.toFixed(1)}–${sp.t1.toFixed(1)}s 的水印`;
  const z = zones.find((q) => boxesOverlap(box, q));
  if (z) { wmHits.push(`${at}压到 ${z.pf} 的${z.name}`); continue; }
  const s = tl.subtitles.find((x) => x.t0 < sp.t1 && x.t1 > sp.t0 && boxesOverlap(box, subtitleBox(tl, x.lines)));
  if (s) { wmHits.push(`${at}压到字幕「${s.text}」`); continue; }
  const far = watermarkBox(wm, sp, wm.contentMargin ?? wm.margin); // 离内容要更远，免得像谁的标注（审片 v10：水印贴在灯泡正下方，像灯泡的标签）
  for (let i = 0; sp.t0 + i * 0.1 <= sp.t1 + 1e-6; i++) {
    const t = sp.t0 + i * 0.1, c = cameraAt(tl.camera, t), hit = tl.strokes.find((x) => x.t0 <= t && boxesOverlap(far, strokeScreenBox(tl, x, c)));
    if (hit) { wmHits.push(`${at}在 ${t.toFixed(2)}s 压到 ${hit.id}`); break; }
  }
}
check('水印避开字幕、平台界面和内容', !wmHits.length, wmHits.length ? wmHits.slice(0, 5).join('；') : wm ? `「${wm.text}」${wm.spans.length} 段，都离字幕、平台界面 ${wm.margin}px、离内容 ${wm.contentMargin ?? wm.margin}px 以上` : '没有水印（本机没有配置 brand.local.json），未查');
// 7. 水印换位避开顿悟句
const hold = tl.style?.motion?.aha?.holdAfter ?? 0, swapHits = [];
for (const sp of wm?.spans ?? []) for (const t of [sp.t0, sp.t1].filter((x) => x > 0.01 && x < tl.duration - 0.01)) {
  const p = (tl.report?.phrases ?? []).find((q) => q.role === 'aha' && t > q.at - wm.fade && t < q.audioEnd + hold + wm.fade);
  if (p) swapHits.push(`${t.toFixed(1)}s 换位落在顿悟句「${p.text}」里`);
}
check('水印换位避开顿悟句', !swapHits.length, swapHits.length ? [...new Set(swapHits)].slice(0, 5).join('；') : wm ? `${Math.max(0, wm.spans.length - 1)} 次换位都不在顿悟句里` : '没有水印，未查');
check('推近时焦点在画面中部', !offC.length, offC.length ? offC.join('；') : maxOff === undefined || !fr ? '风格规范没有 aha.maxOffCenter 或时间线没有取景框，未查' : `${tl.camera.filter((m) => m.focus && (m.to.push ?? 1) > 1.001).length} 次推近，焦点中心都在取景框中心 ${(maxOff * 100).toFixed(0)}% 以内`);
check('镜头停稳时内容不进字幕区', !inSub.length, inSub.length ? `${inSub.length} 处：` + inSub.slice(0, 5).join('；') : `${tl.camera.length} 个镜头位置上，画出来的东西都在字幕上方`);
check('镜头停稳时不切字、不留残边', !cuts.length, cuts.length ? `${cuts.length} 处：` + cuts.slice(0, 5).join('；') : `${tl.camera.length} 个镜头位置上，文字和图形都整段在取景框里或整段在画外（声明 bleed 的图形没有停在边距里）`);
check('内容避开平台界面', !contentHits.length, contentHits.length ? `${contentHits.length} 笔：` + contentHits.slice(0, 5).join('；') : `${tl.strokes.length} 笔在所有镜头位置上都不被平台界面遮挡`);
console.log(`\n安全区检查失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
