// 编译器产物的类型，以及"时间 → 笔/镜头状态"的纯函数。渲染只读这里，不自带任何随机或状态。
import { svgPathProperties } from 'svg-path-properties';

export type Pt = [number, number, number]; // x, y, 压力
export type Stroke = {
  id: string; action: string; group?: string; kind: 'glyph' | 'line' | 'shape';
  color: string; width: number; d: string; dKai?: string; len: number; t0: number; t1: number;
  pts: Pt[];
  kai?: { outline: string; gt: string; median: string };
};
export type PenSeg =
  | { kind: 'rest'; t0: number; t1: number; at: [number, number] }
  | { kind: 'move'; t0: number; t1: number; from: [number, number]; to: [number, number] }
  | { kind: 'down'; t0: number; t1: number; stroke: number };
export type Effect = { id: string; type: 'glow'; cx: number; cy: number; r: number; color: string; t0: number; t1: number; t2?: number; t3?: number; rays?: number[] };
export type Cam = { x: number; y: number; z: number };
export type CamMove = { t0: number; t1: number; from: Cam; to: Cam; focus?: string[]; curve?: 'glide'; accel?: number }; // focus：推近镜头的焦点元素；curve：glide 是片尾长镜头的匀速曲线；accel：加速段占几成（style.motion.easeAccel）
export type EndCard = { t0: number; t1: number; fade: number; title: string; refs: string[]; lines: string[]; size: number; titleSize: number };
export type Timeline = {
  id: string; canvas: { w: number; h: number; fps: number }; fps: number; durationInFrames: number; duration: number;
  narration: string; audio?: string; strokes: Stroke[]; penTrack: PenSeg[]; effects: Effect[];
  subtitles: { text: string; lines: string[]; t0: number; t1: number; join?: boolean; joinNext?: boolean; speaker?: string; label?: string; color?: string }[]; // join/joinNext：同一句拆出的几张，换卡时不淡出淡入；speaker/label/color：对话里不是主讲说的句子（compiler/speakers.mjs）
  style: Style; platforms: string[];
  camera: CamMove[]; view: { cx: number; cy: number };
  pencil?: { sway: number[]; lift: number[]; edge?: number[] }; // 编译器预算并平滑好的铅笔姿态曲线（逐帧）；edge = 避开边缘/字幕的转角
  sub: { cx: number; top: number; size: number; width: number };
  frame: { l: number; t: number; r: number; b: number }; // 取景框（屏幕坐标，平台界面以内）
  endCard?: EndCard; // 片尾参考资料卡（分镜 facts 写了 cite 时自动生成）
  watermark?: Watermark; // 本机配置了品牌（brand.local.json）时才有
  chapters?: { title: string; t: number }[]; // 分镜里写了节名时才有：每节的起点（秒），发布时填进各平台的章节功能
};
export type InkMode = 'mono' | 'kai';
// 时间线里带的风格规范子集（来自 style/style.json），渲染只读它
export type Style = {
  name: string; version: string; palette: Record<string, string>;
  paper: { gridSize: number; gridOpacity: number; fiberOpacity: number; lampOpacity: number; vignetteOpacity: number;
    grain?: { opacity: number; size: number; tiles: number; blend?: string; every?: number }; // 会动的颗粒（屏幕层，按帧号换，逐帧确定）
    relief?: { opacity: number; scale: number; tile: number; azimuth: number; elevation: number; mottle: number; seed: number }; // 纸面起伏（世界层，受光）
    lampDrift?: { period: number; amount: number; shift: number } }; // 光极慢地变：强度 ±amount、中心 ±shift（画面比例），一个周期 period 秒
  grade?: { contrast: number; saturate: number }; // 全局调色
  ink: { opacity: number; layerBlend?: string; layerBy?: 'color' | 'element'; freehand: { sizeScale: number; thinning: number; smoothing: number }; grain: { displace: number; frequency: number; alphaGain: number; alphaBias: number } };
  subtitle: { font: string; fontFamily: string; weight: number; lineHeight: number; maxLines: number; plate: { opacity: number; padX: number; padY: number; radius: number; shadow?: boolean; feather?: number }; glow?: number[] }; // glow：纸色柔光（text-shadow 半径，像素）
  pencil: { base: number; swing: number; length: number; halfWidth: number; scale: number; followZoom?: boolean };
};

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const progress = (t: number, t0: number, t1: number) => clamp01((t - t0) / Math.max(1e-6, t1 - t0));
// 缓入缓出：速度从 0 匀加速到峰值、再匀减速到 0，加速段占 a（0.5 是对称的二次缓动，原来一直用它）。
// a 小于 0.5：起步快、刹车长，像人推镜头，不像机器插值（风格 0.7.0；峰值速度和对称时一样，都是平均速度的 2 倍）
export const ease = (x: number, a = 0.5) => (x < a ? (x * x) / a : 1 - ((1 - x) * (1 - x)) / (1 - a));

