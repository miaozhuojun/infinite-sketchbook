// 写稿自查（分镜校验的一部分，纯静态、几毫秒）：写稿时最容易漏、又能交给程序的几条。
// 出处：E02 做了 13 版，v6 以后理解度测试每一轮都找出一处新的「靠猜」，几乎都是这几类——
// 新词没当场讲清（「不背规则」没看过上一集的人不懂）、例子里的数没交代从哪来（「咳嗽两声…1乘2」的 2 是不是咳了两次）、
// 画面上写的和旁白说的不是一回事、开场的小故事没回收、留给下一集的不是一个清楚的问题。
// 讲法本身好不好程序判断不了：这里只查「写没写、在不在、隔了多远」，默认只给建议（风格规范 gates 的 script.*），私有配置可以升成 hard。
// 字段（都写在分镜里）：
//   brief.terms：[{ term, explain, kind?: 'example', bridge?, prev?: true }]——这一集的新词、新例子、接着上一集用的词，
//                explain 是旁白里讲清它的那半句，bridge（新例子）是把它和前面熟悉的例子接上的那半句；
//   facts[].from（kind: example 的示意数值）：{ "4": "天黑最要紧，给它4", … }——每个数在旁白里交代它从哪来的那半句；
//   brief.payoff（可选）：片中回收开场小故事的那半句，回收句和开场没有共用三个字以上时写。
import { strip } from './validate.mjs';

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT = { 十: 10, 百: 100, 千: 1000 };
// 一串汉字数字可能是哪些数：没有十百千万亿的按一个个念（一九五八 → 1958，也算出现过 1、9、5、8），有的按数值念（一千七百五十亿 → 1750、175000000000）
function cnValues(run) {
  const out = new Set();
  if (![...run].some((c) => UNIT[c] || c === '万' || c === '亿')) {
    out.add([...run].map((c) => CN[c]).join(''));
    for (const c of run) out.add(String(CN[c]));
    return out;
  }
  let total = 0, sec = 0, num = 0;
  for (const c of run) {
    if (CN[c] !== undefined) num = CN[c];
    else if (UNIT[c]) { sec += (num || 1) * UNIT[c]; num = 0; }
    else { sec += num; out.add(String(sec)); total += sec * (c === '万' ? 1e4 : 1e8); sec = 0; num = 0; }
  }
  sec += num;
  if (sec) out.add(String(sec));
  out.add(String(total + sec));
  return out;
}
// 一段旁白里说到了哪些数（阿拉伯数字和汉字念法都算：年份和多位数在旁白稿里写念法）
export function saidNumbers(text) {
  const s = new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
  for (const run of text.match(/[零〇一二两三四五六七八九十百千万亿]+/g) ?? []) for (const v of cnValues(run)) s.add(v);
  return s;
}
// 动作里会画到画面上的字（text、label、各种标签数组）；位置、颜色、引用这些不算
const NOT_DRAWN = new Set(['id', 'type', 'at', 'on', 'after', 'target', 'color', 'anchor', 'note', 'layout', 'bleed', 'ahead', 'kind', 'speed', 'lead', 'hold']);
const drawnStrings = (a) => Object.entries(a).filter(([k]) => !NOT_DRAWN.has(k)).flatMap(([, v]) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flat(3).filter((x) => typeof x === 'string') : []));

// 预告里的这些词不算「这一集没讲过的东西」：问法、代词、连词
const STOP = new Set(['下一集', '下集', '下一期', '我们', '你们', '他们', '它们', '大家', '怎么', '怎样', '如何', '知道', '为什么', '什么', '可是', '但是', '那么', '这个', '那个', '哪个', '哪些', '哪边', '哪里', '哪儿', '多少', '是不是', '能不能', '会不会', '到底', '究竟', '一下', '试试', '一试', '自己', '还是', '就是', '这样', '那样', '如果', '要是', '真的', '还能', '能够', '可以', '应该', '一起', '接下来', '然后']);
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const contentWords = (t) => (SEG ? [...SEG.segment(t)].filter((g) => g.isWordLike).map((g) => g.segment) : t.match(/[一-鿿]{2,}/g) ?? []).filter((w) => /^[一-鿿]{2,}$/.test(w) && !STOP.has(w));
// 两段文字有没有共用的一串汉字（≥ n 个字）
const shares = (a, b, n) => { for (let i = 0; i + n <= a.length; i++) { const s = a.slice(i, i + n); if (/^[一-鿿]+$/.test(s) && b.includes(s)) return s; } return null; };

