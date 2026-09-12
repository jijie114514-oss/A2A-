import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { StarHall } from './app.js';

/** 参数解析：支持 `--base <URL>` / `--token <token>` / `--actor <角色>`，其余按原位置参数处理。
 *  云端部署没有本地 data/ 目录，CLI 通过 --base 直接打公网地址；本地模式行为不变。 */
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length;) {
  if (['--base', '--token', '--actor'].includes(argv[i]) && argv[i + 1]) { flags[argv[i].slice(2)] = argv[i + 1]; argv.splice(i, 2); } else i++;
}
const [command = 'help', ...args] = argv;
const settings = config();
const remoteBase = (flags.base || process.env.STARHALL_BASE_URL || '').replace(/\/+$/, '');
const remoteToken = flags.token || process.env.STARHALL_TOKEN || '';
const usage = '云端用法：npm run cli -- summary --base https://<app>.vercel.app；带身份：--base <URL> --token <token>。';

let baseUrl = remoteBase || `http://${settings.host === '::1' ? '[::1]' : settings.host}:${settings.port}`;
try {
  const parsed = new URL(baseUrl);
  if (!remoteBase && (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('本地入口只允许 http://127.0.0.1');
  if (remoteBase && parsed.protocol !== 'https:') throw new Error('云端入口需要 https://');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('入口地址不能含凭据、路径、查询或片段');
  if (command === 'init') {
    if (remoteBase) throw new Error('init 只能用于本地账本；云端初始化请用 scripts/seed-cloud.js');
    const app = await StarHall.open(settings);
    console.log(`本地数据已初始化：${settings.dataDir}\n凭据：${path.join(settings.dataDir, 'credentials.json')}\n3个模拟顾客，各100分；经纪人独立身份。再次初始化不会重置余额。`);
    await app.close();
  } else if (command === 'help') {
    console.log('商业入口：npm run cli -- market-board\n经纪人展示：npm run cli -- demo-market\n自己的商业档案：npm run cli -- commercial-profile [fan-orion]\n明星赞助：npm run cli -- buy star-sponsorship examples/star-sponsorship.json [fan-orion] [幂等键]');
    console.log('免费试用：npm run cli -- trial poem examples/poem.json [fan-orion] [幂等键]\n恢复试用：npm run cli -- trial-by-key <原键> [fan-orion]\n恢复购买：npm run cli -- order-by-key <原键> [fan-orion]');
    console.log(`StarHall CLI（本地先 npm start；云端加 --base <公网URL>）\n  npm run cli -- catalog\n  npm run cli -- summary\n  npm run cli -- wallet [fan-orion]\n  npm run cli -- buy poem examples/poem.json [fan-orion] [幂等键]\n  npm run cli -- orders [fan-orion]\n  npm run cli -- order <订单ID> [fan-orion]\n  npm run cli -- refund <订单ID> [fan-orion] [原因] ← 机器仲裁退款（客观失败/约束违反自动退）\n  npm run cli -- revision <订单ID> [fan-orion] [修订要求] ← 一次免费修订\n  npm run cli -- wall [fan-orion]\n  npm run cli -- demo\n  npm run cli -- request examples/escalation.json [fan-orion]\n  npm run cli -- practice <会话ID> examples/practice.json [fan-orion] [幂等键]\n${usage}\n文件格式及 HTTP 接口见 docs/API.md。`);
  } else {
    let route, method = 'GET', body, actor = flags.actor || 'fan-orion', key;
    if (['catalog', 'summary', 'market-board'].includes(command)) route = `/v1/${command}`;
    else if (command === 'demo-market') { route = '/v1/market-board'; actor = flags.actor || 'broker'; }
    else if (['wallet', 'wall', 'orders', 'ads', 'commercial-profile'].includes(command)) { route = `/v1/${command}`; actor = args[0] || actor; }
    else if (command === 'order') { route = `/v1/orders/${encodeURIComponent(args[0])}`; actor = args[1] || actor; }
    else if (command === 'refund') { route = `/v1/orders/${encodeURIComponent(args[0])}/refund`; method = 'POST'; actor = args[1] || actor; body = args[2] ? { reason: args[2] } : {}; }
    else if (command === 'revision') { route = `/v1/orders/${encodeURIComponent(args[0])}/revision`; method = 'POST'; actor = args[1] || actor; body = args[2] ? { notes: args[2] } : {}; key = args[3] || randomUUID(); }
    else if (['order-by-key', 'trial-by-key'].includes(command)) { route = command === 'trial-by-key' ? '/v1/trials/by-key' : '/v1/orders/by-key'; key = args[0]; actor = args[1] || actor; }
    else if (['buy', 'trial'].includes(command)) { route = command === 'trial' ? '/v1/trials' : '/v1/orders'; method = 'POST'; body = { service: args[0], ...JSON.parse(await readFile(path.resolve(args[1]), 'utf8')) }; actor = args[2] || actor; key = args[3] || randomUUID(); }
    else if (command === 'demo') { route = '/v1/demo'; method = 'POST'; actor = flags.actor || 'broker'; body = { input: { theme: '竞技场开幕', recipient: '所有参赛队伍' } }; }
    else if (command === 'request') { route = '/v1/requests'; method = 'POST'; body = JSON.parse(await readFile(path.resolve(args[0]), 'utf8')); actor = args[1] || actor; }
    else if (command === 'practice') { route = `/v1/practice/${encodeURIComponent(args[0])}/turns`; method = 'POST'; body = JSON.parse(await readFile(path.resolve(args[1]), 'utf8')); actor = args[2] || actor; key = args[3] || randomUUID(); }
    else throw new Error('未知命令，使用 npm run cli -- help');
    const headers = { 'content-type': 'application/json' };
    const publicRoute = ['catalog', 'summary', 'market-board'].includes(command);
    if (!publicRoute) {
      if (remoteBase) {
        if (!remoteToken) throw new Error(`云端身份调用需要 token：${usage}`);
        headers.authorization = `Bearer ${remoteToken}`;
      } else {
        if (!settings.dataDir) throw new Error(`当前 STARHALL_STORE=${settings.store} 没有本地凭据文件；请用 --base 指向云端地址，或改用 file 驱动。`);
        const credentials = JSON.parse(await readFile(path.join(settings.dataDir, 'credentials.json'), 'utf8'));
        const account = credentials.accounts.find(a => a.id === actor);
        if (!account) throw new Error('本地身份不存在'); headers.authorization = `Bearer ${account.token}`;
      }
    }
    if (key) { headers['idempotency-key'] = key; console.error(`Idempotency-Key: ${key}（重试请复用）`); }
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok || result.status === 'failed') process.exitCode = 1;
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
