// 两个 Python 环境：PY_QA 跑混音和画面检查（numpy、soundfile、pyloudnorm……），PY_MLX 跑本地配音和旁白检查（mlx-audio，只有 Apple Silicon 上有）。
// 先看环境变量，再看仓库约定的虚拟环境（../.venv-qa、../tts/.venv-mlx）。PY_QA 都没有就用 PATH 里的 python3；PY_MLX 没有时为 null，由调用方跳过并写明。
import fs from 'node:fs';
import path from 'node:path';

const pick = (env, venv) => {
  const p = process.env[env] || (fs.existsSync(venv) ? venv : null);
  return p && p.includes('/') ? path.resolve(p) : p; // 绝对路径：子进程换了工作目录也找得到
};
export const PY_QA = pick('PY_QA', '../.venv-qa/bin/python') ?? 'python3';
export const PY_MLX = pick('PY_MLX', '../tts/.venv-mlx/bin/python');
