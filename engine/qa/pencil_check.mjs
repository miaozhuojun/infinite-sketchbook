// 铅笔观感检查（每项都能失败）：直接调用渲染用的 pencilPose，检查的就是画出来的样子。
//   1. 不晃眼：写字、停笔时笔身角度每 1/60 秒变化 ≤ 0.5°，抬笔移动时 ≤ 1.0°；抬笔量每 1/60 秒变化 ≤ 0.08（按秒算：30 帧/秒时每帧上限翻倍，同样快的动作判定一样）
//   2. 不压字幕：字幕显示期间，笔身任何部分不得进入字幕框（外扩 8px）
//   3. 运笔流畅：笔尖在屏幕上每 1/60 秒位移 ≤ 60px，每一笔至少写 3/60 秒（否则像掉帧/瞬移）
//   4. 笔身不出画：笔尖在画面里时，整支铅笔都要在画布内（审片发现方版铅笔被右边缘切掉）；从画外飞入、飞出画外的那两段移动不算
//   5. 顿悟时镜头不拉远：role=aha 的句子说完后再停 aha.holdAfter 秒之前，镜头只能推近或保持（审片发现顿悟时反而拉远）
//   5b. 镜头不甩：每次镜头移动的屏幕平均平移速度不超过 motion.flightSpeed（留 15%）
//   5c. 镜头到位后不对着空纸讲：换取景到位后、下一笔（或发光、下一次镜头移动）之前，旁白在讲的时间不超过 motion.maxIdleAfterMove 秒（E05 v1：空纸 7 秒）
// 笔身、影子、字幕框的几何和编译器的避让共用 src/timeline.ts 里的同一份定义。
//   6. 停笔不压正在讲的东西：笔停够 0.5 秒时，笔身不压已写出的文字、刚画完的元素，推近镜头里还有焦点元素
//   7. 写字时笔身不长时间压住别的字：写字、抬笔移动时，笔身连续压住别的元素已写出的文字不超过 pencil.maxCoverSec 秒，
//      一句旁白里累计不超过 pencil.maxCoverPhraseSec 秒（审片 v10：断续压住「x₂」累计 1.2 秒，连续的检查拦不住）
//      （审片 v9：16x9 画声波的约 1.9 秒里，笔身横压 x₁、x₂ 和「×3」，正在说「这个输入说话越大声」）
//   8. 片尾不带笔：最后一帧整支笔都在画外（审片 v9：16x9 笔扫过算式和灯后停在右缘，终帧带着铅笔）
// 用法：node qa/pencil_check.mjs build/<id>.timeline.json
import '../compiler/node_version.mjs'; // 先查 Node 版本
import fs from 'node:fs';
const { pencilPose, cameraAt, pencilBodyPts, pencilFootprint, subtitleBox, inBox, isFlight, idleAfterCamera, SUB_MARGIN } = await import('../src/timeline.ts'); // .ts 用 await import：Node 版本低时先看到上面那条说明

const tl = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fails = [];
// gate：风格规范 gates 里是 advice 的关卡没过只打 [建议]、不判失败（创作取舍）；没写 gate 或是 hard 的照常判失败
const advs = [];
const check = (name, ok, detail, gate) => {
  const adv = !ok && gate && tl.style?.gates?.[gate] === 'advice';
  console.log(`[${ok ? '通过' : adv ? '建议' : '失败'}] ${name}：${detail}`);
  if (!ok) (adv ? advs : fails).push(name);
};

let prev = null, maxDA = [0, 0], maxDL = [0, 0], maxDAmove = [0, 0];
// 上限按 60 帧/秒定，换成这条时间线的每帧：动作快慢按秒算，不按帧算
const PF = 60 / tl.fps, LIM = { ang: 0.5 * PF, angMove: 1.0 * PF, lift: 0.08 * PF };
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
check('笔身不晃眼', maxDA[0] <= LIM.ang && maxDAmove[0] <= LIM.angMove && maxDL[0] <= LIM.lift,
  `${tl.fps}fps，写字/停笔时角度每帧最大变化 ${maxDA[0].toFixed(2)}°（第 ${maxDA[1]} 帧，上限 ${LIM.ang.toFixed(2)}°），抬笔移动时 ${maxDAmove[0].toFixed(2)}°（第 ${maxDAmove[1]} 帧，上限 ${LIM.angMove.toFixed(2)}°），抬笔量每帧最大变化 ${maxDL[0].toFixed(3)}（第 ${maxDL[1]} 帧，上限 ${LIM.lift.toFixed(3)}）`);
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
const short = tl.strokes.filter((s) => (s.t1 - s.t0) * 60 < 2.95).map((s) => s.id); // 至少 3/60 秒
check('运笔流畅（无瞬移）', over === 0 && !short.length,
  `${tl.fps}fps，笔尖单帧最大位移 ${maxMove[0].toFixed(0)}px（第 ${maxMove[1]} 帧，上限 ${(60 * 60 / tl.fps).toFixed(0)}），超限 ${over} 帧；写不到 3/60 秒的笔画 ${short.length} 个${short.length ? '：' + short.slice(0, 5).join('、') : ''}`);
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
check('顿悟时镜头不拉远', !zoomOut.length, zoomOut.length ? zoomOut.join('；') : `${phr.filter((p) => p.role === 'aha').length} 个顿悟句（说完后再停 ${tl.style?.motion?.aha?.holdAfter ?? 0}s）期间镜头只推近或保持`, 'camera.ahaNoZoomOut');

