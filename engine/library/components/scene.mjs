// 红绿灯和例子卡片：讲「规则 vs 例子」「分类」「数据集」时反复要用的两种小场景。
// 原来每期用 circle + polyline + text 手拼坐标，拼出过两盏灯挤成「8」、两张卡片一模一样（审片 E01 v2）；
// 做成组件后，灯的间距、灯和框的留白由组件算，分镜只说要哪种场景。
const lampColor = (k, name) => k.style.palette[name] ?? k.color;

// 手画圆角框：四条边各一笔，角上收一点，像随手描的框（不是 CSS 圆角）
function box(k, x0, y0, x1, y1, r) {
  const pts = [[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r], [x0 + r * 1.4, y0 - 1]];
  return k.S(k.wobble(pts, 1.2, k.rnd, 24));
}
// 虚线框：「新情况」「没见过的」用虚线，和实线的例子一眼分开
function dashedBox(k, x0, y0, x1, y1) {
  const out = [], dash = 30, gap = 14; // 段长一点、段数少一点：虚线框是陪衬，不该比框里的内容画得还久
  for (const [a, b] of [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]]) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(L / (dash + gap));
    for (let i = 0; i <= n; i++) {
      const u0 = (i * (dash + gap)) / L, u1 = Math.min(1, u0 + dash / L);
      if (u0 >= 1) break;
      out.push(k.S([[a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0], [a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1]], false));
    }
  }
  return out;
}
function lamp(k, cx, cy, r, colorName, lit = false) {
  const pts = [], a0 = -2.2 + (k.rnd() - 0.5) * 0.3, n = 28;
  for (let i = 0; i <= n; i++) { const ang = a0 + ((Math.PI * 2 + 0.25) * i) / n; pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]); }
  const ring = { ...k.S(pts), color: lampColor(k, colorName) };
  return lit ? [ring, colorIn(k, cx, cy, r, colorName)] : [ring];
}
// 彩笔涂满一个圆：一笔来回的斜向排线（像小孩拿彩色铅笔涂色，线和线之间透一点纸色），亮着的灯就这样画。
// 原来灯亮用不动笔的光晕，看着是一团红晕、绿晕，不像笔画出来的（用户看 E01 v7）。
// 线距约两个笔宽：涂得满但看得出笔触；排线收在圆里面半个笔宽，不压外圈
// 线距约两个半笔宽、每道略有长短和疏密（审片 v8：线距一样、每道顶到圆边，像一根弹簧；线太密，一盏灯要涂 1.1 秒）
function colorIn(k, cx, cy, r, colorName) {
  const R = r - k.width * 0.9, gap = k.width * 2.6, th = (-32 + (k.rnd() - 0.5) * 8) * Math.PI / 180;
  const c = Math.cos(th), s = Math.sin(th), pts = [];
  let dir = 1;
  for (let u = -R + gap * 0.6; u < R - gap * 0.3; u += gap * (0.8 + k.rnd() * 0.4)) {
    const h = Math.sqrt(Math.max(0, R * R - u * u));
    const v0 = -h * (0.78 + k.rnd() * 0.2), v1 = h * (0.78 + k.rnd() * 0.2), du = (k.rnd() - 0.5) * gap * 0.3;
    for (const v of dir > 0 ? [v0, v1] : [v1, v0]) pts.push([cx + (u + (v === v1 ? du : 0)) * c - v * s, cy + (u + (v === v1 ? du : 0)) * s + v * c]);
    dir = -dir;
  }
  return { ...k.S(pts, false), color: lampColor(k, colorName) };
}

