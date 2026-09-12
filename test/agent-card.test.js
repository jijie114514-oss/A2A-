import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

async function setup(t, env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-card-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', ...env }));
  t.after(() => host.close());
  const credentials = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  return { host, dataDir, credentials, token: id => credentials.accounts.find(a => a.id === id).token };
}
const get = async (host, route) => { const response = await fetch(host.url + route); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() }; };

test('agent card：免认证、不缓存、三个发现路径同源', async t => {
  const { host } = await setup(t);
  for (const route of ['/agent-card.json', '/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const card = await get(host, route);
    assert.equal(card.status, 200, route);
    assert.equal(card.cache, 'no-store', '卡片必须读时重算，不能缓存');
    assert.equal(card.body.schemaVersion, 'v1');
    assert.equal(card.body.name, 'STARHALL — SELL BETTER IN THE ARENA');
    assert.deepEqual(card.body.pricing.free.map(s => s.id), ['market-board']);
    assert.equal(card.body.pricing.free[0].cost, 0);
  }
});

test('agent card：价格与实时目录一致，分档计价不撒谎', async t => {
  const { host } = await setup(t);
  const card = (await get(host, '/agent-card.json')).body;
  const catalog = (await get(host, '/v1/catalog')).body;
  for (const service of catalog.services) {
    const listed = card.services.find(s => s.id === service.id);
    assert.ok(listed, `卡片缺少服务 ${service.id}`);
    if (service.price === null) continue; // 分档商品在下面单独断言
    assert.equal(listed.cost, service.price, `${service.id} 的卡片价格必须等于目录价`);
    assert.equal(listed.maxDeliverySeconds, service.maxDeliverySeconds ?? null);
  }
  const sponsorship = card.services.find(s => s.id === 'star-sponsorship');
  assert.equal(sponsorship.cost, 5, '分档商品必须给出最低档真实价格，而不是 null');
  assert.deepEqual(Object.keys(sponsorship.plans).sort(), ['delivery', 'featured', 'leaderboard']);
  assert.equal(sponsorship.plans.featured.price, 15);
  assert.equal(card.pricing.matrix['sales-pitch'].cost, 5);
  assert.equal(card.pricing.matrix['commercial-diagnostic'].cost, 30);
  assert.equal(card.services.length, catalog.services.length + catalog.extras.services.length);
  assert.equal(card.services.every(s => s.inputSchema), true, '每个商品都要暴露输入 schema，别人才能无人工调用');
});

test('agent card：不泄露任何凭据或令牌', async t => {
  const { host, credentials } = await setup(t);
  const raw = JSON.stringify((await get(host, '/agent-card.json')).body);
  for (const account of credentials.accounts) assert.ok(!raw.includes(account.token), `卡片泄露了 ${account.id} 的令牌`);
  assert.ok(!/rit_|snk_|sni_/.test(raw), '卡片不得包含任何 SharedNet 凭据');
});

test('agent card：开户与 MCP 信息跟随部署配置变化', async t => {
  const closed = await setup(t);
  const closedCard = (await get(closed.host, '/agent-card.json')).body;
  assert.equal(closedCard.onboarding.requiresHuman, true);
  assert.equal(closedCard.endpoints.register, null);
  assert.equal((await fetch(`${closed.host.url}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);

  const open = await setup(t, { STARHALL_OPEN_REGISTRATION: 'true', STARHALL_PUBLIC_BASE_URL: 'https://arena.example.com' });
  const openCard = (await get(open.host, '/agent-card.json')).body;
  assert.equal(openCard.onboarding.requiresHuman, false);
  assert.equal(openCard.onboarding.mcpTool, 'starhall_register');
  assert.equal(openCard.endpoints.mcp, 'https://arena.example.com/mcp');
  assert.equal(openCard.url, 'https://arena.example.com');
  assert.equal(openCard.interfaces.mcp.tools.includes('starhall_register'), true);
  assert.equal(openCard.interfaces.mcp.tools.includes('starhall_buy_sales_pitch'), true);
});

test('/api/mcp 别名与 /mcp 行为一致', async t => {
  const { host } = await setup(t);
  const rpc = async (route, body) => {
    const response = await fetch(host.url + route, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const viaAlias = await rpc('/api/mcp', list);
  const viaCanonical = await rpc('/mcp', list);
  assert.equal(viaAlias.status, 200);
  assert.deepEqual(viaAlias.body.result.tools.map(t => t.name), viaCanonical.body.result.tools.map(t => t.name));
  assert.equal((await fetch(`${host.url}/api/mcp`)).status, 405, '别名也要明确拒绝 GET');
});
