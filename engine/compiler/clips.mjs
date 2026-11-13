// 贴视频（clip）用的片子：放在 public/clips/（不进仓库：媒体文件一律不进），编译时读出画面尺寸、时长和内容指纹（SHA-256），写进时间线。
// 片子不像贴图那样嵌进时间线（一段几 MB 到几十 MB），按文件名引用；分段渲染、静帧各自起一个空的 public 目录，
// 渲染前用 linkClips 把用到的片子链接进去，顺便核对指纹：编译后换过片子就报错，不让分段缓存拿旧指纹复用旧画面。
// 出处（facts 里 media 写这个文件名的那一条）也在这里查：贴的东西只用自己做的、公有领域的、许可写明可以改编和商用的。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIP_DIR = path.join(ENGINE, 'public', 'clips');
const EXT = ['.mp4', '.mov', '.m4v'];

// ---------- 读 MP4/MOV 的盒子（ISO BMFF）：只读头，不解码 ----------
// 顶层盒子按偏移跳着读（moov 可能在几百 MB 的 mdat 后面），只把 moov 整个读进来
function readMoov(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, head = Buffer.alloc(16);
    for (let off = 0; off + 8 <= size;) {
      fs.readSync(fd, head, 0, 16, off);
      let len = head.readUInt32BE(0), hdr = 8;
      const type = head.toString('latin1', 4, 8);
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - off;
      if (len < hdr) break;
      if (type === 'moov') { const buf = Buffer.alloc(len - hdr); fs.readSync(fd, buf, 0, buf.length, off + hdr); return buf; }
      off += len;
    }
  } finally { fs.closeSync(fd); }
  return null;
}
// 一层里的子盒子：[{ type, body }]
function boxes(buf) {
  const out = [];
  for (let off = 0; off + 8 <= buf.length;) {
    let len = buf.readUInt32BE(off), hdr = 8;
    if (len === 1) { len = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; } else if (len === 0) len = buf.length - off;
    if (len < hdr || off + len > buf.length) break;
    out.push({ type: buf.toString('latin1', off + 4, off + 8), body: buf.subarray(off + hdr, off + len) });
    off += len;
  }
  return out;
}
const child = (buf, type) => (buf ? boxes(buf).find((b) => b.type === type)?.body : undefined);

// 片子的画面宽高（按 tkhd 的旋转矩阵转过来：手机竖拍的片子存的是横的）、时长和编码。
// 时长取视频轨的 mdhd；有编辑列表（elst：ffmpeg -c copy 剪过的、手机相册里剪过的）就取它播出来的长度，两者取短的（PR #71 审查）
export function clipInfo(file) {
  const moov = readMoov(file);
  if (!moov) throw new Error('找不到 moov（不是 MP4/MOV，或者文件不完整）');
  const mvhd = child(moov, 'mvhd'), mts = mvhd ? (mvhd[0] === 1 ? mvhd.readUInt32BE(20) : mvhd.readUInt32BE(12)) : 0;
  const edited = (trak) => { // 编辑列表的总长（秒，按 mvhd 的时间单位）；没有就是 null
    const elst = child(child(trak, 'edts'), 'elst');
    if (!elst || !(mts > 0) || elst.length < 8) return null;
    const v1 = elst[0] === 1, n = elst.readUInt32BE(4), size = v1 ? 20 : 12;
    let sum = 0;
    for (let i = 0, o = 8; i < n && o + size <= elst.length; i++, o += size) sum += v1 ? Number(elst.readBigUInt64BE(o)) : elst.readUInt32BE(o);
    return sum > 0 ? sum / mts : null;
  };
  for (const trak of boxes(moov).filter((b) => b.type === 'trak').map((b) => b.body)) {
    const mdia = child(trak, 'mdia'), hdlr = child(mdia, 'hdlr');
    if (!hdlr || hdlr.toString('latin1', 8, 12) !== 'vide') continue;
    const tkhd = child(trak, 'tkhd'), mdhd = child(mdia, 'mdhd');
    if (!tkhd || !mdhd) throw new Error('视频轨缺 tkhd 或 mdhd');
    const m = tkhd[0] === 1 ? 52 : 40; // 矩阵在 tkhd 里的偏移（version 1 的时间字段是 64 位）
    const a = tkhd.readInt32BE(m) / 65536, b = tkhd.readInt32BE(m + 4) / 65536;
    const w0 = tkhd.readUInt32BE(m + 36) / 65536, h0 = tkhd.readUInt32BE(m + 40) / 65536;
    const turned = Math.abs(a) < 0.5 && Math.abs(b) > 0.5; // 转了 90° 或 270°
    const v1 = mdhd[0] === 1, scale = v1 ? mdhd.readUInt32BE(20) : mdhd.readUInt32BE(12), dur = v1 ? Number(mdhd.readBigUInt64BE(24)) : mdhd.readUInt32BE(16);
    const stsd = child(child(child(mdia, 'minf'), 'stbl'), 'stsd');
    const codec = stsd && stsd.length >= 16 ? stsd.toString('latin1', 12, 16) : '?';
    if (!(w0 > 0 && h0 > 0)) throw new Error('视频轨没有画面尺寸');
    if (!(scale > 0 && dur > 0)) throw new Error('读不出时长（分片 MP4？先转成普通 MP4：ffmpeg -i 原片 -c copy -movflags +faststart 新片.mp4）');
    const ed = edited(trak);
    return { w: turned ? h0 : w0, h: turned ? w0 : h0, duration: ed ? Math.min(ed, dur / scale) : dur / scale, codec };
  }
  throw new Error('没有视频轨');
}

