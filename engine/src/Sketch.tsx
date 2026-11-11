import React from 'react';
import { getStroke } from 'perfect-freehand';
import { AbsoluteFill, Html5Audio, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from 'remotion';
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css';
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'; // 风格 0.7.0 起字幕降一档字重
import { Cam, cameraAt, ease, InkMode, partialPts, PENCIL_SHADOW, PencilPose, pencilPose, Style, Timeline, progress, Stroke, Sticker, STICKER, stickerCard } from './timeline';

// 所有颜色、纸面、墨迹、字幕参数都来自时间线里带的风格规范（style/style.json），这里不写裸值
// 墨迹层的世界坐标框（overflow 可见，只是坐标系，不裁内容）
const WORLD = { x: -1600, y: -1600, w: 4280, h: 5120 };
const worldSvg = { width: WORLD.w, height: WORLD.h, viewBox: `${WORLD.x} ${WORLD.y} ${WORLD.w} ${WORLD.h}`, style: { position: 'absolute' as const, left: WORLD.x, top: WORLD.y, overflow: 'visible' as const } };

const World: React.FC<{ cam: Cam; view: { cx: number; cy: number }; children: React.ReactNode }> = ({ cam, view, children }) => (
  <AbsoluteFill style={{ transformOrigin: '0 0', transform: `translate(${view.cx}px, ${view.cy}px) scale(${cam.z}) translate(${-cam.x}px, ${-cam.y}px)` }}>
    {children}
  </AbsoluteFill>
);

// ---------- 程序生成的纹理（风格 0.7.0）：固定种子的伪随机数，在浏览器里画一次、缓存成图片，逐帧确定（同一帧两次渲染像素一样） ----------
// 不用全画面的 SVG 滤镜（feTurbulence、feDiffuseLighting）逐帧现算：一帧 1920×1080 要几十毫秒，整片渲染慢几倍
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const texCache = new Map<string, string>();
const makeTex = (key: string, n: number, fill: (img: Uint8ClampedArray) => void) => {
  if (!texCache.has(key)) {
    const c = document.createElement('canvas'); c.width = n; c.height = n;
    const ctx = c.getContext('2d')!, img = ctx.createImageData(n, n);
    fill(img.data); ctx.putImageData(img, 0, 0); texCache.set(key, c.toDataURL('image/png'));
  }
  return texCache.get(key)!;
};
// 颗粒：每张 256×256 的灰噪声（近似高斯），几张轮着用、每帧换位置
const grainTile = (k: number) => makeTex(`grain-${k}`, 256, (d) => {
  const r = mulberry32(1013 + k * 7919);
  for (let i = 0; i < d.length; i += 4) { const g = 128 + 42 * (r() + r() + r() - 1.5) * 1.41; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
});
// 纸面起伏：周期性值噪声做高度（四边能无缝拼接），按光的方向算明暗（朗伯），再叠一层更低频的斑驳；中性灰 128 表示不变
const reliefTile = (p: NonNullable<Style['paper']['relief']>) => makeTex(`relief-${JSON.stringify(p)}`, 256, (d) => {
  const n = 256, r = mulberry32(p.seed);
  const field = (cells: number) => { const g = Array.from({ length: cells * cells }, () => r()); return (x: number, y: number) => {
    const fx = (x / n) * cells, fy = (y / n) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), sx = fx - x0, sy = fy - y0;
    const at = (i: number, j: number) => g[((j % cells) + cells) % cells * cells + ((i % cells) + cells) % cells];
    const s = (u: number) => u * u * (3 - 2 * u), a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * s(sx), b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * s(sx);
    return a + (b - a) * s(sy); }; };
  const oct = [field(4), field(8), field(16), field(32)], mot = [field(2), field(3)];
  const H = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) H[y * n + x] = oct[0](x, y) + 0.5 * oct[1](x, y) + 0.25 * oct[2](x, y) + 0.12 * oct[3](x, y);
  const az = (p.azimuth * Math.PI) / 180, el = (p.elevation * Math.PI) / 180, L = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const h = (i: number, j: number) => H[((j + n) % n) * n + ((i + n) % n)];
    const nx = -(h(x + 1, y) - h(x - 1, y)) * p.scale, ny = -(h(x, y + 1) - h(x, y - 1)) * p.scale, len = Math.hypot(nx, ny, 1);
    const shade = (nx * L[0] + ny * L[1] + L[2]) / len - L[2]; // 平的地方是 0
    const m = (mot[0](x, y) + 0.6 * mot[1](x, y) - 0.8) * p.mottle;
    const v = 128 + 255 * (shade + m), i = (y * n + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
});

// ---------- 纸（世界层：底色、方格、纤维） ----------
// 纸只铺在这一帧镜头看得到的那块世界坐标上（再多留一圈）：分章节时各节画在纸面上相隔很远的地方，
// 铺一张固定大小的纸会在后面几节露出没有方格的底（E01 理解度测试：第 3 节起方格不见了）。
// 方格图案和纤维噪声都按世界坐标取值，纸跟着镜头换位置时纹理不会跟着滑
const PaperWorld: React.FC<{ st: Style; cam: Cam; view: { cx: number; cy: number }; canvas: { w: number; h: number } }> = ({ st, cam, view, canvas }) => {
  const pad = 200, x = Math.floor(cam.x - view.cx / cam.z - pad), y = Math.floor(cam.y - view.cy / cam.z - pad);
  const w = Math.ceil(canvas.w / cam.z + 2 * pad), h = Math.ceil(canvas.h / cam.z + 2 * pad);
  return (
  <svg width={w} height={h} viewBox={`${x} ${y} ${w} ${h}`} style={{ position: 'absolute', left: x, top: y, overflow: 'visible' }}>
    <defs>
      <pattern id="grid" width={st.paper.gridSize} height={st.paper.gridSize} patternUnits="userSpaceOnUse" x={10} y={18}>
        <path d={`M${st.paper.gridSize} 0H0V${st.paper.gridSize}`} fill="none" stroke={st.palette.grid} strokeWidth={1.1} opacity={st.paper.gridOpacity} />
      </pattern>
      <filter id="fiber" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves={4} seed={11} />
        <feColorMatrix type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.27  0 0 0 0 0.16  0.9 0 0 0 -0.32" />
      </filter>
    </defs>
    <rect x={x} y={y} width={w} height={h} fill={st.palette.paper} />
    <rect x={x} y={y} width={w} height={h} fill="url(#grid)" />
    <rect x={x} y={y} width={w} height={h} filter="url(#fiber)" opacity={st.paper.fiberOpacity} />
    {st.paper.relief && (<>
      <defs>
        <pattern id="relief" width={st.paper.relief.tile} height={st.paper.relief.tile} patternUnits="userSpaceOnUse">
          <image href={reliefTile(st.paper.relief)} width={st.paper.relief.tile} height={st.paper.relief.tile} preserveAspectRatio="none" />
        </pattern>
      </defs>
      {/* 纸面起伏和斑驳：按世界坐标铺，镜头动时跟着纸走 */}
      <rect x={x} y={y} width={w} height={h} fill="url(#relief)" opacity={st.paper.relief.opacity} style={{ mixBlendMode: 'soft-light' }} />
    </>)}
  </svg>
  );
};

// ---------- 光（屏幕层）：暖光只照纸、压在墨迹下面，墨色不被洗淡；暗角在最上层 ----------
// 风格 0.7.0：光极慢地变（paper.lampDrift），幅度远低于能察觉「在动」的程度；两个方向用不同周期，不走成一个圈
const Lamp: React.FC<{ w: number; h: number; st: Style; t: number }> = ({ w, h, st, t }) => {
  const d = st.paper.lampDrift, ph = d ? (2 * Math.PI * t) / d.period : 0;
  const cx = 0.22 + (d ? d.shift * Math.sin(ph) : 0), cy = 0.06 + (d ? d.shift * Math.cos(ph * 0.77) : 0), op = st.paper.lampOpacity * (1 + (d ? d.amount * Math.sin(ph * 1.31 + 1) : 0));
  return (
  <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
    <defs>
      <radialGradient id="lamp" cx={cx} cy={cy} r="0.95">
        <stop offset="0" stopColor={st.palette.lamp} stopOpacity={op} />
        <stop offset="0.55" stopColor={st.palette.lamp} stopOpacity={op * 0.11} />
        <stop offset="1" stopColor={st.palette.lamp} stopOpacity={0} />
      </radialGradient>
    </defs>
    <rect width={w} height={h} fill="url(#lamp)" />
  </svg>
  );
};
// 风格 0.7.0：会动的颗粒（屏幕层）。几张噪声图按帧号轮换、错位，逐帧确定；画面停着的时候也不是一张截图
const Grain: React.FC<{ w: number; h: number; st: Style; frame: number }> = ({ w, h, st, frame }) => {
  const g = st.paper.grain;
  if (!g || !g.opacity) return null;
  // every：每几帧换一次颗粒（胶片约每秒 24 格；60 帧的片子每帧都换，码率翻一倍，压缩后又几乎看不出来——独立审片）
  const f = Math.floor(frame / (g.every ?? 1)), k = (f * 7919) % g.tiles, ox = (f * 7907) % 256, oy = (f * 4271) % 256, px = 256 * g.size;
  return <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${grainTile(k)})`, backgroundSize: `${px}px ${px}px`, backgroundPosition: `${ox * g.size}px ${oy * g.size}px`,
    imageRendering: 'pixelated', opacity: g.opacity, mixBlendMode: (g.blend ?? 'overlay') as React.CSSProperties['mixBlendMode'], pointerEvents: 'none' }} />;
};
const Vignette: React.FC<{ w: number; h: number; st: Style }> = ({ w, h, st }) => (
  <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
    <defs>
      <radialGradient id="vignette" cx="0.45" cy="0.42" r="0.8">
        <stop offset="0.58" stopColor={st.palette.shade} stopOpacity={0} />
        <stop offset="1" stopColor={st.palette.shade} stopOpacity={st.paper.vignetteOpacity} />
      </radialGradient>
    </defs>
    <rect width={w} height={h} fill="url(#vignette)" />
  </svg>
);

// ---------- 笔迹：perfect-freehand 按压力生成变宽轮廓，正片叠底让交叉/回笔处自然加深 ----------
const avg = (a: number, b: number) => (a + b) / 2;
function outlinePath(pts: number[][]) {
  if (pts.length < 4) return '';
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)} Q${pts[1][0].toFixed(2)},${pts[1][1].toFixed(2)} ${avg(pts[1][0], pts[2][0]).toFixed(2)},${avg(pts[1][1], pts[2][1]).toFixed(2)} T`;
  for (let i = 2; i < pts.length - 1; i++) d += `${avg(pts[i][0], pts[i + 1][0]).toFixed(2)},${avg(pts[i][1], pts[i + 1][1]).toFixed(2)} `;
  return d + 'Z';
}

