// 检查器自测：对一份已通过的时间线/分镜注入已知缺陷，每一项检查都必须报出来；否则说明检查形同虚设。
// 引擎、组件库、风格规范或检查器改动后先跑这个。用法：node qa/selftest.mjs build/<id>-<画幅>.timeline.json [--skip speech]（任何画幅都行：平台界面、版式类注入按这条基线的画幅和界面算；按改了什么跳过整组：--skip speech（没改配音和旁白检查）、--skip compile（没改编译器和分镜校验），可以写成 --skip speech,compile）
// 注入目标按类型和时间挑（文字、图形、推近镜头……），不认某一期的元素名，演示分镜和每一期都能当基线；CI 跑的是演示分镜。
// 旁白类注入要真人配音和本地配音环境：配音是合成提示音（演示分镜）或没有 PY_MLX 时整组跳过，结果里写明跳过了哪些、为什么。
import '../compiler/node_version.mjs'; // 先查 Node 版本
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PY_QA, PY_MLX } from './pyenv.mjs';
import { strip, loadStyle } from '../compiler/validate.mjs';
import { PENLESS } from '../library/index.mjs';
const { cameraAt, penAt, idleAfterCamera, pastedOf, stickerInk } = await import('../src/timeline.ts'); // .ts 用 await import：Node 版本低时先看到上面那条说明

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
  record(name, extra.expect ? extra.expect(out) : out.includes(mustSay), out); // expect：注入时才知道要点名什么（逐句回转点名的那一句）
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
// 旁白检查写的 <时间线>.revoice.json（流水线据此自动换种子重配）：注入用例要它点名该点的句子。基线的 timing 没有 sentences 时旁白检查不点名，返回 null
const REVOICE = path.resolve('build/_selftest.timeline.revoice.json');
const revoiced = () => { try { return JSON.parse(fs.readFileSync(REVOICE, 'utf8')); } catch { return []; } };
const sentencesOf = () => JSON.parse(fs.readFileSync(path.resolve('data', sbeatsSrc.narration.timing), 'utf8')).sentences ?? null;

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
// ok：另加的条件（比如这段时间里笔一直在画面里）
function textFreeOfRest(tl, dur, ok = () => true) {
  const busy = (a, b) => tl.penTrack.some((s) => s.kind === 'rest' && s.t1 - s.t0 >= 0.5 && s.t0 < b && s.t1 > a);
  return [...Map.groupBy(tl.strokes, (x) => x.action).values()].find((q) => q.every(isText) && !busy(q.at(-1).t1 + 0.05, q.at(-1).t1 + 0.05 + dur) && ok(q));
}
// 推近镜头的焦点墨迹：笔画，加上贴在焦点里的贴图、贴视频的外轮廓（和安全区检查同一套）
const focusPts = (tl, m) => [...tl.strokes, ...pastedOf(tl).map(stickerInk)].filter((s) => m.focus.includes(s.action)).flatMap((s) => s.pts);
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
  // 在一句旁白里插四段 0.7 秒的原地「移动」，笔身横在一段已写的文字上，中间隔 0.1 秒：连续的检查拦不住，累计的要拦住。
  // 挑的文字要在这 3.2 秒里一直和笔一起留在画面里：镜头推走、笔尖出了画面的那几帧检查不算（演示分镜贴了视频以后，推近把标题推出了画面）
  const across = (q) => restAcross(tl, q.flatMap((x) => x.pts), q.at(-1).t1 + 0.05);
  const inCanvas = (q) => { const r = across(q); for (let t = r.t0; t <= r.t0 + 3.2; t += 0.1) { const [x, y] = toScreen(tl, r.at, t); if (x < 0 || x > tl.canvas.w || y < 0 || y > tl.canvas.h) return false; } return true; };
  const g = textFreeOfRest(tl, 3.2, inCanvas) ?? textFreeOfRest(tl, 3.2), r = across(g);
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
// 镜头到位后对着空纸讲（camera.idle，默认建议级；私有配置可能升成 hard，所以只认点名，不认级别）：挑一次到位时没在写、之后旁白还要讲一阵的换取景，
// 把到位以后的画面（笔画、笔的轨迹、发光、后面的镜头）整体往后推，旁白不动——就是 E05 v1 换节镜头提前飞走、对着空纸讲 7 秒的样子
{
  const MAXI = base.style?.motion?.maxIdleAfterMove ?? 2.5, D = MAXI + 1;
  const talk = (a, b) => (base.audioClips ?? []).reduce((s, c) => s + Math.max(0, Math.min(b, c.at + c.srcOut - c.srcIn) - Math.max(a, c.at)), 0);
  const cand = idleAfterCamera(base).find((x) => base.camera.some((m) => m.t1 === x.arrive) && x.idle <= MAXI && talk(x.arrive, x.arrive + D) > MAXI + 0.3); // 到位时没在写的那种
  if (!cand) skip('镜头到位后画面晚了几秒才动（对着空纸讲）', '基线里没有到位后旁白还要讲几秒的换取景');
  else expectFail('镜头到位后画面晚了几秒才动（对着空纸讲）', (tl) => {
    // 到位那一刻起的都推后（时间线里的时刻是取整过的，第一笔常和到位同一个数，留 0.01 秒余量）；到位的那次镜头移动本身不动
    const t = cand.arrive - 0.01, sh = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && o[k] >= t) o[k] += D; };
    for (const s of tl.strokes) sh(s, 't0', 't1');
    for (const m of tl.penTrack) sh(m, 't0', 't1');
    for (const e of tl.effects ?? []) sh(e, 't0', 't1', 't2', 't3');
    for (const k of pastedOf(tl)) sh(k, 't0', 't1', 'play', 'end'); // 贴图、贴视频也推后（放着的视频算画面在动）
    for (const m of tl.camera) if (m.t1 !== cand.arrive) sh(m, 't0', 't1');
  }, pencil, `${cand.arrive.toFixed(2)}s 到位`);
}
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
{
  // 回看时笔退到画外以后，又从画外慢慢滑回画面里（审 #73）：挑一段笔在画面中间一带的轨迹，改成「退场 → 从画外滑回原处 → 原地停到换节」
  const posOf = (sg) => { const q = penAt(base, sg.t0); return { at: [q.x, q.y], s: toScreen(base, [q.x, q.y], sg.t0) }; };
  const inMid = ({ s: [x, y] }) => x > base.canvas.w * 0.2 && x < base.canvas.w * 0.8 && y > base.canvas.h * 0.2 && y < base.canvas.h * 0.8;
  const pick = base.penTrack.filter((sg) => sg.t1 - sg.t0 >= 0.4 && inMid(posOf(sg))).sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0))[0];
  if (!pick) skip('退场以后笔又滑回画面', '基线里没有笔在画面中间、够长的一段轨迹');
  else expectFail('退场以后笔又滑回画面', (tl) => {
    const i = tl.penTrack.findIndex((x) => x.t0 === pick.t0 && x.t1 === pick.t1 && x.kind === pick.kind), sg = tl.penTrack[i];
    const c = cameraAt(tl.camera, sg.t0), d = (sg.t1 - sg.t0) / 4, P = posOf(pick).at, off = [c.x + (tl.canvas.w + 600 - tl.view.cx) / c.z, P[1]];
    tl.penTrack.splice(i, 1,
      { kind: 'move', t0: sg.t0, t1: sg.t0 + d, from: P, to: off, exit: true },
      { kind: 'move', t0: sg.t0 + d, t1: sg.t0 + 3 * d, from: off, to: P },
      { kind: 'rest', t0: sg.t0 + 3 * d, t1: sg.t1, at: P, chapter: true });
  }, pencil, '[失败] 退场后笔不回画面');
}
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
// 贴图（被依赖那一集的封面）也是内容：外轮廓和笔画一样查（每集能单独看，用户 2026-11-11）。贴一张卡片，镜头停稳时它的下半截落在字幕衬底底下
expectFail('镜头停稳时贴图压在字幕衬底底下', (tl) => {
  const m = tl.camera.find((x) => !x.focus && x.t1 > x.t0) ?? tl.camera[0], c = m.to;
  const y = c.y + (subTop(tl) + 10 - tl.view.cy) / c.z; // 卡片中心落在字幕上沿下面 10px
  tl.stickers = [{ id: '_stk', href: 'data:image/svg+xml;base64,', cx: c.x, cy: y, w: 300 / c.z, h: 170 / c.z, tilt: -3, t0: Math.max(0, m.t1 - 0.6), t1: Math.max(0.1, m.t1 - 0.1), card: '#ffffff', tape: '#e6d7ad', shade: '#3c2a12' }];
}, safezone, '[失败] 镜头停稳时内容不进字幕区');
// 贴视频也是内容：同一套外轮廓。镜头停稳时这块小屏幕的下半截落在字幕衬底底下
expectFail('镜头停稳时贴视频压在字幕衬底底下', (tl) => {
  const m = tl.camera.find((x) => !x.focus && x.t1 > x.t0) ?? tl.camera[0], c = m.to;
  const y = c.y + (subTop(tl) + 10 - tl.view.cy) / c.z;
  tl.clips = [{ id: '_clp', src: 'clips/_selftest.mp4', sha: '0', duration: 2, cx: c.x, cy: y, w: 300 / c.z, h: 170 / c.z, tilt: 2, t0: Math.max(0, m.t1 - 0.6), t1: Math.max(0.1, m.t1 - 0.1), play: Math.max(0.1, m.t1 - 0.1), end: m.t1 + 1.9, from: 0, to: 2, rate: 1, bezel: '#3b3632', tape: '#e6d7ad', shade: '#3c2a12', warm: { sepia: 0, saturate: 1 } }];
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
  const pts = focusPts(tl, m), fy = (Math.min(...pts.map((q) => q[1])) + Math.max(...pts.map((q) => q[1]))) / 2;
  m.to = { ...m.to, y: fy + (0.35 * (tl.frame.b - tl.frame.t)) / m.to.z };
}, safezone, '[建议] 推近时焦点在画面中部');
{ // 推近镜头把焦点内容推进顶部平台界面：按基线画幅实际的顶部界面算（原来写死 TikTok 顶栏的 650px，16:9 上整段推出画外，查不出来）
  const top = uiZones(base).find((z) => z.t <= 2 && z.r - z.l >= base.canvas.w / 2);
  if (top) expectFail(`推近镜头把焦点内容推进 ${top.pf} 的${top.name}`, (tl) => {
    const m = tl.camera.find((x) => x.focus && (x.to.push ?? 1) > 1.001);
    const pts = focusPts(tl, m), fy = (Math.min(...pts.map((q) => q[1])) + Math.max(...pts.map((q) => q[1]))) / 2;
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
  // 中位数超了：最高的那几句要进 revoice.json 自动换种子重配（tts/revoice.py 的 median_over）
  return { cleanup: [dst, REVOICE], expect: (out) => out.includes('[失败] 说话时没有沙沙声') && (!sentencesOf() || revoiced().length > 0) };
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
  // 超过上限的那一句（最后一段里的句子）要进 revoice.json 自动换种子重配（e02-voyager 一句 112ms，原来只能手写 reseed）
  const S = sentencesOf(), c = sbase.audioClips.at(-1);
  const last = (S ?? []).filter((s) => s.end > c.srcIn + 0.05 && s.start < c.srcOut - 0.05).map((s) => s.text);
  return { cleanup: [dst, REVOICE], expect: (out) => out.includes('[失败] 每句没有回声') && (!S || revoiced().some((t) => last.includes(t))) };
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
// 逐句回转（speech.lineAsr，tts/line_asr.py）：整段的「总混可懂度」放 2%，e01-benchmark「卷子」的「卷」念成「阵」（707 个字错 1 个）过了；
// 句首「写」的字头在总混里被背景乐盖住听成「野」，干声对。注入：挑中间一段够长的旁白，把一个字的声音换成另一个字（声母、韵母都不一样，
// 时长相近，取它中间那一截、两头 5ms 交叉淡化）的声音。干声那条换源配音（不留总混，只查干声）；总混那条只换总混、换这一段的第一个字，
// 干声不动。检查要点名那一句、写进 revoice.json，总混那条还要说明「只有总混错」。基线的关卡级别可能是建议，注入时设成 hard
const swapChar = (where) => (tl) => {
  const from = where === 'src' ? sbase.source : sbase.audio, dst = path.resolve(`public/audio/_selftest.${where}.wav`);
  const rv = path.resolve('build/_selftest.timeline.revoice.json');
  const r = spawnSync(PY_MLX, ['-c', `
import json, numpy as np, soundfile as sf
from pypinyin import pinyin, Style
W, S = (lambda t: (t['words'], t['sentences']))(json.load(open(${JSON.stringify(path.resolve('data', sbeatsSrc.narration.timing))})))
C = json.loads(${JSON.stringify(JSON.stringify(sbase.audioClips))})
x, sr = sf.read(${JSON.stringify(path.resolve('public', from || ''))}, dtype='float64')
cjk = lambda t: len(t) == 1 and '一' <= t <= '鿿'
py = lambda t, st: pinyin(t, style=st, strict=False)[0][0]
inside = lambda c: [k for k, w in enumerate(W) if w['start'] >= c['srcIn'] - 1e-3 and w['end'] <= c['srcOut'] + 1e-3]
ci = sorted([i for i, c in enumerate(C) if len(inside(C[i])) >= 8], key=lambda i: abs(i - len(C) / 2))[0]
c, ks = C[ci], inside(C[ci])
tk = next(k for k in (ks[:3] if ${where === 'mix' ? 'True' : 'False'} else ks[len(ks) // 3:]) if cjk(W[k]['text']))  # 总混那条换开头的字（开头是数字、字母就往后挪一两个）
tw = W[tk]; td = tw['end'] - tw['start']
far = [k for k, w in enumerate(W) if cjk(w['text']) and k not in ks and w['end'] - w['start'] >= td
       and py(w['text'], Style.INITIALS) != py(tw['text'], Style.INITIALS) and py(w['text'], Style.FINALS) != py(tw['text'], Style.FINALS)]
dk = min([k for k in far if W[k]['end'] - W[k]['start'] <= 1.6 * td] or far, key=lambda k: abs(W[k]['end'] - W[k]['start'] - td))
dw = W[dk]; dc = next(q for q in C if q['srcIn'] - 1e-3 <= dw['start'] and dw['end'] <= q['srcOut'] + 1e-3)
at = (lambda w, q: w['start']) if ${where === 'src' ? 'True' : 'False'} else (lambda w, q: q['at'] + w['start'] - q['srcIn'])
a, n = int(at(tw, c) * sr), int(td * sr)
m = int((at(dw, dc) + (dw['end'] - dw['start']) / 2) * sr) - n // 2
seg = x[m:m + n].copy(); f = int(0.005 * sr); up = np.linspace(0, 1, f)
up = up if x.ndim == 1 else up[:, None]
seg[:f] = seg[:f] * up + x[a:a + f] * (1 - up); seg[-f:] = seg[-f:] * up[::-1] + x[a + n - f:a + n] * (1 - up[::-1])
x[a:a + n] = seg
sf.write(${JSON.stringify(dst)}, x, sr)
k = next(k for k, s in enumerate(S) if s['start'] <= (tw['start'] + tw['end']) / 2 < s['end'])
print(json.dumps({'sentence': S[k]['text'], 'char': tw['text'], 'donor': dw['text']}, ensure_ascii=False))`], { encoding: 'utf8' });
  let info = null;
  try { info = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { console.log((r.stderr || '').slice(-400)); }
  if (where === 'src') { tl.source = 'audio/_selftest.src.wav'; delete tl.audio; } else tl.audio = 'audio/_selftest.mix.wav';
  tl.style = { ...tl.style, gates: { ...tl.style?.gates, 'speech.lineAsr': 'hard' } };
  const named = () => { try { return JSON.parse(fs.readFileSync(rv, 'utf8')).includes(info.sentence); } catch { return false; } };
  return {
    cleanup: [dst, rv],
    expect: (out) => !!info && out.includes('[失败] 逐句回转') && out.includes(`「${info.sentence}」`) && named() && (where === 'src' || out.includes('只有总混错')),
  };
};
speechCase('一段旁白里念错一个字（e01-benchmark「卷子」的「卷」听成「阵」，总混可懂度 0.1% 放过了）：逐句回转点名那一句', swapChar('src'));
speechCase('总混里一个字头被盖住、干声是对的（e01-benchmark 句首「写」听成「野」）：逐句回转点名那一句，说明只有总混错', swapChar('mix'), '',
  noSpeech || (sbase.audio ? null : '旁白基线的时间线没有总混'));
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
// 圈出一整行字（layout.ringWide）：圈是以字的中心为圆心、半对角线为半径的圆，宽文字圈出来比字高出一大截（e04、e07-fur 两次撞到旁边的字）。
// 默认是建议，私有配置可能设成 hard，所以都算（any）。挑第一段文字，后面接一个圈它的 ring；文字换成一行宽字母要报，换成一个字母不报
const ringOn = (b, text) => {
  const p = b.phrases.find((q) => (q.actions ?? []).some((a) => a.type === 'text' && a.copyOf === undefined)), t = p.actions.find((a) => a.type === 'text' && a.copyOf === undefined);
  t.text = text;
  p.actions.splice(p.actions.indexOf(t) + 1, 0, { id: '_ring-wide', type: 'ring', at: t.at, target: t.id });
};
expectBeats('圈出一整行字（圈会比字大一大截）', (b) => ringOn(b, 'abcdefgh'), validate, /_ring-wide\.target：圈的是一段宽文字「abcdefgh」/, { any: true });
expectBeats('圈出一个字不报宽文字', (b) => ringOn(b, 'a'), validate, /^(?![\s\S]*圈的是一段宽文字)[\s\S]*分镜校验/, { any: true });
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
// 很短的一句单独成句（E03、E04 各卡了几次：几个字单独配，音色飘，「每句都是同一个人」过不了）：报错；写进 narration.allowShort 的放行
expectBeats('旁白里四个字以内单独成了一句（「对。」）', (b) => { b.narration.script = '对。' + b.narration.script; }, validate, /「对。」去掉标点只有 1 个字，单独成了一句.*跟后面连成一句：「对，/);
expectBeats('对话：短句后面换了人，提示跟前面连成一句', (b) => {
  const [s0, s1] = b.narration.script.match(/[^。？！]+[。？！]/g);
  b.narration.voices = { dad: { voice: 'voice.example.json', label: '爸爸' } };
  b.narration.script = s0 + '还真是。' + b.narration.script.slice(s0.length);
  b.phrases[0].text += '还真是'; // 主讲：我们来做加法还真是；下一句换爸爸说
  for (const q of b.phrases.slice(1)) q.speaker = 'dad';
}, validate, /「还真是。」去掉标点只有 3 个字.*跟前面连成一句：「[^」]+，还真是。」/);
{
  const b = structuredClone(beatsSrc);
  b.id = '_selftest';
  b.narration.script = '对。' + b.narration.script;
  b.narration.allowShort = ['对。'];
  // 通过要真的通过（退出码 0、跑到最后一行），不能是半路崩了才没报短句
  const ok = (bb) => { fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(bb)); const r = spawnSync('node', validate('data/_selftest.beats.json'), { encoding: 'utf8' }); fs.rmSync('data/_selftest.beats.json', { force: true }); return r.status === 0 && /分镜校验：通过/.test(r.stdout) ? '' : r.stdout + r.stderr; };
  const o1 = SKIP.has('compile') ? null : ok(b);
  const o2 = SKIP.has('compile') ? null : ok({ ...b, narration: { ...b.narration, script: '办不到。', allowShort: [] } });
  if (o1 === null) skip('写进 allowShort 的短句、只有一句的旁白稿不报短句', '这次没改编译器和分镜校验（--skip compile）');
  else record('写进 allowShort 的短句、只有一句的旁白稿（封面）不报短句（放行不能失效）', o1 === '' && o2 === '', o1 + o2);
}
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
// 复用（copyOf）：照搬前面画好的元素，提示词那一刻整块出现、不动笔。出现时就在画面里，观众看到的是凭空冒出来一块，要报
// （用户 2026-11-15 看 E07 样片 v3：同一张网画了四遍，「同样的图画过一次就应该以某种优美的方式复用」——复用的图要在镜头外放好，镜头飞过去）
expectBeats('复用的图出现时就在画面里（凭空冒出来）', (b) => {
  const src = firstText(b), p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1);
  if (p.actions.some((a) => a.id === src.id)) throw new Error('基线最后一句就是第一段文字所在的句子，复用要照搬前面句子里的');
  p.actions.unshift({ ...structuredClone(src), id: '_cp', at: p.actions[0].at, copyOf: src.id, shift: [0, 40], y: src.y + 40 });
}, (p) => ['compiler/compile.mjs', p, '--target', TGT], /复用冒出来/);
{
  // 正例：复用放在下一句第一个词上、两屏以下（镜头还停在上一句，它在画外）。演示分镜太小，摆不出真正的下一节（这句的取景要同时框住它和原来的字，
  // 会报别的镜头问题），所以只认复用本身：不报「复用冒出来」，墨迹和原元素只差平移，粗细起伏（按原来那一笔取随机数）也一样，铅笔不画它
  if (SKIP.has('compile')) skip('复用放在画外：不算冒出来、墨迹和原来一笔不差、铅笔不画', '这次没改编译器和分镜校验（--skip compile）');
  else {
    const b = structuredClone(beatsSrc); b.id = '_selftest';
    for (const a of acts(b)) { for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov); delete a.layout; }
    const src = firstText(b), pi = b.phrases.findIndex((q) => q.actions?.some((a) => a.id === src.id)), p = b.phrases[pi + 1], dy = 2 * base.canvas.h;
    p.actions.unshift({ ...structuredClone(src), id: '_cp', at: p.actions[0].at, copyOf: src.id, shift: [0, dy], y: src.y + dy });
    fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
    const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
    const tlp = `build/_selftest-${TGT}.timeline.json`, tl = fs.existsSync(tlp) ? JSON.parse(fs.readFileSync(tlp, 'utf8')) : null;
    const a0 = tl?.strokes.filter((s) => s.action === src.id), a1 = tl?.strokes.filter((s) => s.action === '_cp');
    const same = !!tl && a0.length && a0.length === a1.length && a1.every((s, i) => s.copied && s.t0 === s.t1 && s.pts.length === a0[i].pts.length && s.pts.every(([x, y, w], k) => Math.abs(x - a0[i].pts[k][0]) < 0.02 && Math.abs(y - dy - a0[i].pts[k][1]) < 0.02 && Math.abs(w - a0[i].pts[k][2]) < 1e-6));
    const noPen = !!tl && !tl.penTrack.some((g) => g.kind === 'down' && tl.strokes[g.stroke]?.action === '_cp');
    record('复用放在画外：不算冒出来、墨迹和原来一笔不差、铅笔不画', same && noPen && !/复用冒出来/.test(out), out);
    fs.rmSync('data/_selftest.beats.json', { force: true });
    for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
  }
}
expectBeats('复用的参数没有照原元素平移', (b) => {
  const src = firstText(b), p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1);
  p.actions.unshift({ ...structuredClone(src), id: '_cp', at: p.actions[0].at, copyOf: src.id, shift: [0, 3000], y: src.y });
}, validate, '复用的参数要照');
expectBeats('复用的元素和原元素不是同一种', (b) => {
  const src = firstText(b), p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1);
  p.actions.unshift({ id: '_cp', type: 'circle', at: p.actions[0].at, cx: 0, cy: 0, r: 40, copyOf: src.id, shift: [0, 40] });
}, validate, '复用要和原元素同一种');
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
// 换节起飞不早于上一句说完（排程，不是检查；这里防它退回去）：原来笔一空就起飞，上一句最后一笔落在句中时句尾对着空纸（审片 E05 v1 五处）。
// 注入：最后一句有画的句子改成新的一节、挪到右边很远的纸面上；上一句的动作全挪到句首、写快，笔早早就空了
if (SKIP.has('compile')) skip('换节镜头等上一句说完才起飞', '这次没改编译器和分镜校验（--skip compile）');
else {
  const b = structuredClone(beatsSrc); b.id = '_selftest';
  for (const a of acts(b)) {
    for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov);
    delete a.layout;
  }
  const pi = b.phrases.findLastIndex((q, i) => i > 0 && q.actions?.length && b.phrases[i - 1].actions?.some((a) => a.type !== 'off' && a.type !== 'glow') && !b.phrases[i - 1].revisit?.length && b.phrases[i - 1].role !== 'aha' && b.phrases[i - 1].camera !== 'focus');
  if (pi < 0) skip('换节镜头等上一句说完才起飞', '基线分镜里找不到前后两句都画东西的地方');
  else {
    const p = b.phrases[pi], prev = b.phrases[pi - 1];
    p.chapter = '_换节';
    for (const a of p.actions) for (const k of ['x', 'cx']) if (typeof a[k] === 'number') a[k] += 2400;
    for (const a of p.actions) for (const k of ['from', 'to']) if (Array.isArray(a[k])) a[k] = [a[k][0] + 2400, a[k][1]];
    const head = prev.text.replace(/[\s，。；：！？、,.;:!?"“”'‘’（）()—-]/g, '').slice(0, 2);
    for (const a of prev.actions) { a.at = head; a.speed = 3; }
    fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
    const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT, '--no-validate'], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
    const tlp = `build/_selftest-${TGT}.timeline.json`, tl = fs.existsSync(tlp) ? JSON.parse(fs.readFileSync(tlp, 'utf8')) : null;
    const fly = tl?.penTrack.find((m) => m.chapter && m.phrase === pi), said = tl?.report.phrases[pi - 1].audioEnd, early = tl?.style?.motion?.takeoffEarly ?? 0.3;
    const cam = fly && tl.camera.find((m) => Math.abs(m.t1 - fly.t1) < 0.02);
    const freed = tl?.report.phrases[pi - 1].drawEnd;
    if (tl && freed > said - early - 0.2) skip('换节镜头等上一句说完才起飞', `注入后上一句的笔还是到句末才空（${freed}s，句末 ${said}s），测不出`);
    else record('换节镜头等上一句说完才起飞（笔和镜头都不早于句末前 takeoffEarly 秒）', !!fly && !!cam && fly.t0 >= said - early - 0.01 && cam.t0 >= said - early - 0.01,
      out + `\n上一句说完 ${said}s、笔 ${freed}s 就空了，笔起飞 ${fly?.t0}s，镜头起飞 ${cam?.t0}s`);
    fs.rmSync('data/_selftest.beats.json', { force: true });
    for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
  }
  // 换块不换章（block: true）：同样的注入分别写 chapter 和 block 各编一份。block 那份的笔和镜头要和 chapter 那份逐项一样（取景从新的一块重新框、
  // 换块飞行、镜头不合并都走同一套），章节数不变（平台章节有上限）；再编一份什么都不写的对照，它不该有飞行（不然这个注入测不出 block）
  if (pi >= 0 && !beatsSrc.phrases[pi].chapter) {
    const build = (mark) => {
      const b2 = structuredClone(beatsSrc);
      b2.id = '_selftest';
      for (const a of acts(b2)) {
        for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov);
        delete a.layout;
      }
      const q = b2.phrases[pi];
      if (mark) q[mark] = mark === 'chapter' ? '_换块对照' : true;
      for (const a of q.actions) for (const k of ['x', 'cx']) if (typeof a[k] === 'number') a[k] += 2400;
      for (const a of q.actions) for (const k of ['from', 'to']) if (Array.isArray(a[k])) a[k] = [a[k][0] + 2400, a[k][1]];
      fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b2));
      const r2 = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT, '--no-validate'], { encoding: 'utf8' });
      const tlp2 = `build/_selftest-${TGT}.timeline.json`, tl2 = fs.existsSync(tlp2) ? JSON.parse(fs.readFileSync(tlp2, 'utf8')) : null;
      for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
      fs.rmSync('data/_selftest.beats.json', { force: true });
      return { tl: tl2, out: (r2.stdout || '') + (r2.stderr || '') };
    };
    const blk = build('block'), chp = build('chapter'), none = build(null);
    const fly2 = blk.tl?.penTrack.find((m) => m.chapter && m.phrase === pi), flyN = none.tl?.penTrack.find((m) => m.chapter && m.phrase === pi);
    const same = !!blk.tl && !!chp.tl && JSON.stringify(blk.tl.penTrack) === JSON.stringify(chp.tl.penTrack) && JSON.stringify(blk.tl.camera) === JSON.stringify(chp.tl.camera);
    const base = (beatsSrc.phrases ?? []).filter((x) => x.chapter).length, got = blk.tl?.chapters?.length ?? -1;
    if (flyN) skip('换块不换章（block）', '这个注入不写 block 也会飞（上一句是回看之类），测不出');
    else record('换块不换章（block）：笔和镜头和换节逐项一样，章节数不变', !!fly2 && same && got === base,
      blk.out + `\n飞行 ${fly2 ? `${fly2.t0}–${fly2.t1}s` : '没有'}，和 chapter 那份${same ? '' : '不'}一样，章节 ${got}（基线 ${base}）`);
  }
}
// 换节起飞前停笔的地方要看接下来的飞行（排程，不是检查；这里防它退回去）。起飞前等够 park.minRest 秒时，笔先退到不压东西的空白处停着，
// 原来只看上一镜：镜头起步快、笔是对称缓动，笔在屏幕上先往飞行的反方向偏，停在那一侧画边附近的笔飞到一半就出画
// （E06 试编：第 8 节收尾时停在右上角，下一节在右下方，起飞 1.3 秒后笔尖到了画面最上沿）。
// 注入：同上一条，最后一句有画的句子改成新的一节，再往上挪 DY（笔在屏幕上往下偏，画面下半截停哪儿都会飞出去）；上一句的动作全挪到句首、写快。
// 判：笔起飞前空着够 park.minRest 秒（有工夫先挪个地方）时，整段飞行笔尖（渲染用的 penAt、cameraAt）一直在取景框里，
// 而且编译没报这段时间里铅笔卡住（笔尖在框里、笔身压上字幕时，铅笔角度规划会卡住，审 #68）。
// 演示分镜上原来的排法挑中的是原地（不压东西、离得最近），原地起飞出框、铅笔卡住：默认风格 9:16 出框 98px、16:9 出框 196px，
// 挂上作者的创作配置 29px、113px。往上挪 4000 时 16:9 无论停哪儿都飞不出来（舒适框下沿离字幕太近），不能再挪远
if (SKIP.has('compile')) skip('换节起飞前停笔的地方，飞到下一节的路上笔尖一直在取景框里、铅笔不卡住', '这次没改编译器和分镜校验（--skip compile）');
else {
  const name = '换节起飞前停笔的地方，飞到下一节的路上笔尖一直在取景框里、铅笔不卡住', DY = 3000;
  const b = structuredClone(beatsSrc); b.id = '_selftest';
  for (const a of acts(b)) {
    for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov);
    delete a.layout;
  }
  // 上一句要真的动笔（贴图、发光、熄灭不动笔，笔不会停在那一镜里）
  const pi = b.phrases.findLastIndex((q, i) => i > 0 && q.actions?.length && b.phrases[i - 1].actions?.some((a) => !PENLESS.has(a.type)) && !b.phrases[i - 1].revisit?.length && b.phrases[i - 1].role !== 'aha' && b.phrases[i - 1].camera !== 'focus');
  if (pi < 0) skip(name, '基线分镜里找不到前后两句都动笔的地方');
  else {
    const p = b.phrases[pi], prev = b.phrases[pi - 1];
    p.chapter = '_换节';
    for (const a of p.actions) for (const k of ['y', 'cy']) if (typeof a[k] === 'number') a[k] -= DY;
    for (const a of p.actions) for (const k of ['from', 'to']) if (Array.isArray(a[k])) a[k] = [a[k][0], a[k][1] - DY];
    const head = prev.text.replace(/[\s，。；：！？、,.;:!?"“”'‘’（）()—-]/g, '').slice(0, 2);
    for (const a of prev.actions) { a.at = head; a.speed = 3; }
    fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
    const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT, '--no-validate'], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
    const tlp = `build/_selftest-${TGT}.timeline.json`, tl = fs.existsSync(tlp) ? JSON.parse(fs.readFileSync(tlp, 'utf8')) : null;
    const fly = tl?.penTrack.find((m) => m.chapter && m.phrase === pi);
    // 上一句最后一笔写完到起飞空了多久：够 park.minRest 秒，排程才会给笔挑起飞前停的地方（不够就原地直接起飞，不归这条管）
    const lastDown = fly && tl.penTrack.filter((s) => s.kind === 'down' && s.t1 <= fly.t0 + 1e-6).at(-1);
    const idle = lastDown ? fly.t0 - lastDown.t1 : 0, minRest = tl?.style?.pencil?.park?.minRest ?? 0.5;
    const rest = fly && tl.penTrack.find((s) => s.kind === 'rest' && Math.abs(s.t1 - fly.t0) < 1e-3);
    if (!tl) record(name, false, out + '\n注入后编不出时间线'); // 编译崩了算没过，不是测不出
    else if (!fly) skip(name, '注入后这一节没有换节飞行');
    else if (idle < minRest) skip(name, `注入后上一句写完离起飞只有 ${idle.toFixed(2)} 秒（不到 park.minRest ${minRest} 秒，原地直接起飞），测不出`);
    else {
      const fr = tl.frame;
      let worst = Infinity, at = fly.t0;
      for (let f = Math.ceil(fly.t0 * tl.fps); f <= Math.floor(fly.t1 * tl.fps); f++) {
        const t = f / tl.fps, c = cameraAt(tl.camera, t), q = penAt(tl, t, 'mono');
        const x = (q.x - c.x) * c.z + tl.view.cx, y = (q.y - c.y) * c.z + tl.view.cy, d = Math.min(x - fr.l, fr.r - x, y - fr.t, fr.b - y);
        if (d < worst) { worst = d; at = t; }
      }
      // 编译报的铅笔卡住（「铅笔：a–bs 笔尖离画面边缘或字幕太近」），落在这段飞行里的
      const stuck = [...out.matchAll(/铅笔：([\d.]+)–([\d.]+)s 笔尖离画面边缘或字幕太近/g)].map((m) => [+m[1], +m[2]]).filter(([a, z]) => z >= fly.t0 - 0.05 && a <= fly.t1 + 0.05);
      record(name, worst >= 0 && !stuck.length, out + `\n起飞前空了 ${idle.toFixed(2)} 秒，从纸面 (${fly.from.map((v) => Math.round(v)).join(', ')}) 起飞${rest ? `（停了 ${(rest.t1 - rest.t0).toFixed(2)} 秒）` : ''}，飞行 ${fly.t0.toFixed(2)}–${fly.t1.toFixed(2)}s，笔尖离取景框最近 ${Math.round(worst)}px（${at.toFixed(2)}s，负数是出框）` +
        (stuck.length ? `；这段飞行里铅笔卡住 ${stuck.map(([a, z]) => `${a}–${z}s`).join('、')}` : ''));
    }
    fs.rmSync('data/_selftest.beats.json', { force: true });
    for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
  }
}
// 回看后接新的一节、回看那句不画（审 PR #64 复现）：回看时笔被当成在回看取景的画外，等上一句说完时不能再从那个假位置「停笔」，
// 不然真笔从最后一笔的终点一帧跳过去（运笔流畅判失败，单帧 834px）。注入：第一句加一个远处的字，下一句改成回看第一句、不画，再下一句照常画
if (SKIP.has('compile')) skip('不画的回看之后换节，笔不瞬移', '这次没改编译器和分镜校验（--skip compile）');
else {
  const b = structuredClone(beatsSrc); b.id = '_selftest';
  for (const a of acts(b)) {
    for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov);
    delete a.layout;
  }
  const i = b.phrases.findIndex((q, k) => q.actions?.some((a) => a.type === 'text' && typeof a.x === 'number') && b.phrases[k + 2]?.actions?.some((a) => a.type !== 'off' && a.type !== 'glow'));
  if (i < 0) skip('不画的回看之后换节，笔不瞬移', '基线分镜里找不到连着三句、头尾都画东西的地方');
  else {
    const p = b.phrases[i], t0 = p.actions.find((a) => a.type === 'text' && typeof a.x === 'number');
    p.actions.push({ id: '_far', type: 'text', at: t0.at, text: '1', x: t0.x + 2400, y: t0.y, size: t0.size ?? 72 });
    const ids = new Set(b.phrases[i + 1].actions?.map((a) => a.id));
    for (const a of acts(b)) for (const k of ['after', 'on', 'target']) if (ids.has(a[k])) delete a[k];
    Object.assign(b.phrases[i + 1], { revisit: [t0.id], actions: [] });
    fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
    const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT, '--no-validate'], { encoding: 'utf8' });
    const tlp = path.resolve(`build/_selftest-${TGT}.timeline.json`);
    if (!fs.existsSync(tlp)) skip('不画的回看之后换节，笔不瞬移', '注入后编不出来：' + ((r.stdout || '') + (r.stderr || '')).trim().split('\n').at(-1));
    else {
      const pc = pencil(tlp), out = (pc.stdout || '') + (pc.stderr || '');
      record('不画的回看之后换节，笔不瞬移（运笔流畅不判失败）', /\[通过\] 运笔流畅/.test(out), out);
    }
    fs.rmSync('data/_selftest.beats.json', { force: true });
    for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
  }
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
if (SKIP.has('compile')) skip('同一张表里的两个格子贴近，不按「同一行」报', '这次没改编译器和分镜校验（--skip compile）');
else {
  // 表格例外的反向用例：和上一条同样的两段字，写了相同的 grid（同一张表里的格子）就不按「同一行」规则报；只给一边写 grid 照样报
  const run = (grids, dx = 1.6) => {
    const b = structuredClone(beatsSrc); b.id = '_selftest';
    for (const a of acts(b)) { for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov); delete a.layout; }
    const t = firstText(b);
    if (grids[0]) t.grid = grids[0];
    b.phrases[0].actions.push({ id: '_row', type: 'text', at: t.at, text: '57', x: t.x + t.size * dx, y: t.y, size: 56, ...(grids[1] ? { grid: grids[1] } : {}) });
    fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
    const r = spawnSync('node', compileNoFix(TGT)('data/_selftest.beats.json'), { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
    fs.rmSync('data/_selftest.beats.json', { force: true });
    for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
    return out;
  };
  // 只认被查的是 _row 的那一行（「标签「57」(_row) 离 … 在同一行」）；格子真压在一起时，同一张表里也照样报（表格例外只放宽留空，不放过压字）
  const rowHit = /标签「57」\(_row\).*在同一行/, same = run(['_g', '_g']), half = run(['_g', null]), over = run(['_g', '_g'], 0);
  record('同一张表里的两个格子贴近，不按「同一行」报（只有一边写 grid 照样报）', !rowHit.test(same) && rowHit.test(half), same + half);
  record('同一张表里的两个格子压在一起，照样报', /标签「57」\(_row\) 离 /.test(over), over);
}
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
// 前向依赖（每集能单独看，用户 2026-11-11）：brief.dependsOn 写了的，片中要贴那一集的封面，复述那句话要在贴封面的那一句或前后一句里
{
  const STK = 'public/stickers/_selftest.svg';
  fs.mkdirSync('public/stickers', { recursive: true });
  fs.writeFileSync(STK, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#c4432f"/></svg>');
  // 注入挑最后一句会画东西的句子（片尾全景、回看的句子不画新东西，往那儿加贴图会多报一条无关的错）
  const host = (b) => b.phrases.findLast((q) => !q.camera && !q.revisit?.length && q.actions?.length) ?? b.phrases.at(-1);
  const say = (b) => strip(host(b).text);
  const stick = (b, ep) => { const p = host(b); p.actions.push({ id: '_stk', type: 'sticker', at: p.actions[0]?.at ?? p.text.slice(0, 2), src: '_selftest.svg', cx: 2600, cy: 400, w: 300, ep }); };
  try {
  expectBeats('写了依赖前一集，片中没贴那一集的封面', (b) => {
    b.brief = { ...(b.brief ?? {}), dependsOn: [{ ep: 'e00-test', what: '测试用的前提', recap: say(b) }] };
  }, validate, /贴「e00-test」的封面/);
  expectBeats('贴了前一集的封面，复述那句话不在旁白里', (b) => {
    b.brief = { ...(b.brief ?? {}), dependsOn: [{ ep: 'e00-test', what: '测试用的前提', recap: '这句话旁白里根本没有说过' }] };
    stick(b, 'e00-test');
  }, validate, /不在贴封面那一句/);
  expectBeats('贴了一集的封面，依赖里没写这一集', (b) => {
    b.brief = { ...(b.brief ?? {}), dependsOn: [] };
    stick(b, 'e00-test');
  }, validate, /dependsOn 里没写这条依赖/);
  expectBeats('贴图的图不在 public/stickers/ 里', (b) => {
    stick(b); host(b).actions.at(-1).src = '_selftest-missing.png';
  }, validate, /找不到 public\/stickers\/_selftest-missing.png/);
  // 不是封面的贴图（原文、数据图、实物照片这类证据）要有出处，和贴视频一样（用户 2026-11-13：严格保护版权）
  expectBeats('贴了一张不是封面的图，没写出处', (b) => { stick(b); }, validate, /「_selftest\.svg」没有出处/);
  // 编译：贴图整个盖在一段文字上（文字落在卡片里面，离外轮廓很远），版面检查也要报（PR #66 审查：原来只量到外轮廓的距离）
  expectBeats('贴图整个盖在一段文字上（关闭自动修复）', (b) => {
    const p = b.phrases.find((q) => !q.camera && !q.revisit?.length && q.actions?.some((a) => a.type === 'text' && typeof a.x === 'number'));
    const t = p.actions.find((a) => a.type === 'text' && typeof a.x === 'number');
    b.brief = { ...(b.brief ?? {}), dependsOn: [{ ep: 'e00-test', what: '测试用的前提', recap: strip(p.text) }] };
    p.actions.push({ id: '_stk', type: 'sticker', at: t.at, src: '_selftest.svg', cx: t.x + 60, cy: t.y, w: 900, ep: 'e00-test' });
  }, compileNoFix(TGT), /离 _stk|_stk.*离/);
  } finally { fs.rmSync(STK, { force: true }); }
}
// 贴视频（clip，用户 2026-11-13）：实验画面这类证据贴在纸上放。片子要在、截的那段要在片子里面、出处要齐（许可只收能改编能商用的）；
// 编译时它和贴图一样当一块图形，而且放完之前镜头不能把它移出取景框；分段渲染认片子的内容
{
  // 两段自测片子：20 秒的常规片；比整集还长几秒的长片（查「截的一段比整集还长」，5 帧/秒，长也不占地方）
  const CLP = 'public/clips/_selftest.mp4', LONG = 'public/clips/_selftest-long.mp4', longSec = Math.ceil(base.duration) + 5;
  const NAMES = ['贴视频的片子不在 public/clips/ 里', '贴视频截的一段超出片子长度', '贴视频截的一段 to 在 from 前面', '贴视频的倍速超出 0.25–4', '贴视频放得太长（建议）', '贴视频的 play 不在这句旁白里',
    '贴视频没写出处', '贴的素材出处写成了示意数值（kind: example）', '贴的素材许可带 NC（不许商用）', '不是自己做的素材没写原始网址', '不是自己做的素材没存证（source）', 'CC BY 的素材没写作者', 'CC BY 的署名里没写作者',
    '贴视频整个盖在一段文字上（关闭自动修复）', '贴视频还没放完，镜头就把它移出取景框（关闭自动修复）', '贴视频截的一段比整集还长（定格会被截住）', '回描贴视频只描外轮廓（卡片里的横线不画）',
    '贴视频的片子编译后换过（渲染前核对）', '换了片子，分段渲染的指纹要变'];
  fs.mkdirSync('public/clips', { recursive: true });
  const ff = spawnSync(PY_QA, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).stdout?.trim() || 'ffmpeg';
  const enc = (out, sec, fps) => spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x8a6d4f:s=160x90:d=${sec}:r=${fps}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { encoding: 'utf8' }).status === 0;
  if (!enc(CLP, 20, 30) || !enc(LONG, longSec, 5)) for (const n of NAMES) skip(n, '生成不了自测用的片子（没有 ffmpeg）');
  else try {
    // 注入挑第一句写了字的句子（不推近、不回看）：贴在它上方够远的地方，后面几句的镜头才会离开它
    const host = (b) => b.phrases.find((q) => !q.camera && !q.revisit?.length && q.role !== 'aha' && q.actions?.some((a) => a.type === 'text' && typeof a.x === 'number')) ?? b.phrases[0];
    const own = { media: '_selftest.mp4', license: 'own', origin: '自测生成的 20 秒纯色片' }, web = { media: '_selftest.mp4', license: 'public-domain', origin: 'https://example.org/clip', cite: '示例片子（公有领域）' };
    const paste = (b, extra = {}, fact = own) => {
      const p = host(b);
      if (fact) b.facts = [...(b.facts ?? []), fact];
      p.actions.push({ id: '_clp', type: 'clip', at: p.actions[0]?.at ?? p.text.slice(0, 2), src: '_selftest.mp4', cx: 2600, cy: 400, w: 300, to: 2, ...extra });
    };
    const N = [...NAMES];
    expectBeats(N.shift(), (b) => paste(b, { src: '_selftest-missing.mp4' }, { ...own, media: '_selftest-missing.mp4' }), validate, /找不到 public\/clips\/_selftest-missing\.mp4/);
    expectBeats(N.shift(), (b) => paste(b, { from: 0.5, to: 99 }), validate, /片子只有 20\.00 秒，放不到第 99 秒/);
    expectBeats(N.shift(), (b) => paste(b, { from: 1.5, to: 1 }), validate, /要在 from（1\.5）之后/);
    expectBeats(N.shift(), (b) => paste(b, { rate: 8 }), validate, /倍速在 0\.25–4 之间/);
    expectBeats(N.shift(), (b) => paste(b, { to: 20 }), validate, /超过 15 秒/, { advice: true });
    expectBeats(N.shift(), (b) => paste(b, { play: '旁白里没有这个词' }), validate, /「旁白里没有这个词」不在这句旁白里/);
    expectBeats(N.shift(), (b) => paste(b, {}, null), validate, /「_selftest\.mp4」没有出处/);
    expectBeats(N.shift(), (b) => paste(b, {}, { media: '_selftest.mp4', kind: 'example' }), validate, /media 不能和 kind: example 写在一起/);
    expectBeats(N.shift(), (b) => paste(b, {}, { ...web, license: 'CC-BY-NC-4.0', cite: '示例 CC BY-NC 4.0' }), validate, /「CC-BY-NC-4\.0」不收/);
    expectBeats(N.shift(), (b) => paste(b, {}, { ...web, origin: '网上找的' }), validate, /写原始页面的网址/);
    expectBeats(N.shift(), (b) => paste(b, {}, web), validate, /存证：/);
    expectBeats(N.shift(), (b) => paste(b, {}, { ...web, license: 'CC-BY-4.0', cite: '示例片子 CC BY 4.0' }), validate, /CC-BY-4\.0 要署名：写作者/);
    expectBeats(N.shift(), (b) => paste(b, {}, { ...web, license: 'CC-BY-4.0', author: '某作者', cite: '示例片子 CC BY 4.0' }), validate, /cite 里写上作者「某作者」/);
    // 编译：小屏幕整个盖在一段文字上（文字落在屏幕里面），版面检查要报
    expectBeats(N.shift(), (b) => {
      const p = host(b), t = p.actions.find((a) => a.type === 'text' && typeof a.x === 'number');
      paste(b, { at: t.at, cx: t.x + 60, cy: t.y, w: 900 });
    }, compileNoFix(TGT), /离 _clp|_clp.*离/);
    // 编译：第一句贴在字的上方，慢放成 8 秒，后面几句镜头往下走，它还没放完就出了取景框
    expectBeats(N.shift(), (b) => {
      const p = host(b), t = p.actions.find((a) => a.type === 'text' && typeof a.x === 'number');
      paste(b, { at: t.at, cx: t.x, cy: t.y - 430, w: 260, rate: 0.25 });
    }, compileNoFix(TGT), /_clp 还没放完/);
    // 编译：片子比整集还长，4 倍速放完整段，片子里走过的秒数超过整集（渲染时定格会被截在整集的帧数以内）
    expectBeats(N.shift(), (b) => paste(b, { src: '_selftest-long.mp4', to: undefined, rate: 4 }, { ...own, media: '_selftest-long.mp4' }), compileNoFix(TGT), /截的一段在片子里走 .*比整集.*还长/);
    // 编译：回描贴视频，只描外轮廓（卡片里那排横线只给版面检查用；PR #71 审查：原来会把二十几条横线也描出来）
    {
      const name = N.shift();
      if (SKIP.has('compile')) skip(name, '这次没改编译器和分镜校验（--skip compile）');
      else {
        const b = structuredClone(beatsSrc);
        b.id = '_selftest';
        for (const a of acts(b)) { for (const [keys, ov] of Object.entries(a.layout ?? {})) if (keys.split(',').map((k) => k.trim()).includes(TGT)) Object.assign(a, ov); delete a.layout; }
        paste(b);
        const later = b.phrases.slice(b.phrases.indexOf(host(b)) + 1).find((q) => q.actions?.length);
        later?.actions.push({ id: '_rt', type: 'retrace', at: later.actions[0].at, target: '_clp' });
        fs.writeFileSync('data/_selftest.beats.json', JSON.stringify(b));
        const r = spawnSync('node', ['compiler/compile.mjs', 'data/_selftest.beats.json', '--target', TGT], { encoding: 'utf8' }), tp = `build/_selftest-${TGT}.timeline.json`;
        const n = fs.existsSync(tp) ? JSON.parse(fs.readFileSync(tp, 'utf8')).strokes.filter((s) => s.action === '_rt').length : -1;
        record(name, later && n > 0 && n <= 2, `回描笔画 ${n} 笔（只描外轮廓应是 2 笔）\n${(r.stdout || '') + (r.stderr || '')}`);
        fs.rmSync('data/_selftest.beats.json', { force: true });
        for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
      }
    }
    // 渲染前：编译后换了片子，分段渲染、静帧链接片子时要拦下（不然分段缓存拿旧指纹复用旧画面）
    {
      const { linkClips } = await import('../compiler/clips.mjs'), dir = fs.mkdtempSync(path.resolve('build/_selftest-pub-'));
      let msg = '';
      try { linkClips({ clips: [{ id: '_clp', src: 'clips/_selftest.mp4', sha: '0'.repeat(64) }] }, dir); } catch (e) { msg = e.message; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      record(N.shift(), /编译之后换过了/.test(msg), msg || '没有报错');
    }
    // 分段指纹：同一条时间线只换片子的内容指纹，用得到它的段指纹要变
    {
      const { sliceFor } = await import('../render/segmented.mjs'), tl = structuredClone(base), c = tl.camera.at(-1).to;
      tl.clips = [{ id: '_clp', src: 'clips/_selftest.mp4', sha: 'a', duration: 2, cx: c.x, cy: c.y, w: 200, h: 112, tilt: 2, t0: 0.5, t1: 1, play: 1, end: 3, from: 0, to: 2, rate: 1, bezel: '#3b3632', tape: '#e6d7ad', shade: '#3c2a12', warm: { sepia: 0, saturate: 1 } }];
      const a = JSON.stringify(sliceFor(tl, 0, tl.durationInFrames));
      tl.clips[0].sha = 'b';
      record(N.shift(), a !== JSON.stringify(sliceFor(tl, 0, tl.durationInFrames)), 'sliceFor 没带上片子的指纹');
    }
  } finally { fs.rmSync(CLP, { force: true }); fs.rmSync(LONG, { force: true }); }
}
// 多音字：结构助词「地」（用户听 E02 v5：「细细地讲」念成了 dì）
expectBeats('旁白稿里写了「慢慢地」（「地」会念成 dì）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，我们慢慢地看。');
}, validate, /「慢慢地」.*念 de/, { any: true });
expectBeats('旁白稿里写了「一小步一小步地」（「一X一X地」的 X 是两个字）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，一小步一小步地走。');
}, validate, /「一小步一小步地」.*念 de/, { any: true });
// 「二 + 量词」念「两」、当「必须」讲的「得」念 děi（用户 2026-11-16 看 E07 成片：「2格」念成 èr gé，「得挪到」念成 de）
expectBeats('旁白稿里写了「二格」（数量念「两」）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，往大拧到二格。');
}, validate, /「二格」.*念「两」.*「两格」/, { any: true });
expectBeats('旁白稿里写了「就得」（当「必须」讲念 děi）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，那就得重来一遍。');
}, validate, /「就得」.*děi.*「就要」/, { any: true });
// 「调光灯」念成 diào、「倒着算」念成 dǎo（用户 2026-11-19 看 E08 样片 v1）
expectBeats('旁白稿里写了「调光灯」（当调节讲念 tiáo）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，换成调光灯。');
}, validate, /「调光」.*tiáo.*「条光」/, { any: true });
expectBeats('旁白稿里写了「音调高」（名词「调」念 diào，不该报）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，他的音调高。');
}, validate, /^(?![\s\S]*「调高」)/, { any: true });
expectBeats('旁白稿里写了「倒着算」（不再改写，交给配音时的多音字围栏）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，从后面倒着算。');
}, validate, /^(?![\s\S]*「倒着」)/, { any: true });
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
// 复用（copyOf）的 copyOf 写的是原元素 id，表格名 grid 也是名字，不是写在画面上的字：id、表格名里带数字（E02 的 g00）不能报成「画面上写了 00」。
// 注入：前面一句画一段带表格名的字，后面一句复用它，再另画一个旁白没说过的数当对照——对照要照旧报出来，id 和表格名不能被报
const reusable = beatsSrc.phrases.filter((q) => q.actions?.length && !q.revisit?.length && !q.camera).length >= 2; // 复用要有「前面一句」可抄
if (!reusable) skip('写稿自查：复用件的 copyOf、表格名里带数字，不算画面上写的数', '基线分镜带动作的句子不到两句');
else expectBeats('写稿自查：复用件的 copyOf、表格名里带数字，不算画面上写的数', (b) => {
  const ps = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length && !q.camera), [p1, p2] = [ps[0], ps.at(-1)], a1 = p1.actions[0], a2 = p2.actions[0];
  const x = (a1.x ?? a1.cx ?? 400) + 40, y = (a1.y ?? a1.cy ?? 400) + 160;
  p1.actions.push({ id: 'g0731', type: 'text', at: a1.at, text: '大小', grid: 'row8642', x, y, size: 72 });
  p2.actions.push({ id: '_copy', type: 'text', at: a2.at, copyOf: 'g0731', shift: [0, 300], text: '大小', grid: 'row8642', x, y: y + 300, size: 72 });
  p2.actions.push({ id: '_num', type: 'text', at: a2.at, text: '4137', x: x + 400, y, size: 72 });
}, validate, /^(?![\s\S]*画面上写「(?:g0731|row8642)」)[\s\S]*其中的 4137 旁白到这句/, { any: true });
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
{
  // 理解度打分：测试者常把数字和汉字隔开写（「2 天」「100 亿亿」「1 个」），答对了不能判失败（E02：一位测试者 10 题里 4 题这样丢）。
  // 注入自己带题和答案，不挑基线：前三题答案、关键词里带空白但意思对，必须判通过；第四题答错，仍要判失败（去掉空白不能把什么都放过去）
  const f = path.resolve('build/_selftest.cmp.beats.json'), g = path.resolve('build/_selftest.cmp.answers.json');
  fs.writeFileSync(f, JSON.stringify({ quiz: [
    { q: '要几天？', keywords: [['2天', '两天']] },
    { q: '有多大？', keywords: [['100亿亿']] },
    { q: '有几个？', keywords: [['1 个', '一个']] },
    { q: '再要几天？', keywords: [['2天', '两天']] },
  ] }));
  fs.writeFileSync(g, JSON.stringify({ answers: [{ id: 1, a: '大概 2 天' }, { id: 2, a: '100 亿 亿次' }, { id: 3, a: '只有1个' }, { id: 4, a: '3 天' }] }));
  const r = spawnSync(PY_QA, ['qa/comprehension.py', 'score', f, g], { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
  record('理解度：答案里数字和汉字之间带空格（「2 天」）也算答对，答错的照样判失败', /^\[通过\] 第 1 题.*\n\[通过\] 第 2 题.*\n\[通过\] 第 3 题.*\n\[失败\] 第 4 题/m.test(out) && out.includes('理解度：3/4'), out);
  fs.rmSync(f, { force: true });
  fs.rmSync(g, { force: true });
}
expectBeats('标签在旁白说完后才写（关闭自动修复）', (b) => {
  const p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1), a0 = p.actions[0];
  p.actions.push({ id: '_late', type: 'text', at: a0.at, text: '这一行字太长了来不及跟上旁白', x: 490, y: 1300, size: 72 });
}, compileNoFix(TGT), /说完后才起笔|和本句旁白重叠/, { advice: true });

// 说完了还在写（sync.silent，默认只给建议）：一句话后面挂一大段字，旁白说完很久笔还在写（E03 v2：静音里补写 6 秒）
// 判定只认被注入的那一句（基线自己有别的句子报这一项也不算抓到）；私有配置可能把它升成 hard，所以建议、问题都认（any）
{
  const p0 = beatsSrc.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1);
  const head = (p0?.text ?? '').slice(0, 16).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expectBeats('一句说完后笔还要写很久（静音里补写）', (b) => {
    const p = b.phrases.filter((q) => q.actions?.length && !q.revisit?.length).at(-1), a0 = p.actions[0];
    p.actions.push({ id: '_silent', type: 'text', at: a0.at, text: '这是一行写起来很费时间的长长长长的字', x: 490, y: 1300, size: 72, ahead: true });
  }, compileNoFix(TGT), new RegExp(`「${head}」说完后还要等画面`), { any: true });
}
// 配音风险（script.tts，只给建议）：很短的问句、含以前被听错过的字的句子（E03 两句爸爸的短问句被听错）。注入的句子和听错记录都自己带
// 儿化（script.erhua）：旁白里的「哪儿」配音配不出（E04 两句、E08 两句各试满 30 个种子）。「女儿」「儿子」里的「儿」是一个音节，不算
expectBeats('写稿自查：旁白里有儿化（乘到哪儿，就写在哪儿）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，乘到哪儿，就写在哪儿。');
}, validate, /^(?![\s\S]*后面没有「里」)[\s\S]*「哪儿」是儿化.*「哪里」/, { any: true });   // 写了「哪儿」的只报儿化，不再报「后面没有里」
// 稿子没写「儿」、配音自己加的：「从哪」后面不跟「里」（e04-elnino 样片：「不然热从哪冒出来？」快配 8 条全念成「从哪儿」）
expectBeats('写稿自查：「从哪」后面没有「里」，配音会念成「哪儿」', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，不然热从哪冒出来？');
}, validate, /「从哪」后面没有「里」.*写成「从哪里」/, { any: true });
expectBeats('写稿自查：「哪里」「哪个」「哪几步」「哪层」「哪怕」「哪有」不报（问哪一个、反问，不是问地方）', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，热是哪里来的，往哪边吹，哪个哪几步都行，到底是哪层，哪怕拧哪根，哪有这种事。');
}, validate, /^(?![\s\S]*后面没有「里」)/, { any: true });
expectBeats('写稿自查：「女儿」「儿子」不是儿化，不报', (b) => {
  b.narration.script = b.narration.script.replace(/。/, '，他的女儿和儿子都来了。');
}, validate, /^(?![\s\S]*是儿化)/, { any: true });
// 回描（script.retrace，只给建议）：刚画完、就在画面里的东西又描一遍（E03 样片 28 句 36 处回描，用户：太多了）。注入：一句不是顿悟的句子，回描它自己刚画的东西
expectBeats('写稿自查：回描这句刚画的东西（重复，不是指回旧东西，也不是顿悟）', (b) => {
  const p = b.phrases.find((q) => q.role !== 'aha' && (q.actions ?? []).some((a) => a.type !== 'retrace' && a.type !== 'strike'));
  const a0 = p.actions.find((a) => a.type !== 'retrace' && a.type !== 'strike');
  p.actions.push({ id: '_rt', type: 'retrace', at: a0.at, target: a0.id });
}, validate, /_rt：回描「[^」]+」.*就是这句画的/, { advice: true });
// 父子对话（script.dad，只给建议）：孩子连说太多句没有爸爸（E07 样片 v6）；爸爸老用同一个垫话开头（E04「合着」13 次）
expectBeats('写稿自查：孩子连说太多句，爸爸不捧哏', (b) => {
  b.style = { narrative: { [b.kind]: { dadEvery: 2 } } };
  b.phrases[0].speaker = 'dad';
  const kid = b.phrases.find((p, i) => i > 0);
  b.phrases.push(...[1, 2, 3].map((k) => ({ ...structuredClone(kid), actions: [], text: `孩子又说了第${k}句` })));
}, validate, /孩子连说 \d+ 句没有爸爸/, { advice: true });
expectBeats('写稿自查：爸爸老用同一个开头（合着），接话问句「那……」不算', (b) => {
  b.phrases.push(...[1, 2, 3].map((k) => ({ ...structuredClone(b.phrases[0]), actions: [], speaker: 'dad', text: `合着第${k}回又是这样` })));
  b.phrases.push(...[1, 2, 3].map((k) => ({ ...structuredClone(b.phrases[0]), actions: [], speaker: 'dad', text: `那它第${k}回怎么办` })));
}, validate, /^(?![\s\S]*以「那」开头)[\s\S]*爸爸 3 句都以「合着」开头/, { advice: true });
// 开头一分钟（narrative.opening）、画面停着不动（narrative.still），编译按真实时间算，只给建议
expectBeats('开头没有收获前置，也没有请观众回答的问题', (b) => {
  b.style = { narrative: { [b.kind]: { promiseWithin: 15, askWithin: 60 } } };
  for (const p of b.phrases) p.text = p.text.replace(/看完这一?集|评论|[？?]/g, '');
}, compileNoFix(TGT), /开头没有收获前置[\s\S]*没有请观众想一想/, { advice: true });
// 反过来：第一句就是收获前置（brief.promise 带标点也认得出），只缺请观众回答的问题，就只报后一条
expectBeats('开头有收获前置（带标点的 brief.promise 也认得），只报缺请观众回答的问题', (b) => {
  b.style = { narrative: { [b.kind]: { promiseWithin: 15, askWithin: 60 } } };
  for (const p of b.phrases) p.text = p.text.replace(/看完这一?集|评论|[？?]/g, '');
  b.brief = { ...(b.brief ?? {}), promise: `${b.phrases[0].text.slice(0, 2)}，${b.phrases[0].text.slice(2, 4)}` };
}, compileNoFix(TGT), /^(?![\s\S]*收获前置)[\s\S]*没有请观众想一想/, { advice: true });
// 例行公事地请评论（narrative.commentCall）：E07 到 e04-elnino 六集开头「……？打在评论区」，用户 2026-11-23 说公式化、呆板。
// 旁白文字要和配音对得上，不能往句子里加字：把 commentWords 设成基线句子里本来就有的字，查的是「哪些句子、什么时候说」。
// 默认只是建议，私有配置设成 hard，所以报成建议或问题都算（any）；不报的那条看整段输出
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
expectBeats('开头就请观众打在评论区', (b) => {
  b.style = { narrative: { [b.kind]: { commentWords: esc(strip(b.phrases[0].text)), commentQuiet: 60, commentMax: 9 } } };
}, compileNoFix(TGT), /开头就请观众打在评论区/, { any: true });
// 反过来：开头只问问题（brief.ask）、不催评论，整片只在片尾请一次：两条都不报
expectBeats('开头只问不催评论、片尾请一次：不报', (b) => {
  b.style = { narrative: { [b.kind]: { commentWords: esc(strip(b.phrases.at(-1).text)), commentQuiet: 0.5, commentMax: 1, askWithin: 60 } } };
  b.brief = { ...(b.brief ?? {}), ask: strip(b.phrases[0].text).slice(0, 4) };
}, compileNoFix(TGT), /^(?![\s\S]*(请观众打在评论区|没有请观众想一想|不是合法的正则))[\s\S]*时长 [\d.]+s/, { any: true });  // 要看到编译跑完（时长那行），不让编译崩了也算过
expectBeats('commentWords 写错正则：报得清楚，不崩', (b) => {
  b.style = { narrative: { [b.kind]: { commentWords: '评论区(', commentQuiet: 60, commentMax: 1 } } };
}, compileNoFix(TGT), /commentWords 不是合法的正则/, { any: true });
expectBeats('整片请观众打在评论区太多次', (b) => {
  b.style = { narrative: { [b.kind]: { commentWords: b.phrases.slice(-2).map((p) => esc(strip(p.text))).join('|'), commentQuiet: 0, commentMax: 1 } } };
}, compileNoFix(TGT), /整片 \d+ 句请观众打在评论区/, { any: true });
expectBeats('连着几句一笔不画（画面停着不动）', (b) => {
  b.style = { narrative: { [b.kind]: { maxStill: 0.5 } } };
  const p = b.phrases.at(-1);
  p.actions = []; delete p.revisit; delete p.camera;
}, compileNoFix(TGT), /一笔不画/, { advice: true });
// 开头是空纸（opening.firstInk）：E05、E06、e01-benchmark、e04-elnino 四集第一笔都等了半秒到一秒。默认只是建议，私有配置设成 hard，所以报成建议或问题都算
expectBeats('开头是空纸：第一笔晚于 firstInkWithin', (b) => {
  b.style = { narrative: { [b.kind]: { firstInkWithin: 0.3, firstInkPull: 0.7 } } };
  b.pen = { ...b.pen, leadIn: 1.1 }; // 片头先空 1.1 秒（演示分镜本来就是这样）
}, compileNoFix(TGT), /第一笔在 [\d.]+s 才落/, { any: true });
// 反过来：开场第一样东西挂在第一句的第二个字上（e04-elnino「今年为什么」的「为什么」），比提示词早不到 firstInkPull，编译自己挪到片头落笔，不再报。
// 第一句里留一个文字动作当开场第一笔，其余动作挪到这句最后两个字上（不删：别的动作可能 after 它们）；第一句没有文字、或去掉标点不到 4 个字的基线跳过（审 #94）
{
  const name = '开场第一笔挂在后面的词上：编译挪到片头落笔，不报空纸';
  const p0 = beatsSrc.phrases[0], said = strip(p0.text);
  if (!p0.actions.some((a) => a.type === 'text') || said.length < 4) skip(name, '基线分镜第一句没有文字动作，或太短');
  else expectBeats(name, (b) => {
    b.style = { narrative: { [b.kind]: { firstInkWithin: 0.3, firstInkPull: 0.7 } } };
    b.pen = { ...b.pen, leadIn: 0.05 };
    const q = b.phrases[0], a0 = q.actions.find((a) => a.type === 'text');
    for (const a of q.actions) if (a !== a0) a.at = said.slice(-2);
    a0.at = said.slice(1, 3); delete a0.lead; delete a0.after;
  }, (p) => ['compiler/compile.mjs', p, '--target', TGT], /^(?![\s\S]*第一笔在)[\s\S]*片子一开头就落笔/, { any: true });
}
// 一集超过 10 分钟（narrative.length）、说到灯取景里没灯（scene.lamp）、画面落后太多（sync.lagFar）：用户 2026-11-19 看 E08 样片 v1
// 默认只是建议，私有配置可以设成 hard，所以报成建议或问题都算（any）
expectBeats('正片超过一集的时长上限', (b) => {
  b.style = { narrative: { [b.kind]: { maxSeconds: 1 } } };
}, compileNoFix(TGT), /超过 1s：少讲一点/, { any: true });
// 注入不改旁白：把第一句里的两个字当成「说到灯」的词，再拿掉所有的灯（演示分镜本来就没有灯）
const lampless = (b) => {
  const w = strip(b.phrases[0].text).slice(0, 2);
  b.style = { narrative: { [b.kind]: { lampWords: w } } };
  for (const q of b.phrases) q.actions = (q.actions ?? []).filter((a) => !['bulb', 'glow', 'off'].includes(a.type));
};
expectBeats('旁白说到灯，取景里一盏灯都没有', lampless, compileNoFix(TGT), /说的是灯的事，取景里一盏灯都没有/, { any: true });
expectBeats('旁白说到灯，写了 noLamp 就不报', (b) => {
  lampless(b);
  for (const q of b.phrases) q.noLamp = '演示：这句不该有灯';
}, compileNoFix(TGT), /^(?![\s\S]*说的是灯的事)[\s\S]*时长/, { any: true });
// 说东西变了，画面上的它没跟着变（scene.change，compiler/change_check.mjs）：e03-coldest 成片「把光变弱」时光一笔没变，E08 样片 v1 讲灯时没灯。
// 默认只是建议，私有配置设成 hard，所以报成建议或问题都算（any）。注入不改旁白：挑第 3 句以后的一句（去掉标点至少 6 个字，动作都不指向、不挂在别的元素上），
// 把它的第 5、6 个字当成「变了」的词（整份旁白里只出现这一次，别的句子不会跟着报），给前两句以前画过的一个元素标 is 写这句的头 4 个字（词前面说的东西）。
// 按组件认的名字（changeNames）每样都写成空的：风格规范是深合并，写 {} 关不掉，基线里有灯、光晕时会撞上
const chg = (() => {
  const all = beatsSrc.phrases.map((p) => strip(p.text)).join('');
  const k = beatsSrc.phrases.findIndex((p, i) => {
    const t = strip(p.text), w = t.slice(4, 6);
    return i >= 2 && t.length >= 6 && t.indexOf(w) === 4 && all.indexOf(w) === all.lastIndexOf(w) && !/[没不别未非无]/.test(t[3]) && (p.actions ?? []).length
      && p.actions.every((a) => a.target === undefined && a.on === undefined && a.is === undefined);
  });
  const x = k >= 2 ? beatsSrc.phrases.slice(0, k - 1).flatMap((p) => p.actions ?? [])[0] : null; // 隔一句：这一句和上一句并句时，它照样在「以前」
  return x ? { k, x: x.id, t: strip(beatsSrc.phrases[k].text) } : null;
})();
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const noNames = Object.fromEntries(Object.keys(loadStyle(beatsSrc).narrative?.[beatsSrc.kind]?.changeNames ?? {}).map((k) => [k, []]));
const unchanged = (b) => {
  b.style = { narrative: { [b.kind]: { changeWords: reEsc(chg.t.slice(4, 6)), changeNames: noNames } } };
  acts(b).find((a) => a.id === chg.x).is = chg.t.slice(0, 4);
};
if (!chg) for (const n of ['旁白说东西变了，画面上的它这一句没跟着变', '旁白说东西变了，写了 noChange 就不报', '旁白说东西变了，这一句圈出了它就不报']) skip(n, '基线分镜里挑不出合适的句子');
else {
  expectBeats('旁白说东西变了，画面上的它这一句没跟着变', unchanged, compileNoFix(TGT), /画面上的「[^」]+」（[^）]*）这一句没跟着变/, { any: true });
  expectBeats('旁白说东西变了，写了 noChange 就不报', (b) => {
    unchanged(b);
    b.phrases[chg.k].noChange = '演示：说的是别处的变化';
  }, compileNoFix(TGT), /^(?![\s\S]*这一句没跟着变)[\s\S]*时长/, { any: true });
  expectBeats('旁白说东西变了，这一句圈出了它就不报', (b) => {
    unchanged(b);
    b.phrases[chg.k].actions.push({ id: '_chg', type: 'ring', at: chg.t.slice(4, 6), target: chg.x });
  }, compileNoFix(TGT), /^(?![\s\S]*这一句没跟着变)[\s\S]*时长/, { any: true });
}
// 认不出说的是哪样东西（词在句首，前面没有字）、这一句又一笔不画：最后一句的动作清空（后面没有句子引用它们）
expectBeats('旁白说东西变了，这一句一笔没画', (b) => {
  const p = b.phrases.at(-1);
  b.style = { narrative: { [b.kind]: { changeWords: reEsc(strip(p.text).slice(0, 2)), changeNames: noNames } } };
  p.actions = []; delete p.focus; delete p.frame; delete p.revisit; delete p.camera;
}, compileNoFix(TGT), /说.{1,4}，这一句一笔没画/, { any: true });
// 画太满（layout.crowded）：e06-damp 样片 v1、e07-fur 静帧 s1–s3 三轮审稿点名。默认只是建议，私有配置设成 hard，所以报成建议或问题都算（any）。
// 上限按基线时间线里最满的那一句（M 块）定：上限 M − 1 要报；在 M 块的那一句里加一段接写（after）、两格同一张表（grid），上限 M + 1 不报（接写和那段字是一块、
// 两格是一块，只多了一块）；同样两段字不写 grid 就是两块，要报（对照：证明加的字真在取景里）
const crowd = (() => {
  const R = base.report.phrases;
  if (!R.some((p) => p.textBlocks !== undefined)) return { why: '基线时间线是旧编译器编的，没有每句的字块数：先重新编译基线' };
  const M = Math.max(...R.map((p) => p.textBlocks ?? 0));
  if (M < 2) return { why: `基线里最满的一句只有 ${M} 块字` };
  let i = 0, said = ''; // 分镜里的句子 → 时间线里的句子（编译时没有静音隔开的几句并成一句，文字首尾相接）
  const at = beatsSrc.phrases.map((p) => { if (said === R[i]?.text) { i++; said = ''; } said += p.text; return i; });
  const j = beatsSrc.phrases.findIndex((p, k) => R[at[k]]?.textBlocks === M && !p.revisit && p.camera === undefined
    && (p.actions ?? []).some((a) => a.type === 'text' && a.after === undefined && a.copyOf === undefined && a.grid === undefined && a.on === undefined));
  return j < 0 ? { why: `最满（${M} 块）的那一句自己没写字，加不了接写` } : { M, j };
})();
// 分镜自己带的 style（墨色、调色板）要留着，只改上限（整个换掉，分镜校验就报墨色不在规范里）
const crowdMax = (b, n) => { b.style = { ...b.style, type: { ...b.style?.type, maxScreenTexts: n } }; };
const crowdAdd = (b, grid) => {
  const p = b.phrases[crowd.j], h = p.actions.find((a) => a.type === 'text' && a.after === undefined && a.copyOf === undefined && a.grid === undefined && a.on === undefined);
  const cell = (id, dx) => ({ id, type: 'text', text: 'ab', x: h.x + dx * h.size, y: h.y + 1.6 * h.size, size: h.size, at: h.at, ...(grid ? { grid: '_selftest' } : {}) });
  p.actions.push({ id: '_crowd-aft', type: 'text', text: 'ab', after: h.id, size: h.size, at: h.at }, cell('_crowd-g1', 0), cell('_crowd-g2', 3));
};
if (crowd.why) for (const n of ['画太满（一屏的字块超过上限）', '画太满：接写和同一张表各算一块', '画太满：不在一张表里的两段字算两块']) skip(n, crowd.why);
else {
  expectBeats('画太满（一屏的字块超过上限）', (b) => { crowdMax(b, crowd.M - 1); }, compileNoFix(TGT), new RegExp(`说完时取景里有 \\d+ 块字（上限 ${crowd.M - 1}`), { any: true });
  expectBeats('画太满：接写和同一张表各算一块', (b) => { crowdMax(b, crowd.M + 1); crowdAdd(b, true); },
    compileNoFix(TGT), /^(?![\s\S]*说完时取景里有 \d+ 块字)[\s\S]*时长/, { any: true });
  expectBeats('画太满：不在一张表里的两段字算两块', (b) => { crowdMax(b, crowd.M + 1); crowdAdd(b, false); },
    compileNoFix(TGT), new RegExp(`说完时取景里有 \\d+ 块字（上限 ${crowd.M + 1}`), { any: true });
}
expectBeats('画面落后旁白太多（说到以后好几秒才开始画）', (b) => {
  b.style = { motion: { maxLagFar: 0.01, maxLag: 0 } };
  const p = b.phrases.find((q) => (q.actions ?? []).filter((a) => !a.copyOf).length >= 2);
  for (const a of p.actions) a.at = p.text.slice(0, 2);
}, compileNoFix(TGT), /说到 0\.01s 后还没开始画/, { any: true });
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

