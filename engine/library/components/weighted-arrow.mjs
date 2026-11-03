// 带权连线：权重越大，同一条线描的遍数越多（1~3 遍，彼此错开约 2.6px），整根线看起来更"重"。
// 一支笔多描几遍，而不是换粗笔；箭头随档位等比放大。数值标签另用 text 写在旁边（方便和旁白的词对齐）。
export default {
  meta: {
    name: 'weightedArrow', title: '带权连线', desc: '表示"带权重的连接"。tier 1~3：权重越大描得越多遍、越重。三条线的档位对比就是权重的相对大小。',
    params: {
      from: { type: 'point', required: true }, to: { type: 'point', required: true },
      tier: { type: 'enum', values: [1, 2, 3], required: true, desc: '权重档位：1 轻、2 中、3 重' },
      bow: { type: 'number', desc: '弧度（像素）' }, color: { type: 'inkColor' },
    },
    example: { from: [-120, 0], to: [120, 0], tier: 3, bow: 6 },
    preview: [{ from: [-120, -40], to: [120, -40], tier: 3, bow: 6 }, { from: [-120, 0], to: [120, 0], tier: 2, bow: 6 }, { from: [-120, 40], to: [120, 40], tier: 1, bow: 6 }],
  },
  draw(a, k) {
    const [x0, y0] = a.from, [x1, y1] = a.to;
    const nx = -(y1 - y0), ny = x1 - x0, L = Math.hypot(nx, ny);
    const c = [(x0 + x1) / 2 + (nx / L) * (a.bow || 0), (y0 + y1) / 2 + (ny / L) * (a.bow || 0)];
    const shaft = k.wobble([a.from, c, a.to], 1.5, k.rnd, 20);
    const out = [];
    const offs = [[0], [-1.3, 1.3], [-2.6, 0, 2.6]][a.tier - 1];
    for (const o of offs) out.push(k.S(shaft.map(([x, y], i) => {
      // 每一遍沿法线错开一点，两端收拢（像真的回笔描线）
      const t = i / (shaft.length - 1), e = Math.sin(Math.PI * Math.min(1, t * 1.15));
      return [x + (nx / L) * o * e, y + (ny / L) * o * e]; // (nx, ny)/L 是单位法线
    })));
    const p = shaft[shaft.length - 3], ang = Math.atan2(y1 - p[1], x1 - p[0]), hl = 16 + 4 * a.tier, hw = 0.5;
    out.push(k.S([[x1 - hl * Math.cos(ang - hw), y1 - hl * Math.sin(ang - hw)], [x1, y1], [x1 - hl * Math.cos(ang + hw), y1 - hl * Math.sin(ang + hw)]], false));
    return out;
  },
};
