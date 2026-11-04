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
function lamp(k, cx, cy, r, colorName) {
  const pts = [], a0 = -2.2 + (k.rnd() - 0.5) * 0.3, n = 28;
  for (let i = 0; i <= n; i++) { const ang = a0 + ((Math.PI * 2 + 0.25) * i) / n; pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]); }
  return { ...k.S(pts), color: lampColor(k, colorName) };
}

export default [
  {
    meta: {
      name: 'trafficLight', title: '红绿灯', desc: '竖着的灯箱，上下两盏灯（默认上红下绿，颜色可换）。两盏灯的圆心在 (cx, cy ∓ 1.35r)，要让某盏灯亮就在那里加 glow。',
      params: {
        cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true, desc: '每盏灯的半径' },
        top: { type: 'inkColor', desc: '上面那盏灯的墨色，默认 accent' }, bottom: { type: 'inkColor', desc: '下面那盏灯的墨色，默认 go' },
        color: { type: 'inkColor', desc: '灯箱的墨色，默认 ink' }, width: { type: 'strokeWidth' },
      },
      example: { cx: 0, cy: -10, r: 26 }, extent: (a) => [a.cx - a.r * 1.6, a.cy - a.r * 3, a.cx + a.r * 1.6, a.cy + a.r * 3],
    },
    draw(a, k) {
      const { cx, cy, r } = a, gap = 1.35 * r, pad = 0.5 * r;
      return [
        box(k, cx - r - pad, cy - gap - r - pad, cx + r + pad, cy + gap + r + pad, r * 0.4),
        lamp(k, cx, cy - gap, r, a.top ?? 'accent'),
        lamp(k, cx, cy + gap, r, a.bottom ?? 'go'),
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
      if (a.scene === 'red' || a.scene === 'green') out.push(lamp(k, x0 + sw / 2, cy, r, a.scene === 'red' ? 'accent' : 'go'));
      if (a.scene === 'both') { out.push(lamp(k, x0 + sw / 2 - 1.4 * r, cy, r, 'accent')); out.push(lamp(k, x0 + sw / 2 + 1.4 * r, cy, r, 'go')); }
      out.push(...(a.kind === 'new' ? dashedBox(k, x0, y0, x1, y1) : [box(k, x0, y0, x1, y1, Math.min(w, h) * 0.12)]));
      if (a.label) out.push(...k.text({ text: a.label, size: a.labelSize ?? 72, x: x0 + sw + (w - sw) / 2, y: cy, anchor: 'c', color: a.labelColor }));
      return out;
    },
  },
];
