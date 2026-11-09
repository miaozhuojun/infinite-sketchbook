// 检查器自测：对一份已通过的时间线/分镜注入已知缺陷，每一项检查都必须报出来；否则说明检查形同虚设。
// 引擎、组件库、风格规范或检查器改动后先跑这个。用法：node qa/selftest.mjs build/<id>-<画幅>.timeline.json [--skip speech]（任何画幅都行：平台界面、版式类注入按这条基线的画幅和界面算；按改了什么跳过整组：--skip speech（没改配音和旁白检查）、--skip compile（没改编译器和分镜校验），可以写成 --skip speech,compile）
// 注入目标按类型和时间挑（文字、图形、推近镜头……），不认某一期的元素名，演示分镜和每一期都能当基线；CI 跑的是演示分镜。
// 旁白类注入要真人配音和本地配音环境：配音是合成提示音（演示分镜）或没有 PY_MLX 时整组跳过，结果里写明跳过了哪些、为什么。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cameraAt } from '../src/timeline.ts';
import { PY_QA, PY_MLX } from './pyenv.mjs';

const basePath = process.argv[2];
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
// 旁白类注入可以另用一份基线（--speech-base）：旁白检查按当前 voice.json 的标准查，基线要是按同一套配音规范配出来的那一集，不然基线自己就过不了
const speechBasePath = process.argv.includes('--speech-base') ? process.argv[process.argv.indexOf('--speech-base') + 1] : basePath;
const sbase = JSON.parse(fs.readFileSync(speechBasePath, 'utf8'));
const sbeatsSrc = JSON.parse(fs.readFileSync(`data/${sbase.beatsId}.beats.json`, 'utf8'));
const beatsSrc = JSON.parse(fs.readFileSync(`data/${base.beatsId}.beats.json`, 'utf8'));
const TGT = base.target; // 分镜类注入按基线时间线的画幅编译（原来写死 9:16）
const results = [], skipped = [];
const record = (name, caught, out) => { results.push({ name, caught }); console.log(`${caught ? '✓ 抓到' : '✗ 漏掉'}  ${name}`); if (!caught) console.log(out.slice(-700)); };
const skip = (name, why) => { skipped.push({ name, why }); console.log(`–  跳过  ${name}`); };

// ---------- 时间线上的注入（渲染后检查：铅笔、运笔、镜头、字幕、安全区、旁白） ----------
function expectFail(name, mutate, runner, mustSay, from = base) {
  const tl = structuredClone(from);
  tl.id = '_selftest';
  const extra = mutate(tl) || {};
  const p = path.resolve('build/_selftest.timeline.json');
  fs.writeFileSync(p, JSON.stringify(tl));
  const r = runner(p), out = (r.stdout || '') + (r.stderr || '');
  record(name, out.includes(mustSay), out);
  fs.rmSync(p, { force: true });
  for (const f of extra.cleanup || []) fs.rmSync(f, { force: true });
}
const pencil = (p) => spawnSync('node', ['qa/pencil_check.mjs', p], { encoding: 'utf8' });
const safezone = (p) => spawnSync('node', ['qa/safezone_check.mjs', p], { encoding: 'utf8' });
const speech = (p) => spawnSync(PY_MLX, ['speech_check.py', p, path.resolve('.')], { encoding: 'utf8', cwd: '../tts' });
// --skip speech,compile：按改了什么跳过整组。speech：没动 tts/ 和旁白检查时跳过旁白类注入；compile：没动编译器和分镜校验时跳过要重新编译的注入（大分镜每条要编译一分半钟）。
// 旁白类注入这一组二十来条、每条都要重新加载识别模型，
// 占自测八成的时间（一次二十多分钟）；改了配音或旁白检查才需要跑（用户 2026-11-06：流程太长）
const SKIP = new Set(process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1].split(',') : []);
const noSpeech = SKIP.has('speech') ? '这次没改配音和旁白检查（--skip speech）' : sbeatsSrc.narration?.synthetic ? '配音是合成提示音，没有人声可查' : PY_MLX ? null : '没有本地配音环境（PY_MLX）';
const OTHER_VOICE = path.resolve('qa/fixtures/other-voice.mp3');
const speechCase = (name, mutate, mustSay, why = noSpeech) => (why ? skip(name, why) : expectFail(name, mutate, speech, mustSay, sbase));

// 挑注入目标用的几何：和渲染、检查共用同一套镜头
const toScreen = (tl, [x, y], t) => { const c = cameraAt(tl.camera, t); return [(x - c.x) * c.z + tl.view.cx, (y - c.y) * c.z + tl.view.cy]; };
const mid = (vs) => (Math.min(...vs) + Math.max(...vs)) / 2;
const isText = (s) => s.kind === 'glyph' || s.kind === 'line';
const subTop = (tl) => tl.sub.top - (tl.style?.subtitle?.plate?.padY ?? 0);
// 写字中的一帧（笔在纸上，不在抬笔移动里）：正中那一笔写到一半
const writingFrame = (tl) => { const s = tl.strokes[Math.floor(tl.strokes.length / 2)]; return Math.round(((s.t0 + s.t1) / 2) * tl.fps); };
// 停笔 1 秒，让笔身（不是笔尖）横在一块内容正中：笔尖放在中心沿笔的方向往回 0.45 个笔长的地方
// 写完后这段时间里没有停够 0.5 秒的停笔的第一个整段文字：「写字时压字」那项检查跳过长停笔（归停笔那项管），
// 注入要落在笔在写字或移动的时段里（原来取第一个文字，E02 v4 开场那句写完就停笔 5.5 秒，注入全落在停笔里，永远「漏掉」）
function textFreeOfRest(tl, dur) {
  const busy = (a, b) => tl.penTrack.some((s) => s.kind === 'rest' && s.t1 - s.t0 >= 0.5 && s.t0 < b && s.t1 > a);
  return [...Map.groupBy(tl.strokes, (x) => x.action).values()].find((q) => q.every(isText) && !busy(q.at(-1).t1 + 0.05, q.at(-1).t1 + 0.05 + dur));
}
function restAcross(tl, pts, t0) {
  const P = tl.style.pencil, Lw = P.length * P.scale * (Math.min(tl.canvas.w, tl.canvas.h) / 1080), r = (P.base * Math.PI) / 180;
  const cx = mid(pts.map((q) => q[0])), cy = mid(pts.map((q) => q[1]));
  return { kind: 'rest', t0, t1: t0 + 1, at: [cx - Math.cos(r) * Lw * 0.45, cy - Math.sin(r) * Lw * 0.45] };
}

const b1 = pencil(path.resolve(basePath));
console.log(b1.status === 0 ? '✓ 基线：铅笔与运笔检查通过' : '✗ 基线就没通过，自测无意义');
// 旁白类注入要以这份时间线自己的旁白为基线：基线就不过，后面的「抓到」可能只是碰巧
const b2 = noSpeech ? null : speech(path.resolve(speechBasePath));
console.log(!b2 ? `–  旁白类注入跳过：${noSpeech}` : b2.status === 0 ? '✓ 基线：旁白检查通过' : '✗ 旁白基线没通过，旁白类自测无意义：\n' + ((b2.stdout || '') + (b2.stderr || '')).slice(-600));

