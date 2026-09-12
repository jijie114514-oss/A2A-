import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { getService } from '../src/catalog.js';
import { SERVICES as ALL_SERVICES } from '../src/catalog.js';
import { resource } from '../src/kernel.js';
import { rehearseArena, fixtureMarket, planPurchases } from '../src/arena.js';

const SERVICES = ALL_SERVICES.filter(s => !s.commercial);
const buyer = { id: 'fan-orion' }; const other = { id: 'fan-lyra' }; const broker = { id: 'broker' };
const poem = { service: 'poem', input: { theme: '雨夜写代码', recipient: '猎户座队' }, message: 'PRIVATE-MESSAGE' };
const inputs = { poem: poem.input, speech: { occasion: '产品发布', recipient: '用户' }, patron: { occasion: '庆祝上线', recipient: '用户' },
  roast: { description: '自动写代码的工具' }, review: { description: '数据分析工具' }, prediction: {}, negotiate: { scenario: '预算10分，报价15分' }, tactics: { direction: 'buy' },
  duet: { description: '万能自动化工具', theme: '用交付回应质疑', recipient: '队伍' },
  'ad-spot': { text: '猎户座代码审查服务：15分一次，5分钟内交付结构化报告。' }, 'ad-pin': { text: '织女座专属提醒：冠军预测每晚9点更新。' }, 'ad-sponsor': { text: '天琴座冠名支持本场演出。' } };
