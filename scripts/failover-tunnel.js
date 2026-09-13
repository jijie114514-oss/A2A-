/**
 * 应急兜底：把「常驻进程」这条路一键跑起来（借鉴 ZAAT 那种 always-on 本机服务的形态）。
 *
 *   node scripts/failover-tunnel.js            # Postgres（与线上同一账本）
 *   node scripts/failover-tunnel.js --file     # 本地文件账本（完全离线也能接单）
 *
 * 为什么需要：我们的主路线是 Vercel + Neon（serverless，会冷启动、依赖平台）。
 * 万一平台侧当晚出故障，这个脚本能在 ~60 秒内把同一个产品挂到一个公网 HTTPS 地址上：
 *   1) 起 cloudflared 快速隧道，拿到 https://xxx.trycloudflare.com
 *   2) 用「隧道域名」作为白名单与对外地址起本机服务（同一个 app，同一个内核，同一个账本）
 *   3) 打印对外地址与健康检查结果，Ctrl+C 一起退出
 *
 * 注意：① 机器不能休眠（配合 caffeinate -i）；② 快速隧道域名每次重启会变；
 * ③ 只有确认主站不可用时才切过去，并把新地址发到房间与提交材料里。
 */
import { spawn } from 'node:child_process';

const useFile = process.argv.includes('--file');
const port = process.env.STARHALL_PORT || '4317';

const run = (cmd, argv, { capture = false } = {}) => spawn(cmd, argv, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: process.env });

console.log('① 启动 cloudflared 快速隧道…');
const tunnel = run('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${port}`], { capture: true });
let url = null;
const onChunk = chunk => {
  const text = String(chunk);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !url) {
    url = match[0];
    console.log(`   隧道地址：${url}`);
    startServer(url);
  }
  if (process.env.STARHALL_FAILOVER_VERBOSE) process.stdout.write(text);
};
tunnel.stdout.on('data', onChunk);
tunnel.stderr.on('data', onChunk);
tunnel.on('exit', code => { console.error(`cloudflared 退出（code=${code}）`); process.exit(code ?? 1); });

const started = [];
function startServer(publicUrl) {
  const host = new URL(publicUrl).host;
  console.log('② 用隧道域名白名单启动本机服务…');
  const env = {
    ...process.env,
    STARHALL_MODE: 'cloud',
    STARHALL_STORE: useFile ? 'file' : 'postgres',
    STARHALL_HOST: '127.0.0.1',
    STARHALL_PORT: port,
    STARHALL_ALLOWED_HOSTS: host,
    STARHALL_PUBLIC_BASE_URL: publicUrl,
    STARHALL_OPEN_REGISTRATION: process.env.STARHALL_OPEN_REGISTRATION || 'true',
  };
  const server = spawn('node', ['--env-file-if-exists=.env', 'src/server.js'], { stdio: 'inherit', env });
  started.push(server);
  // 快速隧道的域名**不是立刻可解析**：DNS 记录与各解析器的负缓存会拖到几分钟。
  // 实测（2026-09-13，香港移动网络）：隧道起来 20 秒内 curl 报 Could not resolve host，
  // 三分钟后同一域名可从本机解析；而本机对 1.1.1.1/8.8.8.8 的 DNS 查询被网络挡掉，
  // 所以这里只能按本机解析器重试，并且必须把结论说清楚：可达性要在目标网络里再验一次。
  const attempts = Number(process.env.STARHALL_FAILOVER_ATTEMPTS || 12);
  (async () => {
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await fetch(`${publicUrl}/readiness`, { headers: { accept: 'application/json' } });
        const body = await r.json();
        console.log(`③ 外部可达自检：第 ${i} 次尝试成功 http=${r.status} ready=${body.ready} state=${body.state}`);
        console.log(`\n对外地址（立刻用它替换房间/提交里的地址）：${publicUrl}`);
        console.log(`账本：${useFile ? '本机 data/（与线上不同）' : 'Neon（与线上同一份）'}；Ctrl+C 一起停止。`);
        console.log('⚠️ 切换前请在**对方网络**里再 curl 一次本地址：快速隧道域名依赖 DNS 传播，本机可达不代表其他机器立刻可达。');
        return;
      } catch (error) {
        const waited = i * 10;
        console.log(`③ 第 ${i}/${attempts} 次不可达（${error.message}）；等 10 秒重试…（累计 ${waited}s）`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
    console.error(`③ ${attempts} 次都没能从这个网络确认可达（多半是 DNS 解析被本地网络拖住）。`);
    console.error(`   请在任何一台能上网的机器上执行： curl -s ${publicUrl}/readiness`);
    console.error('   若长期不可达，改用文档里的 Docker/Fly 常驻方案（同一份 Neon 账本）。');
  })();
}

const stop = () => { tunnel.kill('SIGTERM'); for (const s of started) s.kill('SIGTERM'); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
