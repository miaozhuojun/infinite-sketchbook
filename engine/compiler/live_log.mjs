// 跑一个要很久的子进程（配音一跑几十分钟到几小时），完整输出边跑边写进日志文件：跑的时候 tail -f 就能看到每句试了几个种子、卡在哪儿。
// 每一整行交给 onLine（流水线用它把「[卡句]」当场打在终端上），结束后给出全部输出和退出码，照旧交给流水线的 record() 解析。
// 原来配音用 spawnSync，跑完才有输出，报告只留最后 1500 个字（e02-voyager 主讲配音 2 小时 29 分后失败，看不出别的句子试了多少个种子）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const quote = (a) => (/^[\w./=:@,+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

/** append：接着上一次的日志往下写（流水线自动换种子重配的第二、三轮），否则从头写。header：先写一行说明 */
export function runLogged(cmd, args, { cwd, env, log, append = false, header = '', onLine = () => {} } = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, append ? 'a' : 'w');
  const t0 = Date.now();
  // 直接写进文件（不经缓冲），另一个终端 tail -f 马上看得到
  const write = (s) => fs.writeSync(fd, s);
  write(`${header ? `${header}\n` : ''}# ${new Date(t0).toLocaleString('zh-CN', { hour12: false })}　${[cmd, ...args].map(quote).join(' ')}${cwd ? `　（在 ${path.resolve(cwd)}）` : ''}\n`);
  return new Promise((resolve) => {
    // PYTHONUNBUFFERED：Python 输出接到管道时默认攒满 8KB 才写一次，日志半天不动
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', ...env } });
    let out = '';
    const rest = { stdout: '', stderr: '' };
    // 只把整行写进日志和 out：Python 一个 print 分两次写（正文、换行），stdout 和 stderr 同时在写时，按块拼会把另一路的半行插进来，
    // 「[错误]」不在行首，流水线的 record() 就漏了这条待改（PR #93 审查压测：两路同时写，1.6% 的行串了）
    const emit = (l) => { out += l; write(l); };
    const take = (which) => (s) => {
      const lines = (rest[which] + s).split('\n');
      rest[which] = lines.pop();
      for (const l of lines) { emit(`${l}\n`); onLine(l); }
    };
    // 按流各自解码、各自断行：一个汉字的几个字节可能分在两块里，stdout 和 stderr 的半行也不能拼在一起
    ch.stdout.setEncoding('utf8').on('data', take('stdout'));
    ch.stderr.setEncoding('utf8').on('data', take('stderr'));
    ch.on('error', (e) => emit(`${e}\n`));
    ch.on('close', (code, signal) => {
      for (const k of ['stdout', 'stderr']) if (rest[k]) { emit(`${rest[k]}\n`); onLine(rest[k]); } // 最后没换行的半行
      write(`\n# 退出码 ${code ?? signal}，${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      fs.closeSync(fd);
      resolve({ status: code, out });
    });
  });
}