const propsCache = new Map<string, InstanceType<typeof svgPathProperties>>();
const pathProps = (d: string) => {
  let p = propsCache.get(d);
  if (!p) { p = new svgPathProperties(d); propsCache.set(d, p); }
  return p;
};

// 笔画画到 p 时的采样点（末点插值），墨迹与笔尖共用这一组点，保证笔尖永远在墨迹末端
export function partialPts(pts: Pt[], p: number): Pt[] {
  if (p >= 1) return pts;
  const f = p * (pts.length - 1), i = Math.floor(f), k = f - i;
  const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
  return [...pts.slice(0, i + 1), [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]];
}

// heading：笔的运动方向（弧度），铅笔据此微调倾角
export type PenState = { x: number; y: number; down: boolean; lift: number; heading: number };

export function penAt(tl: Timeline, t: number, mode: InkMode): PenState {
  const segs = tl.penTrack;
  // 时间超出轨迹范围时取首/尾段（平滑采样会取到 t<0 或片尾之后）
  let seg = t < segs[0].t0 ? segs[0] : segs[segs.length - 1];
  let hit = false;
  for (const s of segs) if (t >= s.t0 && t < s.t1) { seg = s; hit = true; break; }
  // 落在两段之间的空档里：停在空档前那一段结束的地方。原来取整条轨迹的最后一段（片尾飞出画外那段），
  // 笔在空档里一帧消失、过一会儿又在原地冒出来（审片 E02 v9：全片 4 处，铅笔检查没抓到）
  if (!hit && t >= segs[0].t0) {
    let prev: typeof seg | null = null;
    for (const s of segs) if (s.t1 <= t && (!prev || s.t1 > prev.t1)) prev = s;
    if (prev && prev !== segs[segs.length - 1]) { seg = prev; t = prev.t1 - 1e-6; }
  }
  // 停住时笔贴着纸；抬笔量只在移动中从 0 平滑升起再落回 0，全程连续，影子不会跳
  if (seg.kind === 'rest') return { x: seg.at[0], y: seg.at[1], down: false, lift: 0, heading: 0 };
  if (seg.kind === 'move') {
    const u = progress(t, seg.t0, seg.t1), k = ease(u);
    return {
      x: seg.from[0] + (seg.to[0] - seg.from[0]) * k, y: seg.from[1] + (seg.to[1] - seg.from[1]) * k, down: false,
      lift: Math.sin(Math.PI * u) * 0.5, heading: Math.atan2(seg.to[1] - seg.from[1], seg.to[0] - seg.from[0]),
    };
  }
  const s = tl.strokes[seg.stroke];
  const p = progress(t, seg.t0, seg.t1);
  if (mode === 'kai' && s.dKai) {
    const pp = pathProps(s.dKai);
    const pt = pp.getPointAtLength(pp.getTotalLength() * p);
    return { x: pt.x, y: pt.y, down: true, lift: 0, heading: 0 };
  }
  const n = s.pts.length, i = Math.min(n - 1, Math.round(p * (n - 1)));
  const a = s.pts[Math.max(0, i - 4)], b = s.pts[Math.min(n - 1, i + 4)];
  const end = partialPts(s.pts, p).at(-1)!;
  return { x: end[0], y: end[1], down: true, lift: 0, heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

// 长镜头（curve=glide，片尾几十秒拉到整张纸）：中间匀速、两头各 ramp 秒缓起缓停；缩放按对数插值，看起来是匀速在拉远。
// 普通缓动用在几十秒的镜头上，前后各十几秒几乎不动（审片 E01 v13：拉远前 13 秒像定格，旁白说的东西还没进画面）
export function glideEase(u: number, dur: number, ramp = 1.5): number {
  const r = Math.min(0.45, ramp / Math.max(dur, 1e-6)), k = 1 / (2 * r * (1 - r));
  if (u < r) return u * u * k;
  if (u > 1 - r) return 1 - (1 - u) * (1 - u) * k;
  return (u - r / 2) / (1 - r);
}
// 绕一个不动点缩放：两头取景里屏幕位置相同的那个纸面点 P = (c1·z1 − c0·z0)/(z1 − z0) 一直钉在屏幕上同一处，
// 别的东西都沿直线朝它收（拉远）或离开它（推近）。起始画面里的字只会往 P 靠，不会先漂出画面再回来
// （审片 E01 v18：x/y 线性、z 按对数插值时轨迹是弯的，拉远途中第 6 节标题从左边出画 13 秒）
export function glideAt(from: Cam, to: Cam, e: number): Cam {
  const z = from.z * Math.pow(to.z / from.z, e);
  if (Math.abs(to.z - from.z) < 1e-6) return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z };
  const px = (to.x * to.z - from.x * from.z) / (to.z - from.z), py = (to.y * to.z - from.y * from.z) / (to.z - from.z);
  return { x: px + (from.x - px) * from.z / z, y: py + (from.y - py) * from.z / z, z };
}
export function camLerp(m: CamMove, t: number): Cam {
  const u = progress(t, m.t0, m.t1);
  if (m.curve === 'glide') return glideAt(m.from, m.to, glideEase(u, m.t1 - m.t0));
  const e = ease(u, m.accel);
  return { x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e, z: m.from.z + (m.to.z - m.from.z) * e };
}
export function cameraAt(moves: CamMove[], t: number): Cam {
  let c = moves[0].from;
  for (const m of moves) {
    if (t >= m.t1) c = m.to;
    else if (t > m.t0) c = camLerp(m, t);
  }
  return c;
}

// ---------- 铅笔姿态（屏幕坐标）：渲染和检查共用同一个函数 ----------
// 笔尖必须精确落在墨迹末端；笔身角度、抬笔影子做时间平滑，避免每换一笔就转动/闪烁（用户反馈"晃眼"）
export const PENCIL = { base: 42, swing: 3, length: 276, halfWidth: 14, scale: 0.82 };
export type PencilPose = { x: number; y: number; ang: number; lift: number; sc: number };

export function pencilPose(tl: Timeline, t: number, mode: InkMode = 'mono'): PencilPose {
  const cam = cameraAt(tl.camera, t);
  const toScreen = (p: { x: number; y: number }) => ({ x: (p.x - cam.x) * cam.z + tl.view.cx, y: (p.y - cam.y) * cam.z + tl.view.cy });
  const tip = toScreen(penAt(tl, t, mode));
  let sway: number, lift: number, edge = 0;
  if (tl.pencil) {
    // 编译器已逐帧算好：运笔方向、抬笔量（高斯平滑），以及靠近边缘/字幕时的避让转角（限速包络）
    const f = Math.min(tl.pencil.sway.length - 1, Math.max(0, Math.round(t * tl.fps)));
    sway = tl.pencil.sway[f];
    lift = tl.pencil.lift[f];
    edge = tl.pencil.edge?.[f] ?? 0;
  } else {
    sway = 0;
    lift = penAt(tl, t, mode).lift;
  }
  const P = tl.style?.pencil ?? PENCIL;
  return { x: tip.x, y: tip.y, ang: P.base + P.swing * sway + edge, lift, sc: pencilScale(tl, cam.z) };
}

// 铅笔在屏幕上的缩放：随镜头缩放（和纸上的笔迹保持真实比例；审片发现推近时字和铅笔一样长），并按画布短边归一
export function pencilScale(tl: Timeline, z: number): number {
  const P = tl.style?.pencil ?? PENCIL;
  return P.scale * (Math.min(tl.canvas.w, tl.canvas.h) / 1080) * (P.followZoom ? z : 1);
}

// ---------- 铅笔与字幕框的屏幕几何：渲染、编译器的避让、铅笔检查、安全区检查共用这一份定义 ----------
// （各写一份时尺寸不一致：避让按小框算、检查按大框判，实测 16:9 笔身压字幕 274 帧）
// 影子：相对笔身错开 (dx + dxLift·lift, dy + dyLift·lift)，高斯模糊 σ = blur + blurLift·lift（随笔缩放）
export const PENCIL_SHADOW = { dx: 5, dxLift: 7, dy: 7, dyLift: 10, blur: 4, blurLift: 3, opacity: 0.22, opacityLift: 0.05 };
type PoseLike = { x: number; y: number; ang: number; sc: number; lift: number };

// 笔的外形（局部坐标，见 Sketch.tsx）：笔尖在 0，削尖的锥形到 46 处才到全宽 halfWidth，笔杆一直到 length
const CONE = 46;
const sampleBody = (tl: Timeline, p: PoseLike, ox: number, oy: number, pad: number): [number, number][] => {
  const P = tl.style?.pencil ?? PENCIL;
  const r = (p.ang * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), L = P.length * p.sc, W = P.halfWidth * p.sc, cone = CONE * p.sc;
  const out: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const u = -pad + ((L + 2 * pad) * i) / 24, hw = W * Math.min(1, Math.max(0, u / cone)) + pad;
    for (const v of [-hw, 0, hw]) out.push([p.x + ox + u * c - v * s, p.y + oy + u * s + v * c]);
  }
  return out;
};
// 笔身外轮廓上的采样点（判断出画）
export const pencilBodyPts = (tl: Timeline, p: PoseLike) => sampleBody(tl, p, 0, -p.lift * 2, 0);
// 笔身 + 影子（含 1.5σ 模糊外沿）占用的采样点（判断压字幕）
export function pencilFootprint(tl: Timeline, p: PoseLike): [number, number][] {
  const S = PENCIL_SHADOW, sigma = (S.blur + S.blurLift * p.lift) * p.sc;
  return [...pencilBodyPts(tl, p), ...sampleBody(tl, p, S.dx + S.dxLift * p.lift, S.dy + S.dyLift * p.lift, 1.5 * sigma)];
}
// 字幕衬底框（屏幕像素）：中文按全角、其余按 0.55 字宽估算；margin 为外扩
export type Box = { l: number; t: number; r: number; b: number };
export function subtitleBox(tl: Timeline, lines: string[], margin = 0): Box {
  const pl = tl.style?.subtitle?.plate ?? { padX: 0, padY: 0 }, size = tl.sub.size;
  const w = Math.max(...lines.map((l) => [...l].reduce((a, c) => a + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.55), 0))) * (size + 1) + pl.padX * 2;
  const lh = (tl.style?.subtitle?.lineHeight ?? 1.35) * size;
  return { l: tl.sub.cx - w / 2 - margin, r: tl.sub.cx + w / 2 + margin, t: tl.sub.top - pl.padY - margin, b: tl.sub.top + lh * lines.length + pl.padY + margin };
}
export const inBox = (b: Box, [x, y]: [number, number]) => x > b.l && x < b.r && y > b.t && y < b.b;
export const boxesOverlap = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
// 可见水印（屏幕层）：品牌名小字，按 spans 在几个角之间轮换。编译器选位置、渲染、安全区检查共用这个框（字宽估算同字幕）
export type WatermarkSpan = { t0: number; t1: number; x: number; y: number; anchor: 'l' | 'r' };
export type Watermark = { text: string; size: number; opacity: number; fade: number; margin: number; contentMargin?: number; spans: WatermarkSpan[] };
// 水印一段显示期间查遮挡的时刻：开头、中间每个 0.1 秒的整数倍、结尾。编译放水印和安全区检查都用这一份：
// 原来各自从这段的开头每 0.1 秒数，编译把同一位置的相邻两段并成一段后，检查的格点和放的时候查过的对不上（E03 PR #53 审查）
export function watermarkSampleTimes(t0: number, t1: number): number[] {
  const out = [t0];
  for (let k = Math.floor(t0 * 10 + 1e-6) + 1; k / 10 < t1 - 1e-6; k++) out.push(k / 10);
  if (t1 > t0) out.push(t1);
  return out;
}