const InkStroke: React.FC<{ s: Stroke; i: number; t: number; mode: InkMode; st: Style }> = ({ s, i, t, mode, st }) => {
  const p = progress(t, s.t0, s.t1);
  if (p <= 0) return null;
  if (mode === 'kai' && s.kai) {
    const m = `m${i}`, dash = { pathLength: 1000, strokeDasharray: '1000 1000', strokeDashoffset: 1000 * (1 - p) };
    return (
      <g transform={s.kai.gt}>
        {p < 1 && (
          <mask id={m} maskUnits="userSpaceOnUse" x={-200} y={-300} width={1500} height={1500}>
            <path d={s.kai.median} fill="none" stroke="#fff" strokeWidth={190} strokeLinecap="round" strokeLinejoin="round" {...dash} />
          </mask>
        )}
        <path d={s.kai.outline} fill={s.color} mask={p < 1 ? `url(#${m})` : undefined} />
      </g>
    );
  }
  const outline = getStroke(partialPts(s.pts, p), {
    size: s.width * st.ink.freehand.sizeScale, thinning: st.ink.freehand.thinning, smoothing: st.ink.freehand.smoothing, streamline: 0, simulatePressure: false,
    start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 }, last: p >= 1,
  });
  return <path d={outlinePath(outline)} fill={s.color} />;
};