expectFail('笔身突然转动（姿态曲线跳变 0.8）', (tl) => { for (let i = writingFrame(tl); i < tl.pencil.sway.length; i++) tl.pencil.sway[i] += 0.8; }, pencil, '[失败] 笔身不晃眼');
expectFail('抬笔影子闪烁（单帧抬笔量跳到 0.5）', (tl) => { tl.pencil.lift[writingFrame(tl)] = 0.5; }, pencil, '[失败] 笔身不晃眼');
expectFail('一笔只画 1 帧（看起来像掉帧）', (tl) => { const s = tl.strokes[Math.floor(tl.strokes.length / 3)]; s.t1 = s.t0 + 1 / tl.fps; }, pencil, '[失败] 运笔流畅');
expectFail('字幕挪到笔正在写的位置', (tl) => {
  // 找一笔在字幕显示期间写的，把字幕框挪到这一笔写到一半时笔尖的屏幕位置
  const s = tl.strokes.find((q) => tl.subtitles.some((x) => q.t0 >= x.t0 && q.t1 <= x.t1));
  const [sx, sy] = toScreen(tl, s.pts[Math.floor(s.pts.length / 2)], (s.t0 + s.t1) / 2);
  tl.sub.cx = sx;
  tl.sub.top = sy - 10;
}, pencil, '[失败] 笔身不压字幕');
expectFail('内容右移到右边缘，铅笔伸出画面', (tl) => {
  // 最靠右的一笔挪到离右边缘 30px：笔尖还在画面里，笔身朝右下伸出去
  const xs = tl.strokes.flatMap((s) => s.pts.map((p) => toScreen(tl, p, s.t1)[0]));
  tl.view.cx += tl.canvas.w - 30 - Math.max(...xs);
}, pencil, '[失败] 笔身不出画');
expectFail('顿悟句期间镜头拉远', (tl) => {
  const i = tl.report.phrases.findIndex((p) => p.role === 'aha');
  const at = tl.report.phrases[i].at, c0 = cameraAt(tl.camera, at + 0.1);
  tl.camera.push({ t0: at + 0.15, t1: at + 0.65, from: c0, to: { ...c0, z: c0.z * 0.8 } });
  tl.camera.sort((a, b) => a.t0 - b.t0);
}, pencil, '[建议] 顿悟时镜头不拉远');
expectFail('推近镜头里铅笔停在焦点元素上 1 秒', (tl) => {
  // 推近到位、焦点元素至少写出一笔之后，停笔 1 秒，笔身横在已写出的焦点内容上
  const m = tl.camera.find((x) => x.focus), fx = tl.strokes.filter((x) => m.focus.includes(x.action));
  const t0 = Math.max(m.t1, Math.min(...fx.map((x) => x.t1))) + 0.05;
  tl.penTrack.unshift(restAcross(tl, fx.filter((x) => x.t1 <= t0).flatMap((x) => x.pts), t0)); // 排在最前面，这一秒里取到的就是它
}, pencil, '[建议] 停笔不压正在讲的东西');
expectFail('停笔 1 秒压在刚写完的字上（不在推近镜头里）', (tl) => {
  // 找一个整段都是文字、写完时不在推近镜头里的动作，写完后停笔 1 秒，笔身横在它正中
  const inFocus = (t) => tl.camera.some((m, i) => m.focus && t >= m.t0 && t < (tl.camera[i + 1]?.t0 ?? tl.duration));
  const ss = [...Map.groupBy(tl.strokes, (x) => x.action).values()].reverse().find((g) => g.every(isText) && !inFocus(g.at(-1).t1 + 0.1));
  tl.penTrack.unshift(restAcross(tl, ss.flatMap((x) => x.pts), ss.at(-1).t1 + 0.05));
}, pencil, '[建议] 停笔不压正在讲的东西');
expectFail('写字时笔身横在别的字上 1.5 秒（不是停笔）', (tl) => {
  // 找一个整段都是文字的动作，写完后插一段 1.5 秒的原地「移动」，笔身横在它正中（停够 0.5 秒的停笔归第 6 项管，这里要的是写字和移动时）
  const g = textFreeOfRest(tl, 1.5);
  const r = restAcross(tl, g.flatMap((x) => x.pts), g.at(-1).t1 + 0.05);
  tl.penTrack.unshift({ kind: 'move', t0: r.t0, t1: r.t0 + 1.5, from: r.at, to: r.at });
}, pencil, '[建议] 写字时笔身不长时间压住别的字');
expectFail('一句话里笔身断续压字，累计超过上限（每段都不到 1 秒）', (tl) => {
  // 在一句旁白里插四段 0.7 秒的原地「移动」，笔身横在一段已写的文字上，中间隔 0.1 秒：连续的检查拦不住，累计的要拦住
  const g = textFreeOfRest(tl, 3.2), r = restAcross(tl, g.flatMap((x) => x.pts), g.at(-1).t1 + 0.05);
  for (let i = 3; i >= 0; i--) tl.penTrack.unshift({ kind: 'move', t0: r.t0 + i * 0.8, t1: r.t0 + i * 0.8 + 0.7, from: r.at, to: r.at });
  const p = tl.report.phrases.findLast((q) => q.at <= r.t0);
  p.at = Math.min(p.at, r.t0); // 这四段都算在同一句里
  (tl.report.phrases[tl.report.phrases.indexOf(p) + 1] ?? {}).at = Math.max(tl.report.phrases[tl.report.phrases.indexOf(p) + 1]?.at ?? 0, r.t0 + 3.3);
}, pencil, '累计压字超过');
expectFail('镜头最远那次移动压到上限的 2 倍速（甩镜头）', (tl) => {
  // 找平移最远的一次镜头移动，压到 0.8 秒走完（审片 E02 v4：一节以顿悟句开头时，换节按推近 1.3 秒走了约 2500px）
  const far = (m) => Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) * Math.max(m.from.z, m.to.z);
  const m = tl.camera.filter((x) => x.t1 > x.t0).sort((a, b) => far(b) - far(a))[0];
  m.t1 = m.t0 + Math.max(0.05, far(m) / (2 * (tl.style.motion.flightSpeed ?? tl.style.motion.moveSpeed))); // 压到上限的 2 倍速（固定 0.8 秒时，演示片最远一次也才 600px，压完仍不超速）
}, pencil, '[失败] 镜头不甩');
expectFail('铅笔轨迹中间断了一截（笔在那段时间没有位置，渲染时会一帧闪出画外）', (tl) => {
  // 删掉轨迹正中的一段：审片 E02 v9 发现的笔闪，原因是轨迹有空档
  const i = Math.floor(tl.penTrack.length / 2);
  tl.penTrack.sort((a, b) => a.t0 - b.t0).splice(i, 1);
}, pencil, '[失败] 铅笔轨迹没有空档');
expectFail('片尾铅笔停在画面中间', (tl) => {
  const c = cameraAt(tl.camera, tl.duration), last = tl.penTrack.at(-1);
  last.at = [c.x, c.y]; // 最后一段停笔挪到片尾镜头的正中
  tl.penTrack.at(-2).to = last.at;
}, pencil, '[建议] 片尾不带笔');
// 往平台界面里挪：按基线画幅实际有的界面区算位置（原来写死 9:16 的 TikTok 底栏和右侧按钮列，16:9 基线上这两条注入落不到任何界面里，永远「漏掉」）
const uiZones = (tl) => tl.platforms.flatMap((pf) => (tl.platformUI?.[pf] ?? []).map((z) => ({ ...z, pf })));
{
  const W = base.canvas.w, H = base.canvas.h, zs = uiZones(base).filter((z) => !z.advice); // 只给建议的遮挡区另有用例
  const bottom = zs.filter((z) => z.b >= H - 2 && z.r - z.l >= W / 2).sort((a, b) => a.t - b.t)[0];
  if (bottom) expectFail(`字幕挪进 ${bottom.pf} 的${bottom.name}`, (tl) => { tl.sub.top = bottom.t + 10; }, safezone, '[失败] 字幕避开平台界面');
  else skip('字幕挪进底部平台界面', '基线画幅的平台界面里没有底部横条');
  // 内容挪进界面：右侧竖条往右挪，顶部横条往上挪，底部横条往下挪，挪到内容正好盖住这块界面
  const side = zs.find((z) => z.l >= W / 2 && z.b - z.t >= H / 3), top = zs.find((z) => z.t <= 2 && z.r - z.l >= W / 2);
  if (side) expectFail(`内容整体右移进 ${side.pf} 的${side.name}`, (tl) => { tl.view.cx += (side.l + side.r) / 2 - W / 2; }, safezone, '[失败] 内容避开平台界面'); // 画面中心挪到这条界面的正中
  else if (top) expectFail(`内容整体上移进 ${top.pf} 的${top.name}`, (tl) => { tl.view.cy -= 380; }, safezone, '[失败] 内容避开平台界面');
  else skip('内容整体挪进平台界面', '基线画幅没有侧边或顶部的平台界面');
}
// 竖握手机看横版（抖音信息流）的按钮列：基线画幅有这类只给建议的遮挡区时，把内容整体右移到按钮列底下，检查要给建议
{
  const feed = uiZones(base).find((z) => z.advice);
  if (feed) expectFail(`文字整体右移进 ${feed.pf} 的${feed.name}`, (tl) => { tl.view.cx += (feed.l + feed.r) / 2 - base.canvas.w / 2; tl.view.cy += (feed.t + feed.b) / 2 - base.canvas.h / 2; }, safezone, '文字避开竖握手机看横版时的按钮列');
  else skip('文字挪进竖握手机看横版时的按钮列', '基线画幅没有这类遮挡区');
}
expectFail('推近镜头把一段文字切成半截', (tl) => {
  // 找一个推近镜头和一段已写的文字，把镜头挪到让这段文字正好骑在画面左边缘上
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1);
  const xs = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[0]));
  m.to = { ...m.to, x: mid(xs) + tl.view.cx / m.to.z };
}, safezone, '[失败] 镜头停稳时不切字');
expectFail('推近镜头把一段文字推到字幕衬底下面', (tl) => {
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1);
  const ys = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[1]));
  m.to = { ...m.to, y: mid(ys) - (subTop(tl) - tl.view.cy) / m.to.z }; // 让这段文字的中线正好落在字幕衬底上沿
}, safezone, '[失败] 镜头停稳时不切字');
expectFail('推近时一段文字落进 TikTok 顶部栏（文字整段在画布里）', (tl) => {
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1 && !m.focus.includes(s.action));
  const ys = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[1]));
  m.to = { ...m.to, y: mid(ys) - (65 - tl.view.cy) / m.to.z }; // 文字中线落在屏幕 y=65，正在顶部标签栏（0–130）里
}, safezone, '[失败] 镜头停稳时不切字');
// 一个镜头位置和这一镜里已经开始画的一个图形（优先推近镜头），返回 [镜头, 图形的纵坐标]
function shotWithShape(tl) {
  const shots = tl.camera.map((m, i) => ({ m, until: tl.camera[i + 1]?.t0 ?? tl.duration })).sort((a, b) => !!b.m.focus - !!a.m.focus);
  const shapes = [...Map.groupBy(tl.strokes.filter((s) => s.kind === 'shape'), (s) => s.action).values()];
  const [{ m }, g] = shots.flatMap((sh) => shapes.filter((g) => g[0].t0 < sh.until).map((g) => [sh, g]))[0];
  return [m, g.flatMap((s) => s.pts.map((p) => p[1]))];
}
expectFail('镜头停稳时一个图形压在字幕衬底底下', (tl) => {
  const [m, ys] = shotWithShape(tl);
  m.to = { ...m.to, y: mid(ys) - (subTop(tl) + 20 - tl.view.cy) / m.to.z }; // 图形中线落在字幕上沿下面 20px
}, safezone, '[失败] 镜头停稳时内容不进字幕区');
expectFail('镜头停稳时一个图形越过取景框下沿（还在字幕上方）', (tl) => {
  const [m, ys] = shotWithShape(tl);
  m.to = { ...m.to, y: Math.max(...ys) - (tl.frame.b + 0.5 * (subTop(tl) - tl.frame.b) - tl.view.cy) / m.to.z }; // 图形底边落在取景框下沿和字幕之间
}, safezone, '[建议] 镜头停稳时图形不切半截');
expectFail('图形停在取景框外的顶边距里（像推近后挂在顶边的下划线）', (tl) => {
  const [m, ys] = shotWithShape(tl), z = Math.min(m.to.z, (tl.frame.t - 20) / (Math.max(...ys) - Math.min(...ys)));
  m.to = { ...m.to, z, y: Math.max(...ys) - (tl.frame.t - 10 - tl.view.cy) / z }; // 整个图形落在画布顶边和取景框上沿之间
}, safezone, '[建议] 镜头停稳时图形不切半截');
expectFail('镜头停稳时一个图形被画布左边缘切掉一截、其余伸进取景框（像推近后切掉一半的灯泡）', (tl) => {
  // 镜头不动，在最后一个镜头里加一条横线：左端在画布外 60px，右端伸进取景框 200px，高度取取景框正中。
  // 旧规则（图形被画布边缘裁掉可以）会放过它，别的元素都不受影响
  const m = tl.camera.at(-1), c = m.to; // 最后一镜：之后没有别的镜头位置再看到这条线
  const w = (sx, sy) => [(sx - tl.view.cx) / c.z + c.x, (sy - tl.view.cy) / c.z + c.y], y = (tl.frame.t + tl.frame.b) / 2;
  const [ax, ay] = w(-60, y), [bx, by] = w(tl.frame.l + 200, y);
  tl.strokes.push({ id: '_cut#0', action: '_cut', group: '_cut', kind: 'shape', color: 'ink', d: `M ${ax} ${ay} L ${bx} ${by}`, len: Math.hypot(bx - ax, by - ay), t0: Math.min(m.t1 + 0.1, tl.duration - 0.4), t1: Math.min(m.t1 + 0.3, tl.duration - 0.2), pts: [[ax, ay, 0.5], [bx, by, 0.5]] });
}, safezone, '_cut');
expectFail('镜头停稳时一个字的最后一笔露在画面左缘几像素（路径在画外，笔宽伸进来）', (tl) => {
  // 最后一镜里加一笔「字」：路径中心线在画布左缘外 2px，笔宽 12px，墨迹伸进画面 4px。只看路径点、不算笔宽时会当成整段在画外
  const m = tl.camera.at(-1), c = m.to, y = (tl.frame.t + tl.frame.b) / 2;
  const w = (sx, sy) => [(sx - tl.view.cx) / c.z + c.x, (sy - tl.view.cy) / c.z + c.y];
  const [ax, ay] = w(-2, y - 30), [bx, by] = w(-2, y + 30);
  tl.strokes.push({ id: '_edge#0', action: '_edge', group: '_edge', kind: 'glyph', color: 'ink', width: 12 / c.z, d: `M ${ax} ${ay} L ${bx} ${by}`, len: Math.hypot(bx - ax, by - ay), t0: Math.min(m.t1 + 0.1, tl.duration - 0.4), t1: Math.min(m.t1 + 0.3, tl.duration - 0.2), pts: [[ax, ay, 0.5], [bx, by, 0.5]] });
}, safezone, '_edge 在 ');
expectFail('推近把焦点挤到画面顶上（下面大半空着）', (tl) => {
  const m = tl.camera.find((x) => x.focus && (x.to.push ?? 1) > 1.001);
  // 把焦点中心放到取景框中心上方 35% 个取景框高（按焦点的实际位置算；原来只把镜头往下挪固定一段，焦点本来偏下的基线上挪完反而更居中，查不出来）
  const pts = tl.strokes.filter((s) => m.focus.includes(s.action)).flatMap((s) => s.pts), fy = (Math.min(...pts.map((q) => q[1])) + Math.max(...pts.map((q) => q[1]))) / 2;
  m.to = { ...m.to, y: fy + (0.35 * (tl.frame.b - tl.frame.t)) / m.to.z };
}, safezone, '[建议] 推近时焦点在画面中部');
{ // 推近镜头把焦点内容推进顶部平台界面：按基线画幅实际的顶部界面算（原来写死 TikTok 顶栏的 650px，16:9 上整段推出画外，查不出来）
  const top = uiZones(base).find((z) => z.t <= 2 && z.r - z.l >= base.canvas.w / 2);
  if (top) expectFail(`推近镜头把焦点内容推进 ${top.pf} 的${top.name}`, (tl) => {
    const m = tl.camera.find((x) => x.focus && (x.to.push ?? 1) > 1.001);
    const pts = tl.strokes.filter((s) => m.focus.includes(s.action)).flatMap((s) => s.pts), fy = (Math.min(...pts.map((q) => q[1])) + Math.max(...pts.map((q) => q[1]))) / 2;
    m.to = { ...m.to, y: fy - (top.b / 2 - tl.view.cy) / m.to.z }; // 焦点中心正好落在顶部界面中间
  }, safezone, '[失败] 内容避开平台界面');
  else skip('推近镜头把焦点内容推进顶部平台界面', '基线画幅的平台界面里没有顶部横条');
}
// 水印：没配置品牌的时间线（CI 跑的演示分镜）没有水印，就注入一段，检查照样要查
const wmOf = (tl) => (tl.watermark ??= { text: '测试水印', size: 30, opacity: 0.42, fade: 0.8, margin: 10, spans: [] });
expectFail('水印挪进 TikTok 右侧按钮列', (tl) => { wmOf(tl).spans = [{ t0: 0, t1: tl.duration, x: 980, y: 1000, anchor: 'l' }]; }, safezone, '[失败] 水印避开字幕、平台界面和内容');
expectFail('水印压在字幕上', (tl) => { const s = tl.subtitles[0]; wmOf(tl).spans = [{ t0: s.t0, t1: s.t1, x: tl.sub.cx, y: tl.sub.top, anchor: 'l' }]; }, safezone, '[失败] 水印避开字幕、平台界面和内容');
expectFail('水印换位正好撞上顿悟句', (tl) => {
  // 两段水印在顿悟句说到一半时换位（两个位置都离字幕、平台界面远，只看换位时刻）
  const p = tl.report.phrases.find((q) => q.role === 'aha'), t = (p.at + p.audioEnd) / 2;
  wmOf(tl).spans = [{ t0: 0, t1: t, x: 980, y: 1000, anchor: 'l' }, { t0: t, t1: tl.duration, x: 980, y: 1000, anchor: 'l' }];
}, safezone, '[建议] 水印换位避开顿悟句');
expectFail('水印压在画好的内容上', (tl) => {
  // 最后一笔画完后，水印放在它结尾时的屏幕位置上，一直显示到片尾
  const s = tl.strokes.at(-1), [x, y] = toScreen(tl, s.pts[Math.floor(s.pts.length / 2)], tl.duration);
  wmOf(tl).spans = [{ t0: s.t1, t1: tl.duration, x, y: y - 10, anchor: 'l' }];
}, safezone, '[失败] 水印避开字幕、平台界面和内容');
speechCase('旁白切点切进一个字的正中间', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips.find((x) => timing.words.filter((w) => w.start >= x.srcIn && w.end <= x.srcOut).length >= 3);
  const inClip = timing.words.filter((w) => w.start >= c.srcIn && w.end <= c.srcOut);
  // 切在这个字最响的地方（按源音频能量找）：对齐的字范围前后差几十毫秒，取中点可能正好落在两字之间的空隙（E01 v17 的「和」）
  const r = spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np
x, sr = sf.read(${JSON.stringify(path.resolve('public', sbase.source))}, dtype='float64'); x = x.mean(1) if x.ndim > 1 else x
a, b = int(${inClip[2].start} * sr), int(${inClip[2].end} * sr); h = int(0.01 * sr)
lv = [np.sqrt((x[i:i + h] ** 2).mean()) for i in range(a, max(a + 1, b - h), h)]
print((a + int(np.argmax(lv)) * h + h / 2) / sr)`], { encoding: 'utf8' });
  c.srcIn = Number(r.stdout.trim()) || (inClip[2].start + inClip[2].end) / 2;
}, '[失败] 拼接切点落在静音处');
speechCase('旁白里两个字掉到成人男声的音高（降一个八度，用户两次听出的「学会」畸变）', (tl) => {
  // 最后一段旁白里找一段 0.3 秒的浊音，降一个八度（拉长一倍再取前半，长度不变、音高减半），别的都不动
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, json, numpy as np
from scipy.signal import resample
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a = int((c['at'] + 0.4) * sr); n = int(0.3 * sr)
seg = x[a:a + n]; low = resample(seg, 2 * n)[:n]
x[a:a + n] = low * (np.abs(seg).max() / (np.abs(low).max() + 1e-9))
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 没有掉嗓子');
speechCase('旁白里一小段突然破音（音高跳上去 16 个半音又跳回来，用户听 E02 v3「好几处声音畸变」）', (tl) => {
  // 最后一段旁白开头 0.4 秒后取 0.08 秒浊音，音高抬 2.5 倍（16 个半音，不是八度）
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, json, numpy as np
from scipy.signal import resample
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a = int((c['at'] + 0.45) * sr); n = int(0.08 * sr)
seg = x[a:a + n]; hi = resample(seg, int(n / 2.5)); hi = np.tile(hi, 3)[:n]
x[a:a + n] = hi * (np.abs(seg).max() / (np.abs(hi).max() + 1e-9))
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 没有破音');
speechCase('旁白里一个字从纯静音硬起（剪开处没淡入，用户听 E02 v5「1:20 有个突兀的声音」）', (tl) => {
  // 最后一段旁白开头 0.6 秒处，把前面 40ms 清成纯静音：声音从静音一下子跳回正在发声的地方
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, json, numpy as np
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
m = x if x.ndim == 1 else x[:, 0]
a0 = int((c['at'] + 0.3) * sr); w = int(0.01 * sr)
lv = [np.abs(m[i:i + w]).max() for i in range(a0, a0 + int(1.5 * sr), w)]
a = a0 + int(np.argmax(lv)) * w  # 这段里最响的地方，一定在发声
x[a - int(0.04 * sr):a] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 起音收音不硬切');
speechCase('一句话突然说快了四成（用户听 E02 v5「有的地方突然加快语速」）', (tl) => {
  // 逐字时间里最后一句的字都压短到 0.7 倍（字/秒 ×1.43），其余不动；旁白检查读的是分镜指向的逐字时间，所以另写一份分镜指过去
  const bp = path.resolve('data', `${sbase.beatsId}.beats.json`), b = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const tp = path.resolve('data', b.narration.timing), tm = JSON.parse(fs.readFileSync(tp, 'utf8'));
  const last = tm.sentences.at(-1);
  const L = last.start, k = (t) => L + (t - L) * 0.7; // 整句往句首压：字和字间的停顿一起变短
  for (const w of tm.words) if (w.start >= L - 0.01) { w.start = k(w.start); w.end = k(w.end); }
  const tdst = path.resolve('../tts/out/_selftest.timing.json'), bdst = path.resolve('data/_selftest_rate.beats.json');
  fs.writeFileSync(tdst, JSON.stringify(tm));
  fs.writeFileSync(bdst, JSON.stringify({ ...b, id: '_selftest_rate', narration: { ...b.narration, timing: path.relative(path.resolve('data'), tdst) } }));
  tl.beatsId = '_selftest_rate';
  return { cleanup: [tdst, bdst] };
}, '[失败] 语速一致');
speechCase('整条配音底下垫着嘶嘶的背景噪声（参考音带底噪时会这样；用户听 E01 v7「说话时有明显背景噪音」）', (tl) => {
  // 源配音整条叠上白噪声（比说话低 20dB）；背景干净看全片 9 秒窗 DNSMOS BAK 的中位数
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
m = x if x.ndim == 1 else x[:, 0]
lv = np.sqrt((m.reshape(-1)[: len(m) // 480 * 480].reshape(-1, 480) ** 2).mean(1)); r = np.sqrt((lv[lv > lv.max() * 0.01] ** 2).mean())
n = np.random.default_rng(1).standard_normal(len(m)) * r * 10 ** (-20 / 20)
x = x + (n if x.ndim == 1 else n[:, None])
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 背景干净');
speechCase('一开口就沙沙响、说完就没（噪声只叠在说话声上；用户听 E01 v7–v14）', (tl) => {
  // 按源配音的响度包络给白噪声开关：只在发声时叠上（比说话低 22dB），停顿处还是干净的。DNSMOS 对这种噪声不敏感，要靠浊音谱平坦度
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np
from scipy.ndimage import uniform_filter1d
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
m = x if x.ndim == 1 else x[:, 0]
env = np.sqrt(uniform_filter1d(m ** 2, int(0.02 * sr)))
n = np.random.default_rng(2).standard_normal(len(m)) * env * 10 ** (-22 / 20) * 1.4
x = x + (n if x.ndim == 1 else n[:, None])
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 说话时没有沙沙声');
speechCase('有一句换成了别人的声音（像几个人你一句我一句；用户听 E01 v15）', (tl) => {
  // 源配音里最后一段旁白换成另一个人的声音（同样长、同样响），别的句子不动
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np, subprocess, imageio_ffmpeg, tempfile, os
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
tmp = tempfile.mktemp(suffix='.wav'); subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-i', ${JSON.stringify(OTHER_VOICE)}, '-ac', '1', '-ar', str(sr), tmp], check=True)
o, _ = sf.read(tmp, dtype='float64'); os.remove(tmp)
c = __import__('json').loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a, b = int(c['srcIn'] * sr), int(c['srcOut'] * sr)
seg = x[a:b] if x.ndim == 1 else x[a:b, 0]
rep = np.resize(o, b - a) * (np.sqrt((seg ** 2).mean()) / (np.sqrt((o ** 2).mean()) + 1e-9))
if x.ndim == 1: x[a:b] = rep
else: x[a:b, :] = rep[:, None]
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 每句都是同一个人');
speechCase('有一句带了房间回声（一句有回音一句没有；用户听 E01 v16）', (tl) => {
  // 源配音最后一段卷积一个 0.5 秒的指数衰减混响，别的句子不动
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np, json
from scipy.signal import fftconvolve
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a, b = int(c['srcIn'] * sr), int(c['srcOut'] * sr)
t = np.arange(int(0.5 * sr)) / sr; ir = np.random.default_rng(3).standard_normal(len(t)) * np.exp(-t * 6.9 / 0.5); ir[0] = 4.0
seg = x[a:b] if x.ndim == 1 else x[a:b, 0]
w = fftconvolve(seg, ir)[: b - a]; w *= np.sqrt((seg ** 2).mean() / ((w ** 2).mean() + 1e-12))
if x.ndim == 1: x[a:b] = w
else: x[a:b, :] = w[:, None]
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 每句没有回声');
speechCase('有一句比别的句子响 6dB（句与句音量不一样）', (tl) => {
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, numpy as np, json
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a, b = int(c['srcIn'] * sr), int(c['srcOut'] * sr)
x[a:b] *= 10 ** (6 / 20)
sf.write(${JSON.stringify(dst)}, np.clip(x, -1, 1), sr)`]);
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 每句基础音量一致');
// 像同一个人（VOICE_PIPELINE.md「像同一个人」；用户听 E02 v13「每句话的声音都存在微小差异（包括音色、快慢、音量）」）：
// 「像这个孩子」是关卡；「相邻两句接得上」「整集不越说越偏」只给建议（这几项变好的配法盲听没赢过 v13）。改的是源配音，挑的是基线中间够长的句子
const sameSpeakerSrc = (pyBody) => (tl) => {
  const src = path.resolve('public', sbase.source), dst = path.resolve('public/audio/_selftest.source.wav');
  const tm = JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8'));
  const r = spawnSync(PY_MLX, ['-c', `
import sys, json; sys.path.insert(0, '.')
import soundfile as sf, numpy as np
from scipy.signal import resample
from voice import stretch
x, sr = sf.read(${JSON.stringify(src)}, dtype='float32')
m = (x if x.ndim == 1 else x[:, 0]).astype(np.float64)
sp = json.loads(${JSON.stringify(JSON.stringify(tm.sentences))})
long = [s for s in sp if s['end'] - s['start'] >= 2.5]
def shift(a, b, f):
    # 音高和共振峰一起乘 f（重采样），再变速回原长：像换了个嗓子大一点或小一点的孩子，快慢不变
    b = min(b, len(m)); seg = m[a:b].copy(); y = stretch(resample(seg, int(len(seg) / f)), 1 / f, sr)
    y = np.pad(y, (0, max(0, len(seg) - len(y))))[: len(seg)]
    m[a:b] = y * (np.sqrt((seg ** 2).mean()) / (np.sqrt((y ** 2).mean()) + 1e-12))
${pyBody}
sf.write(${JSON.stringify(dst)}, (m if x.ndim == 1 else np.repeat(m[:, None], x.shape[1], 1)).astype(np.float32), sr)`], { encoding: 'utf8', cwd: '../tts' });
  if (r.status !== 0) console.log((r.stderr || '').slice(-400));
  tl.source = 'audio/_selftest.source.wav';
  delete tl.audio;
  return { cleanup: [dst] };
};
// 只给建议的几条：基线自己就报了这条建议时，注入看不出抓没抓到，跳过并写明
const speechAdvice = (name, mutate, mustSay) => (noSpeech ? skip(name, noSpeech) : !b2 || b2.status !== 0 ? skip(name, '旁白基线没通过')
  : ((b2.stdout || '') + (b2.stderr || '')).includes(mustSay) ? skip(name, `基线自己就报了「${mustSay}」`) : expectFail(name, mutate, speech, mustSay, sbase));
