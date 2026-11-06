// 试编（不配音）：按这个声音的语速给旁白稿造一份假的逐字时间和一段假的配音（每个字一小段音、标点处静音），
// 编译每个画幅，只看版面、镜头、铅笔这些和配音无关的问题。改完分镜几十秒就知道摆得下摆不下，不用先等十几分钟配音（E02 v6 实测）。
// 时间是估的：「画面落后旁白」「停顿过长」这类建议只作参考，以真配音跑出来的报告为准。
// 用法：node compiler/dry_layout.mjs data/<id>.beats.json [--rate 4.0] [--keep]（--keep：留下试编的时间线 build/_dry-<id>-<画幅>.timeline.json，查镜头用）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyle } from './validate.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ENGINE);
const beatsPath = process.argv[2];
if (!beatsPath) { console.error('用法：node compiler/dry_layout.mjs data/<id>.beats.json [--rate 字每秒]'); process.exit(2); }
const beats = JSON.parse(fs.readFileSync(beatsPath, 'utf8'));
// 语速：命令行 > 配音配置 voice.json 的 rate.target > 每秒 4 个字
const voicePath = path.resolve(ENGINE, '../tts/voice.json');
const rateArg = process.argv.indexOf('--rate');
const rate = rateArg > 0 ? Number(process.argv[rateArg + 1]) : (fs.existsSync(voicePath) ? JSON.parse(fs.readFileSync(voicePath, 'utf8')).rate?.target : null) ?? 4.0;
const per = 1 / rate, PAUSE = { '，': 0.35, '、': 0.3, '：': 0.35, '；': 0.4, '。': 0.6, '？': 0.6, '！': 0.6 };

const words = [];
let t = 0.3;
for (const ch of beats.narration.script) {
  if (PAUSE[ch] != null) { t += PAUSE[ch]; continue; }
  if (/\s/.test(ch)) continue;
  words.push({ text: ch, start: +t.toFixed(3), end: +(t + per * 0.85).toFixed(3) });
  t += per;
}
// 假配音：24kHz 单声道 16 位，每个字一段 200Hz 的音，字间和标点处静音（编译按能量找切点）
const SR = 24000, N = Math.ceil((t + 1) * SR), pcm = Buffer.alloc(N * 2);
for (const w of words) for (let i = Math.floor(w.start * SR); i < Math.floor(w.end * SR); i++) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 200 * i) / SR)), i * 2);
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);

const id = `_dry-${beats.id}`, files = [`public/audio/${id}.wav`, `data/${id}.timing.json`, `data/${id}.beats.json`];
fs.writeFileSync(files[0], Buffer.concat([hdr, pcm]));
fs.writeFileSync(files[1], JSON.stringify({ source: '试编用的假时间', text: beats.narration.script, words }));
fs.writeFileSync(files[2], JSON.stringify({ ...beats, id, narration: { ...beats.narration, audio: `audio/${id}.wav`, timing: `${id}.timing.json` } }));
const style = loadStyle(beats), targets = beats.targets ?? style.defaultTargets ?? Object.keys(style.targets);
console.log(`试编 ${beats.id}：按每秒 ${rate} 个字估时间，约 ${Math.round(t)} 秒；画幅 ${targets.join('、')}`);
let bad = 0;
for (const tg of targets) {
  const r = spawnSync('node', ['compiler/compile.mjs', files[2], '--target', tg], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || ''), lines = out.split('\n');
  const i = lines.findIndex((l) => /^问题 \d+ 项/.test(l));
  const probs = i < 0 ? [] : lines.slice(i + 1).filter((l) => /^\s{2}\S/.test(l));
  // 编译过了，再跑只看时间线的成片检查：安全区（切字、压字幕、进平台界面）和铅笔（E02 v6：试编说没问题，真跑时安全区报 30 处切字）
  if (r.status === 0) for (const qa of ['qa/safezone_check.mjs', 'qa/pencil_check.mjs']) {
    const q = spawnSync('node', [qa, `build/${id}-${tg}.timeline.json`], { encoding: 'utf8' });
    for (const l of ((q.stdout || '') + (q.stderr || '')).split('\n').filter((l) => l.startsWith('[失败]'))) probs.push(`  ${l.slice(0, 400)}`);
  }
  bad += r.status !== 0 || probs.length ? 1 : 0;
  console.log(`\n[${tg}] ${r.status === 0 && !probs.length ? '版面、镜头、铅笔没有问题' : `${probs.length || '编译失败'}${probs.length ? ' 项问题' : ''}`}`);
  for (const l of (probs.length ? probs : r.status ? lines.slice(-12) : [])) console.log(l);
}
if (!process.argv.includes('--keep')) for (const f of [...files, `build/${id}.src24k.wav`, ...targets.flatMap((tg) => [`build/${id}-${tg}.timeline.json`, `public/audio/${id}-${tg}.narration.wav`])]) fs.rmSync(f, { force: true });
console.log(bad ? '\n✗ 有要改的版面问题（时间是估的，「落后」「停顿」以真配音为准）' : '\n✓ 试编通过：可以配音、跑流水线了');
process.exit(bad ? 1 : 0);
