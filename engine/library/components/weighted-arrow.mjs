// 带权连线：一条等宽的箭头（一支笔，所有笔画同一线宽），在连线中段旁边写上权重「×w」。
// 原来用同一条线描 1~3 遍表示权重轻重，和「一支笔、统一线宽」矛盾，成片里用的也一直是「等宽连线 + ×w 标签」（审片 v9）。
export default {
  meta: {
    name: 'weightedArrow', title: '带权连线', desc: '表示"带权重的连接"：等宽箭头，中段旁边写「×权重」。标签默认在前进方向的左侧（从左往右画时在线的上方）。',
    params: {
      from: { type: 'point', required: true }, to: { type: 'point', required: true },
      weight: { type: 'number', required: true, desc: '权重，标签写成「×weight」' },
      side: { type: 'enum', values: ['left', 'right'], desc: '标签在前进方向的哪一侧，默认 left' },
      labelSize: { type: 'typeSize', desc: '标签字号，默认 56' },
      bow: { type: 'number', desc: '弧度（像素）' }, color: { type: 'inkColor' },
    },
    example: { from: [-120, 0], to: [120, 0], weight: 4, bow: 6 },
    preview: [{ from: [-130, -80], to: [110, -80], weight: 4, bow: 6 }, { from: [-130, -5], to: [110, -5], weight: 3, bow: 6 }, { from: [-130, 70], to: [110, 70], weight: 2, bow: 6 }],
  },
  draw(a, k) {
    const [x0, y0] = a.from, [x1, y1] = a.to;
    const nx = -(y1 - y0), ny = x1 - x0, L = Math.hypot(nx, ny);
    const c = [(x0 + x1) / 2 + (nx / L) * (a.bow || 0), (y0 + y1) / 2 + (ny / L) * (a.bow || 0)];
    const shaft = k.wobble([a.from, c, a.to], 1.5, k.rnd, 20);
    const p = shaft[shaft.length - 3], ang = Math.atan2(y1 - p[1], x1 - p[0]), hl = 20, hw = 0.5;
    const out = [k.S(shaft), k.S([[x1 - hl * Math.cos(ang - hw), y1 - hl * Math.sin(ang - hw)], [x1, y1], [x1 - hl * Math.cos(ang + hw), y1 - hl * Math.sin(ang + hw)]], false)];
    // 标签写在连线中点旁边：屏幕坐标 y 朝下，前进方向的左侧是 -(nx, ny)
    const size = a.labelSize ?? 56, m = shaft[Math.floor(shaft.length / 2)], s = a.side === 'right' ? 1 : -1, d = size * 0.55 + 8;
    out.push(...k.text({ text: `×${a.weight}`, size, x: m[0] + (s * nx * d) / L, y: m[1] + (s * ny * d) / L, anchor: 'c' }));
    return out;
  },
};
