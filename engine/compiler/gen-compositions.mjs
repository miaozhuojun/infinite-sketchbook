// 扫描 build/ 下的时间线，生成 Remotion 的成片注册表（不再手改 Root.tsx）。以 _ 开头或 -noautofix 的是检查用的临时文件，跳过。
import fs from 'node:fs';

const files = fs.readdirSync('build').filter((f) => f.endsWith('.timeline.json') && !f.startsWith('_') && !f.includes('-noautofix')).sort();
const lines = ["// 自动生成：node compiler/gen-compositions.mjs。不要手改。", "import type { Timeline } from '../src/timeline';"];
files.forEach((f, i) => lines.push(`import t${i} from './${f}';`));
lines.push(`export const timelines = [${files.map((_, i) => `t${i}`).join(', ')}] as unknown as Timeline[];`, '');
fs.writeFileSync('build/compositions.generated.ts', lines.join('\n'));
console.log(`成片注册表：${files.length} 条（${files.map((f) => f.replace('.timeline.json', '')).join('、')}）`);