// ---------- 铅笔（屏幕层，大小不随镜头缩放）：局部坐标里笔尖在原点、笔身沿 +x；姿态来自 pencilPose ----------
// 笔芯颜色跟着正在写的墨色：写红字时是红芯（像红蓝铅笔的红头），不是黑芯写出红字（审片 v11）
const Pencil: React.FC<{ pose: PencilPose; lead: [string, string] }> = ({ pose, lead }) => {
  const { x, y, ang, lift, sc } = pose;
  return (
    <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      <defs>
        <linearGradient id="pc-body" x1="0" y1="-14" x2="0" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fde9a6" />
          <stop offset="0.12" stopColor="#f9d65e" />
          <stop offset="0.3" stopColor="#f2c53a" />
          <stop offset="0.33" stopColor="#e9b82a" />
          <stop offset="0.66" stopColor="#e0aa1f" />
          <stop offset="0.69" stopColor="#c99212" />
          <stop offset="1" stopColor="#a8770b" />
        </linearGradient>
        <linearGradient id="pc-wood" x1="0" y1="-14" x2="0" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f6e2c2" />
          <stop offset="0.55" stopColor="#e3c294" />
          <stop offset="1" stopColor="#c3955f" />
        </linearGradient>
        <linearGradient id="pc-lead" x1="0" y1="0" x2="15" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={lead[0]} />
          <stop offset="1" stopColor={lead[1]} />
        </linearGradient>
        <linearGradient id="pc-metal" x1="0" y1="-15" x2="0" y2="15" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f4f5f6" />
          <stop offset="0.35" stopColor="#c9ccd0" />
          <stop offset="0.7" stopColor="#9a9fa5" />
          <stop offset="1" stopColor="#6c7177" />
        </linearGradient>
        <linearGradient id="pc-eraser" x1="0" y1="-14" x2="0" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f6bdb6" />
          <stop offset="1" stopColor="#c86e67" />
        </linearGradient>
        <filter id="pshadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={PENCIL_SHADOW.blur + lift * PENCIL_SHADOW.blurLift} />
        </filter>
      </defs>
      {/* 影子：落笔时贴着笔尖，抬笔时轻微错开（已做时间平滑，不随每一笔闪动） */}
      <g transform={`translate(${x + PENCIL_SHADOW.dx + lift * PENCIL_SHADOW.dxLift} ${y + PENCIL_SHADOW.dy + lift * PENCIL_SHADOW.dyLift}) rotate(${ang}) scale(${sc})`} opacity={PENCIL_SHADOW.opacity - lift * PENCIL_SHADOW.opacityLift} filter="url(#pshadow)">
        <path d="M0,0 L46,-14 L276,-14 L276,14 L46,14 Z" fill="#2b1d0b" />
      </g>
      <g transform={`translate(${x} ${y - lift * 2}) rotate(${ang}) scale(${sc})`}>
        <path d="M15,-4.6 L46,-14 Q43.5,-9.3 46,-4.6 Q43.5,0 46,4.6 Q43.5,9.3 46,14 L15,4.6 Z" fill="url(#pc-wood)" />
        <path d="M22,-6.8 Q30,-8 40,-11.6 M24,1 Q33,0.6 44,1.4 M22,6.6 Q31,8.4 41,11" stroke="#b98a55" strokeWidth={0.7} fill="none" opacity={0.6} />
        <polygon points="0,0 15,-4.6 15,4.6" fill="url(#pc-lead)" />
        <path d="M46,-14 Q43.5,-9.3 46,-4.6 Q43.5,0 46,4.6 Q43.5,9.3 46,14 L214,14 L214,-14 Z" fill="url(#pc-body)" />
        <rect x={60} y={-11.5} width={148} height={2.2} rx={1} fill="#fff7d6" opacity={0.55} />
        <rect x={214} y={-14.8} width={34} height={29.6} fill="url(#pc-metal)" />
        {[218, 223, 238, 243].map((rx) => <rect key={rx} x={rx} y={-14.8} width={1.4} height={29.6} fill="#5f646a" opacity={0.6} />)}
        <path d="M248,-13.8 H268 Q276,-13.8 276,-5 V5 Q276,13.8 268,13.8 H248 Z" fill="url(#pc-eraser)" />
      </g>
    </svg>
  );
};