// 声调：一个字整集都念成别的声调（多音字按拼音库的读法念、「拧旋钮」念成 níng；用户听 E03 样片）。
// 注入办法：基线里最常出现、走势和本调最一致的一个字，在读法表里把它改登记成别的声调；声调检查（tone_check.py，不用载模型，单独跑几秒）要报它整集念得不像
(() => {
  const name = '一个字整集都念成别的声调（拼音库标错的多音字，用户听 E03 样片「前半段有读错的」）';
  if (noSpeech) return skip(name, noSpeech);
  const nar = sbeatsSrc.narration || {};
  const audio = path.resolve('public', nar.audio || ''), timing = path.resolve('data', nar.timing || '');
  if (!nar.audio || !fs.existsSync(audio) || !fs.existsSync(timing)) return skip(name, '基线没有配音或逐字时间');
  const tone = (args) => spawnSync(PY_MLX, ['tone_check.py', audio, timing, ...args], { encoding: 'utf8', cwd: '../tts' });
  const j = path.resolve('build/_selftest.tone.json'), rd = path.resolve('build/_selftest.readings.json');
  tone(['--json', j]);
  const chars = fs.existsSync(j) ? JSON.parse(fs.readFileSync(j, 'utf8')).chars : {};
  const pick = Object.entries(chars).filter(([k, v]) => k.startsWith('|') && /^[一-鿿]$/.test(k.split('|')[1]) && v.agree >= 0.7).sort((a, b) => b[1].n - a[1].n)[0];
  if (!pick) return skip(name, '基线里没有出现够多、走势又一致的字');
  const [, ch, t] = pick[0].split('|');
  const own = JSON.parse(fs.readFileSync('../tts/readings.json', 'utf8'));
  const wrong = { 1: 3, 2: 4, 3: 1, 4: 2 }[t];
  fs.writeFileSync(rd, JSON.stringify({ ...own, chars: { ...own.chars, [ch]: `a${wrong}` } }));
  const r = tone(['--readings', rd]), out = (r.stdout || '') + (r.stderr || '');
  record(name, new RegExp(`整集一直念得不像${wrong}声[^\\n]*「${ch}」（该念 a${wrong}`).test(out), out);
  for (const f of [j, rd]) fs.rmSync(f, { force: true });
})();
speechCase('整集的嗓子都低了 12%（像换了个大一点的孩子；Qwen3 的「音色一致性」看不出来）', sameSpeakerSrc(`
for s in sp: shift(int(s['start'] * sr), int(s['end'] * sr), 0.88)`), '[失败] 像这个孩子');
speechAdvice('有一句的嗓子像换了个孩子（音高和共振峰一起抬 15%；原来的「每句都是同一个人」看不出来）', sameSpeakerSrc(`
s = long[len(long) // 2]; shift(int(s['start'] * sr), int(s['end'] * sr), 1.15)`), '[建议] 相邻两句接得上');
speechAdvice('越说越低（后三分之一每句都低 2 个半音，一次配长段时就是这样）', sameSpeakerSrc(`
for s in sp[len(sp) - len(sp) // 3:]: shift(int(s['start'] * sr), int(s['end'] * sr), 2 ** (-2 / 12))`), '[建议] 整集不越说越偏');
speechCase('旁白里一个字的开头被抹掉 80ms', (tl) => {
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, json, numpy as np
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips.at(-1)))})
a = int((c['at'] + 0.03) * sr)
k = a + int(np.argmax(np.abs(x[a:a + int(0.6 * sr)]) > 0.05))
x[k:k + int(0.08 * sr)] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 拼接后声音完整');
speechCase('旁白里一个字被吞掉（整个字弱 40dB）', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips[1], w = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut)[2];
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
x[int(${c.at + w.start - c.srcIn} * sr):int(${c.at + w.end - c.srcIn} * sr)] *= 0.01
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 没有吞字');
speechCase('句末的字被吞掉（整字静音）', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips.reduce((m, x) => (x.srcOut - x.srcIn > m.srcOut - m.srcIn ? x : m)), w = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut).at(-1);
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
x[int(${c.at + w.start - c.srcIn} * sr):int(${c.at + c.srcOut - c.srcIn} * sr)] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 没有吞字');
speechCase('字被压成 0ms、邻字也没变长（真吞掉，不是对齐毛病）', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8'));
  // 挑一个前后邻字时长都正常的字（不到中位数的 1.5 倍）：邻字本来就长时，检查会当成「对齐器把它并进邻字了」放过去，这个用例就测不到
  const med = [...timing.words.filter((x) => x.text.length === 1).map((x) => x.end - x.start)].sort((p, q) => p - q)[Math.floor(timing.words.length / 2)];
  const pickW = (ws) => ws.find((x, k) => k > 0 && k < ws.length - 1 && ws[k - 1].end - ws[k - 1].start < 1.5 * med && ws[k + 1].end - ws[k + 1].start < 1.5 * med);
  const c = tl.audioClips.find((x) => pickW(timing.words.filter((y) => y.start >= x.srcIn && y.end <= x.srcOut))), ws = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut), w = pickW(ws);
  const src = path.resolve('public', sbase.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
x[int(${c.at + w.start - c.srcIn} * sr):int(${c.at + w.end - c.srcIn} * sr)] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  w.end = w.start; // 配音时对齐把这个字压成 0ms，前后两个字的时长不变
  fs.writeFileSync('data/_selftest.timing.json', JSON.stringify(timing));
  fs.writeFileSync('data/_selftest.beats.json', JSON.stringify({ ...sbeatsSrc, id: '_selftest', narration: { ...sbeatsSrc.narration, timing: '_selftest.timing.json' } }));
  tl.beatsId = '_selftest';
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst, 'data/_selftest.timing.json', 'data/_selftest.beats.json'] };
}, '[失败] 没有吞字');
// 别的 TTS 音色（与真人录音相似度约 0.93）。样本是本机用在线朗读生成的，不进仓库
speechCase('旁白换成别的音色', (tl) => { tl.narration = OTHER_VOICE; delete tl.audio; }, '[失败] 音色一致性',
  noSpeech ?? (fs.existsSync(OTHER_VOICE) ? null : '本机没有别的音色样本 qa/fixtures/other-voice.mp3'));

