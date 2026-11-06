// 文字：中文用 makemeahanzi 中线（国标笔顺逐笔写），拉丁字母/数字/符号用 Hershey 单线字体；支持下标 x_1、手写 ×、空格。
// 一支笔：所有字形同一笔宽（style.ink.penWidth），不随字号变粗。字号必须取风格规范的字号阶梯（type.scale）。
// 为了和乘号 × 分开：变量 x 写成手写代数里的 ")(" 形；小写 w 写成圆底，不像大写 W（审片发现 ×w₁ 读成 xW1）。
// 每一笔带 gi（第几个字形），组件测试用它检查同一段文字里字形不相交。
export default {
  meta: {
    name: 'text', title: '手写文字', desc: '按真实笔顺写出的文字。标题、标签、公式片段都用它。x_1 表示下标，× 是手写乘号（小、居中，和变量 x 字形不同）。',
    params: {
      text: { type: 'string', required: true }, x: { type: 'number', required: true }, y: { type: 'number', required: true },
      size: { type: 'typeSize', required: true, desc: '字号，必须在风格规范的字号阶梯上' },
      anchor: { type: 'enum', values: ['l', 'c', 'r'], desc: '对齐，默认 c' },
      color: { type: 'inkColor' }, speed: { type: 'number', desc: '书写速度倍数（标题可略快）' },
      plainX: { type: 'enum', values: [true, false], desc: '为 true 时变量 x 写成普通交叉形（默认 false）' },
    },
    example: { text: '感知机 x_1×w_1=4', x: 0, y: 0, size: 72 },
    preview: [{ text: '感知机', x: 0, y: -50, size: 72 }, { text: 'x_1×w_1=4', x: 0, y: 40, size: 56 }],
    // 组件测试额外检查的写法（字形间距最容易出问题的组合）
    cases: [{ text: 'w_1=4 x_2+x_3', x: 0, y: 0, size: 40 }, { text: '1+3+0=4<5', x: 0, y: 0, size: 56 }, { text: '×4 ×1 =7', x: 0, y: 0, size: 112 }],
  },
  draw(a, k) {
    const size = a.size, color = k.color, rnd = k.rnd, W = k.width; // k.width：一支笔的笔宽；风格写了 ink.textWidthBySize 时小字写轻一点（见 kit.mjs）
    const tokens = [];
    for (let i = 0; i < a.text.length; i++) {
      const c = a.text[i];
      if (c === '_' && i + 1 < a.text.length) { tokens.push({ c: a.text[++i], sub: true }); continue; }
      tokens.push({ c, sub: false });
    }
    const custom = (c) => (c === 'x' && !a.plainX) || c === 'w';
    const glyphs = tokens.map((t) => {
      if (k.CJK.test(t.c)) return { ...t, cjk: true, adv: size * 0.96 };
      if (t.c === ' ') return { ...t, space: true, adv: size * 0.3 };
      if (t.c === '×') return { ...t, times: true, adv: size * (0.29 + 0.04 * 2) + W + size * 0.1 }; // 左边 0.04 字号，右边 0.04 字号 + 正常字距，和前一个字形后的字距对称（审片：「0 ×2」像空了一格）
      const sc = t.sub ? 0.62 : 1; // 下标缩小
      // 字间距按墨迹算：字形包围盒是笔画中线，两侧各有半个笔宽，再加上 ±2.5° 旋转和抖动，所以间距 = 一个笔宽 + 0.1 个字号
      // （审片发现统一笔宽后下标 1 和后面的 = 贴在一起，w₁=4 读成 WF=4）
      const pad = W + size * (t.sub ? 0.15 : 0.1); // 下标后面紧跟运算符时要多留（审片：w₁= 的下标 1 顶到等号）
      if (custom(t.c)) return { ...t, custom: true, sc, adv: size * (t.c === 'w' ? 0.6 : 0.5) * sc + pad };
      const g = k.hershey.renderTextArray(t.c, { font: 'futural' })[0];
      if (!g) throw new Error(`Hershey 缺字: ${t.c}`);
      // 按字形真实包围盒排版（hersheytext 给的 width 与坐标不一致，不能直接用）
      const xs = g.d.match(/-?\d+(?=,)/g).map(Number);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const s = (size * (t.sub ? 0.46 : 0.74)) / 21;
      return { ...t, cjk: false, g, s, minX, pre: t.sub ? size * 0.03 : 0, adv: (maxX - minX) * s + pad + (t.sub ? size * 0.03 : 0) };
    });
    const total = glyphs.reduce((s, g) => s + g.adv, 0);
    let x = a.x - (a.anchor === 'l' ? 0 : a.anchor === 'r' ? total : total / 2);
    const strokes = [];
    glyphs.forEach((g, gi) => {
      const rot = ((rnd() - 0.5) * 5 * Math.PI) / 180; // ±2.5°
      const sj = 0.95 + rnd() * 0.1;
      const dy = (rnd() - 0.5) * size * 0.06;
      const push = (s) => strokes.push({ ...s, gi, ...(g.sub ? { sub: true } : {}) });
      const baseY = a.y + dy + size * 0.3 + (g.sub ? size * 0.17 : 0); // 拉丁字母基线
      if (g.space) { x += g.adv; return; }
      if (g.times) {
        // 乘号：约为小写字母高度的 0.6，垂直居中在小写字母中线，两侧留空（0.45 时小得像个点，理解度测试里和 x₂ 混）
        const q = size * 0.145, c = [x + size * 0.04 + q, baseY - size * 0.245];
        push({ kind: 'line', color, width: W, d: k.polyPath(k.wobble([[c[0] - q, c[1] - q], [c[0] + q, c[1] + q]], 0.6, rnd, 8)), normLenRef: size });
        push({ kind: 'line', color, width: W, d: k.polyPath(k.wobble([[c[0] + q, c[1] - q], [c[0] - q, c[1] + q]], 0.6, rnd, 8)), normLenRef: size });
        x += g.adv; return;
      }
      if (g.custom) {
        const h = size * 0.49 * g.sc, w = size * (g.c === 'w' ? 0.6 : 0.5) * g.sc, L = x + (g.sub ? size * 0.03 : 0), top = baseY - h, bot = baseY;
        const J = (p) => [p[0] + (rnd() - 0.5) * size * 0.012, p[1] + (rnd() - 0.5) * size * 0.012];
        if (g.c === 'x') {
          // 手写代数里的 x：先写 ")"，再写 "("，两弧在中间相切
          push({ kind: 'line', color, width: W, d: k.smoothPath([[L + w * 0.06, top], [L + w * 0.34, top + h * 0.22], [L + w * 0.44, top + h * 0.5], [L + w * 0.34, top + h * 0.78], [L + w * 0.06, bot]].map(J)), normLenRef: size });
          push({ kind: 'line', color, width: W, d: k.smoothPath([[L + w * 0.94, top], [L + w * 0.66, top + h * 0.22], [L + w * 0.56, top + h * 0.5], [L + w * 0.66, top + h * 0.78], [L + w * 0.94, bot]].map(J)), normLenRef: size });
        } else {
          // 小写 w：一笔写成的两个圆底
          push({ kind: 'line', color, width: W, d: k.smoothPath([[L, top], [L + w * 0.06, top + h * 0.7], [L + w * 0.2, bot], [L + w * 0.36, top + h * 0.75], [L + w * 0.5, top + h * 0.3], [L + w * 0.64, top + h * 0.75], [L + w * 0.8, bot], [L + w * 0.94, top + h * 0.7], [L + w, top]].map(J)), normLenRef: size });
        }
        x += g.adv; return;
      }
      if (g.cjk) {
        const data = k.glyphData(g.c);
        const sc = (size / 1024) * sj, h = 512 * sc;
        const cx = x + g.adv / 2, cy = a.y + dy;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const T = ([gx, gy]) => {
          const u = gx * sc - h, v = (900 - gy) * sc - h;
          return [cx + u * cos - v * sin, cy + u * sin + v * cos];
        };
        const gt = `translate(${k.r2(cx)} ${k.r2(cy)}) rotate(${k.r2((rot * 180) / Math.PI)}) translate(${k.r2(-h)} ${k.r2(-h)}) scale(${sc.toFixed(5)} ${(-sc).toFixed(5)}) translate(0 -900)`;
        data.medians.forEach((med, si) => {
          const clean = med.map(T);
          const jit = clean.map((p) => [p[0] + (rnd() - 0.5) * size * 0.022, p[1] + (rnd() - 0.5) * size * 0.022]);
          push({
            kind: 'glyph', color, width: W,
            d: k.smoothPath(jit), dKai: k.smoothPath(clean),
            kai: { outline: data.strokes[si], gt, median: k.smoothPath(med) },
            normLenRef: size,
          });
        });
      } else {
        const s = g.s * sj;
        const base = [x + g.pre, baseY];
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const T = ([hx, hy]) => { const u = (hx - g.minX) * s, v = (hy - 22) * s; return [base[0] + u * cos - v * sin, base[1] + u * sin + v * cos]; };
        for (const sub of g.g.d.split('M').filter(Boolean)) {
          const pts = sub.trim().replace(/L/g, ' ').trim().split(/\s+/).map((p) => p.split(',').map(Number)).map(T);
          const w = k.wobble(pts, size * 0.012, rnd, 10);
          push({ kind: 'line', color, width: W, d: k.smoothPath(w), normLenRef: size });
        }
      }
      x += g.adv;
    });
    return strokes;
  },
};
