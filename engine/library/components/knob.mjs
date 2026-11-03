// 旋钮：系列总纲里"权重 = 旋钮"的视觉比喻（拧大了，这个输入说话更算数）。
// 作为"组件库层"新增组件的示例：给写分镜的模型一个可复用的新表达，而不是在某一期里写一次性代码。
export default {
  meta: {
    name: 'knob', title: '旋钮', desc: '圆形旋钮 + 刻度 + 指针。value 0~1 表示拧到多大（指针从左下 -225° 转到右下 45°）。用来表示权重、音量、强度。',
    params: {
      cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true },
      value: { type: 'number', required: true, desc: '0~1' }, ticks: { type: 'number', desc: '刻度数，默认 7' },
      color: { type: 'inkColor' }, width: { type: 'strokeWidth' },
    },
    example: { cx: 0, cy: 0, r: 56, value: 0.75 }, extent: (a) => [a.cx - a.r * 1.45, a.cy - a.r * 1.45, a.cx + a.r * 1.45, a.cy + a.r * 1.45],
  },
  draw(a, k) {
    const { cx, cy, r } = a, out = [];
    // 外圈：手画圆，过头一点收尾
    const a0 = -2.4 + (k.rnd() - 0.5) * 0.2, n = 36;
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const ang = a0 + ((Math.PI * 2 + 0.22) * i) / n;
      ring.push([cx + r * (1 + 0.025 * Math.sin(ang * 3)) * Math.cos(ang), cy + r * (1 + 0.025 * Math.sin(ang * 3)) * Math.sin(ang)]);
    }
    out.push(k.S(ring));
    // 刻度：从 -225° 到 45°，一笔一根
    const ticks = a.ticks ?? 7, A0 = (-225 * Math.PI) / 180, A1 = (45 * Math.PI) / 180;
    for (let i = 0; i < ticks; i++) {
      const ang = A0 + ((A1 - A0) * i) / (ticks - 1), r0 = r * 1.16, r1 = r * (i === 0 || i === ticks - 1 ? 1.4 : 1.3);
      out.push({ ...k.S([[cx + r0 * Math.cos(ang), cy + r0 * Math.sin(ang)], [cx + r1 * Math.cos(ang), cy + r1 * Math.sin(ang)]], false), width: Math.max(2.5, k.width * 0.7) });
    }
    // 指针：从中心朝 value 对应的角度，一笔画出，末端略收
    const ang = A0 + (A1 - A0) * Math.min(1, Math.max(0, a.value));
    out.push({ ...k.S(k.wobble([[cx - Math.cos(ang) * r * 0.15, cy - Math.sin(ang) * r * 0.15], [cx + Math.cos(ang) * r * 0.78, cy + Math.sin(ang) * r * 0.78]], 0.8, k.rnd, 10), false) });
    return out;
  },
};
