import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { StarHall } from './app.js';

const [command = 'help', ...args] = process.argv.slice(2);
const settings = config();
try {
  if (command === 'init') {
    const app = await StarHall.open(settings);
    console.log(`本地数据已初始化：${settings.dataDir}\n凭据：${path.join(settings.dataDir, 'credentials.json')}\n3个模拟顾客，各100分；经纪人独立身份。再次初始化不会重置余额。`);
    await app.close();
  } else if (command === 'help') {
    console.log('商业入口：npm run cli -- market-board\n经纪人展示：npm run cli -- demo-market\n自己的商业档案：npm run cli -- commercial-profile [fan-orion]\n明星赞助：npm run cli -- buy star-sponsorship examples/star-sponsorship.json [fan-orion] [幂等键]');
    console.log('免费试用：npm run cli -- trial poem examples/poem.json [fan-orion] [幂等键]\n恢复试用：npm run cli -- trial-by-key <原键> [fan-orion]\n恢复购买：npm run cli -- order-by-key <原键> [fan-orion]');
    console.log(`StarHall CLI（先 npm start）\n  npm run cli -- catalog\n  npm run cli -- summary\n  npm run cli -- wallet [fan-orion]\n  npm run cli -- buy poem examples/poem.json [fan-orion] [幂等键]\n  npm run cli -- orders [fan-orion]\n  npm run cli -- order <订单ID> [fan-orion]\n  npm run cli -- refund <订单ID> [fan-orion] [原因] ← 机器仲裁退款（客观失败/约束违反自动退）\n  npm run cli -- revision <订单ID> [fan-orion] [修订要求] ← 一次免费修订\n  npm run cli -- wall [fan-orion]\n  npm run cli -- demo\n  npm run cli -- request examples/escalation.json [fan-orion]\n  npm run cli -- practice <会话ID> examples/practice.json [fan-orion] [幂等键]\n文件格式及 HTTP 接口见 docs/API.md。`);
  } else {
    let route, method = 'GET', body, actor = 'fan-orion', key;
    if (['catalog', 'summary', 'market-board'].includes(command)) route = `/v1/${command}`;
    else if (command === 'demo-market') { route = '/v1/market-board'; actor = 'broker'; }
    else if (['wallet', 'wall', 'orders', 'ads', 'commercial-profile'].includes(command)) { route = `/v1/${command}`; actor = args[0] || actor; }
    else if (command === 'order') { route = `/v1/orders/${encodeURIComponent(args[0])}`; actor = args[1] || actor; }
    else if (command === 'refund') { route = `/v1/orders/${encodeURIComponent(args[0])}/refund`; method = 'POST'; actor = args[1] || actor; body = args[2] ? { reason: args[2] } : {}; }
    else if (command === 'revision') { route = `/v1/orders/${encodeURIComponent(args[0])}/revision`; method = 'POST'; actor = args[1] || actor; body = args[2] ? { notes: args[2] } : {}; key = args[3] || randomUUID(); }
    else if (['order-by-key', 'trial-by-key'].includes(command)) { route = command === 'trial-by-key' ? '/v1/trials/by-key' : '/v1/orders/by-key'; key = args[0]; actor = args[1] || actor; }
    else if (['buy', 'trial'].includes(command)) { route = command === 'trial' ? '/v1/trials' : '/v1/orders'; method = 'POST'; body = { service: args[0], ...JSON.parse(await readFile(path.resolve(args[1]), 'utf8')) }; actor = args[2] || actor; key = args[3] || randomUUID(); }
    else if (command === 'demo') { route = '/v1/demo'; method = 'POST'; actor = 'broker'; body = { input: { theme: '竞技场开幕', recipient: '所有参赛队伍' } }; }
    else if (command === 'request') { route = '/v1/requests'; method = 'POST'; body = JSON.parse(await readFile(path.resolve(args[0]), 'utf8')); actor = args[1] || actor; }
    else if (command === 'practice') { route = `/v1/practice/${encodeURIComponent(args[0])}/turns`; method = 'POST'; body = JSON.parse(await readFile(path.resolve(args[1]), 'utf8')); actor = args[2] || actor; key = args[3] || randomUUID(); }
    else throw new Error('未知命令，使用 npm run cli -- help');
    const headers = { 'content-type': 'application/json' };
    if (!['catalog', 'summary', 'market-board'].includes(command)) {
      const credentials = JSON.parse(await readFile(path.join(settings.dataDir, 'credentials.json'), 'utf8'));
      const account = credentials.accounts.find(a => a.id === actor);
      if (!account) throw new Error('本地身份不存在'); headers.authorization = `Bearer ${account.token}`;
    }
    if (key) { headers['idempotency-key'] = key; console.error(`Idempotency-Key: ${key}（重试请复用）`); }
    const response = await fetch(`http://${settings.host === '::1' ? '[::1]' : settings.host}:${settings.port}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok || result.status === 'failed') process.exitCode = 1;
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
