// 铅笔观感检查（每项都能失败）：直接调用渲染用的 pencilPose，检查的就是画出来的样子。
//   1. 不晃眼：写字、停笔时笔身角度每帧变化 ≤ 0.5°，抬笔移动时 ≤ 1.0°；抬笔量每帧变化 ≤ 0.08
//   2. 不压字幕：字幕显示期间，笔身任何部分不得进入字幕框（外扩 8px）
//   3. 运笔流畅：笔尖在屏幕上每帧位移 ≤ 60px（60fps），每一笔至少 3 帧（否则像掉帧/瞬移）
//   4. 笔身不出画：笔尖在画面里时，整支铅笔都要在画布内（审片发现方版铅笔被右边缘切掉）；从画外飞入、飞出画外的那两段移动不算
//   5. 顿悟时镜头不拉远：role=aha 的句子说完后再停 aha.holdAfter 秒之前，镜头只能推近或保持（审片发现顿悟时反而拉远）
// 笔身、影子、字幕框的几何和编译器的避让共用 src/timeline.ts 里的同一份定义。
//   6. 停笔不压正在讲的东西：笔停够 0.5 秒时，笔身不压已写出的文字、刚画完的元素，推近镜头里还有焦点元素
// 用法：node qa/pencil_check.mjs build/<id>.timeline.json
import fs from 'node:fs';
import { pencilPose, cameraAt, pencilBodyPts, pencilFootprint, subtitleBox, inBox, isFlight, SUB_MARGIN } from '../src/timeline.ts';

const tl = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fails = [];
const check = (name, ok, detail) => { console.log(`[${ok ? '通过' : '失败'}] ${name}：${detail}`); if (!ok) fails.push(name); };

let prev = null, maxDA = [0, 0], maxDL = [0, 0], maxDAmove = [0, 0];
const overlaps = [];
// 写字、停笔时笔身转角每帧 ≤0.5°；抬笔在画面上移动（手在挪位置）时放宽到 ≤1.0°
const movingAt = (t) => (tl.penTrack ?? []).some((sg) => sg.kind === 'move' && t >= sg.t0 && t < sg.t1);
for (let f = 0; f < tl.durationInFrames; f++) {
  const t = f / tl.fps, p = pencilPose(tl, t);
  if (prev) {
    const da = Math.abs(p.ang - prev.ang), dl = Math.abs(p.lift - prev.lift);
    if (movingAt(t) && movingAt(t - 1 / tl.fps)) { if (da > maxDAmove[0]) maxDAmove = [da, f]; }
    else if (da > maxDA[0]) maxDA = [da, f];
    if (dl > maxDL[0]) maxDL = [dl, f];
  }
  prev = p;
  const sub = tl.subtitles.find((s) => t >= s.t0 && t < s.t1);
  if (!sub) continue;
  const box = subtitleBox(tl, sub.lines ?? [sub.text], SUB_MARGIN);
  if (pencilFootprint(tl, p).some((q) => inBox(box, q))) overlaps.push(f);
}
check('笔身不晃眼', maxDA[0] <= 0.5 && maxDAmove[0] <= 1.0 && maxDL[0] <= 0.08,
  `写字/停笔时角度每帧最大变化 ${maxDA[0].toFixed(2)}°（第 ${maxDA[1]} 帧，上限 0.5°），抬笔移动时 ${maxDAmove[0].toFixed(2)}°（第 ${maxDAmove[1]} 帧，上限 1.0°），抬笔量每帧最大变化 ${maxDL[0].toFixed(3)}（第 ${maxDL[1]} 帧，上限 0.08）`);
