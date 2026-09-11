import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', 'focused-'));
const settings = config({ ...process.env, STARHALL_DATA_DIR: dir, STARHALL_PORT: '0' });
assert.notEqual(settings.llm.provider, 'mock');
const host = await startServer(settings);
const creds = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
const headers = { authorization: `Bearer ${creds.accounts.find(a => a.id === 'fan-orion').token}`, 'content-type': 'application/json' };
const call = async (route, body, key) => {
  const response = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { ...headers, 'idempotency-key': key || 'read' }, body: body && JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
};
const report = { startedAt: new Date().toISOString(), orders: [], practice: [], issues: [] };
try {
  const scenario = '我方买家预算15积分，对方卖家报价20积分，向别队采购四分钟内交付的代码审查服务；可减少一次修订换取折扣。';
  const inputs = [
    { service: 'negotiate', input: { scenario, context: '用户扮演买方，后续对手扮演卖方；核心代码审查范围优先，不能以牺牲核心交付来凑成交。' } },
    { service: 'duet', input: { description: 'StarHall是卖诗、吐槽和谈判三种服务的AI明星打赏平台', theme: '用交付回应质疑', recipient: 'StarHall', context: '三种服务分别由词曲家、毒舌评审、谈判大师提供；不能把平台缩成单一吐槽服务。' } },
  ];
  const duetOnly = process.argv.includes('--duet-only');
  for (const body of duetOnly ? inputs.slice(1) : inputs) {
    const order = await call('/v1/orders', body, body.service); report.orders.push(order);
    console.log(`${body.service}: ${order.status} / ${order.delivery?.pieces.map(p => p.generation.mode).join('+')}`);
    if (order.status !== 'delivered' || order.delivery.pieces.some(p => p.generation.mode !== 'live')) report.issues.push({ orderId: order.id, issue: 'not_fully_live' });
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
  const session = report.orders[0].delivery.practice?.sessionId;
  for (const [i, message] of (duetOnly ? [] : ['我的预算15分，是否可减少一次修订？', '可以当天提供完整材料，请明确包含哪些评审项目。', '我接受一次修订，但需要具体异议与验证建议。', '如果超过四分钟，交付与扣费如何处理？', '请复述最终价格、范围、时限和未达标处理。']).entries()) {
    const turn = await call(`/v1/practice/${session}/turns`, { message }, `round-${i}`); report.practice.push(turn);
    console.log(`practice ${i + 1}: ${turn.response.generation.mode}`);
    if (turn.response.generation.mode !== 'live') report.issues.push({ round: i + 1, generation: turn.response.generation });
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
  report.wallet = await call('/v1/wallet'); assert.equal(report.wallet.balance, duetOnly ? 85 : 70); assert.equal(report.wallet.held, 0);
  report.completedAt = new Date().toISOString();
  if (report.issues.length) process.exitCode = 1;
} catch (e) { report.issues.push({ error: e.message }); process.exitCode = 1; }
finally { await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2)); await host.close(); console.log(JSON.stringify({ report: path.join(dir, 'report.json'), issues: report.issues.length })); }