// 0. 铅笔轨迹没有空档：编译排出来的每一段（落笔、抬笔移动、停笔）首尾相接。有空档时渲染端只能停在空档前那一段的终点，
//    原来取最后一段，笔一帧闪出画外再冒回来（审片 E02 v9）——空档本身就是排程的毛病，判失败
const segsSorted = [...(tl.penTrack ?? [])].sort((a, b) => a.t0 - b.t0), holes = [];
for (let i = 1; i < segsSorted.length; i++) {
  const gap = segsSorted[i].t0 - Math.max(...segsSorted.slice(0, i).map((x) => x.t1));
  if (gap > 1.5 / tl.fps) holes.push(`${(segsSorted[i].t0 - gap).toFixed(2)}–${segsSorted[i].t0.toFixed(2)}s`);
}
check('铅笔轨迹没有空档', !holes.length, holes.length ? `${holes.length} 处轨迹断开（笔在这里没有位置）：` + holes.slice(0, 6).join('、') : `${segsSorted.length} 段首尾相接`);

// 5b. 镜头不甩：每次镜头移动在屏幕上的平均平移速度不超过 motion.flightSpeed（留 15% 余量），按纸面距离 × 两头较大的放大倍数算，和编译器排飞行时同一个算法。
//     审片 E02 v4：一节以顿悟句开头时，换节按推近走 1.3 秒，平移约 2500px（1940px/s），机器 0.4 秒就出画，之后对着空纸 1.6 秒
const vMax = tl.style?.motion?.flightSpeed ?? tl.style?.motion?.moveSpeed, fast = []; // 没写 flightSpeed 时编译按 moveSpeed 排飞行，这里同一个回落值（CI 用默认风格，原来整项跳过）
if (vMax) for (const m of tl.camera ?? []) {
  const dur = m.t1 - m.t0;
  if (dur <= 0) continue;
  const v = (Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) * Math.max(m.from.z, m.to.z)) / dur;
  if (v > vMax * 1.15) fast.push(`${m.t0.toFixed(2)}–${m.t1.toFixed(2)}s 平均 ${v.toFixed(0)}px/s${m.focus ? '（推近）' : ''}`);
}
check('镜头不甩', !fast.length, fast.length ? `${fast.length} 次镜头移动太快（上限 ${vMax}px/s）：` + fast.slice(0, 5).join('、') : vMax ? `每次镜头移动平均平移不超过 ${vMax}px/s` : '风格里没写 flightSpeed，不查', 'camera.flightSpeed');

// 5c. 镜头到位后不对着空纸讲（判定在 src/timeline.ts 的 idleAfterCamera，自测也用它挑注入点）：换取景（不算推近、回看、全景长镜头）到位以后，
//     到下一笔、发光或下一次镜头移动之前，旁白在讲的时间超过 motion.maxIdleAfterMove 秒。
//     审片 E05 v1：换节镜头在上一句说完前就飞走，五处提前离场，205 秒那处对着空纸讲了 7 秒（E04 复盘同一类，第二次出现做成检查）
const maxIdle = tl.style?.motion?.maxIdleAfterMove ?? 2.5;
const idle = idleAfterCamera(tl).filter((x) => x.idle > maxIdle);
const sayAt = (t) => (tl.report?.phrases ?? []).findLast((p) => p.at <= t + 1e-6)?.text ?? '';
check('镜头到位后不对着空纸讲', !idle.length, idle.length ? `${idle.length} 处镜头到位后旁白讲了很久才有新笔画（上限 ${maxIdle}s）：` + idle.slice(0, 6).map((x) => `${x.arrive.toFixed(2)}s 到位、${x.next.toFixed(2)}s 才动，讲了 ${x.idle.toFixed(1)}s（「${sayAt(x.arrive).slice(0, 12)}」）`).join('；') + '。把这句的第一个动作提到更早的词上，或这一句先画点什么' : `每次换取景到位后 ${maxIdle}s 旁白内就有新笔画`, 'camera.idle');


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
check('停笔不压正在讲的东西', !covered.length, covered.length ? `${covered.length} 帧笔停着、笔身压在文字、刚画完的元素或推近焦点上：` + runs(covered).slice(0, 5).map(([a, b]) => `${(a / tl.fps).toFixed(2)}–${(b / tl.fps).toFixed(2)}s`).join('、') : '笔停够 0.5 秒时，从不压文字、刚画完的元素和推近焦点', 'pencil.park');

