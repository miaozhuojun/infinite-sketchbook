// 一次打包、一个浏览器，渲染一组静帧（画面检查要抽十几帧：每帧单独跑 `remotion still` 都要重新打包、开浏览器，一个画幅约 50 秒）
// 用法：node qa/stills.mjs <合成 id> <任务.json>
//   任务.json：[{ "frame": 帧号, "out": "输出.png", "props": {…可选} }, …]
// 每一帧在新开的页面里渲染（页面里的脚本重新执行），所以同一帧渲两次仍能查出不确定性（随机数、时间）
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';

const [comp, jobsPath] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts'), publicDir: path.resolve('public') });
const browser = await openBrowser('chrome');
try {
  for (const j of jobs) {
    const inputProps = j.props ?? {};
    const composition = await selectComposition({ serveUrl, id: comp, inputProps, puppeteerInstance: browser, logLevel: 'error' });
    await renderStill({ serveUrl, composition, frame: j.frame, output: j.out, inputProps, puppeteerInstance: browser, logLevel: 'error' });
  }
} finally {
  await browser.close({ silent: true });
}
