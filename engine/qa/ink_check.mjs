// 墨迹叠色检查（渲染后量像素，能失败）：用成片同一个渲染器画一张小样，量交叠处的颜色。
//   1. 交叠处不发黑：两笔灰墨十字交叉处、回描（同色两笔几乎重合）处，亮度不低于单笔的 80%
//   2. 红笔盖住灰笔仍是红色：红压灰的交叉处 R−G > 60，不是相乘出来的暗褐
// 审片（v7–v9）：交叠处亮度只有正常笔芯的两到三成，描红的那道弧成了近黑的暗褐色。
// 用法：node qa/ink_check.mjs [--old]（--old 只给检查器自测用：换回 v9 以前每个元素一层、层间相乘的做法，两项都必须失败）
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { samplePts } from '../library/kit.mjs';
import { loadStyle, styleSubset } from '../compiler/validate.mjs';
import { PY_QA } from './pyenv.mjs';

const style = loadStyle(), sub = styleSubset(style);
if (process.argv.includes('--old')) sub.ink = { ...sub.ink, layerBy: 'element', layerBlend: 'multiply' };
const W = 600, H = 300, ink = style.palette.ink, red = style.palette.accent, w = style.ink.penWidth;
const line = (id, color, x0, y0, x1, y1) => {
  const s = { id, action: id.split('#')[0], kind: 'shape', color, width: w, d: `M${x0} ${y0} L${x1} ${y1}`, len: 1, t0: -1, t1: -0.5 };
  return { ...s, pts: samplePts(s) };
};
// 左：灰笔十字；中：灰笔回描（两笔错开 1.3px，和 style.ink.retraceOffsets 一样）；右：先灰后红的十字
const strokes = [
  line('gh#0', ink, 40, 90, 200, 90), line('gv#0', ink, 120, 20, 120, 160),
  line('rt#0', ink, 40, 230, 200, 230), line('rt#1', ink, 40, 231.3, 200, 231.3),
  line('dv#0', ink, 440, 20, 440, 160), line('rh#0', red, 360, 90, 520, 90),
];
const tl = {
  id: 'ink-probe', target: 'probe', canvas: { w: W, h: H, fps: 60 }, fps: 60, durationInFrames: 1, duration: 0.02,
  narration: '', strokes, penTrack: [{ kind: 'rest', t0: 0, t1: 1, at: [99999, 0] }], effects: [],
  camera: [{ t0: 0, t1: 0, from: { x: W / 2, y: H / 2, z: 1 }, to: { x: W / 2, y: H / 2, z: 1 } }], view: { cx: W / 2, cy: H / 2 },
  sub: { cx: W / 2, top: H, size: 40, width: W }, subtitles: [], style: sub, platforms: [],
};
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/ink-probe.timeline.json', JSON.stringify(tl));
execFileSync('node', ['compiler/gen-compositions.mjs'], { stdio: 'ignore' });
execFileSync('npx', ['remotion', 'still', 'src/index.ts', 'ink-probe', 'build/ink-probe.png', '--frame=0', '--log=error'], { stdio: 'inherit' });

// 每个采样点取 5×5 像素的中位数，避开纸纹和石墨颗粒的噪点
const pts = { single: [70, 90], cross: [120, 90], retrace: [100, 230.6], red: [390, 90], redOverInk: [440, 90] };
const r = spawnSync(PY_QA, ['-c', `
import json, statistics
from PIL import Image
im = Image.open('build/ink-probe.png').convert('RGB')
out = {}
for k, (x, y) in json.loads(${JSON.stringify(JSON.stringify(pts))}).items():
    px = [im.getpixel((int(x) + dx, int(round(y)) + dy)) for dx in range(-2, 3) for dy in range(-2, 3)]
    out[k] = [statistics.median(c[i] for c in px) for i in range(3)]
print(json.dumps(out))`], { encoding: 'utf8' });
if (r.status !== 0) { console.log(r.stdout + r.stderr); process.exit(1); }
const c = JSON.parse(r.stdout), lum = ([R, G, B]) => 0.299 * R + 0.587 * G + 0.114 * B;
const fails = [];
const check = (name, ok, detail) => { console.log(`[${ok ? '通过' : '失败'}] ${name}：${detail}`); if (!ok) fails.push(name); };
const base = lum(c.single), cross = lum(c.cross) / base, retrace = lum(c.retrace) / base;
check('交叠处不发黑', cross >= 0.8 && retrace >= 0.8, `单笔亮度 ${base.toFixed(0)}；十字交叉处是单笔的 ${(cross * 100).toFixed(0)}%，回描处 ${(retrace * 100).toFixed(0)}%（下限 80%）`);
const [R, G] = c.redOverInk;
check('红笔盖住灰笔仍是红色', R - G > 60, `红压灰处 RGB ${c.redOverInk.map((v) => v.toFixed(0)).join(',')}，R−G=${(R - G).toFixed(0)}（要求 >60；单独的红笔 R−G=${(c.red[0] - c.red[1]).toFixed(0)}）`);
process.exit(fails.length ? 1 : 0);