// ---------- 可见水印（屏幕层，最上层）：品牌名小字，按时间线里排好的位置轮换；换位时淡出淡入，片头片尾不淡 ----------
const WatermarkLayer: React.FC<{ tl: Timeline; t: number }> = ({ tl, t }) => {
  const wm = tl.watermark, sp = wm?.spans.find((s) => t >= s.t0 && t < s.t1);
  if (!wm || !sp) return null;
  const st = tl.style, fadeIn = sp.t0 <= 0 ? 1 : progress(t, sp.t0, sp.t0 + wm.fade), fadeOut = sp.t1 >= tl.duration ? 1 : 1 - progress(t, sp.t1 - wm.fade, sp.t1);
  return (
    <div style={{
      position: 'absolute', top: sp.y, ...(sp.anchor === 'r' ? { right: tl.canvas.w - sp.x } : { left: sp.x }), opacity: wm.opacity * Math.min(fadeIn, fadeOut),
      font: `${st.subtitle.weight} ${wm.size}px ${st.subtitle.font}`, lineHeight: 1.25, color: st.palette.subtitle, letterSpacing: 1, whiteSpace: 'nowrap',
    }}>{wm.text}</div>
  );
};

// 笔芯颜色：最近一笔（正在写的，或者刚写完的）用的墨色；换色发生在抬笔移动的半路上（笔在空中），不在笔尖碰纸那一帧（审片 v12）。
// 墨色 ink 是黑芯，其余墨色的笔芯就是那个颜色（尖上深一点）
const leadAt = (tl: Timeline, t: number): [string, string] => {
  let c = tl.style.palette.ink;
  const downs = tl.penTrack.filter((sg) => sg.kind === 'down');
  for (const sg of downs) if (sg.t0 <= t) c = tl.strokes[sg.stroke].color;
  const move = tl.penTrack.find((sg) => sg.kind === 'move' && t >= (sg.t0 + sg.t1) / 2 && t < sg.t1), next = move && downs.find((sg) => sg.t0 >= move.t1 - 1e-6);
  if (next) c = tl.strokes[next.stroke].color;
  if (c === tl.style.palette.ink) return ['#1f2023', '#4a4c51'];
  const dark = '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.75).toString(16).padStart(2, '0')).join('');
  return [dark, c];
};