async function setup(t, brain) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-test-'));
  const settings = config({ STARHALL_DATA_DIR: dir });
  const app = await StarHall.open(settings, brain);
  t.after(() => app.close()); return { app, dir, settings };
}
test('every listed service delivers at its exact price; duet calls independent stars', async t => {
  const { app, dir } = await setup(t);
  for (let i = 0; i < SERVICES.length; i++) {
    const s = SERVICES[i]; const actor = i % 2 ? other : buyer;
    const before = app.wallet(actor).balance;
    const order = await app.order(actor, { service: s.id, input: inputs[s.id] }, `all-${s.id}`);
    assert.equal(order.status, 'delivered', JSON.stringify(order)); assert.equal(app.wallet(actor).balance, before - s.price);
    assert.ok(order.elapsedMs < s.maxDeliverySeconds * 1000);
    if (s.id === 'duet') assert.deepEqual(order.delivery.pieces.map(p => p.star), ['star-b', 'star-a']);
    if (s.id === 'negotiate') assert.equal(order.delivery.pieces[0].rounds.length, 5);
    if (s.id === 'patron') assert.ok(order.delivery.summary.pinnedThanks.length);
  }
  assert.equal((await app.wall(buyer)).wall.length, 12);
  const audit = (await readFile(path.join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const star of ['star-a', 'star-b', 'star-c', 'ledger']) assert.ok(audit.some(e => e.type === 'turn.ended' && e.actor.agentId === star && e.outcome === 'succeeded'));
  for (const purpose of ['market-tip', 'ledger-update']) assert.ok(audit.some(e => e.purpose === purpose));
});
test('summary hides comments, membership grants full wall, broker cannot touch ledger', async t => {
  const { app } = await setup(t);
  await assert.rejects(app.wall(buyer), e => e.status === 403);
  await assert.rejects(app.wall(broker), e => e.status === 403);
  await assert.rejects(app.summary(broker), e => e.status === 403);
  await assert.rejects(app.order(broker, poem, 'broker-buy'), e => e.status === 403);
  await app.order(buyer, poem, 'paid');
  assert.equal((await app.wall(buyer)).wall[0].message, 'PRIVATE-MESSAGE');
  assert.ok(!JSON.stringify(await app.summary()).includes('PRIVATE-MESSAGE'));
  await assert.rejects(app.wall(other), e => e.status === 403);
  assert.equal(app.wallet(broker).balance, 100);
});
test('kernel rejects wrong purpose, fan ledger writes, and star reading broker files', async t => {
  const { app } = await setup(t);
  await assert.rejects(app.bridge.call('fan-orion', 'arena-demo', 'service_poem', {}), e => e.status === 403);
  await assert.rejects(app.bridge.call('fan-orion', 'ledger-update', 'ledger_record', {}), e => e.status === 403);
  const decision = await app.bridge.kernel.authorize(app.bridge.context('star-a', 'market-tip'), { resource: resource('files/broker'), action: 'read' });
  assert.equal(decision.allowed, false);
  const demo = await app.demo(broker, { input: poem.input }); assert.equal(demo.charged, 0);
  assert.equal((await app.summary()).ranking.reduce((n, s) => n + s.tips, 0), 0);
});
test('recipient ledger authority is independently enforced; revocation prevents settlement', async t => {
  const { app } = await setup(t);
  const original = app.bridge.grants.bind(app.bridge);
  app.bridge.grants = id => original(id).filter(g => g.id !== 'ledger:ledger/storage-record');
  const order = await app.order(buyer, poem, 'revoked-ledger');
  assert.equal(order.status, 'failed');
  assert.equal(app.wallet(buyer).balance, 100); assert.equal(app.wallet(buyer).held, 0);
  assert.equal(app.store.read().wall.length, 0);
});
test('same-key parallel requests deliver once; changed body conflicts; buyer scopes keys', async t => {
  const { app } = await setup(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => app.order(buyer, poem, 'same')));
  assert.equal(new Set(results.map(o => o.id)).size, 1);
  assert.equal(app.wallet(buyer).balance, 95); assert.equal(app.store.read().wall.length, 1);
  await assert.rejects(app.order(buyer, { ...poem, message: 'changed' }, 'same'), e => e.status === 409);
  assert.notEqual((await app.order(other, poem, 'same')).id, results[0].id);
  assert.throws(() => app.getOrder(other, results[0].id), e => e.status === 404);
});
test('parallel reservations cannot overspend and failed generation releases holds', async t => {
  const { app } = await setup(t);
  // 余额从目录取，不再写死：只够买一件，第二件必须被拒。
  const poemPrice = getService('poem').price;
  await app.store.transaction(s => { s.accounts.find(a => a.id === buyer.id).balance = poemPrice * 2 - 1; });
  const results = await Promise.allSettled([app.order(buyer, poem, 'one'), app.order(buyer, poem, 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.status === 'delivered').length, 1);
  assert.equal(app.wallet(buyer).balance, poemPrice - 1); assert.equal(app.wallet(buyer).held, 0);
  const failed = await setup(t, { generate: async () => { throw new Error('secret-provider-detail'); } });
  const order = await failed.app.order(buyer, poem, 'failure'); assert.equal(order.status, 'failed');
  assert.equal(failed.app.wallet(buyer).balance, 100); assert.equal(failed.app.wallet(buyer).held, 0);
  assert.equal(failed.app.store.read().wall.length, 0); assert.ok(!JSON.stringify(order).includes('secret-provider-detail'));
});
test('memory is private per star and buyer; returning fans receive a greeting', async t => {
  const { app } = await setup(t);
  await app.order(buyer, poem, 'memory-1');
  const repeat = await app.order(buyer, poem, 'memory-2'); assert.match(repeat.delivery.pieces[0].greeting, /欢迎回来/);
  const newcomer = await app.order(other, poem, 'memory-3'); assert.match(newcomer.delivery.pieces[0].greeting, /初次见面/);
  await assert.rejects(app.bridge.call('star-b', 'market-tip', 'memory_star-a', { buyerId: buyer.id }), e => e.status === 403);
});
test('out-of-catalog request escalates in the SDK, then broker declines without charging', async t => {
  const { app, dir } = await setup(t);
  const result = await app.request(buyer, { star: 'star-a', request: '写一整本答辩书并提交' });
  assert.equal(result.status, 'escalated'); assert.equal(result.decision.status, 'declined'); assert.ok(result.decision.recommendations.length);
  assert.equal(app.wallet(buyer).balance, 100);
  const audit = await readFile(path.join(dir, 'audit.jsonl'), 'utf8'); assert.match(audit, /escalation.requested/); assert.match(audit, /escalation-review/);
});
test('five interactive rounds preserve ownership and idempotency, with no new charge', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, { service: 'negotiate', input: inputs.negotiate }, 'neg');
  const id = order.delivery.practice.sessionId;
  await assert.rejects(app.practice(other, id, { message: 'hello' }, 'bad'), e => e.status === 404);
  for (let i = 1; i <= 5; i++) {
    const reply = await app.practice(buyer, id, { message: `我的提议${i}` }, `round-${i}`);
    assert.equal(reply.round, i); assert.equal(reply.remaining, 5 - i);
  }
  assert.equal((await app.practice(buyer, id, { message: '我的提议1' }, 'round-1')).round, 1);
  await assert.rejects(app.practice(buyer, id, { message: '再来一次' }, 'round-6'), e => e.code === 'session_completed');
  assert.equal(app.wallet(buyer).balance, 92);
});
// file 驱动专属：重启即中断（pending → failed）与 projections 落盘只在单进程本地语义下成立。
test('restart preserves delivery, membership and idempotency; pending holds recover', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-restart-')); const settings = config({ STARHALL_DATA_DIR: dir });
  const first = await StarHall.open(settings);
  const order = await first.order(buyer, poem, 'persisted');
  await first.store.transaction(s => { s.orders.push({ id: 'pending-crash', buyerId: buyer.id, status: 'pending', price: 80 }); });
  await first.close();
  const second = await StarHall.open(settings); t.after(() => second.close());
  assert.equal((await second.order(buyer, poem, 'persisted')).id, order.id);
  assert.equal(second.wallet(buyer).balance, 95); assert.equal(second.wallet(buyer).held, 0);
  assert.equal(second.getOrder(buyer, 'pending-crash').status, 'failed');
  assert.equal((await second.wall(buyer)).wall.length, 1);
  const works = JSON.parse(await readFile(path.join(dir, 'stars', 'star-a', 'works', `${order.id}.json`), 'utf8'));
  assert.equal(works.star, 'star-a');
  await assert.rejects(StarHall.open(settings), e => e.code === 'data_locked');
});
test('rejects client supplied prices, identities, grants and invalid direction', async t => {
  const { app } = await setup(t);
  for (const field of ['price', 'buyerId', 'grants', 'purpose', 'actor']) await assert.rejects(app.order(buyer, { ...poem, [field]: 'forged' }, field), e => e.code === 'invalid_input');
  await assert.rejects(app.order(buyer, { service: 'tactics', input: { direction: 'BUY' } }, 'direction'), e => e.code === 'invalid_input');
  await assert.rejects(app.order(buyer, poem, ''), e => e.code === 'invalid_input');
});
test('arena uses distinct teams, real fixture receipts, and exactly 80 credits', async () => {
  const result = await rehearseArena(fixtureMarket());
  assert.equal(result.spent, 80); assert.equal(result.differentTeams, 4); assert.equal(result.ranking[0], 'starhall');
  assert.ok(result.reviews.every(r => r.objection.length > 20));
  assert.throws(() => planPurchases([{ teamId: 'one', id: '1', price: 80 }]), /候选价格/);
});