export function watermarkBox(wm: Watermark, sp: { x: number; y: number; anchor: 'l' | 'r' }, margin = 0): Box {
  const w = [...wm.text].reduce((a, c) => a + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.55), 0) * (wm.size + 1), l = sp.anchor === 'r' ? sp.x - w : sp.x;
  return { l: l - margin, r: l + w + margin, t: sp.y - margin, b: sp.y + wm.size * 1.25 + margin };
}
// 一笔墨迹在镜头 c 下的屏幕包围盒（含笔宽）：水印避让和检查用。世界包围盒按笔画缓存
const inkWorldBox = new WeakMap<Stroke, number[]>();
export function strokeScreenBox(tl: Timeline, s: Stroke, c: Cam): Box {
  let b = inkWorldBox.get(s);
  if (!b) {
    const p = s.width / 2;
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of s.pts) { b[0] = Math.min(b[0], x - p); b[1] = Math.min(b[1], y - p); b[2] = Math.max(b[2], x + p); b[3] = Math.max(b[3], y + p); }
    inkWorldBox.set(s, b);
  }
  return { l: (b[0] - c.x) * c.z + tl.view.cx, r: (b[2] - c.x) * c.z + tl.view.cx, t: (b[1] - c.y) * c.z + tl.view.cy, b: (b[3] - c.y) * c.z + tl.view.cy };
}
export const SUB_MARGIN = 8; // 笔身和影子离字幕衬底至少这么远（屏幕像素）
// 飞入/飞出：一端在画布外的抬笔移动（开头从画外进来、结尾离开画面），这期间笔身本来就有一截在画外，避让和检查都不管
export function isFlight(tl: Timeline, m: PenSeg): boolean {
  if (m.kind !== 'move') return false;
  const off = (pt: number[], t: number) => {
    const c = cameraAt(tl.camera, t), x = (pt[0] - c.x) * c.z + tl.view.cx, y = (pt[1] - c.y) * c.z + tl.view.cy;
    return x < 0 || x > tl.canvas.w || y < 0 || y > tl.canvas.h;
  };
  return off(m.from, m.t0) || off(m.to, m.t1);
}