const spans = [];
for (const f of overlaps) { const last = spans[spans.length - 1]; if (last && f === last[1] + 1) last[1] = f; else spans.push([f, f]); }
check('笔身不压字幕', overlaps.length === 0, overlaps.length ? `${overlaps.length} 帧重叠：` + spans.slice(0, 6).map(([a, b]) => `${(a / tl.fps).toFixed(2)}–${(b / tl.fps).toFixed(2)}s`).join('、') : '字幕显示期间笔身从未进入字幕框');
let maxMove = [0, 0], over = 0, last = null;
for (let f = 0; f < tl.durationInFrames; f++) {
  const p = pencilPose(tl, f / tl.fps);
  const on = p.x > -200 && p.x < tl.canvas.w + 200 && p.y > -200 && p.y < tl.canvas.h + 200;
  if (last && on && last.on) {
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    if (d > maxMove[0]) maxMove = [d, f];
    if (d > 60 * 60 / tl.fps) over++;
  }
  last = { x: p.x, y: p.y, on };
}
const short = tl.strokes.filter((s) => (s.t1 - s.t0) * tl.fps < 2.95).map((s) => s.id);
check('运笔流畅（无瞬移）', over === 0 && !short.length,
  `${tl.fps}fps，笔尖单帧最大位移 ${maxMove[0].toFixed(0)}px（第 ${maxMove[1]} 帧，上限 ${(60 * 60 / tl.fps).toFixed(0)}），超限 ${over} 帧；不足 3 帧的笔画 ${short.length} 个${short.length ? '：' + short.slice(0, 5).join('、') : ''}`);
// 4. 笔身不出画
const outFrames = [];
const offCanvas = ([x, y]) => x < 0 || x > tl.canvas.w || y < 0 || y > tl.canvas.h;
const flights = (tl.penTrack ?? []).filter((m) => isFlight(tl, m));
for (let f = 0; f < tl.durationInFrames; f++) {
  const t = f / tl.fps, p = pencilPose(tl, t);
  if (offCanvas([p.x, p.y]) || flights.some((m) => t >= m.t0 && t <= m.t1)) continue;
  if (pencilBodyPts(tl, p).some(offCanvas)) outFrames.push(f);
}
const runs = (frames) => { const r = []; for (const f of frames) { const l = r[r.length - 1]; if (l && f === l[1] + 1) l[1] = f; else r.push([f, f]); } return r; };
check('笔身不出画', !outFrames.length, outFrames.length ? `${outFrames.length} 帧铅笔伸出画面：` + runs(outFrames).slice(0, 5).map(([a, b]) => `${(a / tl.fps).toFixed(2)}–${(b / tl.fps).toFixed(2)}s`).join('、') : '笔尖在画面里时，整支铅笔始终在画布内');

// 5. 顿悟时镜头不拉远
const phr = tl.report?.phrases ?? [];
const zoomOut = [];
phr.forEach((p, i) => {
  if (p.role !== 'aha') return;
  const t0 = p.at, t1 = Math.min(p.audioEnd + (tl.style?.motion?.aha?.holdAfter ?? 0), tl.duration);
  let prevZ = cameraAt(tl.camera, t0).z;
  for (let f = Math.ceil(t0 * tl.fps); f < t1 * tl.fps; f++) {
    const z = cameraAt(tl.camera, f / tl.fps).z;
    if (z < prevZ - 0.003) { zoomOut.push(`「${p.text}」在 ${(f / tl.fps).toFixed(2)}s 拉远（${prevZ.toFixed(3)} → ${z.toFixed(3)}）`); break; }
    prevZ = Math.max(prevZ, z);
  }
});
check('顿悟时镜头不拉远', !zoomOut.length, zoomOut.length ? zoomOut.join('；') : `${phr.filter((p) => p.role === 'aha').length} 个顿悟句（说完后再停 ${tl.style?.motion?.aha?.holdAfter ?? 0}s）期间镜头只推近或保持`);

