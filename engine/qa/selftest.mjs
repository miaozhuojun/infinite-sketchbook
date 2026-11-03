// 检查器自测：对一份已通过的时间线/分镜注入已知缺陷，每一项检查都必须报出来；否则说明检查形同虚设。
// 引擎、组件库、风格规范或检查器改动后先跑这个。用法：node qa/selftest.mjs build/<id>-9x16.timeline.json
// 注入目标按类型和时间挑（文字、图形、推近镜头……），不认某一期的元素名，演示分镜和每一期都能当基线；CI 跑的是演示分镜。
// 旁白类注入要真人配音和本地配音环境：配音是合成提示音（演示分镜）或没有 PY_MLX 时整组跳过，结果里写明跳过了哪些、为什么。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cameraAt } from '../src/timeline.ts';
import { PY_QA, PY_MLX } from './pyenv.mjs';

const basePath = process.argv[2];
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const beatsSrc = JSON.parse(fs.readFileSync(`data/${base.beatsId}.beats.json`, 'utf8'));
const results = [], skipped = [];
const record = (name, caught, out) => { results.push({ name, caught }); console.log(`${caught ? '✓ 抓到' : '✗ 漏掉'}  ${name}`); if (!caught) console.log(out.slice(-700)); };
const skip = (name, why) => { skipped.push({ name, why }); console.log(`–  跳过  ${name}`); };