export function scriptIssues(beats, style) {
  const issues = [], add = (gate, where, msg) => issues.push({ gate, where, msg }), err = (where, msg) => issues.push({ gate: null, where, msg });
  const script = beats.narration?.script ?? '';
  const sents = script.match(/[^。？！]+[。？！]?/g) ?? [];
  const sentOf = (frag) => { const f = strip(frag); return f ? sents.findIndex((s) => strip(s).includes(f)) : -1; };
  const brief = beats.brief ?? {}, episode = beats.kind === 'episode';
  const W = style.narrative?.[beats.kind]?.termWithin ?? 3;
  const quote = (k) => `第 ${k + 1} 句「${sents[k].slice(0, 14)}${sents[k].length > 14 ? '…' : ''}」`;

  // 1. 新词、新例子、接着上一集用的词：当场讲清（第一次说到它的那句，往后 W 句以内）
  const terms = brief.terms;
  if (terms !== undefined && !Array.isArray(terms)) err('brief.terms', '要写成数组：[{ term, explain }, …]');
  else if (episode && script && !terms?.length) add('script.terms', 'brief.terms', '没写：列出这一集的新词、新例子，和接着上一集用的词，各写上旁白里讲清它的那半句（explain）。写出来就看得出哪个没讲（E02 v6：「不背规则」，没看过上一集的人不知道规则是什么）');
  (Array.isArray(terms) ? terms : []).forEach((t, i) => {
    const T = `brief.terms[${i}]「${t.term ?? ''}」`;
    if (!t.term || !t.explain) return err(T, '要写 term（词）和 explain（旁白里讲清它的那半句）');
    const s0 = sents.findIndex((s) => s.includes(t.term));
    if (s0 < 0) return err(T, '旁白稿里没有这个词');
    const se = sentOf(t.explain);
    if (se < 0) return err(`${T}.explain`, `「${t.explain}」不在旁白稿里`);
    if (se - s0 > W) add('script.terms', T, `第一次说到在${quote(s0)}，讲清它的「${t.explain}」在第 ${se + 1} 句，隔了 ${se - s0} 句（要求 ${W} 句以内）：新词当场讲清，别让观众带着疑问往下听`);
    if (t.kind === 'example') {
      if (!t.bridge) add('script.terms', T, '是新例子，没写 bridge：换到陌生的例子前，先接上前面熟悉的那个，说清新例子里的东西各是什么（E02 v5 从灯一下跳到打孔卡片，用户：很多人理解不过来）；写上旁白里接上的那半句');
      else {
        const sb = sentOf(t.bridge);
        if (sb < 0) err(`${T}.bridge`, `「${t.bridge}」不在旁白稿里`);
        else if (Math.abs(sb - s0) > W) add('script.terms', T, `新例子第一次说到在${quote(s0)}，接上熟悉例子的「${t.bridge}」在第 ${sb + 1} 句，隔了 ${Math.abs(sb - s0)} 句（要求 ${W} 句以内）`);
      }
    }
  });
  const ep = beats.series?.episode ?? 1;
  if (episode && beats.series?.serial && ep > 1 && Array.isArray(terms) && terms.length && !terms.some((t) => t.prev))
    add('script.terms', 'brief.terms', `剧集第 ${ep} 集，没有一个标 prev: true 的词：上一集讲过、这一集要用的（上一集的结论、说好的那样东西），也列进来，写上这一集里重新交代它的那半句——没看过上一集的人也要看得懂`);

  // 2. 数：画面上写的数，旁白要在这句或前面说到；示意数值要交代从哪来
  const said = new Set();
  (beats.phrases ?? []).forEach((p, pi) => {
    for (const v of saidNumbers(`${p.text ?? ''}|${p.caption ?? ''}`)) said.add(v);
    for (const a of p.actions ?? []) for (const s of drawnStrings(a)) for (const n of s.match(/\d+(?:\.\d+)?/g) ?? [])
      if (!said.has(n)) add('script.numbers', `phrases[${pi}].${a.id}`, `画面上写「${s}」，其中的 ${n} 旁白到这句（「${(p.caption ?? p.text ?? '').slice(0, 14)}」）还没说到：画面上的数，旁白要在这句或前面说出来，不然观众不知道它是哪来的`);
  });
  const examples = (beats.facts ?? []).map((f, i) => [f, i]).filter(([f]) => f.kind === 'example');
  for (const [f, i] of examples) {
    const nums = (f.match ?? []).filter((x) => /^\d+(?:\.\d+)?$/.test(x));
    if (!nums.length) continue;
    if (!f.from) { if (episode) add('script.numbers', `facts[${i}]`, `示意数值 ${nums.join('、')} 没写 from：每个数写上旁白里交代它从哪来的那半句（{ "4": "天黑最要紧，给它4" }）。E02 的测试者猜过「咳嗽两声…1乘2」的 2 是不是咳了两次、跺三脚算一次还是三次`); continue; }
    if (typeof f.from !== 'object' || Array.isArray(f.from)) { err(`facts[${i}].from`, '要写成 { "数": "旁白里交代它从哪来的那半句" }'); continue; }
    const miss = nums.filter((n) => !f.from[n]);
    if (miss.length) add('script.numbers', `facts[${i}].from`, `${miss.join('、')} 没写从哪来`);
    for (const [n, frag] of Object.entries(f.from)) {
      const sf = sentOf(frag);
      if (sf < 0) { err(`facts[${i}].from.${n}`, `「${frag}」不在旁白稿里`); continue; }
      const first = sents.findIndex((s) => (s.match(/\d+(?:\.\d+)?/g) ?? []).includes(n));
      if (first >= 0 && first < sf) add('script.numbers', `facts[${i}].from.${n}`, `${n} 在${quote(first)}就用上了，交代它从哪来的「${frag}」在第 ${sf + 1} 句：先交代来历，再拿它算`);
    }
  }

  // 3. 开场的小故事，片中要回收（E02 v4：开场「跺了三脚还是黑的」，片子没再回到它；v5 回收成「天黑的权重定小了」）
  const P = beats.phrases ?? [];
  const hooks = P.map((p, i) => [p, i]).filter(([p]) => p.role === 'hook');
  if (episode && hooks.length) {
    const lastHook = hooks.at(-1)[1];
    // 回收要在开场那一节之后（没分节就在前四分之一之后）
    const nextCh = P.findIndex((p, i) => i > lastHook && p.chapter);
    const from = nextCh > 0 ? nextCh : Math.max(lastHook + 1, Math.ceil(P.length / 4));
    const hookText = strip(hooks.map(([p]) => p.text).join(''));
    const later = P.slice(from);
    if (brief.payoff) {
      if (!later.some((p) => strip(p.text).includes(strip(brief.payoff)))) add('script.payoff', 'brief.payoff', `「${brief.payoff}」不在开场那一节之后的旁白里`);
    } else if (!later.some((p) => shares(hookText, strip(p.text), 3)))
      add('script.payoff', `phrases[${hooks[0][1]}]`, `开场的小故事（「${hookText.slice(0, 16)}…」）在后面没再提到：片中按这一集讲的道理回收一次，把开场的问题答上（E02 v4）。回收的句子和开场没有共用三个字以上时，把它写进 brief.payoff`);
  }

  // 4. 留给下一集的：说成一个问题，问的是这一集讲过的东西（悬念，不是一头雾水）
  const nexts = P.map((p, i) => [p, i]).filter(([p]) => p.role === 'next');
  if (episode && nexts.length && sents.length) {
    const idx = [...new Set(nexts.map(([p]) => sentOf(p.text)).filter((k) => k >= 0))];
    const qs = idx.filter((k) => /[？?]$/.test(sents[k]) || nexts.some(([p]) => sentOf(p.text) === k && /[？?]$/.test(p.caption ?? '')));
    if (!qs.length) add('script.next', `phrases[${nexts[0][1]}]`, '留给下一集的没有说成一个问题：片尾用一句具体的问题点出来（「可是猜错了，它怎么知道该拧哪个旋钮？」），让观众知道这里还有个问题，而不是觉得刚才没看懂');
    for (const k of qs) {
      const before = sents.slice(0, k).join('');
      const unknown = [...new Set(contentWords(sents[k]).filter((w) => !before.includes(w)))];
      if (unknown.length) add('script.next', `phrases[${nexts.find(([p]) => sentOf(p.text) === k)?.[1] ?? nexts[0][1]}]`, `预告的问题里「${unknown.join('」「')}」前面没讲过：留给下一集的问题，用这一集讲过的东西来问（只把「怎么做到」留下）`);
    }
  }
  return issues;
}
