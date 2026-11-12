// 引擎要 Node 26（README「快速开始」、CI 都是 26）：src/timeline.ts 靠 Node 自带的类型剥离直接 import。
// 版本低了 Node 只报「Unknown file extension ".ts"」，看不出是版本的事（会话里 shell 被 nvm 换成 Node 16 时实测）。
// 入口（compile、dry_layout、pipeline）第一个 import 这个文件，先把话说清楚。
// 注意：入口自己的静态 import 里不能有 .ts（静态 import 整张图先加载、后执行，.ts 加载失败时这里还没来得及跑），要用 await import()
const NEED = 26;
const major = Number(process.versions.node.split('.')[0]);
if (major < NEED) {
  console.error(`引擎要 Node ${NEED} 以上，现在用的是 ${process.version}（${process.execPath}）。` +
    `\n  换成 Node ${NEED} 再跑：nvm use ${NEED}，或者把装了 Node ${NEED} 的目录放到 PATH 最前面。`);
  process.exit(1);
}