// ---------- 分镜上的注入（渲染前：校验器与编译器版面/节奏规则） ----------
const acts = (b) => b.phrases.flatMap((p) => p.actions);
const firstText = (b) => acts(b).find((a) => a.type === 'text');
// advice：这条是创作取舍（风格规范 gates 里的 advice 级），要被报成「建议」而不是错误；只看建议那几行
const adviceOf = (out) => [...(out.match(/建议 \d+ 项：\n((?:\s+.*\n?)*)/) || [, ''])[1].split('\n'), ...[...out.matchAll(/^\s*\[建议\] (.*)$/gm)].map((m) => m[1])].join('\n');
// advice：要报成建议；any：报成建议或错误都算（注入的间距在不同基线上可能刚好压在一起，那就是错误）
function expectBeats(name, mutate, cmd, mustMatch, { advice = false, any = false } = {}) {
  if (SKIP.has('compile')) return skip(name, '这次没改编译器和分镜校验（--skip compile）');
  const b = structuredClone(beatsSrc);
  b.id = '_selftest';
  // 注入改的是动作上的 x/y 这些字段；基线分镜给编译画幅写了 layout 覆盖时，先把覆盖并进动作本身，改的位置才真的生效
  // （原来写死按 9:16 编译、改的是竖版坐标；只出横版的基线上，横版的 layout 覆盖把注入盖掉，几条「关闭自动修复」的注入永远漏掉）
  for (const a of acts(b)) {
    for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov);
    delete a.layout;
  }
  mutate(b);
  const p = 'data/_selftest.beats.json';
  fs.writeFileSync(p, JSON.stringify(b));
  const r = spawnSync('node', cmd(p), { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
  const hit = (txt) => (mustMatch instanceof RegExp ? mustMatch.test(txt) : txt.includes(mustMatch));
  record(name, any ? hit(out) : advice ? hit(adviceOf(out)) : r.status !== 0 && hit(out), out);
  fs.rmSync(p, { force: true });
  for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
}
const validate = (p) => ['compiler/validate.mjs', p];
const compileNoFix = (t) => (p) => ['compiler/compile.mjs', p, '--target', t, '--no-autofix'];


expectBeats('用了不存在的组件', (b) => { acts(b).at(-1).type = 'bulbb'; }, validate, '未知组件「bulbb」');
expectBeats('写了裸色值', (b) => { firstText(b).color = '#ff0000'; }, validate, '不是规范里的墨色');
expectBeats('字号不在字号阶梯上', (b) => { firstText(b).size = 75; }, validate, '不在字号阶梯', { advice: true });
expectBeats('手写汉字字号太小（会糊）', (b) => { acts(b).find((a) => a.type === 'text' && /\p{Script=Han}/u.test(a.text)).size = 48; }, validate, '小于手写汉字下限', { advice: true });
expectBeats('旁白里数字后面跟冒号（会读成「比」）', (b) => { b.narration.script = b.narration.script.replace(/(\d)。?/, '$1：'); }, validate, '读成「比」');
expectBeats('旁白里的数字没有出处', (b) => { b.facts = []; }, validate, '没有出处');
expectBeats('按句选情绪写的不是旁白稿里的一整句', (b) => { b.narration.mood = { '旁白稿里没有这句。': '好奇' }; }, validate, 'narration.mood');
expectBeats('文字里有手写字体没有的字（全角逗号）', (b) => { const t = b.phrases.flatMap((p) => p.actions).find((x) => x.type === 'text'); t.text += '，'; }, validate, '画不出来');
// 对话（compiler/speakers.mjs）：说话的人要登记；配音按句生成，换人只能在句末
expectBeats('对话：句子的说话人没在 narration.voices 里登记', (b) => { b.phrases[1].speaker = 'dad'; }, validate, '没在 narration.voices 里登记');
expectBeats('对话：一句话里换了说话的人', (b) => {
  b.narration.voices = { dad: { voice: 'voice.example.json', label: '爸爸' } };
  b.narration.script = b.narration.script.replace(/。/, '，'); // 头两句并成一句，第二句却是爸爸说的
  b.phrases[1].speaker = 'dad';
}, validate, '一句话里换了说话的人');
expectBeats('对话：字幕颜色不是调色板里的名字', (b) => { b.narration.voices = { dad: { voice: 'voice.example.json', caption: '#2b5f80' } }; }, validate, '不是规范调色板里的颜色名');
expectBeats('回看的句子指向还没画过的元素', (b) => { b.phrases[0].revisit = [b.phrases.at(-1).actions?.[0]?.id ?? 'nope']; b.phrases[0].actions = []; }, validate, 'revisit');
expectBeats('提示词不在这句旁白里', (b) => { acts(b).at(-1).at = '这句旁白里没有的词'; }, validate, '不在这句旁白里');
expectBeats('节名太长、章节不从第一句开始', (b) => { b.phrases.at(-1).chapter = '这是一个特别特别长的小节名字超过了十五个字'; }, validate, /节名要写，最多|从第一句开始/);
expectBeats('完整一集缺少钩子和回收', (b) => { b.kind = 'episode'; for (const q of b.phrases) if (['hook', 'recap'].includes(q.role)) q.role = 'setup'; }, validate, '必须有 role=hook', { advice: true }); // 基线本身是完整一集时，先把钩子和回收去掉
expectBeats('字幕太长会折成三行（标点之间也拆不开）', (b) => { b.phrases[0].caption = '这是一句特别特别长而且中间一个标点也没有的字幕长到在哪个画幅上都要折成好几行观众根本来不及看完所以必须拆成短句再配画面'; }, validate, '请拆句');
expectBeats('回描引用了还没画的元素', (b) => { b.phrases[0].actions.push({ id: '_rt', type: 'retrace', at: b.phrases[0].actions[0].at, target: b.phrases.filter((q) => q.actions?.length).at(-1).actions.at(-1).id }); }, validate, '不存在或还没画');
expectBeats('两个图形的墨迹相切（关闭自动修复）', (b) => {
  const p = b.phrases.find((q) => q.actions.some((a) => a.type === 'circle')), c = p.actions.find((a) => a.type === 'circle');
  p.actions.push({ id: '_tan', type: 'circle', at: c.at, cx: c.cx + c.r * 2 + 3, cy: c.cy, r: c.r });
}, compileNoFix(TGT), '墨迹只隔', { advice: true });
expectBeats('箭头尖碰到后来画的红圈（关闭自动修复）', (b) => {
  // 写一段字、圈出来，再让一根箭头的尖正好落在圈上：圈是装饰，箭头尖碰到它不算「接上」
  // 最后几句可能不画（片尾全景），取最后一句有动作的；回看句不算（镜头只框回看的那几样，新写的字在画外，报的是别的问题，E02 v5 起回顾句也描东西）
  const p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1), at = p.actions[0].at;
  p.actions.push({ id: '_t', type: 'text', at, text: 'AB', x: 640, y: 1150, size: 72 });
  p.actions.push({ id: '_ring', type: 'ring', at, target: '_t' });
  p.actions.push({ id: '_arw', type: 'arrow', at, from: [360, 1150], to: [578, 1150] });
}, compileNoFix(TGT), /「_ring」和「_arw」的墨迹只隔|「_arw」和「_ring」的墨迹只隔/, { advice: true });
expectBeats('顿悟句推不近又没声明', (b) => {
  // 顿悟句的焦点圈住画面最上面的字和下面远处新写的一行：焦点装不下，推不近；分镜没写 noPush，编译要报
  const p = b.phrases.find((q) => q.role === 'aha'), top = acts(b).find((a) => a.type === 'text');
  p.actions.push({ id: '_far', type: 'text', at: p.actions[0].at, text: '1=1', x: top.x, y: top.y + 1000, size: 72 });
  p.focus = [top.id, '_far'];
}, (p) => ['compiler/compile.mjs', p, '--target', TGT], /推不近.*noPush/, { advice: true });
{
  // 分镜写了 noPush，这个画幅的顿悟句就不能推近（原来只是不报建议，镜头照样推近 1.5 倍）
  const b = structuredClone(beatsSrc); b.id = '_selftest';
  const p = b.phrases.find((q) => q.role === 'aha'); p.noPush = [TGT];
  fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
  const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
  const tlp = `build/_selftest-${TGT}.timeline.json`, tl = fs.existsSync(tlp) ? JSON.parse(fs.readFileSync(tlp, 'utf8')) : null;
  const ids = new Set(p.actions.map((a) => a.id)), pushed = tl?.camera.find((m) => m.focus && m.focus.some((id) => ids.has(id)) && (m.to.push ?? 1) > 1.001);
  record('分镜声明 noPush 的顿悟句真的不推近', !!tl && !pushed, out + (pushed ? `\n推近了：${JSON.stringify(pushed.to)}` : ''));
  fs.rmSync('data/_selftest.beats.json', { force: true });
  for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
}
expectBeats('标签压线（关闭自动修复）', (b) => { const v = firstText(b), c = acts(b).find((a) => a.type === 'circle'); v.x = c.cx; v.y = c.cy - c.r; }, compileNoFix(TGT), /离 .* 只有/, { advice: true });
expectBeats('两段文字压在一起（关闭自动修复，仍判错误）', (b) => {
  const t = firstText(b);
  b.phrases[0].actions.push({ id: '_on', type: 'text', at: t.at, text: t.text, x: t.x, y: t.y, size: t.size });
}, compileNoFix(TGT), /「_on」|离 _on/);
expectBeats('同一行两个文字标签贴太近（关闭自动修复）', (b) => {
  const t = firstText(b);
  b.phrases[0].actions.push({ id: '_row', type: 'text', at: t.at, text: '57', x: t.x + t.size * 1.6, y: t.y, size: 56 });
}, compileNoFix(TGT), /在同一行，横向只有/, { any: true });
{
  // 私有创作配置把一项建议升成 hard：同样的缺陷就要判失败（用户可以把自己在意的取舍收紧）
  const prof = path.resolve('build/_selftest.profile.json');
  fs.writeFileSync(prof, JSON.stringify({ gates: { 'type.scale': 'hard' } }));
  const b = structuredClone(beatsSrc); b.id = '_selftest'; firstText(b).size = 75;
  fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
  const r = spawnSync('node', ['compiler/validate.mjs', 'data/_selftest.beats.json'], { encoding: 'utf8', env: { ...process.env, SKETCH_PROFILE: prof } }), out = (r.stdout || '') + (r.stderr || '');
  record('私有创作配置把「字号阶梯」升成 hard 后判错误', r.status !== 0 && /\[错误\].*不在字号阶梯/.test(out), out);
  fs.rmSync('data/_selftest.beats.json', { force: true }); fs.rmSync(prof, { force: true });
}
// 写在画面上的字，旁白下一句才说到（用户看 E02 v5「开头有点音画不同步」：先写了「规则」，下一句「它不背规则」才说到）
{
  // 先在基线分镜里找注入点：一句 i 和它后面隔一句以上的 j，j 里有个连着的两字词，i 说完以前、以及 i 和 j 之间都没说过。
  // 只从原句里真正连着的汉字里挑（去掉数字再拼会拼出旁白里没有的词，演示片「2加2等于4」拼成「加等」，注入落空）；挑不到就跳过
  const cjkRuns = (t) => t.match(/[一-鿿]{2,}/g) ?? [];
  const said = (a, z) => beatsSrc.phrases.slice(a, z).map((q) => q.text).join('|');
  let at = null;
  for (let i = 0; i < beatsSrc.phrases.length - 2 && !at; i++) {
    const pi = beatsSrc.phrases[i];
    if (!pi.actions?.length || pi.revisit?.length || pi.camera) continue;
    for (let j = i + 2; j < beatsSrc.phrases.length && !at; j++) for (const run of cjkRuns(beatsSrc.phrases[j].text)) {
      for (let k = 0; k + 2 <= run.length && !at; k++) { const w = run.slice(k, k + 2); if (!said(0, j).includes(w)) at = { i, w }; }
    }
  }
  if (!at) skip('一个词先写在画面上，旁白隔一句才说到', '基线分镜太短，找不到隔一句才说到的词');
  else expectBeats('一个词先写在画面上，旁白隔一句才说到', (b) => {
    const a0 = b.phrases[at.i].actions[0];
    b.phrases[at.i].actions.push({ id: '_ahead', type: 'text', at: a0.at, text: at.w, x: (a0.x ?? a0.cx ?? 400) + 40, y: (a0.y ?? a0.cy ?? 400) + 160, size: 72 });
  }, (p) => ['compiler/compile.mjs', p, '--target', TGT], /才说到/, { any: true });
}
// 同一句里字比话早写（审片 E02 v6：在「美国科学家」上就写「罗森布拉特」，早 1.1 秒）：挑一句较长的话，在它第一个词上写它最后两个字
{
  // 先在基线分镜里找：一句话汉字够多（≥10 个），句首有个连着的两字词当提示词，句末那个连着的两字词这句之前没说过、在这句里只出现一次
  const runs = (t) => t.match(/[一-鿿]{2,}/g) ?? [];
  const before = (i) => beatsSrc.phrases.slice(0, i).map((q) => q.text).join('|');
  const k = beatsSrc.phrases.findIndex((q, i) => {
    const rs = runs(q.text), w = rs.at(-1)?.slice(-2);
    return q.actions?.length && !q.revisit?.length && !q.camera && rs.join('').length >= 10 && rs.length && w && q.text.endsWith(w) && q.text.indexOf(w) === q.text.length - 2 && !before(i).includes(w);
  });
  if (k < 0) skip('同一句里，句末的词在句首就写出来', '基线分镜没有够长的句子');
  else expectBeats('同一句里，句末的词在句首就写出来', (b) => {
    const q = b.phrases[k], rs = runs(q.text), w = rs.at(-1).slice(-2), a0 = q.actions[0];
    q.actions.push({ id: '_early', type: 'text', at: rs[0].slice(0, 2), text: w, x: (a0.x ?? a0.cx ?? 400) + 40, y: (a0.y ?? a0.cy ?? 400) + 160, size: 72 });
  }, (p) => ['compiler/compile.mjs', p, '--target', TGT], /早写了/, { any: true });
}
// 多音字：结构助词「地」（用户听 E02 v5：「细细地讲」念成了 dì）
expectBeats('旁白稿里写了「慢慢地」（「地」会念成 dì）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，我们慢慢地看。');
}, validate, /「慢慢地」.*念 de/, { any: true });
// 自测题只考复述（用户：E02 v5 理解度 5/5，可 1958 那段很多人理解不过来）
if (!(beatsSrc.quiz ?? []).length) skip('自测题全是复述题，没有一道解释或迁移题', '基线分镜没有自测题（演示片段不要求）');
else expectBeats('自测题全是复述题，没有一道解释或迁移题', (b) => {
  b.brief = { ...(b.brief ?? {}), objectives: b.brief?.objectives?.length ? b.brief.objectives : ['能说出这一集讲的东西'] };
  for (const q of b.quiz ?? []) { q.kind = 'recall'; q.objective = 0; }
}, validate, /没有一道 explain 或 transfer 题/, { any: true });
// 写稿自查（compiler/script_checks.mjs；E02 v6–v13 理解度测试每轮找出的「靠猜」）。注入都自己带上要用的旁白，不挑基线：演示片段和每一期都能跑
const FILL = '这一句是补上的。'.repeat(4); // 把「讲清它的那半句」推到第一次说到之后四句（要求三句以内）
expectBeats('写稿自查：新词第一次说到以后，隔了好几句才讲清', (b) => {
  b.kind = 'episode';
  b.narration.script = `嘎嘣来了。${b.narration.script}${FILL}嘎嘣就是一种声音。`;
  b.brief = { ...(b.brief ?? {}), terms: [{ term: '嘎嘣', explain: '嘎嘣就是一种声音' }] };
}, validate, /「嘎嘣」.*隔了 \d+ 句/, { any: true });
expectBeats('写稿自查：换成新例子，没写怎么接上熟悉的例子', (b) => {
  b.kind = 'episode';
  b.narration.script = `给它看一张卡片，卡片上有个记号。${b.narration.script}`;
  b.brief = { ...(b.brief ?? {}), terms: [{ term: '卡片', kind: 'example', explain: '卡片上有个记号' }] };
}, validate, /「卡片」.*没写 bridge/, { any: true });
expectBeats('写稿自查：画面上写了一个旁白没说过的数', (b) => {
  const p = b.phrases.find((q) => q.actions?.length && !q.revisit?.length && !q.camera), a0 = p.actions[0];
  p.actions.push({ id: '_num', type: 'text', at: a0.at, text: '37', x: (a0.x ?? a0.cx ?? 400) + 40, y: (a0.y ?? a0.cy ?? 400) + 160, size: 72 });
}, validate, /其中的 37 旁白到这句.*还没说到/, { any: true });
expectBeats('写稿自查：开场的小故事后面没再提到', (b) => {
  b.kind = 'episode';
  const p = b.phrases[0];
  p.role = 'hook'; p.text = '火星上的兔子会不会弹钢琴'; p.caption = '火星上的兔子，会不会弹钢琴？';
  for (const a of p.actions ?? []) a.at = '火星';
  delete b.brief?.payoff;
}, validate, /开场的小故事.*在后面没再提到/, { any: true });
expectBeats('写稿自查：留给下一集的不是一个问题', (b) => {
  b.kind = 'episode';
  for (const q of b.phrases) if (q.role === 'next') q.role = 'recap'; // 基线自己的预告（E02 已经是问句）先去掉，只留注入的这一句
  const p = b.phrases.at(-1);
  p.role = 'next'; p.text = '下一集我们接着讲'; p.caption = '下一集，我们接着讲';
  b.narration.script += '下一集，我们接着讲。';
}, validate, /没有说成一个问题/, { any: true });
expectBeats('写稿自查：预告的问题用了这一集没讲过的词', (b) => {
  b.kind = 'episode';
  const p = b.phrases.at(-1);
  p.role = 'next'; p.text = '下一集它怎么学会反向传播'; p.caption = '下一集，它怎么学会反向传播？';
  b.narration.script += '下一集，它怎么学会反向传播？';
}, validate, /「反向.*前面没讲过/, { any: true });
expectBeats('写稿自查：示意数值的来历在用它之后才交代', (b) => {
  b.kind = 'episode';
  b.narration.script = `加起来等于97。${b.narration.script}${FILL}97是我们随便定的。`;
  b.facts = [...(b.facts ?? []), { match: ['97'], kind: 'example', from: { 97: '97是我们随便定的' } }];
}, validate, /97 在第 1 句.*就用上了/, { any: true });
{
  // 理解度打分：关键词全对，但测试者说有一处跟不上、视频也没说下一集讲——要判不过（悬念可以，一头雾水不行）
  const bp = path.resolve('data', `${base.beatsId ?? base.id}.beats.json`), b = JSON.parse(fs.readFileSync(bp, 'utf8'));
  if ((b.quiz ?? []).length) {
    const f = path.resolve('build/_selftest.answers.json');
    fs.writeFileSync(f, JSON.stringify({ answers: b.quiz.map((q, i) => ({ id: i + 1, a: q.keywords.map((g) => g[0]).join('，') })), unclear: [{ where: '第 3 节', what: '从上一个例子一下跳到这里，没交代，只能猜', later: false, state: '靠猜' }] }));
    const r = spawnSync(PY_QA, ['qa/comprehension.py', 'score', bp, f], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
    record('理解度：题都答对，但有一处跟不上、又不是留给下一集的', r.status !== 0 && out.includes('[失败] 跟不上'), out);
    fs.rmSync(f, { force: true });
  } else skip('理解度：有一处跟不上', '基线分镜没有自测题');
}
expectBeats('标签在旁白说完后才写（关闭自动修复）', (b) => {
  const p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1), a0 = p.actions[0];
  p.actions.push({ id: '_late', type: 'text', at: a0.at, text: '这一行字太长了来不及跟上旁白', x: 490, y: 1300, size: 72 });
}, compileNoFix(TGT), /说完后才起笔|和本句旁白重叠/, { advice: true });

