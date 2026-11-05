// 渲染用哪种 OpenGL：本机是 Mac 时用 GPU（angle）——E01 900 帧 18s 对默认 28s、软件渲染（swangle）438s；
// 画面和默认逐像素差异只在铅笔颗粒纹理上（PSNR 42dB），同一帧两次渲染完全一致。别的系统（CI 没有 GPU）用 Remotion 默认
export const GL = process.platform === 'darwin' ? 'angle' : null;