export default [
  {
    meta: {
      name: 'colorIn', title: '彩笔涂色', desc: '用彩色铅笔把一个圆涂满（一笔来回的斜排线，透一点纸色）。灯亮、标记某个点时用；比光晕（glow）更像笔画出来的。',
      params: {
        cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true, desc: '圆的半径（和要涂的那盏灯一样）' },
        color: { type: 'inkColor', desc: '默认 accent' }, width: { type: 'strokeWidth' },
      },
      example: { cx: 0, cy: 0, r: 40, color: 'accent' },
      extent: (a) => [a.cx - a.r, a.cy - a.r, a.cx + a.r, a.cy + a.r],
    },
    draw(a, k) { return [colorIn(k, a.cx, a.cy, a.r, a.color ?? 'accent')]; },
  },
  {
    meta: {
      name: 'trafficLight', title: '红绿灯', desc: '竖着的灯箱，上下两盏灯（默认上红下绿，颜色可换）。lit 让灯亮：亮的灯用彩笔涂满。两盏灯的圆心在 (cx, cy ∓ 1.35r)；要在别的时刻再点亮，就在那里另加一个 colorIn（同样的圆心和 r）。',
      params: {
        cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true, desc: '每盏灯的半径' },
        top: { type: 'inkColor', desc: '上面那盏灯的墨色，默认 accent' }, bottom: { type: 'inkColor', desc: '下面那盏灯的墨色，默认 go' },
        color: { type: 'inkColor', desc: '灯箱的墨色，默认 ink' }, width: { type: 'strokeWidth' },
        lit: { type: 'enum', values: ['none', 'top', 'bottom', 'both'], desc: '哪盏灯亮（彩笔涂满），默认 none' },
      },
      example: { cx: 0, cy: -10, r: 26, lit: 'top' }, extent: (a) => [a.cx - a.r * 1.6, a.cy - a.r * 3, a.cx + a.r * 1.6, a.cy + a.r * 3],
    },
    draw(a, k) {
      const { cx, cy, r } = a, gap = 1.35 * r, pad = 0.5 * r;
      return [
        box(k, cx - r - pad, cy - gap - r - pad, cx + r + pad, cy + gap + r + pad, r * 0.4),
        ...lamp(k, cx, cy - gap, r, a.top ?? 'accent', a.lit === 'top' || a.lit === 'both'),
        ...lamp(k, cx, cy + gap, r, a.bottom ?? 'go', a.lit === 'bottom' || a.lit === 'both'),
      ];
    },
  },
  {
    meta: {
      name: 'exampleCard', title: '例子卡片', desc: '一张小卡片：左边画场景（一两盏小灯），右边写结果；先画灯再画框。结果想在别的时刻写（比如先画「?」、后写答案），就不写 label，另加文字动作。scene：red 红灯、green 绿灯、both 两盏一起亮（左右并排）、none 不画灯。kind：example 实线框（见过的例子），new 虚线框（没教过的新情况）。卡片左上角在 (x, y)，默认 200×130。',
      params: {
        x: { type: 'number', required: true }, y: { type: 'number', required: true },
        scene: { type: 'enum', values: ['red', 'green', 'both', 'none'], required: true },
        label: { type: 'string', desc: '结果，比如「停」「走」「?」；不写就空着' },
        kind: { type: 'enum', values: ['example', 'new'], desc: '默认 example' },
        w: { type: 'number', desc: '宽，默认 200' }, h: { type: 'number', desc: '高，默认 130' },
        labelSize: { type: 'typeSize', desc: '结果的字号，默认 72' }, labelColor: { type: 'inkColor' },
        color: { type: 'inkColor', desc: '框的墨色，默认 ink' }, width: { type: 'strokeWidth' },
      },
      example: { x: -100, y: -65, scene: 'both', label: '停' },
      preview: [{ x: -190, y: -50, w: 170, h: 100, scene: 'red', label: '停', labelSize: 56 }, { x: 15, y: -50, w: 170, h: 100, scene: 'both', label: '?', labelSize: 56, kind: 'new' }],
      extent: (a) => [a.x - 4, a.y - 4, a.x + (a.w ?? 200) + 4, a.y + (a.h ?? 130) + 4],
    },
    draw(a, k) {
      const w = a.w ?? 200, h = a.h ?? 130, x0 = a.x, y0 = a.y, x1 = x0 + w, y1 = y0 + h, out = [];
      // 先画场景（灯）再画框：说到「两个灯一起亮」时先看到灯，框是陪衬（审片 E01 v3：虚线框画了 3 秒，灯晚了 2 秒）
      // 场景占左边 55%，灯半径按卡片高度算；两盏并排时圆心相距 2.8r（中间留 0.8r），离框至少 0.6r
      const sw = w * 0.55, cy = y0 + h / 2, r = Math.min(h * 0.22, sw / 6);
      // 卡片里的灯都是「亮着」的场景，用彩笔涂满
      if (a.scene === 'red' || a.scene === 'green') out.push(...lamp(k, x0 + sw / 2, cy, r, a.scene === 'red' ? 'accent' : 'go', true));
      if (a.scene === 'both') { out.push(...lamp(k, x0 + sw / 2 - 1.4 * r, cy, r, 'accent', true)); out.push(...lamp(k, x0 + sw / 2 + 1.4 * r, cy, r, 'go', true)); }
      out.push(...(a.kind === 'new' ? dashedBox(k, x0, y0, x1, y1) : [box(k, x0, y0, x1, y1, Math.min(w, h) * 0.12)]));
      if (a.label) out.push(...k.text({ text: a.label, size: a.labelSize ?? 72, x: x0 + sw + (w - sw) / 2, y: cy, anchor: 'c', color: a.labelColor }));
      return out;
    },
  },
];
