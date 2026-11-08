// 对话：一集里不止一个人说话（锟仔讲、爸爸问）。分镜里说话的人写在句子的 speaker 上，
// 每个说话的人在 narration.voices 里登记音色配置、名字和字幕颜色；没写 speaker 的句子是主讲（tts/voice.json）。
//   "narration": { "voices": { "dad": { "voice": "ref/dad/voice.dad.json", "label": "爸爸", "caption": "subtitleAlt" } } }
//   "phrases": [ { "text": "多大的计算机", "caption": "多大的计算机？", "speaker": "dad", ... } ]
// 配音按人分开配（各用各的音色配置），再按旁白稿的顺序拼回一条；旁白检查按人分开查；字幕按人换颜色。
// 配音是按句（句号、问号、叹号）生成的，所以换人只能在句末：这里把旁白稿的每一句对到分镜的句子上，查出一句话两个人说的地方。
export const SENTENCE = /[^。？！]+[。？！]?/g;
export const stripPunct = (s) => s.replace(/[\s，。；：！？、,.;:!?"“”'‘’（）()—-]/g, '');

export const voicesOf = (beats) => beats?.narration?.voices ?? {};
export const isDialogue = (beats) => Object.keys(voicesOf(beats)).length > 0 && (beats.phrases ?? []).some((p) => p.speaker);

// 旁白稿逐句 → { text, speaker }；speaker 为 '' 是主讲。
// 对不上（旁白稿和分镜的字不一致）或一句话跨了两个人时，problems 里写明是哪一句
export function sentenceSpeakers(beats) {
  const script = beats?.narration?.script ?? '';
  const sents = (script.match(SENTENCE) ?? []).filter((s) => stripPunct(s));
  const owner = []; // 去标点后的每个字归哪个说话的人
  for (const p of beats.phrases ?? []) for (const _ of stripPunct(p.text ?? '')) owner.push(p.speaker ?? '');
  const total = sents.reduce((n, s) => n + stripPunct(s).length, 0);
  const problems = [];
  if (total !== owner.length) problems.push(`旁白稿去掉标点后 ${total} 个字，分镜各句的 text 合起来 ${owner.length} 个字，对不上：分不出每句是谁说的`);
  let k = 0;
  const out = sents.map((s) => {
    const n = stripPunct(s).length, who = new Set(owner.slice(k, k + n));
    k += n;
    if (who.size > 1) problems.push(`「${s}」一句话里换了说话的人（${[...who].map((w) => w || '主讲').join('、')}）：配音按句生成，换人要在句号、问号或叹号处`);
    return { text: s, speaker: owner[k - n] ?? '' };
  });
  return { sentences: out, problems };
}

// 这一句是不是一段话的开头（上一句是别人说的）：配音时不和上一句连着配、不和上一句比接不接得上
export const turnStarts = (sents) => sents.filter((s, i) => i > 0 && sents[i - 1].speaker !== s.speaker).map((s) => s.text);
