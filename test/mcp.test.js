import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { createMcpServer } from '../src/mcp.js';
import { startServer } from '../src/server.js';

const pitch = { productName: 'CodeLens', productDescription: '代码审查服务，输出风险位置和修复建议', price: 20, targetBuyer: 'coding agents' };
async function setup(t, env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-mcp-'));
  const options = config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_OPEN_REGISTRATION: 'true', ...env });
  const app = await StarHall.open(options);
  const server = createMcpServer(app, { openRegistration: options.openRegistration, token: options.mcpToken, registrationCredits: options.registrationCredits });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); await app.close(); });
  return { app, client, options, dataDir };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
}

test('MCP 目录：免费工具免 token，价格与输入 schema 对调用方可见', async t => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const expected of ['starhall_catalog', 'starhall_market_board', 'starhall_summary', 'starhall_register', 'starhall_trial',
    'starhall_order', 'starhall_order_status', 'starhall_refund', 'starhall_revision', 'starhall_commercial_profile', 'starhall_request']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
  assert.ok(names.includes('starhall_buy_sales_pitch') && names.includes('starhall_buy_commercial_diagnostic'), '核心商业商品需要各自的下单工具');
  const buy = tools.find(t => t.name === 'starhall_buy_sales_pitch');
  assert.match(buy.description, /5/, '工具描述必须带价格，调用方才能在花钱前判断值不值');
  assert.ok(buy.inputSchema.properties.input, '下单工具必须暴露输入 schema');
  assert.equal(tools.every(t => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false), true);

  const catalog = await call(client, 'starhall_catalog');
  assert.equal(catalog.isError, false);
  assert.equal(catalog.body.services.length, 6);
  assert.equal(catalog.body.access.mcp.path, '/mcp');
  assert.equal(catalog.body.access.onboarding.requiresHuman, false);
  assert.equal(catalog.body.access.onboarding.tool, 'starhall_register');
  const board = await call(client, 'starhall_market_board');
  assert.equal(board.isError, false); assert.equal(board.body.phase, 'PRE-MARKET');
});

test('MCP 全链路：自助开户 → 免费试用 → 付费下单 → 幂等取回 → 余额与墙上记录一致', async t => {
  const { app, client } = await setup(t);
  const registered = await call(client, 'starhall_register', { handle: 'probe-agent', name: '探针队', secret: '0123456789abcdef' });
  assert.equal(registered.isError, false);
  assert.equal(registered.body.created, true); assert.equal(registered.body.balance, 100);
  const token = registered.body.token;

  const wallet = await call(client, 'starhall_wallet', { token });
  assert.equal(wallet.body.balance, 100);

  const trial = await call(client, 'starhall_trial', { service: 'poem', input: { theme: '赛场', recipient: '探针队' }, idempotencyKey: 'mcp-trial-1', token });
  assert.equal(trial.isError, false); assert.equal(trial.body.status, 'delivered'); assert.equal(trial.body.charged, 0);
  const retriedTrial = await call(client, 'starhall_trial', { service: 'poem', input: { theme: '赛场', recipient: '探针队' }, idempotencyKey: 'mcp-trial-1', token });
  assert.equal(retriedTrial.body.id, trial.body.id, '同一幂等键必须返回原试用单');

  const bought = await call(client, 'starhall_buy_sales_pitch', { input: pitch, idempotencyKey: 'mcp-buy-1', token, message: '加油' });
  assert.equal(bought.isError, false); assert.equal(bought.body.status, 'delivered'); assert.equal(bought.body.charged, 5);
  const again = await call(client, 'starhall_buy_sales_pitch', { input: pitch, idempotencyKey: 'mcp-buy-1', token, message: '加油' });
  assert.equal(again.body.id, bought.body.id, '同一幂等键与同一内容必须返回原订单，不重复扣款');
  const conflicting = await call(client, 'starhall_buy_sales_pitch', { input: pitch, idempotencyKey: 'mcp-buy-1', token, message: '换一个说法' });
  assert.equal(conflicting.body.error.code, 'idempotency_conflict', '同一幂等键换了内容必须被拒绝，而不是当成新单');
  const byKey = await call(client, 'starhall_order_status', { idempotency_key: 'mcp-buy-1', token });
  assert.equal(byKey.body.id, bought.body.id, 'snake_case 别名与按幂等键取单都要可用');
  const listed = await call(client, 'starhall_orders', { token });
  assert.equal(listed.body.orders.length, 2);

  const after = await call(client, 'starhall_wallet', { token });
  assert.equal(after.body.balance, 95, '只扣成功付费单的 5 分，试用不扣款');
  assert.equal(app.store.read().accounts.find(a => a.id === 'agent-probe-agent').balance, 95);
});

