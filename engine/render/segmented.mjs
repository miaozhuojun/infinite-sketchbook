// 分段缓存渲染：成片按固定时长切段，每段算一个指纹（这段画面用得到的时间线内容 + 渲染程序 + 渲染参数），
// 指纹没变的段直接用上次渲好的，只渲变了的段，再无损拼接、配上混音。改一两处时，改动点之前的段全部复用。
//
// 用法：node render/segmented.mjs <时间线.json> <输出.mp4> [--audio <wav>] [--scale 0.5] [--x264-preset veryfast]
//        [--segment 30（秒）] [--concurrency N] [--verify 1（每个复用段抽查几帧）]
// 输出：<输出.mp4>，和 <输出>.segments.json（每段的起止、指纹、这次是新渲还是复用；增量审片按它只看改过的段）
//
// 为什么能复用：Sketch 的每一帧只由（时间线, 帧号）决定（Remotion 本来就要求逐帧确定，qa.py 查同帧确定性）。
// 指纹只取这段时间里画得出来的东西：已经开始的笔画、走过的笔迹、动过的镜头、这段里的字幕和水印、这段的铅笔姿态……
// 后面的改动不影响前面的段。纸面的光（lampDrift）和颗粒按绝对时间、帧号变，所以段的起止帧也在指纹里：
// 前面改动让后面整体挪了时间，后面的段就要重渲（挪了时间的画面和原来本来就不是同一帧）。
// 兜底：复用的段每段抽 --verify 帧重新渲一张，和缓存里的那一帧比；对不上（指纹漏了什么）就丢掉那一段重渲，并报出来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { GL } from '../qa/gl.mjs';
import { PY_QA } from '../qa/pyenv.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

// 渲染并发：Remotion 默认取一半核、最多 8。M3 Max（14 核）上 10 比默认 7 快约 8%，12、14 不再快（E03 600 帧实测 7.6s → 7.0s）。
// 核多的机器留 4 个核给系统和编码，核少的（CI）用默认
export const defaultConcurrency = () => (os.cpus().length >= 12 ? os.cpus().length - 4 : null);

// 这段 [f0, f1) 的画面会用到的时间线内容。和 src/Sketch.tsx、src/timeline.ts 读的字段一一对应；那边加了读时间线的地方，这里要跟着加
export function sliceFor(tl, f0, f1) {
  const ta = f0 / tl.fps, tb = (f1 - 1) / tl.fps, eps = 1e-9;
  const st = tl.style, byElement = st.ink.layerBy === 'element';
  // 墨色分层的先后按整条时间线里第一次出现的顺序（含后面才出现的颜色），只取顺序本身
  const layers = [...new Set(tl.strokes.map((s) => (byElement ? s.group ?? s.action : s.color)))];
  const pen = tl.penTrack, last = pen.length - 1;
  const nextDown = pen.findIndex((s) => s.kind === 'down' && s.t0 > tb + eps);
  const penIdx = pen.map((s, i) => i).filter((i) => i === 0 || i === last || pen[i].t0 <= tb + eps || i === nextDown);
  const cam = tl.camera.filter((m, i) => i === 0 || m.t0 < tb + eps);
  const f = (a) => a?.slice(f0, f1);
  return {
    canvas: tl.canvas, fps: tl.fps, view: tl.view, sub: tl.sub, frame: tl.frame, style: st, layers,
    strokes: tl.strokes.map((s, i) => [i, s]).filter(([, s]) => s.t0 < tb + eps),
    pen: penIdx.map((i) => [i, pen[i], pen[i].kind === 'down' ? tl.strokes[pen[i].stroke].color : null]),
    camera: cam, effects: tl.effects.filter((e) => e.t0 < tb + eps),
    subtitles: tl.subtitles.filter((s) => s.t0 <= tb + eps && s.t1 > ta),
    pencil: tl.pencil ? { sway: f(tl.pencil.sway), lift: f(tl.pencil.lift), edge: f(tl.pencil.edge) } : null,
    watermark: tl.watermark ? { ...tl.watermark, spans: tl.watermark.spans.filter((s) => s.t0 <= tb + eps && s.t1 > ta).map((s) => ({ ...s, atEnd: s.t1 >= tl.duration })) } : null,
    endCard: tl.endCard && tl.endCard.t0 <= tb + eps ? tl.endCard : null,
  };
}