const sha256 = (file) => {
  const h = createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
};

// 读一段片子：{ src（相对 public/，渲染时 staticFile 用）, w, h（像素）, duration（秒）, codec, sha（SHA-256）}。
// 找不到、读不出就抛错，错误里写明放哪儿
const cache = new Map();
export function loadClip(src) {
  if (typeof src !== 'string' || !src || src.includes('..') || path.isAbsolute(src)) throw new Error(`src 写 public/clips/ 下的文件名（「${src}」）`);
  const file = path.join(CLIP_DIR, src), ext = path.extname(src).toLowerCase();
  if (!EXT.includes(ext)) throw new Error(`「${src}」：只支持 ${EXT.join(' ')}（别的格式先转成 MP4）`);
  if (!fs.existsSync(file)) throw new Error(`找不到 public/clips/${src}（片子拷进这个目录，它不进仓库）`);
  const st = fs.statSync(file), key = `${src}\u0000${st.size}\u0000${st.mtimeMs}`;
  if (!cache.has(key)) {
    let info;
    try { info = clipInfo(file); } catch (e) { throw new Error(`public/clips/${src}：${e.message}`); }
    cache.set(key, { src: `clips/${src}`, ...info, sha: sha256(file) });
  }
  return cache.get(key);
}

// 分段渲染、静帧打包好的 bundle/public：把时间线用到的片子放进去（硬链接，不占地方；跨磁盘才拷贝），并核对内容没在编译后换过。
// 不用符号链接：Remotion 的文件服务按真实路径找文件，链接到 bundle 外面的一律 404
export function linkClips(tl, publicDir) {
  for (const k of tl.clips ?? []) {
    const real = path.join(ENGINE, 'public', k.src), dest = path.join(publicDir, k.src);
    if (!fs.existsSync(real)) throw new Error(`贴视频 ${k.id}：找不到 public/${k.src}`);
    if (sha256(real) !== k.sha) throw new Error(`贴视频 ${k.id}：public/${k.src} 在编译之后换过了，重新编译再渲染`);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.linkSync(real, dest); } catch { fs.copyFileSync(real, dest); }
  }
}

// ---------- 出处：贴在纸上的东西（贴视频，和不是封面的贴图）都要在 facts 里有一条 media 写它的文件名 ----------
// license 只收这几种：own（自己拍的、自己做的、程序生成的）、public-domain（公有领域）、CC0-1.0，和允许改编、允许商用、只要求署名的 CC BY。
// 带 NC（不许商用：作品要在四个平台发）、ND（不许改编：要裁、调色、歪着贴）的不收；SA（相同方式共享）也不收：
// 裁剪调色以后是改编，改编的部分要按 CC BY-SA 放出去，和作品保留所有权利冲突
export const MEDIA_LICENSES = ['own', 'public-domain', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0', 'CC-BY-2.5', 'CC-BY-2.0', 'CC-BY-1.0'];
export const mediaOf = (f) => (Array.isArray(f?.media) ? f.media : typeof f?.media === 'string' ? [f.media] : []);
// 这条 media 出处缺了什么：返回 [字段, 说明] 的列表（空列表就是齐了）。source（存证）在不在由分镜校验按项目路径另查
export function mediaFactIssues(f) {
  const out = [], lic = f.license;
  if (!MEDIA_LICENSES.includes(lic)) out.push(['license', `「${lic ?? ''}」不收：只用 ${MEDIA_LICENSES.join('、')}（带 NC、ND、SA 的不行：要发四个平台、要裁剪调色，作品保留所有权利）`]);
  if (typeof f.origin !== 'string' || !f.origin.trim()) out.push(['origin', lic === 'own' ? '写怎么做的（哪天拍的什么、哪个脚本生成的）' : '写原始页面的网址']);
  else if (lic !== 'own' && !/^https?:\/\/\S+$/.test(f.origin.trim())) out.push(['origin', '不是自己做的，写原始页面的网址（http 开头）']);
  if (lic && lic !== 'own') {
    if (!f.source) out.push(['source', '存证：把原始页面（看得到作者和许可的那一页）存成 PDF 或 HTML 放进项目，写它的路径（「文件#锚点」，锚点可省）']);
    const cite = (Array.isArray(f.cite) ? f.cite : f.cite ? [f.cite] : []).join(' ');
    if (!cite) out.push(['cite', '写片尾资料卡上的署名（作者、出处、许可）']);
    if (/^CC-BY/.test(lic)) {
      if (typeof f.author !== 'string' || !f.author.trim()) out.push(['author', `${lic} 要署名：写作者`]);
      else if (cite && (!cite.includes(f.author.trim()) || !/CC[\s-]?BY/i.test(cite))) out.push(['cite', `${lic} 要署名：cite 里写上作者「${f.author.trim()}」和许可（如 CC BY 4.0）`]);
    }
  }
  return out;
}