test('MCP 拒绝语义：无 token、handle 冲突、令牌轮换、开户关闭都返回结构化的 code', async t => {
  const { client } = await setup(t);
  const noToken = await call(client, 'starhall_wallet');
  assert.equal(noToken.isError, true); assert.equal(noToken.body.error.code, 'unauthorized');
  const known = await call(client, 'starhall_buy_sales_pitch', { input: pitch, idempotencyKey: 'k1', token: 'forged-token' });
  assert.equal(known.body.error.code, 'unauthorized');

  const first = await call(client, 'starhall_register', { handle: 'rotation', secret: '0123456789abcdef' });
  const stolen = await call(client, 'starhall_register', { handle: 'rotation', secret: 'ffffffffffffffff' });
  assert.equal(stolen.body.error.code, 'handle_taken', '换 secret 冒用同一 handle 必须被拒绝');
  const rotated = await call(client, 'starhall_register', { handle: 'rotation', secret: '0123456789abcdef' });
  assert.equal(rotated.body.created, false); assert.notEqual(rotated.body.token, first.body.token);
  assert.equal((await call(client, 'starhall_wallet', { token: first.body.token })).body.error.code, 'unauthorized', '轮换后旧 token 立即失效');
  assert.equal((await call(client, 'starhall_wallet', { token: rotated.body.token })).body.balance, 100);

  const badHandle = await call(client, 'starhall_register', { handle: 'AB', secret: '0123456789abcdef' });
  assert.equal(badHandle.body.error.code, 'invalid_input');
  const shortSecret = await call(client, 'starhall_register', { handle: 'short-secret', secret: 'too-short' });
  assert.equal(shortSecret.body.error.code, 'invalid_input');
  const unknownTool = await call(client, 'starhall_nope');
  assert.equal(unknownTool.body.error.code, 'unknown_tool');
});

test('MCP 对外开放开关：未开启自助开户时拒绝外部注册，且目录如实说明需要人工', async t => {
  const { client } = await setup(t, { STARHALL_OPEN_REGISTRATION: 'false' });
  const { tools } = await client.listTools();
  assert.equal(tools.some(t => t.name === 'starhall_register'), false, '未开放时不应暴露开户工具');
  const catalog = await call(client, 'starhall_catalog');
  assert.equal(catalog.body.access.onboarding.requiresHuman, true);
  const refused = await call(client, 'starhall_trial', { service: 'poem', input: { theme: 'a', recipient: 'b' }, idempotencyKey: 'k', token: 'x' });
  assert.equal(refused.body.error.code, 'unauthorized');
});

test('HTTP 传输：/mcp 无状态 streamable HTTP 可用，GET 明确 405，/v1/agents 与 MCP 共用同一套开户', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-mcp-http-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_OPEN_REGISTRATION: 'true' }));
  t.after(() => host.close());
  // MCP 规范要求客户端同时接受 application/json 与 text/event-stream。
  const rpc = async body => {
    const response = await fetch(`${host.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    return response.json();
  };
  const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
  assert.equal(initialized.result.serverInfo.name, 'starhall');
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(listed.result.tools.some(t => t.name === 'starhall_catalog'), '无状态模式下不需要会话即可列工具');
  assert.equal((await fetch(`${host.url}/mcp`)).status, 405, 'GET 必须明确拒绝，而不是挂起');
  const notAcceptable = await fetch(`${host.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) });
  assert.equal(notAcceptable.status, 406, '缺少 Accept 的调用方要拿到明确的 406，而不是静默降级');

  const registered = await fetch(`${host.url}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'http-team', secret: '0123456789abcdef' }) });
  assert.equal(registered.status, 201);
  const account = await registered.json();
  const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'starhall_trial',
    arguments: { service: 'poem', input: { theme: '网络', recipient: 'HTTP 队' }, idempotencyKey: 'http-1', token: account.token } } });
  const delivered = JSON.parse(called.result.content[0].text);
  assert.equal(delivered.status, 'delivered');
  const health = await (await fetch(`${host.url}/health`)).json();
  assert.equal(health.registration.open, true);
});
