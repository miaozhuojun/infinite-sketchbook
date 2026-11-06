// 多音字：配音模型按最常见的读音念，结构助词常念错（用户听 E02 v5：「细细地讲」的「地」念成了 dì，应念 de）。
// 回转识别听不出来：识别器按意思写回「细细地」，拼音库也把这里的「地」标成 dì。所以在旁白稿里直接写成不会念错的同音字，
// 字幕和画面上照旧写原字（和「锟仔ai科学」念「爱」一样）。这里只收程序能可靠判断的情况，判断不了的不报，不限制怎么写稿。
// 每条：pattern 匹配要改的那一段（g 标志），fix 给出旁白稿里的写法
export const POLYPHONES = [
  // 叠字后面的「地」是状语助词：细细地、慢慢地、悄悄地、一点一点地
  { pattern: /([一-鿿])\1地/g, fix: (m) => m.slice(0, -1) + '的', why: '叠字后面的「地」念 de' },
  { pattern: /([一-鿿])\1([一-鿿])\2地/g, fix: (m) => m.slice(0, -1) + '的', why: '叠字后面的「地」念 de' },
  { pattern: /一([一-鿿])一\1地/g, fix: (m) => m.slice(0, -1) + '的', why: '「一X一X地」的「地」念 de' },
  // 常见的「形容词/副词 + 地 + 动作」
  { pattern: /(认真|仔细|小心|轻轻|使劲|努力|拼命|大声|小声|飞快|高兴|开心|耐心|不停|突然|偷偷|默默|静静|渐渐|紧紧|好好|稳稳|一口气|一步步|一遍遍|自然而然)地/g, fix: (m) => m.slice(0, -1) + '的', why: '状语后面的「地」念 de' },
];

// 旁白稿里念错风险的地方：[{ text, say, why, index }]
export function polyphoneIssues(script) {
  const out = [];
  for (const r of POLYPHONES) for (const m of script.matchAll(r.pattern)) out.push({ text: m[0], say: r.fix(m[0]), why: r.why, index: m.index });
  return out.filter((x, i, a) => a.findIndex((y) => y.index === x.index && y.text === x.text) === i);
}
