// 基础图元。每个组件：meta（给写分镜的模型看的说明 + 参数定义 + 示例）和 draw（参数 → 笔画，纯函数）。
// 参数类型：number / point [x,y] / points [[x,y]...] / numbers / inkColor（风格规范 inkColors 里的名字）/ strokeWidth
// 一支笔：线宽默认取 style.ink.penWidth，组件不自带粗细；要表达"更重"用多描几遍（见 weighted-arrow）
const common = { color: { type: 'inkColor', desc: '墨色名，默认 ink' }, width: { type: 'strokeWidth', desc: '线宽，默认取风格规范' } };

export default [
  {
    meta: {
      name: 'circle', title: '手画圆', desc: '从左上起笔、略微过头收尾、半径有低频起伏的手画圆。用作节点、输入、强调圈。',
      params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true }, ...common },
      example: { cx: 0, cy: 0, r: 60 }, extent: (a) => [a.cx - a.r * 1.2, a.cy - a.r * 1.2, a.cx + a.r * 1.2, a.cy + a.r * 1.2],
    },
    draw(a, k) {
      const a0 = -2.2 + (k.rnd() - 0.5) * 0.3, sweep = Math.PI * 2 + 0.28, n = 40, ph = k.rnd() * 6;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, ang = a0 + sweep * t;
        const rr = a.r * (1 + 0.035 * Math.sin(ph + ang * 2) + 0.03 * t);
        pts.push([a.cx + rr * Math.cos(ang), a.cy + rr * Math.sin(ang)]);
      }
      return [k.S(pts)];
    },
  },
  {
    meta: {
      name: 'line', title: '手画线', desc: '两点之间略带弧度和抖动的线。用作下划线、坐标轴、底线。',
      params: { from: { type: 'point', required: true }, to: { type: 'point', required: true }, bow: { type: 'number', desc: '弧度（像素，正负决定弯向）' }, ...common },
      example: { from: [-100, 0], to: [100, 0], bow: 5 },
    },
    draw(a, k) {
      const mid = [(a.from[0] + a.to[0]) / 2, (a.from[1] + a.to[1]) / 2];
      const nx = -(a.to[1] - a.from[1]), ny = a.to[0] - a.from[0], L = Math.hypot(nx, ny);
      const c = [mid[0] + (nx / L) * (a.bow || 0), mid[1] + (ny / L) * (a.bow || 0)];
      return [k.S(k.wobble([a.from, c, a.to], 1.5, k.rnd, 24))];
    },
  },
  {
    meta: {
      name: 'arrow', title: '手画箭头', desc: '带弧度的箭杆 + 一笔画成的箭头（先杆后头，共两笔）。用作流程、因果。',
      params: { from: { type: 'point', required: true }, to: { type: 'point', required: true }, bow: { type: 'number' }, ...common },
      example: { from: [-100, 0], to: [100, 0], bow: 6 },
    },
    draw(a, k) {
      const [x0, y0] = a.from, [x1, y1] = a.to;
      const nx = -(y1 - y0), ny = x1 - x0, L = Math.hypot(nx, ny);
      const c = [(x0 + x1) / 2 + (nx / L) * (a.bow || 0), (y0 + y1) / 2 + (ny / L) * (a.bow || 0)];
      const shaft = k.wobble([a.from, c, a.to], 1.5, k.rnd, 20);
      const p = shaft[shaft.length - 3], ang = Math.atan2(y1 - p[1], x1 - p[0]), hl = 20, hw = 0.5;
      const h1 = [x1 - hl * Math.cos(ang - hw), y1 - hl * Math.sin(ang - hw)];
      const h2 = [x1 - hl * Math.cos(ang + hw), y1 - hl * Math.sin(ang + hw)];
      return [k.S(shaft), k.S([h1, [x1, y1], h2], false)];
    },
  },
  {
    meta: {
      name: 'polyline', title: '折线', desc: '按给定点一笔画成的折线（拐角保持尖锐）。用作阶跃函数、折线图。',
      params: { points: { type: 'points', required: true }, ...common },
      example: { points: [[-80, 30], [0, 30], [0, -30], [80, -30]] },
    },
    draw(a, k) { return [k.S(k.wobble(a.points, 1.2, k.rnd, 16), false)]; },
  },
  {
    meta: {
      name: 'sigma', title: '求和符号 Σ', desc: '一笔写成的 Σ。注意：对零基础观众是行话，优先用 + 或"加起来"。',
      params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, size: { type: 'number', required: true }, ...common },
      example: { cx: 0, cy: 0, size: 86 },
    },
    draw(a, k) {
      const s = a.size / 2, { cx, cy } = a;
      const pts = [[cx + s * 0.62, cy - s * 0.78], [cx - s * 0.6, cy - s * 0.8], [cx + s * 0.08, cy], [cx - s * 0.62, cy + s * 0.8], [cx + s * 0.66, cy + s * 0.78]];
      return [k.S(k.wobble(pts, 1.2, k.rnd, 14), false)];
    },
  },
  {
    meta: {
      name: 'bulb', title: '灯泡', desc: '玻璃泡 + 两道底座 + 灯丝（两根支架，顶上折成 M），共四笔。表示"输出/亮了/想到了"。点亮用 glow（可带 rays 光芒），熄灭用 off。',
      params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true }, ...common },
      example: { cx: 0, cy: 0, r: 48 }, extent: (a) => [a.cx - a.r * 1.2, a.cy - a.r * 1.2, a.cx + a.r * 1.2, a.cy + a.r * 1.5],
    },
    draw(a, k) {
      const { cx, cy, r } = a, out = [];
      const glass = [];
      for (let i = 0; i <= 34; i++) {
        const ang = Math.PI * 0.68 + (Math.PI * 1.64 * i) / 34;
        glass.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
      }
      const neckL = [cx - r * 0.42, cy + r * 1.12], neckR = [cx + r * 0.42, cy + r * 1.12];
      out.push(k.S([neckL, ...glass.slice(1, -1), neckR]));
      out.push(k.S([[cx - r * 0.44, cy + r * 1.2], [cx + r * 0.44, cy + r * 1.2]], false));
      out.push(k.S([[cx - r * 0.38, cy + r * 1.38], [cx + r * 0.38, cy + r * 1.38]], false));
      // 灯丝：两根支架从灯口往上，顶上折成一个 M（审片 E01 v1：原来的锯齿顶像小城堡或梳子；绕小圈的螺旋在常用字号下糊成一条横杠）
      out.push(k.S([[cx - r * 0.22, cy + r * 1.08], [cx - r * 0.24, cy + r * 0.32], [cx - r * 0.12, cy - r * 0.08], [cx, cy + r * 0.22], [cx + r * 0.12, cy - r * 0.08], [cx + r * 0.24, cy + r * 0.32], [cx + r * 0.22, cy + r * 1.08]], false));
      return out;
    },
  },
  {
    meta: {
      name: 'arcs', title: '声波/强调弧', desc: '以 (cx,cy) 为圆心的若干段弧，角度单位为度。表示"说话声音大""强调"。弧的数量要和想表达的强弱一致。',
      params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, radii: { type: 'numbers', required: true }, from: { type: 'number', required: true }, to: { type: 'number', required: true }, ...common },
      example: { cx: 0, cy: 0, radii: [70, 86, 102], from: 152, to: 208 },
    },
    draw(a, k) {
      return a.radii.map((rr) => {
        const pts = [];
        for (let i = 0; i <= 14; i++) {
          const ang = ((a.from + ((a.to - a.from) * i) / 14) * Math.PI) / 180;
          pts.push([a.cx + rr * Math.cos(ang), a.cy + rr * Math.sin(ang)]);
        }
        return k.S(pts);
      });
    },
  },
  {
    meta: {
      name: 'dashed', title: '虚线', desc: '一段一段画出的虚线。表示阈值、门槛、参考线。',
      params: { from: { type: 'point', required: true }, to: { type: 'point', required: true }, dash: { type: 'number', required: true }, gap: { type: 'number', required: true }, ...common },
      example: { from: [-110, 0], to: [110, 0], dash: 26, gap: 14 },
    },
    draw(a, k) {
      const [x0, y0] = a.from, [x1, y1] = a.to, L = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(L / (a.dash + a.gap));
      const out = [];
      for (let i = 0; i <= n; i++) {
        const u0 = (i * (a.dash + a.gap)) / L, u1 = Math.min(1, u0 + a.dash / L);
        if (u0 >= 1) break;
        out.push(k.S([[x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0], [x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1]], false));
      }
      return out;
    },
  },
  {
    meta: {
      name: 'bar', title: '排线柱', desc: '先勾边、再排斜线的柱子。表示数量大小，配合虚线表示"超过门槛"。',
      params: { x0: { type: 'number', required: true }, x1: { type: 'number', required: true }, top: { type: 'number', required: true }, base: { type: 'number', required: true }, ...common },
      example: { x0: -21, x1: 21, top: -60, base: 60 },
    },
    draw(a, k) {
      const { x0, x1, top, base } = a, out = [k.S(k.wobble([[x0, base], [x0, top], [x1, top], [x1, base]], 1, k.rnd, 14), false)];
      // 排线：一支笔、同一线宽；柱子矮时把间距收小，至少三道
      const gapY = Math.min(22, (base - 16 - (top + 8)) / 2.5);
      for (let yy = base - 16; yy > top + 8; yy -= gapY) out.push(k.S([[x0 + 4, yy + 8], [x1 - 4, yy - 8]], false));
      return out;
    },
  },
  {
    meta: {
      name: 'rays', title: '放射短线', desc: '围绕中心的放射短线（一笔一根）。表示发光、顿悟、爆发。',
      params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r0: { type: 'number', required: true }, r1: { type: 'number', required: true }, angles: { type: 'numbers', required: true }, ...common },
      example: { cx: 0, cy: 0, r0: 64, r1: 88, angles: [-150, -115, -80, -45, -10, 25] },
    },
    draw(a, k) {
      return a.angles.map((deg) => {
        const ang = (deg * Math.PI) / 180;
        return k.S([[a.cx + a.r0 * Math.cos(ang), a.cy + a.r0 * Math.sin(ang)], [a.cx + a.r1 * Math.cos(ang), a.cy + a.r1 * Math.sin(ang)]], false);
      });
    },
  },
];
