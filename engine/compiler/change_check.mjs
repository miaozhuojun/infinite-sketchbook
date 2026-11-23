// 说东西变了，画面上的它要跟着变（scene.change，编译时查；纯静态，不看几何）。
// 出处：e03-coldest 成片说「把光变弱」「光就要变弱」（2:00、2:23–2:34），画面上两束激光和碗底的光点一笔没变，
// 只把碗沿划掉、写了「光变弱」三个字；E08 样片 v1 讲灯的亮暗时画面上没有灯（scene.lamp 只管「说到灯时取景里有没有灯」）。同一类第二次，做成关卡。
// 认法：
//   1. 旁白里每个「变了」的词（风格规范 narrative.<kind>.changeWords，如 变弱、变暗、关掉、灭了、没了），前面是「没、不、没有、不会」的跳过（「没变小」）；
//   2. 往前看这个词前面几个字（最多 4 个字；原样看一遍，再把结尾的「就要、还真、了」这类虚字一个个去掉各看一遍，取对上最多的），
//      在这一句以前画过的元素的名字里找，对上最长的那个就是被说变了的东西。只对上一个字时，那个字要在名字里自成一个词
//      （「光做的碗」里的「光」算，「温度」里的「度」、「旅行者1号」里的「1」不算）。
//      元素的名字：分镜里写的 is（「这一笔画的是什么」）、文字写的字、挂在（on）它身上的文字标签、按组件认的名字（changeNames，如灯泡叫「灯」），
//      复用件（copyOf）连原元素的名字一起算。连着两个词（「变弱弱到零」）后一个沿用前一个的东西；
//   3. 认出来了：这一句要有一个动作落在它身上——target 指它（划掉、回描、圈出、熄灭），不是文字的笔画 on 挂在它身上，
//      或者新画一个不是文字的元素、is（或按组件认的名字）就是它（变化后的样子）。只写字不算：e03 写了「光变弱」三个字，光还是没变；
//      对上的元素里有画出来的（不是文字），就要落在画出来的那几笔上，圈出它的标签不算；
//   4. 认不出（画面上没有叫这个名字的东西）：退一步，这一句至少要画点什么（动作、回看、全景都算），一笔不画就报。
// 豁免：说的是别处的变化（「拧大扣分变少就往大拧」这种规则、比方），分镜那句写 noChange: "为什么"。
import { strip } from './validate.mjs';

// 「变」字前面、不是东西的那些字（副词、助词、把字句）：从后往前一个个去掉，剩下的结尾才是东西
const TAIL = /(自己|就要|就会|还真|已经|一下子|一下|慢慢|渐渐|突然|马上|跟着|都|就|要|会|也|又|再|能|还|真|全|得|地|了|是|把|让|将|给|被|可|才|却)$/;
const NEG = /(没有|[没不别未非无])$/;
const HAN = /\p{Script=Han}/u;
const clean = (s) => strip(s).replace(/[…「」『』《》〈〉～·]/g, ''); // strip 留着的引号、省略号、书名号
const list = (v) => [].concat(v ?? []).filter((x) => typeof x === 'string' && x.trim());
const SEG = new Intl.Segmenter('zh', { granularity: 'word' });
const segCache = new Map();
const wordsOf = (n) => { if (!segCache.has(n)) segCache.set(n, new Set([...SEG.segment(n)].map((g) => g.segment))); return segCache.get(n); };
// 名字 n 和词前面那几个字 w 对上了几个字：w 结尾最长的一段被 n 包含；只对上一个字时，它要等于 n，或是汉字、在 n 里自成一个词
const score1 = (n, w) => {
  for (let L = w.length; L >= 2; L--) if (n.includes(w.slice(-L))) return L;
  const c = w.slice(-1);
  return c && (n === c || (HAN.test(c) && wordsOf(n).has(c))) ? 1 : 0;
};
const score = (ns, w) => Math.max(0, ...ns.map((n) => score1(n, w)));