// 配音风险（script.tts，只给建议）：很短的问句、含以前被听错过的字的句子（E03 两句爸爸的短问句被听错）。注入的句子和听错记录都自己带
// 回描（script.retrace，只给建议）：刚画完、就在画面里的东西又描一遍（E03 样片 28 句 36 处回描，用户：太多了）。注入：一句不是顿悟的句子，回描它自己刚画的东西
expectBeats('写稿自查：回描这句刚画的东西（重复，不是指回旧东西，也不是顿悟）', (b) => {
  const p = b.phrases.find((q) => q.role !== 'aha' && (q.actions ?? []).some((a) => a.type !== 'retrace' && a.type !== 'strike'));
  const a0 = p.actions.find((a) => a.type !== 'retrace' && a.type !== 'strike');
  p.actions.push({ id: '_rt', type: 'retrace', at: a0.at, target: a0.id });
}, validate, /_rt：回描「[^」]+」.*就是这句画的/, { advice: true });
expectBeats('写稿自查：只有几个字的问句（配音容易念含糊、被听错）', (b) => {
  b.narration.script = `${b.narration.script}嘎嘣呢？`;
}, validate, /「嘎嘣呢？」.*只有 3 个字的问句/, { advice: true });
{
  const f = path.resolve('build/_selftest.misheard.json');
  fs.writeFileSync(f, JSON.stringify({ pairs: [{ said: '咕噜转一圈。', heard: '骨路转一圈', risky: ['咕噜'] }] }));
  process.env.TTS_MISHEARD = f;
  expectBeats('写稿自查：句子里有以前被听错过的字（tts/misheard.json）', (b) => {
    b.narration.script = `${b.narration.script}它咕噜咕噜地转。`;
  }, validate, /「咕噜」以前被听错过.*1 句有它/, { advice: true });
  delete process.env.TTS_MISHEARD;
  fs.rmSync(f, { force: true });
}
// 配音逐句验收（tts/voice.py 的 line_defects，qwen_clone.py 每个候选、退路、缓存复查和整段切出来的句子都用它）：
// 掉嗓子、破音、硬切、语速离目标超过 maxDev，各造一条合成音，每条都要被点名，干净的那条不能被点名。阈值是 voice.json 的写法，这里给一份固定的
if (SKIP.has('speech') || !PY_MLX) skip('配音逐句验收：掉嗓子、破音、硬切、语速（单元检查）', SKIP.has('speech') ? '这次没改配音和旁白检查（--skip speech）' : '没有本地配音环境（PY_MLX）');
else {
  const r = spawnSync(PY_MLX, ['-c', `
import sys, json, numpy as np
sys.path.insert(0, '.')
from voice import line_defects, soften_edges
sr = 24000; sil = np.zeros(int(0.2 * sr))
V = {"pitchFloorHz": 200, "takeNoBreaks": True, "rate": {"target": 4.0, "maxDev": 0.1, "minChars": 3}}
def voiced(f):  # 按逐帧频率合成，带一个二次谐波，像人声一样有基频
    ph = 2 * np.pi * np.cumsum(f) / sr
    return 0.3 * np.sin(ph) + 0.15 * np.sin(2 * ph)
flat = lambda hz, d: np.full(int(d * sr), float(hz))
soft = lambda x: np.concatenate([sil, soften_edges(x, sr, 30), sil])
W = lambda n, d: [{"text": "字", "start": i * d / n, "end": (i + 1) * d / n} for i in range(n)]
cases = {
  "干净": line_defects(soft(voiced(flat(300, 1))), sr, W(4, 1), V),
  "硬切": line_defects(np.concatenate([sil, voiced(flat(300, 1)), sil]), sr, W(4, 1), V),
  "掉嗓子": line_defects(soft(voiced(flat(120, 1))), sr, W(4, 1), V),
  "破音": line_defects(soft(voiced(np.r_[flat(300, 0.5), flat(750, 0.08), flat(300, 0.5)])), sr, W(4, 1.08), V),
  "语速": line_defects(soft(voiced(flat(300, 1))), sr, W(6, 1), V),
}
print(json.dumps(cases, ensure_ascii=False))`], { encoding: 'utf8', cwd: '../tts' });
  let got = {}; try { got = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {}
  const ok = got['干净']?.length === 0 && ['硬切', '掉嗓子', '破音', '语速'].every((k) => got[k]?.some((m) => m.startsWith(k)));
  record('配音逐句验收：掉嗓子、破音、硬切、语速（单元检查）', ok, (r.stdout || '') + (r.stderr || ''));
}

// ---------- 墨迹叠色：换回 v9 以前每个元素一层、层间相乘的叠法，渲染小样上两项都必须失败 ----------
{
  const r = spawnSync('node', ['qa/ink_check.mjs', '--old'], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
  record('墨迹换回旧叠法（交叠处发黑、红压灰成暗褐）', r.status !== 0 && out.includes('[失败] 交叠处不发黑') && out.includes('[失败] 红笔盖住灰笔仍是红色'), out);
  spawnSync('node', ['qa/ink_check.mjs'], { encoding: 'utf8' }); // 恢复正常小样
}

// ---------- 组件库：放进一个会画出非法坐标的组件，组件测试必须失败 ----------
{
  const f = 'library/components/_selftest_broken.mjs';
  fs.writeFileSync(f, "export default { meta: { name: 'broken', title: '坏组件', desc: '自测用', params: { x: { type: 'number', required: true } }, example: { x: 0 } }, draw: (a, k) => [k.S([[a.x, NaN], [a.x + 10, 0]], false)] };\n");
  try {
    const r = spawnSync('node', ['library/test.mjs'], { encoding: 'utf8' }), out = r.stdout + r.stderr;
    record('组件画出非法坐标', r.status !== 0 && /broken：/.test(out), out);
  } finally { fs.rmSync(f, { force: true }); }
}

// ---------- 字幕折行（单元检查）：行首不出现收尾标点（审片发现「…权重：4 / 、3、2」）；不在词中间断；
// 两行字数差不超过 3（审片发现「每个输入，/都要乘上自己的权重：4、3、2」5 字对 15 字）----------
{
  const { breakLines, NO_LINE_START } = await import('../compiler/validate.mjs');
  const cases = ['每个输入，都要乘上自己的权重：4、3、2', '我们把门槛定在 5，超过它，灯才会亮', '它有三个输入：x₁、x₂、x₃，这次分别是 1、1、0，然后呢？'];
  const out = cases.map((c) => breakLines(c, 52, 840));
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const atWordEdge = (c, L) => { const edges = new Set([...seg.segment(c)].map((g) => g.index)); let i = 0; return L.slice(0, -1).every((l) => { i = c.indexOf(l, i) + l.length; while (c[i] === ' ') i++; return edges.has(i) || edges.has(i - 1) && c[i - 1] === ' '; }); };
  const ok = out.every((L) => L.every((l) => !NO_LINE_START.test(l[0])))
    && cases.every((c, k) => atWordEdge(c, out[k]))
    && out.every((L) => L.length < 2 || Math.max(...L.map((l) => [...l].length)) - Math.min(...L.map((l) => [...l].length)) <= 3);
  record('字幕折行把标点放到行首（单元检查）', ok, JSON.stringify(out));
}

const missed = results.filter((r) => !r.caught);
const why = [...new Set(skipped.map((s) => s.why))];
console.log(`\n检查器自测：${results.length} 个注入缺陷，抓到 ${results.length - missed.length} 个${missed.length ? `，漏掉：${missed.map((m) => m.name).join('、')}` : ''}${skipped.length ? `；跳过 ${skipped.length} 个（${why.join('；')}）` : ''}`);
process.exit(missed.length || b1.status !== 0 || (b2 && b2.status !== 0) ? 1 : 0);
