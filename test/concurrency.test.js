import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { localWork } from '../src/brain.js';

/**
 * 并发正确性（乐观并发的核心回归）：
 * - 50 个并行下单不允许把余额扣成负数，也不允许同一笔订单重复扣分；
 * - 同一 Idempotency-Key 并发只产生一笔订单。
 * file/memory 走单实例串行；postgres 走「读-改-写 + 版本号 + 重跑 fn」的乐观并发。
 */
const brain = { options: { fallback: true }, generate: async (_star, service, input) => ({ ...localWork(service, input), generation: { mode: 'live', provider: 'fixture', model: 'fixture' } }) };
const secret = `secret_${'c'.repeat(20)}`;

async function hammer(app, handle) {
  const registered = await app.registerAgent({ handle, name: '并发自检', secret });
  const actor = app.authenticate(registered.token);
  const settle = promise => promise.then(order => order.status, error => `error:${error.code}`);
  const statuses = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    settle(app.order(actor, { service: 'poem', input: { theme: `并发第${i}次`, recipient: '所有队伍' } }, `${handle}-${i}`))));
  const wallet = app.wallet(actor);
  const orders = app.orders(actor);
  const delivered = orders.filter(o => o.status === 'delivered');
  return { balance: wallet.balance, held: wallet.held, delivered: delivered.length,
    spent: delivered.reduce((sum, order) => sum + order.price, 0), statuses };
}

const invariants = (result, start = 100) => {
  assert.ok(result.balance >= 0, `余额不能为负：${result.balance}`);
  assert.equal(result.held, 0, '所有订单都已结束，不应还有预留');
  assert.ok(result.spent <= start, `扣分总额 ${result.spent} 不能超过初始余额 ${start}`);
  assert.equal(result.balance + result.spent, start, '余额 + 已扣分应守恒');
  assert.equal(result.spent, result.delivered * 5, '每笔成功订单恰好扣一次目录价');
};

test('50 个并行订单：memory 驱动不超扣、不重复扣分', async t => {
  const app = await StarHall.open(config({ STARHALL_STORE: 'memory' }), brain);
  t.after(() => app.close());
  invariants(await hammer(app, `conc-mem-${Date.now().toString(36)}`));
});

test('50 个并行订单：file 驱动不超扣、不重复扣分', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-concurrency-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir, STARHALL_STORE: 'file' }), brain);
  t.after(() => app.close());
  invariants(await hammer(app, `conc-file-${Date.now().toString(36)}`));
});

test('50 个并行订单：postgres 乐观并发不超扣、不重复扣分', { skip: !process.env.DATABASE_URL && '需要 DATABASE_URL（Neon）' }, async t => {
  const app = await StarHall.open(config({ STARHALL_MODE: 'cloud', STARHALL_STORE: 'postgres', DATABASE_URL: process.env.DATABASE_URL }), brain);
  t.after(() => app.close());
  invariants(await hammer(app, `conc-pg-${Date.now().toString(36)}`));
});

test('同一 Idempotency-Key 并发只产生一笔订单（memory + file）', async t => {
  for (const options of [config({ STARHALL_STORE: 'memory' }), config({ STARHALL_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'starhall-idem-')), STARHALL_STORE: 'file' })]) {
    const app = await StarHall.open(options, brain);
    try {
      const registered = await app.registerAgent({ handle: `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: '幂等自检', secret });
      const actor = app.authenticate(registered.token);
      const body = { service: 'poem', input: { theme: '同一把钥匙', recipient: '队伍' } };
      const [first, second] = await Promise.all([app.order(actor, body, 'same-key'), app.order(actor, body, 'same-key')]);
      assert.equal(first.id, second.id);
      assert.equal(app.orders(actor).length, 1);
      assert.equal(app.wallet(actor).balance, 95);
    } finally { await app.close(); }
  }
});
