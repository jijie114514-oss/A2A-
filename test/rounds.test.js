import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { StarHall } from '../src/app.js';
import { roundOf, roundContext, TRIAL_POLICY, CRITIQUE_START, MARKET_START, ARENA_END } from '../src/rounds.js';
import { DELIVERY_BUDGET_SECONDS } from '../src/limits.js';
import { SERVICES, AD_SERVICES } from '../src/catalog.js';
import { COMMERCIAL_SERVICES } from '../src/commercial-catalog.js';

/** 官方规则：第一轮（点评）试用不花钱、积分第二轮才发；第二轮（市场）用积分购买。 */
test('两轮判定：UTC 边界、建议性质、试用政策', () => {
  assert.equal(roundOf(CRITIQUE_START - 1).id, 'BEFORE');
  assert.equal(roundOf(CRITIQUE_START).id, 'CRITIQUE');
  assert.equal(roundOf(MARKET_START - 1).id, 'CRITIQUE');
  assert.equal(roundOf(MARKET_START).id, 'MARKET');
  assert.equal(roundOf(ARENA_END).id, 'AFTER');
  // 北京时间 21:00 → UTC 13:00；两轮各一小时
  assert.equal(new Date(CRITIQUE_START).toISOString(), '2026-09-13T13:00:00.000Z');
  assert.equal(new Date(MARKET_START).toISOString(), '2026-09-13T14:00:00.000Z');
  const first = roundContext(CRITIQUE_START);
  assert.equal(first.advisory, true, '轮次只是建议，不是闸门');
  assert.match(first.task, /试用 ≥3 家/);
  assert.match(first.callToAction.endpoint, /\/v1\/trials/);
  assert.equal(first.trialPolicy.price, 0);
  assert.match(first.trialPolicy.limit, /最多一次/);
  assert.equal(TRIAL_POLICY.endpoint, '/v1/trials');
  const second = roundContext(MARKET_START);
  assert.match(second.task, /≥80 分/);
  assert.equal(second.callToAction.endpoint, '/v1/orders');
  assert.equal(second.payment.simulated, true);
  assert.equal(second.payment.arenaCreditsSettledHere, false);
});

test('交付承诺与实际硬预算一致：目录里没有 115 秒以上的内容服务', () => {
  for (const s of SERVICES.filter(s => !s.ad)) assert.equal(s.maxDeliverySeconds, DELIVERY_BUDGET_SECONDS, `${s.id} 的承诺必须等于执行预算`);
  for (const s of COMMERCIAL_SERVICES.filter(s => !s.ad)) assert.equal(s.maxDeliverySeconds, DELIVERY_BUDGET_SECONDS, `${s.id} 的承诺必须等于执行预算`);
  for (const s of AD_SERVICES) assert.equal(s.maxDeliverySeconds, 15, '广告不走模型');
  assert.ok(DELIVERY_BUDGET_SECONDS * 2 < 300, '两单串行也不能顶到赛事 5 分钟上限');
});

test('目录与 agent card 暴露轮次、试用政策与交付条款', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-rounds-'));
  const options = config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_OPEN_REGISTRATION: 'true', STARHALL_PUBLIC_BASE_URL: 'https://example.test' });
  const host = await startServer(options); t.after(() => host.close());
  const catalog = await (await fetch(host.url + '/v1/catalog')).json();
  assert.ok(['BEFORE', 'CRITIQUE', 'MARKET', 'AFTER'].includes(catalog.round.id));
  assert.equal(catalog.round.trialPolicy.price, 0);
  assert.equal(catalog.delivery.hardTimeoutSeconds, DELIVERY_BUDGET_SECONDS);
  assert.equal(catalog.delivery.onTimeout, 'FAILED_NO_CHARGE');
  assert.ok(catalog.services.every(s => s.maxDeliverySeconds <= DELIVERY_BUDGET_SECONDS));
  const card = await (await fetch(host.url + '/agent-card.json')).json();
  assert.equal(card.round.id, catalog.round.id);
  assert.match(card.howToParticipate.roundOne, /不要为服务付款/);
  assert.match(card.howToParticipate.roundTwo, /≥80 分/);
  assert.equal(card.endpoints.evidence, 'https://example.test/v1/evidence');
});

test('公开证据端点与 MCP 工具：数字可复算，且如实说明不主张什么', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-evidence-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dataDir, STARHALL_STORE: 'file' }));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_STORE: 'file', STARHALL_OPEN_REGISTRATION: 'true' }), app); t.after(() => host.close());

  const registered = await (await fetch(host.url + '/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `evidence-${Date.now().toString(36)}`, name: '证据自检', secret: 'e'.repeat(24) }) })).json();
  const auth = { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' };
  await fetch(host.url + '/v1/trials', { method: 'POST', headers: { ...auth, 'idempotency-key': 'ev-1' }, body: JSON.stringify({ service: 'poem', input: { theme: '证据', recipient: '队伍' } }) });
  await fetch(host.url + '/v1/orders', { method: 'POST', headers: { ...auth, 'idempotency-key': 'ev-2' }, body: JSON.stringify({ service: 'review', input: { description: '一个待评审的工具' } }) });

  const evidence = await (await fetch(host.url + '/v1/evidence')).json();
  const claim = name => evidence.claims.find(c => c.claim.startsWith(name)).value;
  assert.equal(claim('成功交付数'), 2);
  assert.equal(claim('免费试用次数'), 1);
  assert.equal(claim('付费成交笔数与模拟积分').orders, 1);
  assert.equal(claim('真实模型交付占比') >= 0, true);
  assert.equal(claim('交付硬预算（秒）'), DELIVERY_BUDGET_SECONDS);
  assert.equal(evidence.round.id, roundOf().id);
  assert.ok(evidence.whatWeDoNotClaim.some(text => /impressions/.test(text)));
  assert.ok(evidence.prices.every(p => p.maxDeliverySeconds <= DELIVERY_BUDGET_SECONDS));

  // MCP：免费工具，不需要 token
  const rpc = await fetch(host.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'starhall_evidence', arguments: {} } }) });
  const body = await rpc.json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.claims.find(c => c.claim.startsWith('成功交付数')).value, 2);
  const listed = await (await fetch(host.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).json();
  assert.ok(listed.result.tools.some(tool => tool.name === 'starhall_evidence'));
});
