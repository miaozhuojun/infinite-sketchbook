// 组件注册表：自动加载 components/ 下所有组件。编译器、分镜校验、组件测试都从这里取组件和参数定义。
// 内置动作（不是画图组件、由编译器直接处理）：retrace（回描已有元素加粗）、strike（划掉已有元素）、ring（圈出已有元素）、glow（光晕效果，不动笔）、off（熄灭光晕）、sticker（贴图，不动笔）、clip（贴视频，不动笔）。
// 不动笔的动作（铅笔不去画它，编译时直接按提示词的时刻出现）
export const PENLESS = new Set(['glow', 'off', 'sticker', 'clip']);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILTINS = {
  retrace: {
    name: 'retrace', title: '回描加粗', desc: '笔回到已画好的元素上再描几遍，让它变粗（强调"更大/更重要"）。',
    params: { target: { type: 'actionId', required: true }, passes: { type: 'number', desc: '描几遍，默认 2' } },
  },
  strike: {
    name: 'strike', title: '划掉', desc: '在已画好的元素上斜着划一道（改数、否定）。划线按目标墨迹的范围自动生成，目标被自动避让挪动后跟着重画。target 写一组时一笔划过它们整体；一组同心声波（arcs）时沿半径斜穿过被划的几道，不碰留下的里圈（权重变小时划掉多出来的声波）。',
    params: { target: { type: 'actionIds', required: true, desc: '一个元素，或一组元素' }, color: { type: 'inkColor', desc: '墨色名，默认 accent（红笔改错）' } },
  },
  ring: {
    name: 'ring', title: '圈出', desc: '用一个手画圈把已写的元素圈起来（强调「这一个」）。圈的位置和大小按目标墨迹自动算，目标被自动避让挪动后跟着重画。',
    params: { target: { type: 'actionId', required: true }, color: { type: 'inkColor', desc: '墨色名，默认 accent' } },
  },
  glow: {
    name: 'glow', title: '光晕', desc: '不动笔的柔和光晕（灯亮等），可带几道光芒（rays 写角度）。只用效果色。光是效果不是墨迹，所以能用 off 熄灭。',
    params: { cx: { type: 'number', required: true }, cy: { type: 'number', required: true }, r: { type: 'number', required: true }, color: { type: 'effectColor', required: true }, rays: { type: 'numbers', desc: '光芒方向（度），不写就没有光芒' } },
  },
  sticker: {
    name: 'sticker', title: '贴图',
    desc: '把一张图贴在纸面上：被依赖那一集的封面（每集能单独看：第一次用到前一集的结论时贴它的封面，同一句旁白复述一句）。印出来的小卡片，留一圈白边、略歪、上边两角两条胶带，0.5 秒从上方落下放好（不是淡入）。铅笔不画它；版面检查、取景、安全区检查把它当一块图形。图放在 public/stickers/（不进仓库），编译时嵌进时间线。',
    params: {
      src: { type: 'string', required: true, desc: 'public/stickers/ 下的文件名（.jpg .png .svg）' },
      cx: { type: 'number', required: true }, cy: { type: 'number', required: true },
      w: { type: 'number', required: true, desc: '图的宽（纸面像素，不含白边），高按图的比例' },
      tilt: { type: 'number', desc: '歪几度（正数顺时针），默认 -3' },
      ep: { type: 'string', desc: '这张图代表哪一集（brief.dependsOn 里的 ep）：分镜校验据此核对每条依赖都贴了封面' },
    },
  },
  clip: {
    name: 'clip', title: '贴视频',
    desc: '把一小段片子贴在纸面上，当一块小屏幕放：实验画面、实物怎么动这类证据（核心概念照旧用笔边说边写）。深色细边框、略歪、上边两角两条胶带，和贴图一样 0.5 秒从上方落下；落定（或说到 play 那个词）时开始放 from–to 这一段，放完停在最后一帧。不出声，旁白照常。调成纸面的暖色（style.clip.warm）。铅笔不画它；版面检查、取景、安全区检查把它当一块图形，镜头在它放完之前不能把它移出取景框。片子放在 public/clips/（不进仓库），出处写在 facts 里一条 media 写这个文件名的（license、origin）。',
    params: {
      src: { type: 'string', required: true, desc: 'public/clips/ 下的文件名（.mp4 .mov .m4v）' },
      cx: { type: 'number', required: true }, cy: { type: 'number', required: true },
      w: { type: 'number', required: true, desc: '画面的宽（纸面像素，不含边框），高按片子的比例' },
      from: { type: 'number', desc: '从片子的第几秒放起，默认 0' },
      to: { type: 'number', desc: '放到片子的第几秒，默认放到结尾' },
      rate: { type: 'number', desc: '放的速度（0.25–4，慢放写 0.5），默认 1' },
      play: { type: 'string', desc: '说到这个词时开始放（同一句旁白里、在 at 之后），默认落定就放' },
      tilt: { type: 'number', desc: '歪几度（正数顺时针），默认 2' },
    },
  },
  off: {
    name: 'off', title: '熄灭', desc: '让之前亮起的光晕（连同光芒）在提示词处熄灭，比如反例里同一盏灯灭掉。',
    params: { target: { type: 'actionId', required: true } },
  },
};

// 组件来自两处：components/（公开、随引擎发布）和 components.local/（本机私有，不进仓库）。
// 某一期需要的新画法可以先放进 components.local/ 直接用，不必先进公开仓库；觉得通用再提 PR 挪到 components/
export async function loadLibrary() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reg = new Map();
  const files = ['components', 'components.local'].flatMap((d) => (fs.existsSync(path.join(here, d)) ? fs.readdirSync(path.join(here, d)).filter((f) => f.endsWith('.mjs')).sort().map((f) => path.join(d, f)) : []));
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(here, f)).href);
    for (const c of [].concat(mod.default)) {
      if (!c?.meta?.name || typeof c.draw !== 'function') throw new Error(`组件文件 ${f} 缺少 meta.name 或 draw`);
      if (reg.has(c.meta.name) || BUILTINS[c.meta.name]) throw new Error(`组件名重复：${c.meta.name}（${f}）`);
      reg.set(c.meta.name, { ...c, file: f });
    }
  }
  return reg;
}
