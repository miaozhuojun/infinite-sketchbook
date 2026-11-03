// 门槛量表：按数值精确算出柱高和门槛线高度（柱高 = value × unit），保证比例真实（审片发现手拼的柱子 7:5 画成了 1.47）。
// 分两部分画，方便跟旁白对齐：part=threshold 画底线、门槛虚线和门槛标签；part=value 画数值柱（勾边+排线）和数值标签。
// 底线默认跟门槛一起画（标签、虚线之后）；也可以挪到某根柱子上画（baseline）。注意挪到柱子上以后，划掉这根柱子会连底线一起划。
// 标签位置由组件统一安排：门槛标签在虚线左侧（或上方）；数值标签在柱顶上方，若离门槛线太近就挪到柱子右侧——两者不会同行相撞。
export default {
  meta: {
    name: 'meter', title: '门槛量表', desc: '比较"一个数有没有超过门槛"。同一组 x/base/unit/threshold 画两次：先 part=threshold（底线+门槛虚线+标签），再 part=value（数值柱+标签）。可以并排画多根柱（不同 x）。',
    params: {
      part: { type: 'enum', values: ['threshold', 'value'], required: true },
      x: { type: 'number', required: true, desc: '柱子中心 x' }, base: { type: 'number', required: true, desc: '零刻度的 y' },
      unit: { type: 'number', required: true, desc: '每 1 个单位的像素高度' }, threshold: { type: 'number', required: true },
      value: { type: 'number', desc: 'part=value 时的数值' },
      span: { type: 'numbers', desc: '底线和门槛线的 [左, 右] x，默认 [x-110, x+90]' },
      barWidth: { type: 'number', desc: '柱宽，默认 42' },
      label: { type: 'string', desc: '标签文字（门槛如"门槛 5"，数值如"7"）' },
      labelSize: { type: 'typeSize', desc: '标签字号，默认 56' },
      labelPos: { type: 'enum', values: ['left', 'above'], desc: '门槛标签位置，默认 left（虚线左侧）' },
      baseline: { type: 'enum', values: [true, false], desc: '画不画底线（零刻度，横跨 span）。默认 threshold 画、value 不画；想等第一根柱子出来再画底线，就给 threshold 写 false、第一根柱子写 true' },
      color: { type: 'inkColor' },
    },
    example: { part: 'value', x: 0, base: 70, unit: 20, threshold: 5, value: 7, label: '7' },
    preview: [
      { part: 'threshold', x: 0, base: 70, unit: 16, threshold: 5, span: [-60, 110], label: '门槛 5', labelSize: 72 },
      { part: 'value', x: 0, base: 70, unit: 16, threshold: 5, value: 7, label: '7' },
      { part: 'value', x: 60, base: 70, unit: 16, threshold: 5, value: 4, label: '4', color: 'accent' },
    ],
    extent: (a) => [a.x - 260, a.base - Math.max(a.value ?? 0, a.threshold) * a.unit - 110, a.x + 200, a.base + 20],
  },
  draw(a, k) {
    const [l, r] = a.span ?? [a.x - 110, a.x + 90];
    const ty = a.base - a.threshold * a.unit, size = a.labelSize ?? 56, out = [];
    const drawBase = a.baseline ?? a.part === 'threshold';
    const base = () => k.S(k.wobble([[l, a.base], [r, a.base]], 1, k.rnd, 24), false);
    if (a.part === 'threshold') {
      // 先写标签、再画虚线、最后画底线：旁白一般先说「门槛定在 5」再说「就是这条线」（审片：标签写在句子说完之后）
      if (a.label) {
        const pos = a.labelPos === 'above' ? { x: l + (r - l) * 0.28, y: ty - size * 0.8, anchor: 'c' } : { x: l - size * 0.35, y: ty, anchor: 'r' };
        out.push(...k.text({ text: a.label, size, ...pos }));
      }
      const dash = 24, gap = 13, L = r - l, n = Math.floor(L / (dash + gap));
      for (let i = 0; i <= n; i++) {
        const u0 = l + i * (dash + gap), u1 = Math.min(r, u0 + dash);
        if (u0 >= r) break;
        out.push(k.S([[u0, ty], [u1, ty]], false));
      }
      if (drawBase) out.push(base());
      return out;
    }
    if (drawBase) out.push(base());
    const w = a.barWidth ?? 42, x0 = a.x - w / 2, x1 = a.x + w / 2, top = a.base - a.value * a.unit;
    out.push(k.S(k.wobble([[x0, a.base], [x0, top], [x1, top], [x1, a.base]], 1, k.rnd, 14), false));
    for (let yy = a.base - 16; yy > top + 8; yy -= 22) out.push({ ...k.S([[x0 + 4, yy + 8], [x1 - 4, yy - 8]], false), width: k.width * 0.85 });
    if (a.label) {
      const aboveY = top - size * 0.75;
      // 柱顶标签离门槛虚线太近（不到 0.9 个字号）就挪到柱子右侧，避免和虚线、门槛标签挤在一行；
      // 挪到右侧时也和虚线隔开一个字号（审片：「4」贴着门槛虚线只隔 12px）
      const side = top > ty ? Math.max(top + size * 0.35, ty + size) : Math.min(top + size * 0.35, ty - size);
      const pos = Math.abs(aboveY - ty) >= size * 0.9 ? { x: a.x, y: aboveY, anchor: 'c' } : { x: x1 + size * 0.35, y: side, anchor: 'l' };
      out.push(...k.text({ text: a.label, size, ...pos }));
    }
    return out;
  },
};
