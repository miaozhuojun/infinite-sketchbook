// 一次打包、一个浏览器，渲染一组静帧（画面检查要抽十几帧：每帧单独跑 `remotion still` 都要重新打包、开浏览器，一个画幅约 50 秒）
// 用法：node qa/stills.mjs <合成 id> <任务.json>
//   任务.json：[{ "frame": 帧号, "out": "输出.png", "props": {…可选} }, …]
// 每一帧在新开的页面里渲染（页面里的脚本重新执行），所以同一帧渲两次仍能查出不确定性（随机数、时间）
// 静帧审稿（qa/still_review.mjs）渲染没注册的试编时间线：import { renderTimelineStills }，不改成片注册表、不用配音
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { GL } from './gl.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = { logLevel: 'error', chromiumOptions: { gl: GL } };

// 同一个浏览器里同时开几个页面渲染（Mac 上约 0.5 秒一帧，几百帧时并行快几倍）。同一个合成、同一份 props 只选一次合成
async function renderAll(serveUrl, jobs, concurrency) {
  const browser = await openBrowser('chrome', { chromiumOptions: { gl: GL } });
  try {
    const comps = new Map();
    const compOf = (id, inputProps) => {
      const k = `${id}\u0000${JSON.stringify(inputProps)}`;
      if (!comps.has(k)) comps.set(k, selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser, ...opts }));
      return comps.get(k);
    };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++], inputProps = j.props ?? {};
        const composition = await compOf(j.comp, inputProps);
        await renderStill({ serveUrl, composition, frame: j.frame, output: j.out, inputProps, puppeteerInstance: browser, ...opts });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await browser.close({ silent: true });
  }
}

// 渲染试编时间线（或任何时间线文件）的静帧：临时写一个只注册这几条时间线的入口打包，不碰 build/compositions.generated.ts（流水线和别的检查在用）。
// timelines：{ 合成名: 时间线文件 }；jobs：[{ comp, frame, out, props? }]。不带配音（静帧用不到，试编的假配音也不在 public/ 里）
export async function renderTimelineStills(timelines, jobs, { concurrency = Math.min(4, Math.max(1, os.cpus().length - 2)) } = {}) {
  const dir = fs.mkdtempSync(path.join(ENGINE, 'build', '_stills-'));
  try {
    const names = Object.keys(timelines);
    const lines = ["import React from 'react';", "import { Composition, registerRoot } from 'remotion';", "import { Sketch } from '../../src/Sketch';", "import type { Timeline } from '../../src/timeline';"];
    names.forEach((n, i) => {
      fs.copyFileSync(timelines[n], path.join(dir, `t${i}.json`));
      lines.push(`import j${i} from './t${i}.json';`, `const t${i} = { ...(j${i} as unknown as Timeline), narration: '', audio: undefined };`);
    });
    lines.push('registerRoot(() => (<>', ...names.map((n, i) => `  <Composition id=${JSON.stringify(n)} component={Sketch} durationInFrames={t${i}.durationInFrames} fps={t${i}.fps} width={t${i}.canvas.w} height={t${i}.canvas.h} defaultProps={{ tl: t${i}, inkMode: 'mono' as const }} />`), '</>));', '');
    fs.writeFileSync(path.join(dir, 'entry.tsx'), lines.join('\n'));
    fs.mkdirSync(path.join(dir, 'public'));
    const serveUrl = await bundle({ entryPoint: path.join(dir, 'entry.tsx'), publicDir: path.join(dir, 'public'), outDir: path.join(dir, 'bundle') });
    await renderAll(serveUrl, jobs, concurrency);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [comp, jobsPath] = process.argv.slice(2);
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')).map((j) => ({ comp, ...j }));
  const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts'), publicDir: path.resolve('public') });
  // 本机是 Mac 时用 GPU 画（angle）：比默认快约三分之一，同一帧两次渲染逐像素一致（qa/gl.mjs）
  // 一次一帧：成片检查要比较同一帧两次渲染（同帧确定性），按顺序渲
  await renderAll(serveUrl, jobs, 1);
}