// 7. 写字时笔身不长时间压住别的字（停够 0.5 秒的停笔由第 6 项管）
const longRest = (t) => (tl.penTrack ?? []).some((sg) => sg.kind === 'rest' && sg.t1 - sg.t0 >= 0.5 && t >= sg.t0 && t < sg.t1);
const writing = (t) => { const d = (tl.penTrack ?? []).find((sg) => sg.kind === 'down' && t >= sg.t0 && t < sg.t1); return d ? tl.strokes[d.stroke].action : null; };
const coverFrames = [];
for (let f = 0; f < tl.durationInFrames; f++) {
  const t = f / tl.fps;
  if (longRest(t)) continue;
  const p = pencilPose(tl, t);
  if (p.x < 0 || p.x > tl.canvas.w || p.y < 0 || p.y > tl.canvas.h) continue;
  const c = cameraAt(tl.camera, t), self = writing(t), boxes = [];
  for (const [id, a] of drawnAt(t)) {
    if (id === self || !a.text) continue;
    const b = a.text;
    boxes.push([(b[0] - c.x) * c.z + tl.view.cx - 4, (b[1] - c.y) * c.z + tl.view.cy - 4, (b[2] - c.x) * c.z + tl.view.cx + 4, (b[3] - c.y) * c.z + tl.view.cy + 4]);
  }
  const r = (p.ang * Math.PI) / 180, near = 0.2 * (tl.style?.pencil?.length ?? 276) * p.sc;
  const body = pencilBodyPts(tl, p).filter(([x, y]) => (x - p.x) * Math.cos(r) + (y - p.y) * Math.sin(r) >= near);
  if (body.some(([x, y]) => boxes.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]))) coverFrames.push(f);
}
const maxCover = tl.style?.pencil?.maxCoverSec ?? 1.0, longCover = runs(coverFrames).filter(([a, b]) => (b - a + 1) / tl.fps > maxCover);
const maxPhrase = tl.style?.pencil?.maxCoverPhraseSec ?? Infinity, phr7 = tl.report?.phrases ?? [];
const phraseCover = phr7.map((p, i) => {
  const t1 = phr7[i + 1]?.at ?? tl.duration;
  return { p, sec: coverFrames.filter((f) => f / tl.fps >= p.at && f / tl.fps < t1).length / tl.fps };
});
const heavy = phraseCover.filter((x) => x.sec > maxPhrase);
check('写字时笔身不长时间压住别的字', !longCover.length && !heavy.length,
  [longCover.length ? `${longCover.length} 段连续压字超过 ${maxCover}s：` + longCover.slice(0, 5).map(([a, b]) => `${(a / tl.fps).toFixed(2)}–${(b / tl.fps).toFixed(2)}s`).join('、') : '',
    heavy.length ? `${heavy.length} 句累计压字超过 ${maxPhrase}s：` + heavy.slice(0, 5).map((x) => `「${x.p.text}」${x.sec.toFixed(2)}s`).join('、') : ''].filter(Boolean).join('；') ||
  `写字和移动时，笔身连续压住别的字最长 ${(Math.max(0, ...runs(coverFrames).map(([a, b]) => b - a + 1)) / tl.fps).toFixed(2)}s（上限 ${maxCover}s），一句里累计最多 ${Math.max(0, ...phraseCover.map((x) => x.sec)).toFixed(2)}s（上限 ${maxPhrase}s）`, 'pencil.cover');

// 8. 片尾不带笔
const lastPose = pencilPose(tl, (tl.durationInFrames - 1) / tl.fps), onCanvas = pencilBodyPts(tl, lastPose).filter(([x, y]) => x > 0 && x < tl.canvas.w && y > 0 && y < tl.canvas.h);
check('片尾不带笔', !onCanvas.length, onCanvas.length ? `最后一帧铅笔还在画面里（笔尖 ${lastPose.x.toFixed(0)},${lastPose.y.toFixed(0)}）` : '最后一帧整支笔都在画外', 'pencil.exit');

console.log(`\n铅笔检查失败 ${fails.length} 项${advs.length ? `（另有建议 ${advs.length} 项）` : ''}`);
process.exit(fails.length ? 1 : 0);