// 6. 停笔不压正在讲的东西：凡是停够 0.5 秒（写字、笔画之间的移动、等下一个词的短停都不算），
//    笔身不能压在已经写出来的文字上、刚画完的那个元素上，推近镜头里还有焦点元素
//    （审片：笔停在刚写的「0」上 2.6 秒，正说「0 就是没有」；推近 x₁ 时铅笔横在 x₁ 上）
const { svgPathProperties } = await import('svg-path-properties');
// 按笔画算「已写出」：一个动作写到一半时笔停下，已写的那几笔也要护住（原来按整个动作画完才算，半截动作上的停笔查不到）
const grow = (b, x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
const strokeBoxes = tl.strokes.map((s) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity], pr = new svgPathProperties(s.d), L = pr.getTotalLength();
  for (let k = 0; k <= 8; k++) { const q = pr.getPointAtLength((L * k) / 8); grow(b, q.x, q.y); }
  return { b, action: s.action, t1: s.t1, text: s.kind === 'glyph' || s.kind === 'line' };
});
// t 时刻每个动作已写出部分的包围盒：{ all: 全部已写笔画, text: 其中的文字笔画 }
const drawnAt = (t) => {
  const acts = new Map();
  for (const s of strokeBoxes) {
    if (s.t1 > t) continue;
    const a = acts.get(s.action) ?? { all: [Infinity, Infinity, -Infinity, -Infinity], text: null };
    grow(a.all, s.b[0], s.b[1]); grow(a.all, s.b[2], s.b[3]);
    if (s.text) { a.text ??= [Infinity, Infinity, -Infinity, -Infinity]; grow(a.text, s.b[0], s.b[1]); grow(a.text, s.b[2], s.b[3]); }
    acts.set(s.action, a);
  }
  return acts;
};
const covered = [];
for (const rest of (tl.penTrack ?? []).filter((sg) => sg.kind === 'rest' && sg.t1 - sg.t0 >= 0.5)) {
  const lastId = tl.strokes.filter((s) => s.t1 <= rest.t0 + 1e-3).reduce((m, s) => (!m || s.t1 > m.t1 ? s : m), null)?.action;
  for (let f = Math.ceil(rest.t0 * tl.fps); f < Math.min(rest.t1, tl.duration) * tl.fps; f++) {
    const t = f / tl.fps, c = cameraAt(tl.camera, t), p = pencilPose(tl, t);
    if (p.x < 0 || p.x > tl.canvas.w || p.y < 0 || p.y > tl.canvas.h) continue; // 笔在画面外等着，不算
    const shot = tl.camera.filter((m) => m.t1 <= t + 1e-6).at(-1), focus = new Set(shot?.focus ?? []);
    const boxes = [];
    for (const [id, a] of drawnAt(t)) {
      const pick = id === lastId || focus.has(id) ? a.all : a.text;
      if (!pick) continue;
      const pad = 4 + (pick === a.text ? 0.15 * (pick[3] - pick[1]) : 0);
      boxes.push([(pick[0] - c.x) * c.z + tl.view.cx - pad, (pick[1] - c.y) * c.z + tl.view.cy - pad, (pick[2] - c.x) * c.z + tl.view.cx + pad, (pick[3] - c.y) * c.z + tl.view.cy + pad]);
    }
    // 笔尖那段削尖的锥（前 20%）只是碰着刚写完的地方，不算压住；要查的是笔身挡没挡住内容
    const r = (p.ang * Math.PI) / 180, near = 0.2 * (tl.style?.pencil?.length ?? 276) * p.sc;
    const body = pencilBodyPts(tl, p).filter(([x, y]) => (x - p.x) * Math.cos(r) + (y - p.y) * Math.sin(r) >= near);
    if (body.some(([x, y]) => boxes.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]))) covered.push(f);
  }
}
check('停笔不压正在讲的东西', !covered.length, covered.length ? `${covered.length} 帧笔停着、笔身压在文字、刚画完的元素或推近焦点上：` + runs(covered).slice(0, 5).map(([a, b]) => `${(a / tl.fps).toFixed(2)}–${(b / tl.fps).toFixed(2)}s`).join('、') : '笔停够 0.5 秒时，从不压文字、刚画完的元素和推近焦点');

console.log(`\n铅笔检查失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
