// 贴图（sticker）用的图：放在 public/stickers/（不进仓库：被依赖那一集的封面是私有作品），编译时读出来、嵌进时间线（data URI）。
// 嵌进去而不是按文件名引用：分段渲染、静帧各自起一个空的 public 目录（render/segmented.mjs、qa/stills.mjs），图要跟着时间线走；
// 图换了，时间线跟着变，分段渲染的指纹也就变了。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STICKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'stickers');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

// 图的像素宽高（只读文件头，不解码）：PNG 的 IHDR、JPEG 的 SOF 段、SVG 的 width/height 或 viewBox
export function imageSize(buf, ext) {
  if (ext === '.png') {
    if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('不是 PNG');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG');
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    throw new Error('JPEG 里找不到尺寸');
  }
  if (ext === '.svg') {
    const s = buf.toString('utf8'), num = (k) => Number((s.match(new RegExp(`<svg[^>]*\\s${k}="([\\d.]+)`)) || [])[1]);
    const vb = (s.match(/viewBox="([^"]+)"/) || [])[1]?.trim().split(/[\s,]+/).map(Number);
    const w = num('width') || vb?.[2], h = num('height') || vb?.[3];
    if (!(w > 0 && h > 0)) throw new Error('SVG 要写 width/height 或 viewBox');
    return { w, h };
  }
  throw new Error(`只支持 ${Object.keys(MIME).join(' ')}`);
}

// 读一张贴图：{ href（data URI）, w, h（像素）}。找不到、读不出尺寸就抛错，错误里写明放哪儿
const cache = new Map();
export function loadSticker(src) {
  if (cache.has(src)) return cache.get(src);
  if (typeof src !== 'string' || !src || src.includes('..') || path.isAbsolute(src)) throw new Error(`src 写 public/stickers/ 下的文件名（「${src}」）`);
  const file = path.join(STICKER_DIR, src), ext = path.extname(src).toLowerCase();
  if (!MIME[ext]) throw new Error(`「${src}」：只支持 ${Object.keys(MIME).join(' ')}`);
  if (!fs.existsSync(file)) throw new Error(`找不到 public/stickers/${src}（被依赖那一集的封面拷进这个目录，它不进仓库）`);
  const buf = fs.readFileSync(file), size = imageSize(buf, ext);
  const out = { href: `data:${MIME[ext]};base64,${buf.toString('base64')}`, ...size };
  cache.set(src, out);
  return out;
}
