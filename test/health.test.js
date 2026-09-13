import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { localSales } from '../src/sales.js';
import { VERSION } from '../src/catalog.js';
import { startServer } from '../src/server.js';

const buyer = { id: 'fan-orion' };
const pitch = { service: 'sales-pitch', input: { productName: 'Orion Review', productDescription: '代码审查服务，输出风险位置和修复建议', price: 12, targetBuyer: 'coding agents' } };

/** 固定模式的大脑：不调用模型，直接产出可交付作品，generation 元数据可控制。 */
const fixtureBrain = makeGen => ({
  options: { fallback: true },
  generate: async (_star, service, input) => ({ ...localSales(service, input), generation: makeGen() }),
});
const liveGen = () => ({ mode: 'live', provider: 'fixture', model: 'fixture', appVersion: VERSION, elapsedMs: 10, modelDurationMs: 5 });
const fallbackGen = reason => ({ mode: 'fallback', provider: 'fixture', model: 'fixture', appVersion: VERSION, elapsedMs: 20, modelDurationMs: 5, reason, internalReason: 'MODEL_TIMEOUT' });
const oldFallbackGen = () => ({ mode: 'fallback', provider: 'local-template', reason: 'model_failed', internalReason: 'MODEL_PROVIDER_UNAVAILABLE', elapsedMs: 165 }); // 无 appVersion = 修复前的历史

async function setup(t, brain) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-health-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir }), brain);
  t.after(() => app.close());
  return { app, dir };
}

test('Test A: one live request increments currentVersion and recent', async t => {
  const { app } = await setup(t, fixtureBrain(liveGen));
  const order = await app.order(buyer, pitch, 'live-1', { testRunId: 'run-a' });
  assert.equal(order.status, 'delivered');
  const h = app.salesPitchHealth({ testRunId: 'run-a' });
  assert.equal(h.currentVersion.version, VERSION);
  assert.equal(h.currentVersion.total, 1); assert.equal(h.currentVersion.live, 1); assert.equal(h.currentVersion.fallback, 0);
  assert.equal(h.recent.window, 10); assert.equal(h.recent.total, 1); assert.equal(h.recent.live, 1); assert.equal(h.recent.liveRate, 1);
  assert.equal(h.testRun.total, 1); assert.equal(h.testRun.live, 1);
  assert.equal(h.status, 'healthy');
  const catalogHealth = app.catalog().services.find(s => s.id === 'sales-pitch').health;
  assert.equal(catalogHealth.recent.live, 1);
});

test('Test B: an induced fallback increments fallback and records internalReason', async t => {
  const { app } = await setup(t, fixtureBrain(() => fallbackGen('model_timeout')));
  const order = await app.order(buyer, pitch, 'fb-1');
  // 备用交付不收费：订单变 refunded，但它在健康统计里仍然是一次 fallback 样本
  assert.equal(order.status, 'refunded'); assert.equal(order.refundReason, 'FALLBACK_NOT_CHARGED'); assert.equal(order.chargedCredits, 0);
  const h = app.salesPitchHealth();
  assert.equal(h.currentVersion.total, 1); assert.equal(h.currentVersion.fallback, 1); assert.equal(h.currentVersion.live, 0);
  assert.equal(h.currentVersion.fallbackReasons.MODEL_TIMEOUT, 1);
  assert.equal(h.recent.fallback, 1);
  assert.equal(h.status, 'degraded'); // 近期 0% live
});

test('Test C: lifetime keeps old history; currentVersion starts fresh and status is not dragged by it', async t => {
  const { app } = await setup(t, fixtureBrain(oldFallbackGen));
  const oldBuyers = [{ id: 'fan-orion' }, { id: 'fan-lyra' }, { id: 'fan-vega' }];
  for (let i = 0; i < 3; i++) await app.order(oldBuyers[i], pitch, `old-${i}`);
  // 把旧记录推到两天前：lifetime 保留它们；样本不足窗口时 recent 不强行凑数
  await app.store.transaction(s => { for (const o of s.orders) o.completedAt = new Date(Date.now() - 2 * 86400000).toISOString(); });
  const old = app.salesPitchHealth();
  assert.equal(old.lifetime.total, 3); assert.equal(old.lifetime.fallback, 3); assert.equal(old.lifetime.fallbackReasons.MODEL_PROVIDER_UNAVAILABLE, 3);
  assert.equal(old.currentVersion.total, 0); // 旧记录没有 appVersion，不猜
  assert.equal(old.recent.total, 3); // 样本不足窗口时如实显示 3，不凑成 10
  app.brain = fixtureBrain(liveGen);
  for (let i = 0; i < 11; i++) await app.order(buyer, pitch, `new-${i}`);
  const h = app.salesPitchHealth();
  assert.equal(h.lifetime.total, 14); assert.equal(h.lifetime.fallback, 3); assert.equal(h.lifetime.live, 11);
  assert.equal(h.currentVersion.total, 11); assert.equal(h.currentVersion.live, 11); assert.equal(h.currentVersion.fallback, 0);
  assert.equal(h.recent.total, 10); assert.equal(h.recent.fallback, 0); assert.equal(h.recent.liveRate, 1);
  assert.equal(h.status, 'healthy'); // lifetime 有旧失败，但 recent/currentVersion 健康，主状态不受拖累
});

test('Test D: recent window caps at last 10 requests', async t => {
  const { app } = await setup(t, fixtureBrain(liveGen));
  for (let i = 0; i < 12; i++) await app.order(buyer, pitch, `win-${i}`);
  const h = app.salesPitchHealth();
  assert.equal(h.lifetime.total, 12);
  assert.equal(h.recent.total, 10); assert.equal(h.recent.live, 10); assert.equal(h.recent.liveRate, 1);
  const h5 = app.salesPitchHealth({ window: 5 });
  assert.equal(h5.recent.total, 5);
});

test('Test E: testRunId separates stability windows; HTTP header flows through', async t => {
  const { app, dir } = await setup(t, fixtureBrain(liveGen));
  await app.order(buyer, pitch, 'x-1', { testRunId: 'run-x' });
  await app.order(buyer, pitch, 'x-2', { testRunId: 'run-x' });
  await app.order(buyer, pitch, 'y-1', { testRunId: 'run-y' });
  assert.equal(app.salesPitchHealth({ testRunId: 'run-x' }).testRun.total, 2);
  assert.equal(app.salesPitchHealth({ testRunId: 'run-y' }).testRun.total, 1);
  assert.equal(app.salesPitchHealth({ testRunId: 'run-z' }).testRun.total, 0);
  assert.equal(app.salesPitchHealth().lifetime.total, 3);
  // HTTP: 头标签写入订单 + 查询端点筛选
  const host = await startServer(config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0' }), app);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeIdleConnections(); }));
  const creds = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
  const token = creds.accounts.find(a => a.id === buyer.id).token;
  const res = await fetch(`${host.url}/v1/orders`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'http-run', 'x-test-run-id': 'run-http' }, body: JSON.stringify(pitch) });
  assert.equal((await res.json()).status, 'delivered');
  const h = await fetch(`${host.url}/v1/health/sales-pitch?testRunId=run-http`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.equal(h.testRun.total, 1); assert.equal(h.testRun.live, 1);
  assert.ok(!JSON.stringify(h).includes(token));
  const all = await fetch(`${host.url}/v1/health/sales-pitch`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.equal(all.lifetime.total, 4); // 历史不丢
});
