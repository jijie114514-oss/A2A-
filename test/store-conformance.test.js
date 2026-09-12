import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { localWork } from '../src/brain.js';

/**
 * 驱动一致性：同一串真实操作（开户 → 免费试用 → 付费单 → 机器退款 → 免费修订 → 主观退款被拒）
 * 在 file / memory / postgres 上必须给出同样的结果。
 * 断言只看**该身份自己**的余额、订单、墙上记录，因此可以在有历史数据的共享 Neon 上跑。
 */
let emptyNext = false;
const brain = {
  options: { fallback: true },
  generate: async (_star, service, input) => {
    const empty = emptyNext; emptyNext = false;
    const work = empty ? { text: '' } : localWork(service, input);
    return { ...work, generation: { mode: empty ? 'fallback' : 'live', provider: 'fixture', model: 'fixture' } };
  },
};

const INPUTS = { poem: { theme: '驱动一致性', recipient: '所有参赛队伍' }, poem2: { theme: '空交付演练', recipient: '所有参赛队伍' } };

async function scenario(app, handle) {
  const registered = await app.registerAgent({ handle, name: '一致性自检', secret: `secret_${'0'.repeat(20)}` });
  const actor = app.authenticate(registered.token);
  const start = app.wallet(actor).balance;

  const trial = await app.order(actor, { service: 'poem', input: INPUTS.poem }, `${handle}-trial`, { trial: true });
  const paid = await app.order(actor, { service: 'poem', input: INPUTS.poem }, `${handle}-paid`);
  emptyNext = true;
  const broken = await app.order(actor, { service: 'poem', input: INPUTS.poem2 }, `${handle}-empty`);
  const revision = await app.revisionRequest(actor, paid.id, { notes: '把第二段改短' }, `${handle}-rev`);
  const refund = await app.refundRequest(actor, paid.id, '我不想要了');

  const wallet = app.wallet(actor);
  const orders = app.orders(actor);
  return {
    start,
    balance: wallet.balance, held: wallet.held,
    trial: { status: trial.status, charged: trial.chargedCredits, mode: trial.delivery.pieces[0].generation.mode },
    paid: { status: paid.status, charged: paid.chargedCredits, revisionAvailable: paid.revisionAvailable },
    broken: { status: broken.status, charged: broken.chargedCredits, reason: broken.refundReason, source: broken.refundSource },
    revision: { used: revision.revisionUsed, charged: revision.chargedCredits, hasPieces: revision.revision.pieces.length > 0 },
    refund: { decision: refund.decision, refundEligible: refund.refundEligible, remedy: refund.remedy },
    statuses: orders.map(o => `${o.service}:${o.status}:${o.chargedCredits}:${o.refundReason || '-'}`).sort(),
    wall: app.store.read().wall.filter(w => w.buyerId === actor.id).map(w => `${w.amount}:${w.kind}:${w.stars.join('+')}`).sort(),
    registered: registered.created,
  };
}

async function withApp(options, run) {
  const app = await StarHall.open(options, brain);
  try { return await run(app); } finally { await app.close(); }
}

test('store conformance: file and memory behave identically', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-conformance-'));
  const stamp = Date.now().toString(36);
  const file = await withApp(config({ STARHALL_DATA_DIR: dir, STARHALL_STORE: 'file' }), app => scenario(app, `conf-file-${stamp}`));
  const memory = await withApp(config({ STARHALL_STORE: 'memory' }), app => scenario(app, `conf-memory-${stamp}`));
  assert.deepEqual(memory, file);
  assert.equal(file.broken.reason, 'EMPTY_DELIVERY');
  assert.equal(file.broken.source, 'automatic');
  assert.equal(file.refund.decision, 'DECLINED');
  assert.equal(file.revision.used, true);
});

test('store conformance: postgres matches file', { skip: !process.env.DATABASE_URL && '需要 DATABASE_URL（Neon）' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-conformance-pg-'));
  const stamp = Date.now().toString(36);
  const file = await withApp(config({ STARHALL_DATA_DIR: dir, STARHALL_STORE: 'file' }), app => scenario(app, `conf-file-${stamp}`));
  const pg = await withApp(config({ STARHALL_MODE: 'cloud', STARHALL_STORE: 'postgres', DATABASE_URL: process.env.DATABASE_URL }), app => scenario(app, `conf-pg-${stamp}`));
  assert.deepEqual(pg, file);
});

test('rate limit is enforced through the store on every driver', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-ratelimit-'));
  const drivers = [
    ['file', config({ STARHALL_DATA_DIR: dir, STARHALL_STORE: 'file' })],
    ['memory', config({ STARHALL_STORE: 'memory' })],
  ];
  if (process.env.DATABASE_URL) drivers.push(['postgres', config({ STARHALL_MODE: 'cloud', STARHALL_STORE: 'postgres', DATABASE_URL: process.env.DATABASE_URL })]);
  for (const [name, options] of drivers) {
    const store = await createStore(options).open();
    try {
      const key = `rate-${name}-${Date.now().toString(36)}`;
      await store.rateLimit({ bucket: 'test', key, perHour: 2 });
      await store.rateLimit({ bucket: 'test', key, perHour: 2 });
      await assert.rejects(store.rateLimit({ bucket: 'test', key, perHour: 2 }), e => e.code === 'rate_limited', `${name} 第三次调用必须被限流`);
      await store.rateLimit({ bucket: 'test', key, perHour: 0 });
    } finally { await store.close(); }
  }
});
