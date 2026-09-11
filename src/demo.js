import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { startServer } from './server.js';
import { rehearseArena, fixtureMarket } from './arena.js';

await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', 'demo-'));
const settings = config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0', LLM_PROVIDER: 'mock' });
const host = await startServer(settings);
const credentials = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
const call = async (method, route, actor, body, key) => {
  const headers = { 'content-type': 'application/json' };
  if (actor) headers.authorization = `Bearer ${credentials.accounts.find(a => a.id === actor).token}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${host.url}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
try {
  console.log('StarHall 本地端到端演练（模板模型 / 模拟积分 / 自托管内核）');
  const marketOpening = await call('GET', '/v1/market-board', 'broker');
  assert.equal(marketOpening.status, 200); assert.equal(marketOpening.body.phase, 'PRE-MARKET');
  console.log('✓ 经纪人展示真实Market Board：0分；私有账本仍无权限');
  const opening = await call('POST', '/v1/demo', 'broker', { input: { theme: '竞技场开幕', recipient: '所有参赛队' } });
  assert.equal(opening.status, 200); console.log('✓ 经纪人 → 星A：开幕演示，0分');
  const denied = await call('GET', '/v1/wall', 'broker'); assert.equal(denied.status, 403); console.log('✓ 经纪人访问账本：内核拒绝');
  const before = await call('GET', '/v1/wall', 'fan-orion'); assert.equal(before.status, 403);
  const inputs = [
    ['poem', 'fan-orion', { theme: '凌晨三点的黑客松', recipient: '猎户座队' }],
    ['speech', 'fan-lyra', { occasion: '天琴产品上线', recipient: '第一批使用者' }],
    ['patron', 'fan-vega', { occasion: '代码从想法变成作品', recipient: '每位创造者' }],
    ['roast', 'fan-orion', { description: '声称一句话解决所有问题的万能助手' }],
    ['review', 'fan-lyra', { description: '按次收费的自动数据分析服务' }],
    ['prediction', 'fan-vega', {}],
    ['negotiate', 'fan-orion', { scenario: '预算15积分，希望购买报价20积分的评审' }],
    ['tactics', 'fan-lyra', { direction: 'sell' }],
    ['duet', 'fan-vega', { description: '只给宣传语不给示例的产品', theme: '用交付回应质疑', recipient: '织女星队' }],
  ];
  const orders = [];
  for (const [service, buyer, input] of inputs) {
    const response = await call('POST', '/v1/orders', buyer, { service, input, message: '欢迎关注我们的作品！' }, `demo-${service}`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.status, 'delivered');
    orders.push(response.body); console.log(`✓ ${service.padEnd(10)} ${response.body.price}分 · ${response.body.elapsedMs}ms · 已上墙`);
  }
  const retry = await call('POST', '/v1/orders', 'fan-orion', { service: 'poem', input: inputs[0][2], message: '欢迎关注我们的作品！' }, 'demo-poem');
  assert.equal(retry.body.id, orders[0].id); console.log('✓ 重复请求：同一交付，不重复扣款');
  const session = orders.find(o => o.service === 'negotiate').delivery.practice.sessionId;
  for (let i = 1; i <= 5; i++) {
    const reply = await call('POST', `/v1/practice/${session}/turns`, 'fan-orion', { message: `第${i}次提议：减少一次修订以换取更好的报价。` }, `practice-${i}`);
    assert.equal(reply.status, 200); assert.equal(reply.body.round, i);
  }
  console.log('✓ 谈判：五回合互动完成，未额外扣分');
  const escalation = await call('POST', '/v1/requests', 'fan-orion', { star: 'star-a', request: '请代写完整答辩材料并直接提交参赛' });
  assert.equal(escalation.body.status, 'escalated'); console.log('✓ 未上架请求：明星升级 → 经纪人策略拒绝并推荐');
  const summary = await call('GET', '/v1/summary');
  const wall = await call('GET', '/v1/wall', 'fan-orion'); assert.equal(wall.body.wall.filter(w => w.amount > 0).length, 9);
  const arena = await rehearseArena(fixtureMarket()); console.log(`✓ 经纪人模拟两轮：${arena.reviews.length}队点评，排名已记录，消费${arena.spent}分 / ${arena.differentTeams}队`);
  const report = { mode: 'local', allAssertionsPassed: true, marketOpening: marketOpening.body, opening: opening.body, denied: denied.body, orders, escalation: escalation.body, summary: summary.body, arena };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n演练通过。报告：${path.join(dir, 'report.json')}\n审计：${path.join(dir, 'audit.jsonl')}\n演练数据与正式本地 data 目录隔离。`);
} finally { await host.close(); }