const plateFill = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

// ---------- 贴图（sticker）：被依赖那一集的封面，印出来的小卡片贴在纸面上（世界层，墨迹下面） ----------
// 0.5 秒从上方落下：先略高、略大、多歪一点，影子远而淡；落定时影子收近。只在第一帧前后很短地显出来，不是淡入
const StickerCard: React.FC<{ s: Sticker; t: number }> = ({ s, t }) => {
  if (t < s.t0) return null;
  const k = ease(progress(t, s.t0, s.t1), 0.35), up = 1 - k, { W, H } = stickerCard(s), b = STICKER.border * s.w;
  const tw = STICKER.tapeW * s.w, th = STICKER.tapeH * s.w;
  const tape = (x: number, ang: number) => <rect x={x - tw / 2} y={-H / 2 - th / 2} width={tw} height={th} fill={s.tape} opacity={0.78} transform={`rotate(${ang} ${x} ${-H / 2})`} />;
  return (
    <g opacity={Math.min(1, progress(t, s.t0, s.t0 + 0.08))} transform={`translate(${s.cx} ${s.cy - up * STICKER.rise}) rotate(${s.tilt + up * STICKER.turn}) scale(${1 + up * (STICKER.scale0 - 1)})`}>
      <rect x={-W / 2 + 6 + up * 14} y={-H / 2 + 8 + up * 20} width={W} height={H} rx={3} fill={s.shade} opacity={STICKER.shadow * (0.6 + 0.4 * k)} filter="url(#sticker-shadow)" />
      <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={3} fill={s.card} />
      <image href={s.href} x={-W / 2 + b} y={-H / 2 + b} width={s.w} height={s.h} preserveAspectRatio="xMidYMid slice" />
      {tape(-W / 2 + tw * 0.3, -32)}
      {tape(W / 2 - tw * 0.3, 32)}
    </g>
  );
};

// ---------- 主画面 ----------

// ---------- 片尾参考资料卡（屏幕层）：正片说完后整张纸色底淡入，取景框里列出这一集的资料和附言（timeline.endCard） ----------
const EndCardLayer: React.FC<{ tl: Timeline; t: number }> = ({ tl, t }) => {
  const c = tl.endCard;
  if (!c || t < c.t0) return null;
  const st = tl.style, f = tl.frame, k = progress(t, c.t0, c.t0 + c.fade);
  return (
    <div style={{ position: 'absolute', inset: 0, background: st.palette.paper, opacity: k }}>
      <div style={{
        position: 'absolute', left: f.l + (f.r - f.l) * 0.08, width: (f.r - f.l) * 0.84, top: f.t + (f.b - f.t) * 0.1, height: (f.b - f.t) * 0.8,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: c.size * 0.55, color: st.palette.ink, font: `${st.subtitle.weight} ${c.size}px ${st.subtitle.font}`, lineHeight: 1.35,
      }}>
        {c.title && <div style={{ fontSize: c.titleSize }}>{c.title}</div>}
        {c.refs.map((r, i) => <div key={i} style={{ paddingLeft: c.size * 1.2, textIndent: -c.size * 1.2 }}>{`${i + 1}. ${r}`}</div>)}
        {c.lines.map((l, i) => <div key={`l${i}`} style={{ color: st.palette.accent, marginTop: i ? 0 : c.size * 0.4 }}>{l}</div>)}
      </div>
    </div>
  );
};

