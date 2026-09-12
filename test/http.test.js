import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

test('HTTP authentication, purchasing, ownership, input limits and purpose boundaries', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-http-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0' })); t.after(() => host.close());
  const credentials = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  const token = id => credentials.accounts.find(a => a.id === id).token;
  const request = async (route, options = {}) => {
    const response = await fetch(host.url + route, options); return { status: response.status, body: await response.json() };
  };
  const health = (await request('/health')).body;
  assert.equal(health.mode, 'local'); assert.equal(health.store, 'file'); assert.equal(health.dbReady, true);
  const catalog = (await request('/v1/catalog')).body;
  assert.equal(catalog.services.length, 6);
  assert.equal(catalog.extras.services.find(s => s.id === 'ad-pin').price, 10);
  assert.equal(catalog.extras.services.find(s => s.id === 'ad-spot').price, 5);
  assert.equal((await request('/v1/summary')).status, 200);
  assert.equal((await request('/v1/wallet')).status, 401);
  assert.equal((await request('/v1/wallet', { headers: { authorization: 'Bearer forged' } })).status, 401);
  assert.equal((await request('/v1/summary', { headers: { authorization: `Bearer ${token('broker')}` } })).status, 403);
  const headers = { authorization: `Bearer ${token('fan-orion')}`, 'content-type': 'application/json', 'idempotency-key': 'http-poem' };
  const buy = { method: 'POST', headers, body: JSON.stringify({ service: 'poem', input: { theme: '测试', recipient: '队伍' } }) };
  const order = await request('/v1/orders', buy); assert.equal(order.status, 200); assert.equal(order.body.status, 'delivered');
  assert.equal((await request('/v1/orders', buy)).body.id, order.body.id);
  assert.equal((await request(`/v1/orders/${order.body.id}`, { headers: { authorization: `Bearer ${token('fan-lyra')}` } })).status, 404);
  assert.equal((await request('/v1/orders', { ...buy, body: '{broken' })).status, 400);
  assert.equal((await request('/v1/orders', { ...buy, body: JSON.stringify({ data: 'x'.repeat(34000) }) })).status, 413);
  assert.equal((await request('/v1/orders', { ...buy, headers: { ...headers, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/v1/orders', { ...buy, headers: { ...headers, origin: 'https://example.invalid' } })).status, 403);
  const forged = await request('/v1/orders', { ...buy, body: JSON.stringify({ service: 'poem', input: { theme: '测试', recipient: '队伍' }, grants: ['write-ledger'] }) });
  assert.equal(forged.status, 400);
  assert.equal((await request('/v1/demo', { method: 'POST', headers, body: JSON.stringify({ input: { theme: '测试', recipient: '队伍' } }) })).status, 403);
  const wallet = await request('/v1/wallet', { headers }); assert.equal(wallet.body.balance, 95);
  assert.ok(!JSON.stringify(order.body).includes(token('fan-orion')));
});

test('外部接入的失败语义：未知路径 404、只写入口 405、HEAD 可用', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-http2-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_PUBLIC_BASE_URL: 'https://example.test' })); t.after(() => host.close());
  const get = (path, options = {}) => fetch(host.url + path, options);
  // 打错 URL 的 agent 应该看到 404，而不是以为「只是缺 token」
  const typo = await get('/v1/walelt');
  assert.equal(typo.status, 404);
  assert.equal((await typo.json()).error.code, 'not_found');
  // 存在的路由但缺 token 仍然是 401
  assert.equal((await get('/v1/wallet')).status, 401);
  // 人类点开 POST 链接：405 + Allow + 调用示例
  const clicked = await get('/v1/agents');
  assert.equal(clicked.status, 405);
  assert.equal(clicked.headers.get('allow'), 'POST');
  assert.match((await clicked.json()).howTo, /curl -X POST https:\/\/example\.test\/v1\/agents/);
  assert.equal((await get('/mcp')).status, 405);
  // HEAD 按 GET 路由（探活脚本常用），且不返回 body
  const head = await fetch(host.url + '/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(host.url + '/', { method: 'HEAD' })).status, 200);
});
