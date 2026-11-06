// 试编（不配音）：按这个声音的语速给旁白稿造一份假的逐字时间和一段假的配音（每个字一小段音、标点处静音），
// 编译每个画幅，只看版面、镜头、铅笔这些和配音无关的问题。改完分镜几分钟就知道摆得下摆不下，不用先等十几分钟配音（E02 v6 实测）。
// 时间是估的：「画面落后旁白」「停顿过长」这类建议只作参考，以真配音跑出来的报告为准。
// 用法：node compiler/dry_layout.mjs data/<id>.beats.json [--rate 4.0] [--keep]（--keep：留下试编的时间线 build/_dry-<id>-<画幅>.timeline.json，查镜头用）
// 静帧审稿（qa/still_review.mjs）也用它：import { dryLayout } 拿到每个画幅的试编时间线、问题和建议
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyle } from './validate.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAUSE = { '，': 0.35, '、': 0.3, '：': 0.35, '；': 0.4, '。': 0.6, '？': 0.6, '！': 0.6 };

// 语速：参数 > 配音配置 voice.json 的 rate.target > 每秒 4 个字
export function voiceRate(rate) {
  if (rate) return rate;
  const voicePath = path.resolve(ENGINE, '../tts/voice.json');
  return (fs.existsSync(voicePath) ? JSON.parse(fs.readFileSync(voicePath, 'utf8')).rate?.target : null) ?? 4.0;
}

// 按语速估出每个字的开口时间（秒，旁白源音频上的时间；编译会按句切开、插停顿，成片上的时间看时间线 audioClips）
export function fakeWords(script, rate) {
  const per = 1 / rate, words = [];
  let t = 0.3;
  for (const ch of script) {
    if (PAUSE[ch] != null) { t += PAUSE[ch]; continue; }
    if (/\s/.test(ch)) continue;
    words.push({ text: ch, start: +t.toFixed(3), end: +(t + per * 0.85).toFixed(3) });
    t += per;
  }
  return { words, total: t };
}

// 试编一遍：返回 { rate, seconds, words, targets: [{ target, ok, compiled, problems, advice, timeline }] }。
// keep=false 时编完就删掉试编文件（时间线也删）；要用时间线（静帧审稿、查镜头）就传 keep=true，用完自己调 cleanup()
export function dryLayout(beatsPath, { rate, keep = false, targets: only } = {}) {
  const cwd = process.cwd();
  process.chdir(ENGINE);
  try {
    const beats = JSON.parse(fs.readFileSync(path.resolve(cwd, beatsPath), 'utf8'));
    rate = voiceRate(rate);
    const { words, total } = fakeWords(beats.narration.script, rate);
    // 假配音：24kHz 单声道 16 位，每个字一段 200Hz 的音，字间和标点处静音（编译按能量找切点）
    const SR = 24000, N = Math.ceil((total + 1) * SR), pcm = Buffer.alloc(N * 2);
    for (const w of words) for (let i = Math.floor(w.start * SR); i < Math.floor(w.end * SR); i++) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 200 * i) / SR)), i * 2);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);

    const id = `_dry-${beats.id}`, files = [`public/audio/${id}.wav`, `data/${id}.timing.json`, `data/${id}.beats.json`];
    fs.mkdirSync('public/audio', { recursive: true });
    fs.mkdirSync('build', { recursive: true });
    fs.writeFileSync(files[0], Buffer.concat([hdr, pcm]));
    fs.writeFileSync(files[1], JSON.stringify({ source: '试编用的假时间', text: beats.narration.script, words }));
    fs.writeFileSync(files[2], JSON.stringify({ ...beats, id, narration: { ...beats.narration, audio: `audio/${id}.wav`, timing: `${id}.timing.json` } }));
    const style = loadStyle(beats), tgs = only ?? beats.targets ?? style.defaultTargets ?? Object.keys(style.targets);
    const out = [];
    for (const tg of tgs) {
      const r = spawnSync('node', ['compiler/compile.mjs', files[2], '--target', tg], { encoding: 'utf8', maxBuffer: 1 << 28 });
      const text = (r.stdout || '') + (r.stderr || ''), lines = text.split('\n');
      const block = (head) => { const i = lines.findIndex((l) => head.test(l)); if (i < 0) return []; const o = []; for (const l of lines.slice(i + 1)) { if (!/^\s{2}\S/.test(l)) break; o.push(l.trim()); } return o; };
      const problems = block(/^问题 \d+ 项/), advice = block(/^建议 \d+ 项/);
      const timeline = path.join(ENGINE, `build/${id}-${tg}.timeline.json`);
      // 编译过了，再跑只看时间线的成片检查：安全区（切字、压字幕、进平台界面）和铅笔（E02 v6：试编说没问题，真跑时安全区报 30 处切字）
      if (r.status === 0) for (const qa of ['qa/safezone_check.mjs', 'qa/pencil_check.mjs']) {
        const q = spawnSync('node', [qa, timeline], { encoding: 'utf8', maxBuffer: 1 << 28 });
        for (const l of ((q.stdout || '') + (q.stderr || '')).split('\n')) {
          if (l.startsWith('[失败]')) problems.push(l.slice(4, 400).trim());
          else if (l.startsWith('[建议]')) advice.push(l.slice(4, 400).trim());
        }
      }
      out.push({ target: tg, compiled: r.status === 0, ok: r.status === 0 && !problems.length, problems: problems.length || r.status === 0 ? problems : lines.slice(-12), advice, timeline: r.status === 0 ? timeline : null });
    }
    const cleanup = () => { for (const f of [...files, `build/${id}.src24k.wav`, ...tgs.flatMap((tg) => [`build/${id}-${tg}.timeline.json`, `public/audio/${id}-${tg}.narration.wav`])]) fs.rmSync(path.join(ENGINE, f), { force: true }); };
    if (!keep) cleanup();
    return { id: beats.id, rate, seconds: total, words, targets: out, cleanup };
  } finally {
    process.chdir(cwd);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const beatsPath = process.argv[2];
  if (!beatsPath) { console.error('用法：node compiler/dry_layout.mjs data/<id>.beats.json [--rate 字每秒] [--keep]'); process.exit(2); }
  const rateArg = process.argv.indexOf('--rate');
  const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
  const style = loadStyle(beats), tgs = beats.targets ?? style.defaultTargets ?? Object.keys(style.targets);
  const rate = voiceRate(rateArg > 0 ? Number(process.argv[rateArg + 1]) : null);
  console.log(`试编 ${beats.id}：按每秒 ${rate} 个字估时间，约 ${Math.round(fakeWords(beats.narration.script, rate).total)} 秒；画幅 ${tgs.join('、')}`);
  const r = dryLayout(beatsPath, { rate, keep: process.argv.includes('--keep') });
  for (const t of r.targets) {
    console.log(`\n[${t.target}] ${t.ok ? '版面、镜头、铅笔没有问题' : t.compiled ? `${t.problems.length} 项问题` : '编译失败'}`);
    for (const l of t.problems) console.log(`  ${l}`);
  }
  const bad = r.targets.filter((t) => !t.ok).length;
  console.log(bad ? '\n✗ 有要改的版面问题（时间是估的，「落后」「停顿」以真配音为准）' : '\n✓ 试编通过：可以配音、跑流水线了');
  process.exit(bad ? 1 : 0);
}