export const Sketch: React.FC<{ tl: Timeline; inkMode: InkMode; showPen?: boolean }> = ({ tl, inkMode, showPen = true }) => {
  const frame = useCurrentFrame();
  const t = frame / tl.fps;
  const { w, h } = tl.canvas;
  const cam = cameraAt(tl.camera, t);
  const sub = tl.subtitles.find((s) => t >= s.t0 && t < s.t1);
  const st = tl.style, paper = st.palette.paper;
  // 同一种墨色的笔画先合成到一层，再整体上透明度：不同元素交叉、回描处也不叠出黑斑。
  // 墨色 ink 在最下，其余颜色按第一次出现的先后往上叠（红笔盖住灰笔）。layerBy=element 是旧做法，只留给检查器自测复现
  const groups = React.useMemo(() => {
    const byElement = st.ink.layerBy === 'element', m = new Map<string, { s: Stroke; i: number }[]>(byElement ? [] : [[st.palette.ink, []]]);
    tl.strokes.forEach((s, i) => { const g = byElement ? s.group ?? s.action : s.color; if (!m.has(g)) m.set(g, []); m.get(g)!.push({ s, i }); });
    return [...m.entries()].filter(([, list]) => list.length);
  }, [tl]);
  // 字幕字体必须真正加载成功（不能悄悄回退到系统字体）：等待加载，失败就让渲染直接报错
  const [fontHandle] = React.useState(() => (tl.subtitles.length || tl.watermark || tl.endCard ? delayRender('加载字幕字体') : null));
  React.useEffect(() => {
    if (fontHandle === null) return;
    const spec = `${st.subtitle.weight} ${tl.sub.size}px "${st.subtitle.fontFamily}"`, sample = tl.subtitles.map((x) => x.text).join('') + (tl.watermark?.text ?? '') + (tl.endCard ? [tl.endCard.title, ...tl.endCard.refs, ...tl.endCard.lines].join('') : '');
    document.fonts.load(spec, sample).then((faces) => {
      if (!faces.length || !document.fonts.check(spec, sample)) cancelRender(new Error(`字幕字体「${st.subtitle.fontFamily}」没有加载成功`));
      else continueRender(fontHandle);
    }).catch((e) => cancelRender(e));
  }, [fontHandle]);
  // 贴图是嵌在时间线里的图（data URI）：解码完再出帧，不然第一帧可能是空卡片
  const [stickerHandle] = React.useState(() => (tl.stickers?.length ? delayRender('解码贴图') : null));
  React.useEffect(() => {
    if (stickerHandle === null) return;
    Promise.all((tl.stickers ?? []).map((k) => { const im = new Image(); im.src = k.href; return im.decode(); }))
      .then(() => continueRender(stickerHandle)).catch((e) => cancelRender(e));
  }, [stickerHandle]);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, overflow: 'hidden', ...(st.grade ? { filter: `contrast(${st.grade.contrast}) saturate(${st.grade.saturate})` } : {}) }}>
      {(tl.audio || tl.narration) && <Html5Audio src={staticFile(tl.audio ?? tl.narration)} />}
      <World cam={cam} view={tl.view}><PaperWorld st={st} cam={cam} view={tl.view} canvas={tl.canvas} /></World>
      <Lamp w={w} h={h} st={st} t={t} />
      <World cam={cam} view={tl.view}>
        <svg {...worldSvg}>
          <defs>
            <filter id="graphite" x="-2%" y="-2%" width="104%" height="104%">
              <feTurbulence type="fractalNoise" baseFrequency={st.ink.grain.frequency} numOctaves={2} seed={7} result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale={st.ink.grain.displace} xChannelSelector="R" yChannelSelector="G" result="d" />
              <feTurbulence type="fractalNoise" baseFrequency="0.9 0.5" numOctaves={1} seed={3} result="g" />
              <feColorMatrix in="g" type="matrix" values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${st.ink.grain.alphaGain} 0 0 0 ${st.ink.grain.alphaBias}`} result="ga" />
              <feComposite in="d" in2="ga" operator="in" />
            </filter>
            <filter id="sticker-shadow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation={7} /></filter>
            {tl.effects.map((e) => (
              <radialGradient key={e.id} id={`g-${e.id}`}>
                <stop offset="0" stopColor={e.color} stopOpacity={0.7} />
                <stop offset="0.5" stopColor={e.color} stopOpacity={0.28} />
                <stop offset="1" stopColor={e.color} stopOpacity={0} />
              </radialGradient>
            ))}
          </defs>
          {(tl.stickers ?? []).map((k) => <StickerCard key={k.id} s={k} t={t} />)}
          {tl.effects.map((e) => {
            // 亮起 t0→t1；熄灭 t2→t3（off 动作）。光芒是柔和的光，不是墨线，随光晕一起亮灭
            const k = progress(t, e.t0, e.t1) * (e.t2 !== undefined ? 1 - progress(t, e.t2, e.t3 ?? e.t2) : 1);
            if (k <= 0) return null;
            return (
              <g key={e.id} opacity={k}>
                <circle cx={e.cx} cy={e.cy} r={e.r * (0.75 + 0.25 * k)} fill={`url(#g-${e.id})`} />
                {(e.rays ?? []).map((deg) => {
                  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), a = e.r * 0.5, b = e.r * (0.5 + 0.25 * k);
                  return <line key={deg} x1={e.cx + a * c} y1={e.cy + a * s} x2={e.cx + b * c} y2={e.cy + b * s} stroke={e.color} strokeWidth={e.r * 0.07} strokeLinecap="round" opacity={0.9} />;
                })}
              </g>
            );
          })}
          <g filter="url(#graphite)">
            {groups.map(([gid, list]) => (
              <g key={gid} opacity={st.ink.opacity} style={{ mixBlendMode: (st.ink.layerBlend ?? 'normal') as React.CSSProperties['mixBlendMode'] }}>
                {list.map(({ s, i }) => <InkStroke key={s.id} s={s} i={i} t={t} mode={inkMode} st={st} />)}
              </g>
            ))}
          </g>
        </svg>
      </World>
      <Vignette w={w} h={h} st={st} />
      {showPen && <Pencil pose={pencilPose(tl, t, inkMode)} lead={leadAt(tl, t)} />}
      <Grain w={w} h={h} st={st} frame={frame} />
      {sub && (
        <div style={{
          position: 'absolute', left: tl.sub.cx - tl.sub.width / 2, width: tl.sub.width, top: tl.sub.top - st.subtitle.plate.padY, display: 'flex', justifyContent: 'center',
          opacity: Math.min(sub.join ? 1 : progress(t, sub.t0, sub.t0 + 0.12), sub.joinNext ? 1 : 1 - progress(t, sub.t1 - 0.12, sub.t1)), // 同一句拆出的几张之间不淡出淡入
        }}>
          <div style={{
            // 底板的透明度只给底色（原来给整个元素，字也跟着淡）；风格 0.7.0 去掉底板（opacity 0），改用纸色柔光 glow 把字从方格和墨迹上托出来
            background: plateFill(st.palette.plate, st.subtitle.plate.opacity), borderRadius: st.subtitle.plate.radius,
            // feather：底色向四周晕开、没有边（风格 0.7.0）。完全不衬时，镜头大幅移动途中画好的字会从字幕后面滑过、和字幕叠在一起（独立审片 E02 父子对话样片 333s、346s）
            padding: `${st.subtitle.plate.padY}px ${st.subtitle.plate.padX}px`,
            boxShadow: st.subtitle.plate.feather ? `0 0 ${st.subtitle.plate.feather}px ${st.subtitle.plate.feather * 0.6}px ${plateFill(st.palette.plate, st.subtitle.plate.opacity)}` : st.subtitle.plate.shadow === false || !st.subtitle.plate.opacity ? 'none' : '0 2px 8px rgba(60,42,18,0.10)',
            textShadow: (st.subtitle.glow ?? []).map((r) => `0 0 ${r}px ${paper}`).join(', ') || undefined,
            font: `${st.subtitle.weight} ${tl.sub.size}px ${st.subtitle.font}`, lineHeight: st.subtitle.lineHeight, color: sub.color ?? st.palette.subtitle, // 对话：按说话的人换字幕颜色
            letterSpacing: 1, textAlign: 'center', whiteSpace: 'nowrap',
          }}>{sub.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      )}
      <EndCardLayer tl={tl} t={t} />
      <WatermarkLayer tl={tl} t={t} />
    </AbsoluteFill>
  );
};