// 渲染程序本身：src/ 下的代码、Remotion 版本
function engineKey() {
  const src = fs.readdirSync(path.join(ENGINE, 'src')).sort().map((f) => [f, fs.readFileSync(path.join(ENGINE, 'src', f), 'utf8')]);
  const ver = JSON.parse(fs.readFileSync(path.join(ENGINE, 'node_modules/@remotion/renderer/package.json'), 'utf8')).version;
  return sha([src, ver]);
}

export function plan(tl, { segment = 30, scale = 1, preset = null } = {}) {
  const n = Math.max(1, Math.round(segment * tl.fps)), segs = [];
  const key = engineKey(), opts = { scale, preset, gl: GL, codec: 'h264' };
  for (let f0 = 0; f0 < tl.durationInFrames; f0 += n) {
    const f1 = Math.min(tl.durationInFrames, f0 + n);
    segs.push({ f0, f1, t0: f0 / tl.fps, t1: f1 / tl.fps, hash: sha([key, opts, f0, f1, sliceFor(tl, f0, f1)]).slice(0, 24) });
  }
  return segs;
}

// ffmpeg 用画面检查那个 Python 环境里带的（imageio-ffmpeg），和混音、检查用的是同一个
function ffmpeg() {
  const r = spawnSync(PY_QA, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', cwd: ENGINE });
  return r.status === 0 ? r.stdout.trim() : 'ffmpeg';
}
const FF = ffmpeg();
const ff = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${args.join(' ')}\n${r.stderr}`);
  return r;
};

// 缓存里那一段的第 k 帧（段内序号）和新渲的一张静帧比：分 32×32 的块算平均差，编码噪声一般 1–3，画面不同（字、笔画、铅笔）远大于它
function sameFrame(segFile, k, png, w, h, fps) {
  const raw = (args) => spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-'], { maxBuffer: 1 << 28 }).stdout;
  // 跳到第 k 帧之前的关键帧再解（从段首一路解到段中间，一段要一秒多）：取第一个时间戳 ≥ (k − ¼)/fps 的帧，就是第 k 帧
  const a = raw(['-ss', ((k - 0.25) / fps).toFixed(6), '-i', segFile, '-frames:v', '1']), b = raw(['-i', png]);
  if (!a?.length || a.length !== b?.length) return { ok: false, worst: Infinity };
  let worst = 0;
  for (let by = 0; by + 32 <= h; by += 32) for (let bx = 0; bx + 32 <= w; bx += 32) {
    let s = 0;
    for (let y = by; y < by + 32; y++) for (let x = bx; x < bx + 32; x++) s += Math.abs(a[y * w + x] - b[y * w + x]);
    worst = Math.max(worst, s / 1024);
  }
  return { ok: worst < 12, worst };
}

export async function renderSegmented(tlPath, outFile, { audio = null, scale = 1, preset = null, segment = 30, concurrency = defaultConcurrency(), verify = 1, log = console.log } = {}) {
  const tl = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
  const segs = plan(tl, { segment, scale, preset });
  const cache = path.join(ENGINE, 'build', `${tl.id}.segments`);
  fs.mkdirSync(cache, { recursive: true });
  const file = (s) => path.join(cache, `${s.hash}.mp4`);
  for (const s of segs) s.reused = fs.existsSync(file(s));
  // 不带配音的临时入口（同 qa/stills.mjs 的做法）：段都是静音渲的，混音最后整条配上
  const dir = fs.mkdtempSync(path.join(ENGINE, 'build', '_seg-'));
  const t0 = Date.now();
  try {
    fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ ...tl, narration: '', audio: undefined }));
    fs.writeFileSync(path.join(dir, 'entry.tsx'), ["import React from 'react';", "import { Composition, registerRoot } from 'remotion';", "import { Sketch } from '../../src/Sketch';",
      "import type { Timeline } from '../../src/timeline';", "import j from './t.json';", 'const t = j as unknown as Timeline;',
      "registerRoot(() => <Composition id=\"seg\" component={Sketch} durationInFrames={t.durationInFrames} fps={t.fps} width={t.canvas.w} height={t.canvas.h} defaultProps={{ tl: t, inkMode: 'mono' as const }} />);", ''].join('\n'));
    fs.mkdirSync(path.join(dir, 'public'));
    const serveUrl = await bundle({ entryPoint: path.join(dir, 'entry.tsx'), publicDir: path.join(dir, 'public'), outDir: path.join(dir, 'bundle') });
    const chromiumOptions = GL ? { gl: GL } : {};
    const composition = await selectComposition({ serveUrl, id: 'seg', logLevel: 'error', chromiumOptions });
    const w = Math.round(tl.canvas.w * scale), h = Math.round(tl.canvas.h * scale);
    // 兜底抽查复用的段：同一个浏览器里几页并行渲（一张一张渲时 23 段要一分多钟）
    const checks = segs.filter((x) => x.reused).flatMap((s) => Array.from({ length: verify }, (_, v) => ({ s, k: Math.floor(((v + 0.5) / verify) * (s.f1 - s.f0)), png: path.join(dir, `v-${s.hash}-${v}.png`) })));
    if (checks.length) {
      const browser = await openBrowser('chrome', { chromiumOptions });
      try {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(6, checks.length) }, async () => {
          while (next < checks.length) {
            const c = checks[next++];
            await renderStill({ serveUrl, composition, frame: c.s.f0 + c.k, output: c.png, scale, logLevel: 'error', chromiumOptions, puppeteerInstance: browser });
          }
        }));
      } finally {
        await browser.close({ silent: true });
      }
      for (const c of checks) {
        if (!c.s.reused) continue;
        const r = sameFrame(file(c.s), c.k, c.png, w, h, tl.fps);
        if (!r.ok) {
          log(`[警告] 复用段 ${c.s.t0.toFixed(1)}–${c.s.t1.toFixed(1)}s 第 ${c.s.f0 + c.k} 帧和重新渲的对不上（块差 ${r.worst.toFixed(1)}）：指纹漏了某项时间线内容，这一段重渲。请把这件事报成引擎问题`);
          fs.rmSync(file(c.s), { force: true }); c.s.reused = false; c.s.stale = true;
        }
      }
    }
    const todo = segs.filter((s) => !s.reused);
    for (const [i, s] of todo.entries()) {
      const tmp = file(s) + '.part.mp4', ts = Date.now();
      await renderMedia({ serveUrl, composition, codec: 'h264', muted: true, frameRange: [s.f0, s.f1 - 1], outputLocation: tmp, scale,
        ...(preset ? { x264Preset: preset } : {}), ...(concurrency ? { concurrency } : {}), chromiumOptions, logLevel: 'error' });
      fs.renameSync(tmp, file(s));
      log(`  段 ${i + 1}/${todo.length}：${s.t0.toFixed(1)}–${s.t1.toFixed(1)}s（${((Date.now() - ts) / 1000).toFixed(1)}s）`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 无损拼接（每段都从关键帧开始、编码参数一样），再配混音：Remotion 整条渲时是 48kHz 立体声 AAC 320k，这里一样；配音比画面短就补静音，长就截到画面长
  const list = path.join(cache, '_concat.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${file(s)}'`).join('\n'));
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const dur = (tl.durationInFrames / tl.fps).toFixed(6);
  if (audio) ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-af', 'apad', '-t', dur, outFile]);
  else ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-t', dur, outFile]);
  fs.rmSync(list);
  // 缓存只留这一次用到的段（上一版没变的段已经在里面了）
  const keep = new Set(segs.map((s) => `${s.hash}.mp4`));
  for (const f of fs.readdirSync(cache)) if (!keep.has(f)) fs.rmSync(path.join(cache, f), { force: true });
  const fresh = segs.filter((s) => !s.reused);
  fs.writeFileSync(outFile.replace(/\.mp4$/, '') + '.segments.json', JSON.stringify({ id: tl.id, segment, segments: segs.map(({ f0, f1, t0, t1, hash, reused, stale }) => ({ f0, f1, t0, t1, hash, reused, ...(stale ? { stale } : {}) })) }, null, 1));
  log(`分段渲染：${segs.length} 段，新渲 ${fresh.length} 段（${fresh.reduce((n, s) => n + s.t1 - s.t0, 0).toFixed(0)}s 画面），复用 ${segs.length - fresh.length} 段；用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return segs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k, d = null) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const [tlPath, outFile] = a;
  if (!tlPath || !outFile) { console.error('用法：node render/segmented.mjs <时间线.json> <输出.mp4> [--audio <wav>] [--scale s] [--x264-preset p] [--segment 秒] [--concurrency N] [--verify N]'); process.exit(2); }
  const c = opt('--concurrency');
  await renderSegmented(tlPath, outFile, { audio: opt('--audio'), scale: Number(opt('--scale', 1)), preset: opt('--x264-preset'), segment: Number(opt('--segment', 30)),
    concurrency: c ? Number(c) : defaultConcurrency(), verify: Number(opt('--verify', 1)) });
}