// phrases：编译合并过的句子（每句 { text, actions, noChange?, revisit?, camera? }）；words：changeWords（正则源码）；names：{ 组件类型: [名字…] }。
// 返回 [{ pi, miss: [{ word, s?, ids?, onlyText? }] }]：pi 句里说变了的东西没跟着变（s 是认出来的东西，没认出来就没有 s）
export function changeIssues(phrases, { words, names }) {
  const RE = new RegExp(words, 'g'), byType = names ?? {};
  const phraseOf = new Map(), all = [];
  phrases.forEach((p, pi) => (p.actions ?? []).forEach((a) => { phraseOf.set(a.id, pi); all.push(a); }));
  const byId = new Map(all.map((a) => [a.id, a]));
  const labels = new Map(); // 文字标签挂在（on）谁身上，它的字就是谁的名字
  for (const a of all) if (a.type === 'text' && a.on && typeof a.text === 'string') labels.set(a.on, [...(labels.get(a.on) ?? []), a.text]);
  const own = (a) => [...list(a.is), ...list(byType[a.type])].map(clean).filter(Boolean); // 元素自己声明的名字（不含它写的字）
  const nameCache = new Map();
  const nameOf = (a, seen = new Set()) => {
    if (nameCache.has(a.id)) return nameCache.get(a.id);
    seen.add(a.id);
    const src = a.copyOf && !seen.has(a.copyOf) ? byId.get(a.copyOf) : null; // 复用件是同一样东西
    const ns = [...new Set([...own(a), ...list([a.text, a.label]).map(clean), ...(labels.get(a.id) ?? []).map(clean), ...(src ? nameOf(src, seen) : [])].filter(Boolean))];
    nameCache.set(a.id, ns);
    return ns;
  };
  const out = [];
  phrases.forEach((p, pi) => {
    if (p.noChange) return;
    const t = clean(p.text ?? ''), acts = p.actions ?? [];
    const before = all.filter((a) => phraseOf.get(a.id) < pi);
    const miss = [];
    let last = 0, prev = null;
    for (const m of t.matchAll(RE)) {
      if (!m[0]) continue; // 词表写成能匹配空串的样子（「变弱|」）
      let w = t.slice(last, m.index), pre = t.slice(0, m.index);
      last = m.index + m[0].length;
      const stages = [w.slice(-4)];
      while (TAIL.test(w)) { w = w.replace(TAIL, ''); stages.push(w.slice(-4)); }
      while (TAIL.test(pre)) pre = pre.replace(TAIL, '');
      if (NEG.test(t.slice(0, m.index)) || NEG.test(pre)) continue; // 没变小、光不会变暗、光没有变弱
      let sub = prev;
      if (stages.some(Boolean)) {
        sub = null;
        for (const st of stages.filter(Boolean)) { // 对上一样多时取去掉虚字以后的
          const sc = before.map((a) => [a, score(nameOf(a), st)]), best = Math.max(0, ...sc.map((x) => x[1]));
          // 还带着虚字的那一遍，对上的要比结尾的虚字长（「动能」的「能」算名字的一部分；「冷下来是」只对上一个「是」不算）
          if (best > (st.match(TAIL)?.[0].length ?? 0) && best >= (sub?.n ?? 0)) sub = { n: best, s: st.slice(-best), T: sc.filter((x) => x[1] === best).map((x) => x[0]) };
        }
      }
      prev = sub;
      if (!sub) {
        if (!acts.length && !(p.revisit ?? []).length && p.camera !== 'overview') miss.push({ word: m[0] });
        continue;
      }
      const drawn = sub.T.filter((a) => a.type !== 'text'), T = new Set((drawn.length ? drawn : sub.T).map((a) => a.id));
      const changed = acts.some((a) => list(a.target).some((x) => T.has(x))
        || (a.type !== 'text' && (T.has(a.on) || own(a).some((n) => n.includes(sub.s) || sub.s.endsWith(n))))); // is 是作者写明的，「风」也算「信风」
      if (!changed) miss.push({ word: m[0], s: sub.s, ids: sub.T.map((a) => a.id), onlyText: !drawn.length });
    }
    if (miss.length) out.push({ pi, miss });
  });
  return out;
}
