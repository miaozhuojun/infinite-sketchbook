// 输出路径在比例 p 处的坐标，供 qa.py 复现笔尖位置
import { svgPathProperties } from 'svg-path-properties';

const [d, p] = process.argv.slice(2);
const pr = new svgPathProperties(d);
const q = pr.getPointAtLength(pr.getTotalLength() * Number(p));
console.log(q.x, q.y);