// ---------- 时间线上的注入（渲染后检查：铅笔、运笔、镜头、字幕、安全区、旁白） ----------
function expectFail(name, mutate, runner, mustSay) {
  const tl = structuredClone(base);
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
const noSpeech = beatsSrc.narration?.synthetic ? '配音是合成提示音，没有人声可查' : PY_MLX ? null : '没有本地配音环境（PY_MLX）';
const OTHER_VOICE = path.resolve('qa/fixtures/other-voice.mp3');
const speechCase = (name, mutate, mustSay, why = noSpeech) => (why ? skip(name, why) : expectFail(name, mutate, speech, mustSay));

// 挑注入目标用的几何：和渲染、检查共用同一套镜头
const toScreen = (tl, [x, y], t) => { const c = cameraAt(tl.camera, t); return [(x - c.x) * c.z + tl.view.cx, (y - c.y) * c.z + tl.view.cy]; };
const mid = (vs) => (Math.min(...vs) + Math.max(...vs)) / 2;
const isText = (s) => s.kind === 'glyph' || s.kind === 'line';
const subTop = (tl) => tl.sub.top - (tl.style?.subtitle?.plate?.padY ?? 0);
// 写字中的一帧（笔在纸上，不在抬笔移动里）：正中那一笔写到一半
const writingFrame = (tl) => { const s = tl.strokes[Math.floor(tl.strokes.length / 2)]; return Math.round(((s.t0 + s.t1) / 2) * tl.fps); };
// 停笔 1 秒，让笔身（不是笔尖）横在一块内容正中：笔尖放在中心沿笔的方向往回 0.45 个笔长的地方
function restAcross(tl, pts, t0) {
  const P = tl.style.pencil, Lw = P.length * P.scale * (Math.min(tl.canvas.w, tl.canvas.h) / 1080), r = (P.base * Math.PI) / 180;
  const cx = mid(pts.map((q) => q[0])), cy = mid(pts.map((q) => q[1]));
  return { kind: 'rest', t0, t1: t0 + 1, at: [cx - Math.cos(r) * Lw * 0.45, cy - Math.sin(r) * Lw * 0.45] };
}

const b1 = pencil(path.resolve(basePath));
console.log(b1.status === 0 ? '✓ 基线：铅笔与运笔检查通过' : '✗ 基线就没通过，自测无意义');
// 旁白类注入要以这份时间线自己的旁白为基线：基线就不过，后面的「抓到」可能只是碰巧
const b2 = noSpeech ? null : speech(path.resolve(basePath));
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
}, pencil, '[失败] 顿悟时镜头不拉远');
expectFail('推近镜头里铅笔停在焦点元素上 1 秒', (tl) => {
  // 推近到位、焦点元素至少写出一笔之后，停笔 1 秒，笔身横在已写出的焦点内容上
  const m = tl.camera.find((x) => x.focus), fx = tl.strokes.filter((x) => m.focus.includes(x.action));
  const t0 = Math.max(m.t1, Math.min(...fx.map((x) => x.t1))) + 0.05;
  tl.penTrack.unshift(restAcross(tl, fx.filter((x) => x.t1 <= t0).flatMap((x) => x.pts), t0)); // 排在最前面，这一秒里取到的就是它
}, pencil, '[失败] 停笔不压正在讲的东西');
expectFail('停笔 1 秒压在刚写完的字上（不在推近镜头里）', (tl) => {
  // 找一个整段都是文字、写完时不在推近镜头里的动作，写完后停笔 1 秒，笔身横在它正中
  const inFocus = (t) => tl.camera.some((m, i) => m.focus && t >= m.t0 && t < (tl.camera[i + 1]?.t0 ?? tl.duration));
  const ss = [...Map.groupBy(tl.strokes, (x) => x.action).values()].reverse().find((g) => g.every(isText) && !inFocus(g.at(-1).t1 + 0.1));
  tl.penTrack.unshift(restAcross(tl, ss.flatMap((x) => x.pts), ss.at(-1).t1 + 0.05));
}, pencil, '[失败] 停笔不压正在讲的东西');
expectFail('写字时笔身横在别的字上 1.5 秒（不是停笔）', (tl) => {
  // 找一个整段都是文字的动作，写完后插一段 1.5 秒的原地「移动」，笔身横在它正中（停够 0.5 秒的停笔归第 6 项管，这里要的是写字和移动时）
  const g = [...Map.groupBy(tl.strokes, (x) => x.action).values()].find((q) => q.every(isText));
  const r = restAcross(tl, g.flatMap((x) => x.pts), g.at(-1).t1 + 0.05);
  tl.penTrack.unshift({ kind: 'move', t0: r.t0, t1: r.t0 + 1.5, from: r.at, to: r.at });
}, pencil, '[失败] 写字时笔身不长时间压住别的字');
expectFail('一句话里笔身断续压字，累计超过上限（每段都不到 1 秒）', (tl) => {
  // 在一句旁白里插四段 0.7 秒的原地「移动」，笔身横在一段已写的文字上，中间隔 0.1 秒：连续的检查拦不住，累计的要拦住
  const g = [...Map.groupBy(tl.strokes, (x) => x.action).values()].find((q) => q.every(isText)), r = restAcross(tl, g.flatMap((x) => x.pts), g.at(-1).t1 + 0.05);
  for (let i = 3; i >= 0; i--) tl.penTrack.unshift({ kind: 'move', t0: r.t0 + i * 0.8, t1: r.t0 + i * 0.8 + 0.7, from: r.at, to: r.at });
  const p = tl.report.phrases.findLast((q) => q.at <= r.t0);
  p.at = Math.min(p.at, r.t0); // 这四段都算在同一句里
  (tl.report.phrases[tl.report.phrases.indexOf(p) + 1] ?? {}).at = Math.max(tl.report.phrases[tl.report.phrases.indexOf(p) + 1]?.at ?? 0, r.t0 + 3.3);
}, pencil, '累计压字超过');
expectFail('片尾铅笔停在画面中间', (tl) => {
  const c = cameraAt(tl.camera, tl.duration), last = tl.penTrack.at(-1);
  last.at = [c.x, c.y]; // 最后一段停笔挪到片尾镜头的正中
  tl.penTrack.at(-2).to = last.at;
}, pencil, '[失败] 片尾不带笔');
expectFail('字幕挪进 TikTok 底部信息栏', (tl) => { tl.sub.top = 1600; }, safezone, '[失败] 字幕避开平台界面');
expectFail('内容整体右移 400px 进右侧按钮列', (tl) => { tl.view.cx += 400; }, safezone, '[失败] 内容避开平台界面');
expectFail('推近镜头把一段文字切成半截', (tl) => {
  // 找一个推近镜头和一段已写的文字，把镜头挪到让这段文字正好骑在画面左边缘上
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1);
  const xs = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[0]));
  m.to = { ...m.to, x: mid(xs) + tl.view.cx / m.to.z };
}, safezone, '[失败] 镜头停稳时不切字、不留残边');
expectFail('推近镜头把一段文字推到字幕衬底下面', (tl) => {
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1);
  const ys = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[1]));
  m.to = { ...m.to, y: mid(ys) - (subTop(tl) - tl.view.cy) / m.to.z }; // 让这段文字的中线正好落在字幕衬底上沿
}, safezone, '[失败] 镜头停稳时不切字、不留残边');
expectFail('推近时一段文字落进 TikTok 顶部栏（文字整段在画布里）', (tl) => {
  const m = tl.camera.find((x) => x.focus), st = tl.strokes.find((s) => isText(s) && s.t1 < m.t1 && !m.focus.includes(s.action));
  const ys = tl.strokes.filter((s) => s.action === st.action).flatMap((s) => s.pts.map((p) => p[1]));
  m.to = { ...m.to, y: mid(ys) - (65 - tl.view.cy) / m.to.z }; // 文字中线落在屏幕 y=65，正在顶部标签栏（0–130）里
}, safezone, '[失败] 镜头停稳时不切字、不留残边');
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
}, safezone, '[失败] 镜头停稳时不切字、不留残边');
expectFail('图形停在取景框外的顶边距里（像推近后挂在顶边的下划线）', (tl) => {
  const [m, ys] = shotWithShape(tl), z = Math.min(m.to.z, (tl.frame.t - 20) / (Math.max(...ys) - Math.min(...ys)));
  m.to = { ...m.to, z, y: Math.max(...ys) - (tl.frame.t - 10 - tl.view.cy) / z }; // 整个图形落在画布顶边和取景框上沿之间
}, safezone, '[失败] 镜头停稳时不切字、不留残边');
expectFail('推近把焦点挤到画面顶上（下面大半空着）', (tl) => {
  const m = tl.camera.find((x) => x.focus && (x.to.push ?? 1) > 1.001);
  m.to = { ...m.to, y: m.to.y + (0.35 * (tl.frame.b - tl.frame.t)) / m.to.z }; // 焦点中心往上挪 35% 个取景框高
}, safezone, '[失败] 推近时焦点在画面中部');
expectFail('推近镜头把焦点内容推进 TikTok 顶部栏', (tl) => { const m = tl.camera.find((x) => x.focus); m.to = { ...m.to, y: m.to.y + 650 / m.to.z }; }, safezone, '[失败] 内容避开平台界面');
// 水印：没配置品牌的时间线（CI 跑的演示分镜）没有水印，就注入一段，检查照样要查
const wmOf = (tl) => (tl.watermark ??= { text: '测试水印', size: 30, opacity: 0.42, fade: 0.8, margin: 10, spans: [] });
expectFail('水印挪进 TikTok 右侧按钮列', (tl) => { wmOf(tl).spans = [{ t0: 0, t1: tl.duration, x: 980, y: 1000, anchor: 'l' }]; }, safezone, '[失败] 水印避开字幕、平台界面和内容');
expectFail('水印压在字幕上', (tl) => { const s = tl.subtitles[0]; wmOf(tl).spans = [{ t0: s.t0, t1: s.t1, x: tl.sub.cx, y: tl.sub.top, anchor: 'l' }]; }, safezone, '[失败] 水印避开字幕、平台界面和内容');
expectFail('水印换位正好撞上顿悟句', (tl) => {
  // 两段水印在顿悟句说到一半时换位（两个位置都离字幕、平台界面远，只看换位时刻）
  const p = tl.report.phrases.find((q) => q.role === 'aha'), t = (p.at + p.audioEnd) / 2;
  wmOf(tl).spans = [{ t0: 0, t1: t, x: 980, y: 1000, anchor: 'l' }, { t0: t, t1: tl.duration, x: 980, y: 1000, anchor: 'l' }];
}, safezone, '[失败] 水印换位避开顿悟句');
expectFail('水印压在画好的内容上', (tl) => {
  // 最后一笔画完后，水印放在它结尾时的屏幕位置上，一直显示到片尾
  const s = tl.strokes.at(-1), [x, y] = toScreen(tl, s.pts[Math.floor(s.pts.length / 2)], tl.duration);
  wmOf(tl).spans = [{ t0: s.t1, t1: tl.duration, x, y: y - 10, anchor: 'l' }];
}, safezone, '[失败] 水印避开字幕、平台界面和内容');
speechCase('旁白切点切进一个字的正中间', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', beatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips.find((x) => timing.words.filter((w) => w.start >= x.srcIn && w.end <= x.srcOut).length >= 3);
  const inClip = timing.words.filter((w) => w.start >= c.srcIn && w.end <= c.srcOut);
  c.srcIn = (inClip[2].start + inClip[2].end) / 2;
}, '[失败] 拼接切点落在静音处');
speechCase('旁白里一个字的开头被抹掉 80ms', (tl) => {
  const src = path.resolve('public', base.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf, json, numpy as np
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
c = json.loads(${JSON.stringify(JSON.stringify(base.audioClips.at(-1)))})
a = int((c['at'] + 0.03) * sr)
k = a + int(np.argmax(np.abs(x[a:a + int(0.6 * sr)]) > 0.05))
x[k:k + int(0.08 * sr)] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  tl.narration = 'audio/_selftest.narration.wav';
  delete tl.audio;
  return { cleanup: [dst] };
}, '[失败] 拼接后声音完整');
speechCase('旁白里一个字被吞掉（整个字弱 40dB）', (tl) => {
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', beatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips[1], w = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut)[2];
  const src = path.resolve('public', base.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
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
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', beatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips.reduce((m, x) => (x.srcOut - x.srcIn > m.srcOut - m.srcIn ? x : m)), w = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut).at(-1);
  const src = path.resolve('public', base.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
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
  const timing = JSON.parse(fs.readFileSync(path.resolve('data', beatsSrc.narration.timing), 'utf8'));
  const c = tl.audioClips[1], ws = timing.words.filter((x) => x.start >= c.srcIn && x.end <= c.srcOut), w = ws[2];
  const src = path.resolve('public', base.narration), dst = path.resolve('public/audio/_selftest.narration.wav');
  spawnSync(PY_QA, ['-c', `
import soundfile as sf
x, sr = sf.read(${JSON.stringify(src)}, dtype='float64')
x[int(${c.at + w.start - c.srcIn} * sr):int(${c.at + w.end - c.srcIn} * sr)] = 0
sf.write(${JSON.stringify(dst)}, x, sr)`]);
  w.end = w.start; // 配音时对齐把这个字压成 0ms，前后两个字的时长不变
  fs.writeFileSync('data/_selftest.timing.json', JSON.stringify(timing));
  fs.writeFileSync('data/_selftest.beats.json', JSON.stringify({ ...beatsSrc, id: '_selftest', narration: { ...beatsSrc.narration, timing: '_selftest.timing.json' } }));
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
function expectBeats(name, mutate, cmd, mustMatch) {
  const b = structuredClone(beatsSrc);
  b.id = '_selftest';
  mutate(b);
  const p = 'data/_selftest.beats.json';
  fs.writeFileSync(p, JSON.stringify(b));
  const r = spawnSync('node', cmd(p), { encoding: 'utf8' }), out = (r.stdout || '') + (r.stderr || '');
  record(name, r.status !== 0 && (mustMatch instanceof RegExp ? mustMatch.test(out) : out.includes(mustMatch)), out);
  fs.rmSync(p, { force: true });
  for (const f of fs.readdirSync('build').filter((f) => f.startsWith('_selftest'))) fs.rmSync(path.join('build', f), { force: true });
}
const validate = (p) => ['compiler/validate.mjs', p];
const compileNoFix = (t) => (p) => ['compiler/compile.mjs', p, '--target', t, '--no-autofix'];

expectBeats('用了不存在的组件', (b) => { acts(b).at(-1).type = 'bulbb'; }, validate, '未知组件「bulbb」');
expectBeats('写了裸色值', (b) => { firstText(b).color = '#ff0000'; }, validate, '不是规范里的墨色');
expectBeats('字号不在字号阶梯上', (b) => { firstText(b).size = 75; }, validate, '不在字号阶梯');
expectBeats('手写汉字字号太小（会糊）', (b) => { acts(b).find((a) => a.type === 'text' && /\p{Script=Han}/u.test(a.text)).size = 48; }, validate, '小于手写汉字下限');
expectBeats('旁白里数字后面跟冒号（会读成「比」）', (b) => { b.narration.script = b.narration.script.replace(/(\d)。?/, '$1：'); }, validate, '读成「比」');
expectBeats('旁白里的数字没有出处', (b) => { b.facts = []; }, validate, '没有出处');
expectBeats('提示词不在这句旁白里', (b) => { acts(b).at(-1).at = '这句旁白里没有的词'; }, validate, '不在这句旁白里');
expectBeats('完整一集缺少钩子和回收', (b) => { b.kind = 'episode'; }, validate, '必须有 role=hook');
expectBeats('字幕太长会折成三行', (b) => { b.phrases[0].caption = '这是一句特别特别长的字幕，长到在竖屏上要折成好几行，观众根本来不及看完，所以必须拆成短句再配画面'; }, validate, '请拆句');
expectBeats('回描引用了还没画的元素', (b) => { b.phrases[0].actions.push({ id: '_rt', type: 'retrace', at: b.phrases[0].actions[0].at, target: b.phrases.at(-1).actions.at(-1).id }); }, validate, '不存在或还没画');
expectBeats('两个图形的墨迹相切（关闭自动修复）', (b) => {
  const p = b.phrases.find((q) => q.actions.some((a) => a.type === 'circle')), c = p.actions.find((a) => a.type === 'circle');
  p.actions.push({ id: '_tan', type: 'circle', at: c.at, cx: c.cx + c.r * 2 + 3, cy: c.cy, r: c.r });
}, compileNoFix('9x16'), '墨迹只隔');
expectBeats('标签压线（关闭自动修复）', (b) => { const v = firstText(b), c = acts(b).find((a) => a.type === 'circle'); v.x = c.cx; v.y = c.cy - c.r; }, compileNoFix('9x16'), /离 .* 只有/);
expectBeats('同一行两个文字标签贴太近（关闭自动修复）', (b) => {
  const t = firstText(b);
  b.phrases[0].actions.push({ id: '_row', type: 'text', at: t.at, text: '57', x: t.x + t.size * 1.6, y: t.y, size: 56 });
}, compileNoFix('9x16'), /在同一行，横向只有/);
expectBeats('标签在旁白说完后才写（关闭自动修复）', (b) => {
  const p = b.phrases.at(-1), a0 = p.actions[0];
  p.actions.push({ id: '_late', type: 'text', at: a0.at, text: '这一行字太长了来不及跟上旁白', x: 490, y: 1300, size: 72 });
}, compileNoFix('9x16'), /说完后才起笔|和本句旁白重叠/);

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