// ---------- 镜头到位后对着空纸讲：编译和铅笔检查共用 ----------
// 每次换取景（不算顿悟推近、回看、全景长镜头：那几种本来就是看已有的东西）到位以后，到下一个画面变化（新一笔、发光、下一次镜头移动）之前，
// 有多少秒旁白在讲。超过 motion.maxIdleAfterMove 秒，观众就是对着一块空纸（或没变的画面）听讲。
// 审片 E05 v1：五处换节镜头在上一句说完前就飞到下一节，205 秒那处对着空纸讲了 7 秒（E04 复盘也有）
export type IdleAfterMove = { arrive: number; next: number; idle: number };
export function idleAfterCamera(tl: Pick<Timeline, 'camera' | 'strokes' | 'effects'> & { audioClips?: { at: number; srcIn: number; srcOut: number }[] }): IdleAfterMove[] {
  const talk = (tl.audioClips ?? []).map((c) => [c.at, c.at + c.srcOut - c.srcIn] as const);
  const said = (a: number, b: number) => talk.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const events = [...tl.strokes.map((s) => [s.t0, s.t1] as const), ...(tl.effects ?? []).map((e) => [e.t0, e.t1] as const)];
  const out: IdleAfterMove[] = [];
  tl.camera.forEach((m, i) => {
    const to = m.to as Cam & { revisit?: boolean; overview?: boolean };
    if (m.focus || m.curve === 'glide' || to.revisit || to.overview || m.t1 <= m.t0) return;
    const arrive = m.t1;
    if (events.some(([a, b]) => a < arrive && b > arrive)) return; // 到位时正在写
    const later = Math.min(...events.map(([a]) => a).filter((a) => a >= arrive), ...tl.camera.slice(i + 1).map((n) => n.t0).filter((a) => a >= arrive));
    const next = Number.isFinite(later) ? later : Math.max(arrive, ...talk.map(([, y]) => y)); // 之后再也没有动静：算到旁白讲完
    out.push({ arrive, next, idle: said(arrive, next) });
  });
  return out;
}
