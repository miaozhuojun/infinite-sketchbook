// 旋钮：系列总纲里"权重 = 旋钮"的视觉比喻（拧大了，这个输入说话更算数）。
// 作为"组件库层"新增组件的示例：给写分镜的模型一个可复用的新表达，而不是在某一期里写一次性代码。
// 审片 E02 v5：原来的旋钮（圈外一圈刻度、指针从圆心伸出）像秒表，指针也不会动，看不出「拧了一点点」。
// 改成：圈外一段刻度弧、两头「−」「+」（像音量旋钮），指针是从边上往里的一道刻痕；part=turn 再画一次同一个旋钮，就是「拧过」：红色新刻痕 + 贴着圈走的弧形箭头
export default {
  meta: {
    name: 'knob', title: '旋钮',
    desc: '圆形旋钮：圈外一段刻度弧，两头是「−」「+」，指针是从边上往里的一道刻痕。value 0~1 表示拧到多大（从左下 -225° 转到右下 45°）。用来表示权重、音量、强度。'
      + '要表现「拧了一下」：先画 part=body（拧之前，value 写旧值），再在要拧的词上画 part=turn（同样的 cx/cy/r，from 写旧值、value 写新值）：新刻痕和一段贴着圈的弧形箭头。',
    params: {
      cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true },
      value: { type: 'number', required: true, desc: '0~1；part=turn 时是拧到的新值' },
      part: { type: 'enum', values: ['body', 'turn'], desc: '默认 body（整个旋钮）；turn 只画拧过去的新刻痕和弧形箭头' },
      from: { type: 'number', desc: 'part=turn 时拧之前的值（0~1），弧形箭头从这里画到 value' },
      color: { type: 'inkColor' }, width: { type: 'strokeWidth' },
    },
    example: { cx: 0, cy: 0, r: 56, value: 0.35 },
    extent: (a) => [a.cx - a.r * 1.8, a.cy - a.r * 1.6, a.cx + a.r * 1.8, a.cy + a.r * 1.6],
  },
  draw(a, k) {
    const { cx, cy, r } = a, out = [];
    const A0 = (-225 * Math.PI) / 180, A1 = (45 * Math.PI) / 180, angOf = (v) => A0 + (A1 - A0) * Math.min(1, Math.max(0, v));
    const pt = (ang, rr) => [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)];
    const notch = (ang) => k.S(k.wobble([pt(ang, r * 0.96), pt(ang, r * 0.42)], 0.6, k.rnd, 8), false);
    if (a.part === 'turn') {
      // 新刻痕（红笔）+ 圈外一段弧形箭头，从旧值转到新值（不到 20° 时按 20° 画，太短看不出方向）
      const g0 = angOf(a.from ?? 0), g1 = angOf(a.value), dir = Math.sign(g1 - g0) || 1, span = Math.max(Math.abs(g1 - g0), (20 * Math.PI) / 180);
      out.push(notch(g1));
      const arc = [], n = 14, rr = r * 1.42;
      for (let i = 0; i <= n; i++) arc.push(pt(g0 + (dir * span * i) / n, rr));
      out.push(k.S(arc, false));
      // 箭头头：在弧的终点，沿切线方向两短笔合成一笔
      const end = g0 + dir * span, tip = pt(end, rr), tan = end + (dir * Math.PI) / 2, hl = r * 0.32;
      const back = (da) => [tip[0] - hl * Math.cos(tan + da), tip[1] - hl * Math.sin(tan + da)];
      out.push(k.S([back(0.5), tip, back(-0.5)], false));
      return out;
    }
    // 外圈：手画圆，过头一点收尾
    const a0 = -2.4 + (k.rnd() - 0.5) * 0.2, n = 36, ring = [];
    for (let i = 0; i <= n; i++) {
      const ang = a0 + ((Math.PI * 2 + 0.22) * i) / n;
      ring.push([cx + r * (1 + 0.02 * Math.sin(ang * 3)) * Math.cos(ang), cy + r * (1 + 0.02 * Math.sin(ang * 3)) * Math.sin(ang)]);
    }
    out.push(k.S(ring));
    // 刻度弧：圈外从最小到最大一段弧，两头画「−」「+」，一看就是能拧大拧小的旋钮（像音量旋钮）
    const sc = [], m = 18, rs = r * 1.2;
    for (let i = 0; i <= m; i++) sc.push(pt(A0 + ((A1 - A0) * i) / m, rs));
    out.push(k.S(sc, false));
    const sym = r * 0.2, pm = pt(A0, r * 1.55), pp = pt(A1, r * 1.55);
    out.push(k.S([[pm[0] - sym, pm[1]], [pm[0] + sym, pm[1]]], false));
    out.push(k.S([[pp[0] - sym, pp[1]], [pp[0] + sym, pp[1]]], false), k.S([[pp[0], pp[1] - sym], [pp[0], pp[1] + sym]], false));
    // 指针：从边上往里的一道刻痕
    out.push(notch(angOf(a.value)));
    return out;
  },
};