// 回转比对的拼音（tts/voice.py 的 pinyin_syllables 和识别那一边的 heard_syllables，qwen_clone.py 逐句验收、speech_check.py 总混可懂度、line_asr.py 逐句回转都用它）：
// 同音字算一致；前后鼻音不分（用户 2026-11-16：南方孩子本来就不太分，E07「考零格」听成「考林格」卡掉 30 个种子）；平翘舌、别的韵母读错仍算错。
// 识别写出来的字是多音字、其中一个读音和稿子的字一样，也算一致（e07-fur 稿子「黏成」识别写「粘成」，粘按上下文念 zhān，种子试满也过不了）；
// 只放宽这一种：稿子写的多音字照上下文定一个读音（稿子「粘在」、识别「黏在」仍算错），识别写的多音字没有稿子那个读音的仍算错（一成 / 一长）；
// 读音只认词表里用到过的（也 yì、有 wěi 这类生僻读音不算），高频虚词不放宽（「第一」念糊、识别写「的一」仍算错）
if (SKIP.has('speech') || !PY_MLX) skip('回转比对：前后鼻音不分、识别写的多音字任一读音都算、别的读错仍算错（单元检查）', SKIP.has('speech') ? '这次没改配音和旁白检查（--skip speech）' : '没有本地配音环境（PY_MLX）');
else {
  const r = spawnSync(PY_MLX, ['-c', `
import sys, json
sys.path.insert(0, '.')
from voice import pinyin_syllables as s, heard_syllables as h
print(json.dumps({"前后鼻音": s("考零格") == s("考林格") and s("人生") == s("人身") and s("一样") == s("一言") and s("考零格") == h("考林格"),
  "同音字": s("乘上") == s("成上") and s("乘上") == h("成上"), "数字": s("试了50次") == s("试了五十次") and s("试了50次") == h("试了五十次"),
  "平翘舌仍算错": s("一成") != s("一层") and s("一成") != h("一层"), "韵母仍算错": s("才亮") != s("材料") and s("才亮") != h("材料"), "字母原样": s("AI") == ["a", "i"] and h("AI") == ["a", "i"],
  "识别写的多音字任一读音都算": s("头发就黏成一缕") == h("头发就粘成一缕") and h("头发就粘成一缕") == s("头发就黏成一缕"),
  "稿子写的多音字不放宽": s("粘在一起") != h("黏在一起"), "多音字没有那个读音仍算错": s("一成") != h("一长") and s("一层") != h("一长"),
  "高频虚词不放宽": s("第一") != h("的一") and s("一块儿") != h("一会儿") and s("换成") != h("还成") and s("聊天") != h("了天"),
  "词表里没用到的生僻读音不算": s("一样") != h("也样") and s("为什么") != h("有什么") and s("零个") != h("任个") and s("拧开") != h("年开")}))`], { encoding: 'utf8', cwd: '../tts' });
  let got = {}; try { got = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {}
  record('回转比对：前后鼻音不分、识别写的多音字任一读音都算、别的读错仍算错（单元检查）', Object.keys(got).length === 11 && Object.values(got).every(Boolean), (r.stdout || '') + (r.stderr || ''));
}
// 逐句回转的比法和点名（tts/line_asr.py，识别换成桩，不载模型）：一个片段里两句，念错的字只点名它在的那一句；
// 稿子「1、1、0」「两千五百」「AI」和识别写的「一一零」「2500」「AI」算一致（片段 phrase 去了标点是 110，要按逐字拼稿子）；
// 只有总混错、错在开头的单独标出来；多听到的字算在它前面那个字所在的那一句；短于 3 个字的片段跳过并计数
if (SKIP.has('speech') || !PY_MLX) skip('逐句回转：念错的字点名到那一句、只有总混错单独标出、识别写的多音字任一读音都算（单元检查）', SKIP.has('speech') ? '这次没改配音和旁白检查（--skip speech）' : '没有本地配音环境（PY_MLX）');
else {
  const r = spawnSync(PY_MLX, ['-c', `
import sys, json
sys.path.insert(0, '.')
from line_asr import check_lines
S = ["它俩本事没变，新卷子要是更难，它俩也该掉分。", "有1、1、0个AI，2500道。", "写代码这类卷子。", "哦。"]
words, sents, t = [], [], 0.0
for s in S:
    a = t
    toks, i = [], 0
    while i < len(s):
        for tok in ("AI", "2500"):
            if s.startswith(tok, i): toks.append(tok); i += len(tok); break
        else:
            if s[i] not in "，。、": toks.append(s[i])
            i += 1
    for tok in toks: words.append({"text": tok, "start": t, "end": t + 0.18}); t += 0.2
    sents.append({"text": s, "start": a, "end": t}); t += 0.5
strip = lambda s: "".join(ch for ch in s if ch not in "，。、")
clips = [{"phrase": strip(S[0] + S[1]), "at": 0, "srcIn": sents[0]["start"], "srcOut": sents[1]["end"]},
         {"phrase": strip(S[2]), "at": 20, "srcIn": sents[2]["start"], "srcOut": sents[2]["end"]},
         {"phrase": strip(S[3]), "at": 30, "srcIn": sents[3]["start"], "srcOut": sents[3]["end"]}]
def run(dry, mix):  # 桩：dry、mix 是每段识别出的字，片段的「音频」就是这段字
    return check_lines(clips, {"words": words, "sentences": sents}, lambda i, c: (dry[i], 0), lambda i, c: (mix[i], 0), lambda x, sr: x)
ok = ["它俩本事没变，新卷子要是更难，它俩也该掉分。有一一零个AI，2500道。", "写代码这类卷子。", "哦。"]
ok2 = ["它俩本事没变新卷子要是更难它俩也该掉分，有一、一、零个AI两千五百道", "写代码这类卷子", "噢"]
juan = [ok[0].replace("新卷子", "新阵子")] + ok[1:]
ye = [ok[0], "野代码这类卷子。", ok[2]]
en = [ok[0].replace("零个", "零个嗯")] + ok[1:]  # 多听到一个字：算在它前面那个字所在的那一句
a, b, c, d, e = run(ok, ok2), run(juan, juan), run(ok, ye), run(ok2, ok), run(en, ok)
pick = lambda res: [(x["clip"], x["ks"], x["dryDiff"], x["mixDiff"], x["mixOnly"], x["atStart"]) for x in res["bad"]]
# 识别写的同音字是多音字、有稿子那个读音（稿子「黏成」nián，识别「粘成」）算对上；写成只念 zhān 的「沾成」仍算错（e07-fur 样片）
S2 = "头发就黏成一缕。"
w2 = [{"text": ch, "start": 0.2 * k, "end": 0.2 * k + 0.18} for k, ch in enumerate(strip(S2))]
c2 = [{"phrase": strip(S2), "at": 0, "srcIn": 0.0, "srcOut": w2[-1]["end"]}]
one = lambda said: check_lines(c2, {"words": w2, "sentences": [{"text": S2, "start": 0.0, "end": w2[-1]["end"]}]}, lambda i, c: (said, 0), lambda i, c: (said, 0), lambda x, sr: x)
f, g = one("头发就粘成一缕"), one("头发就沾成一缕")
print(json.dumps({"ok": not a["bad"] and not d["bad"] and a["checked"] == 2 and a["skipped"] == 1,
  "juan": pick(b) == [(0, [0], ["卷→阵"], ["卷→阵"], False, False)],
  "ye": pick(c) == [(1, [2], [], ["写→野"], True, True)],
  "extra": pick(e) == [(0, [1], ["多了「嗯」"], [], False, False)],
  "nian": not f["bad"] and f["checked"] == 1, "zhan": pick(g) == [(0, [0], ["黏→沾"], ["黏→沾"], False, False)]}, ensure_ascii=False))`], { encoding: 'utf8', cwd: '../tts' });
  let got = {}; try { got = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {}
  record('逐句回转：念错的字点名到那一句、只有总混错单独标出、识别写的多音字任一读音都算（单元检查）', Object.keys(got).length === 6 && Object.values(got).every(Boolean), (r.stdout || '') + (r.stderr || ''));
}

// ---------- 旁白检查按时刻点名到句（tts/sentence_map.py，单元检查）：一个片段里有两句时，前一句句尾的收音硬切要点名前一句，
// 后一句句首的起音硬切点名后一句；两句都要有范围（E05 558 秒：「回到那三条规则。第二条说，听到咳嗽就算有人。」同一片段，
// 原来按片段归句，前一句没有范围，硬切点名到「第二条说……」，自动换种子换错了句）。时间取自 E05 的真实时间线 ----------
{
  const r = spawnSync(PY_QA, ['-c', `
import sys, json
sys.path.insert(0, '../tts')
from sentence_map import sentence_spans, sentence_at
clips = [{'at': 557.23, 'srcIn': 495.4680, 'srcOut': 498.4255}, {'at': 560.18, 'srcIn': 498.4255, 'srcOut': 504.0780}]
S = [{'start': 495.40, 'end': 498.403}, {'start': 498.403, 'end': 500.683}, {'start': 500.683, 'end': 504.073}]
sp = sentence_spans(clips, S)
end1 = [b for k, a, b in sp if k == 1][0]
print(json.dumps({'ks': [k for k, a, b in sp], 'shou': sentence_at(end1 - 0.05, sp, -0.02), 'qi': sentence_at(end1 + 0.03, sp, 0.02),
                  'edge': sentence_at(end1, sp, -0.02), 'mid': sentence_at(558.5, sp), 'far': sentence_at(9999, sp)}))`], { encoding: 'utf8' });
  let o = null;
  try { o = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* 下面按漏掉记 */ }
  record('旁白检查点名：同一片段里两句，硬切按时刻落到具体句子（单元检查）', !!o && o.ks.join() === '0,1,2' && o.shou === 1 && o.qi === 2 && o.edge === 1 && o.mid === 0 && o.far === null, (r.stdout || '') + (r.stderr || ''));
}
// ---------- 配音断句（tts/voice.py 的 phrasing，单元检查）：没标点却停、字拖长（E04「天黑不天黑」：没有静音，「黑」拖了 0.56 秒）都要报；
// 逗号前、句末的字拖长是正常停顿和收尾，不报。合成的音频：每个字一段连续的浊音，标点处留静音。voice.py 顶上要 mlx，这里换成空模块 ----------
{
  const r = spawnSync(PY_QA, ['-c', `
import sys, types, json
sys.modules['mlx'] = types.ModuleType('mlx'); sys.modules['mlx.core'] = types.ModuleType('mlx.core'); sys.modules['mlx'].core = sys.modules['mlx.core']
sys.path.insert(0, '../tts')
import numpy as np
from voice import phrasing
sr = 16000
def take(text, durs, gaps, drawl=None):
    # durs：每个字的秒数；gaps：{第几个字后面: 静音秒数}
    words, xs, t = [], [], 0.0
    chars = [c for c in text if c not in '，。']
    for i, (c, d) in enumerate(zip(chars, durs)):
        n = int(d * sr); xs.append(0.3 * np.sin(2 * np.pi * 220 * np.arange(n) / sr)); words.append({'text': c, 'start': round(t, 3), 'end': round(t + d, 3)}); t += d
        g = gaps.get(i, 0.0)
        if g: xs.append(np.zeros(int(g * sr))); t += g
    return phrasing(np.concatenate(xs), sr, words, text, drawl=drawl)[0]
T = '天黑不天黑都一样，它只看两件事。'
d0 = [0.2] * 14
out = {
  'clean': take(T, d0, {7: 0.3}),
  'drawl': take(T, [0.2, 0.56] + [0.2] * 12, {7: 0.3}),
  'beforeComma': take(T, [0.2] * 7 + [0.6] + [0.2] * 6, {7: 0.3}),
  'last': take(T, [0.2] * 13 + [0.7], {7: 0.3}),
  'pause': take(T, d0, {1: 0.3, 7: 0.3}),
  'off': take(T, [0.2, 0.56] + [0.2] * 12, {7: 0.3}, {'minSec': 0}),
}
print(json.dumps(out, ensure_ascii=False))`], { encoding: 'utf8' });
  let o = null;
  try { o = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* 下面按漏掉记，打出 stderr */ }
  const kinds = (xs) => (xs ?? []).map((x) => `${x[0]}|${x[1]}:${x[3]}`).join(',');
  const out = (r.stdout || '') + (r.stderr || '');
  record('配音断句：字拖长 0.56 秒、没有静音（「天黑|不天黑」）', !!o && kinds(o.drawl) === '天黑|不天黑:拖' && !o.clean.length, out);
  record('配音断句：没标点却停了 0.3 秒', !!o && kinds(o.pause) === '天黑|不天黑:停', out);
  record('配音断句：逗号前、句末拖长不算，drawl.minSec 填 0 不查（不误报）', !!o && !o.beforeComma.length && !o.last.length && !o.off.length, out);
}
// ---------- 字中间掉音（tts/voice.py 的 zero_dropouts，单元检查）：字里挖 40ms 全零要报；逗号停顿处整段全零（TTS 本来就这样输出）、
// 前一个字收得快（20ms 窗里还在发声）的不报（e03-coldest 成片 v1「皮开尔文，那是」的逗号停顿被当成掉音，整片停在渲染前）----------
{
  const r = spawnSync(PY_QA, ['-c', `
import sys, types, json
sys.modules['mlx'] = types.ModuleType('mlx'); sys.modules['mlx.core'] = types.ModuleType('mlx.core'); sys.modules['mlx'].core = sys.modules['mlx.core']
sys.path.insert(0, '../tts')
import numpy as np
from voice import zero_dropouts
sr = 16000
def take(durs, gaps):
    # 每个字一段 0.3 振幅的浊音、首尾 10ms 线性淡入淡出；gaps：{第几个字后面: 全零秒数}
    xs, items, t = [], [], 0.0
    for i, d in enumerate(durs):
        n, f = int(d * sr), int(0.01 * sr)
        s = 0.3 * np.sin(2 * np.pi * 220 * np.arange(n) / sr); s[:f] *= np.linspace(0, 1, f); s[-f:] *= np.linspace(1, 0, f)
        xs.append(s); items.append({'t0': t, 't1': t + d}); t += d
        g = gaps.get(i, 0.0)
        if g: xs.append(np.zeros(int(g * sr))); t += g
    return np.concatenate(xs), items
x, items = take([0.24] * 6, {3: 0.3})        # 「皮开尔文，那是」：第 4 个字后面逗号停 0.3 秒
hole = x.copy(); m = int(0.36 * sr); hole[m:m + int(0.04 * sr)] = 0   # 第 2 个字正中挖 40ms
print(json.dumps({'pause': zero_dropouts(x, sr, items), 'pauseNoTiming': zero_dropouts(x, sr), 'hole': zero_dropouts(hole, sr, items),
                  'joint': zero_dropouts(x, sr, (), [1.11])}))`], { encoding: 'utf8' }); // joint：没有逐字时间，停顿正好是两段配音的接缝
  let o = null;
  try { o = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* 下面按漏掉记，打出 stderr */ }
  const out = (r.stdout || '') + (r.stderr || '');
  record('字中间掉音：字里挖 40ms 全零（单元检查）', !!o && o.hole.length === 1 && Math.abs(o.hole[0][0] - 0.36) < 0.002, out);
  record('字中间掉音：逗号停顿处整段全零不算，接缝处的也不算（不误报；没有逐字时间时照旧按两侧发声判）', !!o && !o.pause.length && !o.joint.length && o.pauseNoTiming.length === 1, out);
}

// ---------- 配音卡句早报、拼好后换种子配不出来就不再重配（tts/qwen_clone.py 整个跑一遍，模型换成桩：qa/fixtures/fake_voice.py，不要配音环境）----------
// e02-voyager：一句「十」拼好后偏弱，重配换种子没配出来，又从同一个种子起再试两轮（每轮 50 条），主讲配音 2 小时 29 分才报失败，中间看不出卡在哪一句。
// 剧本一（stuck）：第 2 句每个种子都把「球只」念成「我只」（配不出来）；第 3 句前 16 个种子把「尺子」念成「绳子」（试到一半还没过，后来过了）。
//   两句都要在第 15 个种子（上限 10×3 的一半）时打一行「[卡句]」，写明试了几个、原因、听成什么；第 2 句的那一行要在它配完之前打出来，只打一次；
//   整轮配完列出第 2 句（[错误]、stuck.json）、非零退出，第 3 句照样配出来。
// 剧本二（weak，就是 e02-voyager 那样）：第 2 句的「十」念得很轻（逐句的关卡都过，拼好后才查出字偏弱），种子 3 起还念成「四」（重配换种子配不出来）：
//   重配一次、当中打「[卡句]」，配不出来就不再重配，报 [错误]、非零退出（原来留原来那条，又从同一个种子起再试两轮）。
// 剧本三（weak2，PR #93 审查）：「十」只有种子 2、3 念得轻：重配出来的那条还偏弱，就从它的下一个种子再配，第二次配通，整个过（不能改成直接失败）。
// 剧本四（clean）：同样的稿子不念轻：整个配通。上面几条失败的不是桩
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-voice-'));
  const play = (name, scen) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(scen));
    const r = spawnSync(PY_QA, ['qa/fixtures/fake_voice.py', path.join(dir, name), f], { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), dir: path.join(dir, name) };
  };
  try {
    const T = '我们先看一个小圆。这根绳子有几十米长。这样就看清楚了。';
    const c = play('clean', { text: T, rules: [] });
    record('假配音环境：没有毛病的稿子整个配通（下面几条的失败不是桩造成的）', c.status === 0 && c.out.includes('通过：3 句'), c.out);

    const S2 = '红球比蓝球大很多倍，蓝球只占一点地方。', S3 = '再拿一根尺子量它。';
    const a = play('stuck', { text: `我们先看一个小圆。${S2}${S3}这样就看清楚了。`, rules: [{ has: '球只', say: '我只' }, { has: '尺子', say: '绳子', below: 18 }] });
    const L = a.out.split('\n'), at = (p) => L.findIndex((l) => l.includes(p));
    const k2 = at(`[卡句] 第 2/4 句「${S2}」试了 15 个种子还没有一条过关`), k3 = at(`[卡句] 第 3/4 句「${S3}」试了 15 个种子还没有一条过关`);
    let stuck = null;
    try { stuck = JSON.parse(fs.readFileSync(path.join(a.dir, 'out/fake.stuck.json'), 'utf8')); } catch { /* 下面按漏掉记 */ }
    record('配音卡句早报：一句试到上限的一半还没过，当场打「[卡句]」（第几句、原文、试了几个、原因、听成什么），只打一次，接着试完',
      k2 >= 0 && k2 < at('第 2/4 句没配出来') && L[k2].includes('回转识别没对上 15 次') && L[k2].includes('听成「红球比蓝球大很多倍蓝我只占一点地方」15 次')
      && L.filter((l) => l.startsWith('[卡句] 第 2/4 句')).length === 1 && k3 >= 0 && k3 < at('第 3/4 句（种子 18，'), a.out);
    record('配音整轮配完一次列出没过的句子、非零退出，试到一半卡过、后来过了的句子照样配出来',
      a.status !== 0 && L.some((l) => l.startsWith(`[错误] 第 2/4 句配不出来：「${S2}」试了 30 条`)) && !a.out.includes('[错误] 第 3/4 句')
      && stuck?.stuck.map((x) => x.text).join() === S2, a.out);

    const b = play('weak', { text: T, rules: [{ has: '十', weak: true }, { has: '十', say: '四', from: 3 }] });
    record('配音拼好后查出字偏弱、重配换种子配不出来：不再从同一个种子起重配，当中打「[卡句]」，报 [错误]、非零退出（原来又试两轮）',
      b.status !== 0 && (b.out.match(/拼好后第 2 句有字偏弱/g) || []).length === 1 && b.out.includes('[卡句] 第 2/3 句（拼好后有字偏弱，第 1 次换种子重配）')
      && b.out.split('\n').some((l) => l.startsWith('[错误] 第 2/3 句拼好后有字偏弱（「十」') && l.includes('没配出全部关卡都过的一条') && l.includes('听成「这根绳子有几四米长」')), b.out);
    const w2 = play('weak2', { text: T, rules: [{ has: '十', weak: true, below: 4 }] });
    record('配音拼好后字偏弱、重配出来的那条还偏弱：从它的下一个种子接着配，配通了照样过（不改成直接失败）',
      w2.status === 0 && (w2.out.match(/拼好后第 2 句有字偏弱/g) || []).length === 2 && w2.out.includes('通过：3 句'), w2.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// ---------- 配音日志边跑边写（compiler/live_log.mjs，流水线的配音几步用它写 tts/out/<id>.<说话人>.voice.log）：子进程还没跑完，
// 「[卡句]」那一行已经在日志里、已经交给 onLine；stderr 的半行和下一块拼成一整行；一个汉字的字节分在两块里也不乱码；
// stdout 写了半行时 stderr 插进来一行，「[错误]」那一行仍然完整、在行首（流水线按行首认待改）；退出码照传；append 接着往下写 ----------
{
  const { runLogged } = await import('../compiler/live_log.mjs');
  const log = path.resolve('build/_selftest.voice.log');
  const child = `const o = process.stdout, e = process.stderr, han = Buffer.from('汉');
o.write('第 1 句\\n');
setTimeout(() => { o.write('[卡句] 第 2 句「十」\\n'); e.write('警告：一半');
  setTimeout(() => { e.write('的行\\n'); o.write(han.subarray(0, 2)); setTimeout(() => { o.write(han.subarray(2)); o.write('字\\n');
    o.write('[错误] 甲'); setTimeout(() => { e.write('乙\\n'); setTimeout(() => { o.write('\\n'); process.exitCode = 3; }, 30); }, 30); }, 50); }, 300); }, 100);`;
  const seen = [];
  let mid = null;
  fs.mkdirSync('build', { recursive: true });
  const r1 = await runLogged(process.execPath, ['-e', child], { log, onLine: (l) => { seen.push(l); if (l.startsWith('[卡句]')) mid = fs.readFileSync(log, 'utf8'); } });
  const r2 = await runLogged(process.execPath, ['-e', 'console.log("第二轮")'], { log, append: true, header: '# 第 1 轮自动换种子重配' });
  const body = fs.readFileSync(log, 'utf8');
  fs.rmSync(log, { force: true });
  record('配音日志边跑边写：没跑完就能在日志里看到「[卡句]」，整行交给 onLine，汉字不乱码，退出码照传，重配那一轮接着写',
    r1.status === 3 && !!mid && mid.includes('[卡句] 第 2 句「十」') && !mid.includes('汉字') && seen.includes('警告：一半的行') && seen.includes('汉字')
    && r1.out.includes('汉字') && /^\[错误\] 甲$/m.test(r1.out) && /^\[错误\] 甲$/m.test(body) && body.includes('退出码 3') && body.indexOf('第 1 句') < body.indexOf('# 第 1 轮自动换种子重配') && body.includes('第二轮') && r2.status === 0,
    JSON.stringify({ r1, seen, mid, body }));
}
// ---------- 旁白检查点名回声、沙沙声超标的句子（tts/revoice.py，单元检查）：回声管最长一句，超过上限的每句都重配；
// 沙沙声管全片中位数，没超不点名（个别句子高也不点），超了只点最高的那几句、够把中位数拉回上限以内（e02-voyager 一句回声 112ms、上限 110，原来只能手写 reseed）----------
{
  const r = spawnSync(PY_QA, ['-c', `
import sys, json, random, statistics
sys.path.insert(0, '../tts')
from revoice import over, median_over
V = lambda xs: list(enumerate(xs))
fixed_ok = True
rng = random.Random(7)
for _ in range(300):  # 随便造几百组：点名的那几句换成上限以下以后，中位数一定回到上限以内；中位数本来没超就不点名
    xs = [rng.uniform(0.05, 0.14) for _ in range(rng.randint(1, 40))]
    ks = median_over(V(xs), 0.095)
    ys = [0.0 if k in ks else x for k, x in enumerate(xs)]
    fixed_ok &= statistics.median(ys) <= 0.095 and (bool(ks) == (statistics.median(xs) > 0.095))
print(json.dumps({"echo": over(V([90, 112, 105, 130]), 110) == [1, 3], "echoOk": over(V([90, 100, 110]), 110) == [],
  "medOk": median_over(V([0.08, 0.09, 0.12, 0.13, 0.07]), 0.095) == [], "medOdd": median_over(V([0.08, 0.10, 0.12, 0.13, 0.07]), 0.095) == [3],
  "medEven": median_over(V([0.08, 0.10, 0.12, 0.13, 0.07, 0.096]), 0.095) == [3, 2], "empty": median_over([], 0.095) == [], "fixed": fixed_ok}))`], { encoding: 'utf8' });
  let o = null;
  try { o = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* 下面按漏掉记 */ }
  record('旁白检查点名：回声超标的每句、沙沙声中位数超了时最高的几句进 revoice.json（单元检查）', !!o && Object.keys(o).length === 7 && Object.values(o).every(Boolean), (r.stdout || '') + (r.stderr || ''));
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
