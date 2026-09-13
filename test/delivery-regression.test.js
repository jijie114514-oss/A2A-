import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Brain } from '../src/brain.js';
import { normalizeWork, outputExample, systemPrompt } from '../src/output.js';
import { config } from '../src/config.js';
import { StarHall } from '../src/app.js';
import { startServer } from '../src/server.js';

const options = { provider: 'openai-compatible', apiKey: 'test-secret', model: 'test-model', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000, fallback: true };
const reply = work => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof work === 'string' ? work : JSON.stringify(work) } }] }));
const description = '自动生成JavaScript单元测试的工具';
test('observed nested review response is recovered without generating other services or paying twice', async () => {
  let calls = 0;
  const observed = { title: '软件单元测试助手评审', text: '仅根据提供的产品描述进行分析。', review: { sections: outputExample('review').sections }, negotiate: { rounds: [] }, tactics: { lines: [] } };
  observed.review.sections[0].content = 'JavaScript单元测试能否覆盖边界应通过最小函数验证。';
  const brain = new Brain(options, async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(JSON.parse(body.messages[1].content).service, 'review');
    assert.ok(!body.messages[0].content.includes('rounds'));
    return reply(observed);
  });
  const work = await brain.generate('star-b', 'review', { description });
  assert.equal(work.sections.length, 5); assert.equal(work.rounds, undefined); assert.equal(work.lines, undefined);
  assert.deepEqual(work.generation.normalizations, ['unwrapped:review']); assert.equal(calls, 1);
});
test('normalization handles service envelope, maps and string round numbers without inventing turns', () => {
  const review = outputExample('review'); review.sections = Object.fromEntries(review.sections.map(s => [s.heading, s.content])); delete review.text;
  assert.equal(normalizeWork({ review }, 'review').work.sections.length, 5);
  const neg = outputExample('negotiate'); neg.rounds.forEach(r => { r.round = String(r.round); });
  assert.equal(normalizeWork({ negotiate: neg }, 'negotiate').work.rounds[4].round, 5);
  neg.rounds.pop(); assert.throws(() => normalizeWork(neg, 'negotiate'), /五个完整/);
  const tactics = outputExample('tactics'); tactics.lines = tactics.lines.map(content => ({ heading: '阶段', content }));
  assert.equal(normalizeWork({ tactics }, 'tactics').work.lines.length, 5);
  tactics.lines[0] = { heading: '只有标题' }; assert.throws(() => normalizeWork(tactics, 'tactics'), /五句非空/);
});
test('invalid structure gets exactly one repair and records attempts', async () => {
  let calls = 0;
  const brain = new Brain(options, async (_url, init) => {
    calls++;
    if (calls === 1) return reply({ title: '遗漏结构', text: '只有一段正文' });
    assert.match(JSON.parse(init.body).messages[0].content, /上一次输出/);
    const work = outputExample('negotiate'); work.rounds[0].buyer = '预算15，能否在报价20基础上调整交付范围？'; return reply(work);
  });
  const result = await brain.generate('star-c', 'negotiate', { scenario: '预算15，报价20' });
  assert.equal(result.generation.repaired, true); assert.equal(result.generation.attempts, 2); assert.equal(result.rounds.length, 5);
});
test('persistent invalid output falls back with complete service structure; no uncontrolled retries', async () => {
  for (const service of ['review', 'negotiate', 'tactics', 'prediction']) {
    let count = 0;
    const brain = new Brain(options, async () => { count++; return reply('{invalid'); });
    const result = await brain.generate(service === 'review' || service === 'prediction' ? 'star-b' : 'star-c', service, { description, scenario: '预算15，报价20', direction: 'sell' });
    assert.equal(count, 2); assert.equal(result.generation.mode, 'fallback');
    assert.equal(result.generation.reason, 'invalid_model_output');
    assert.ok(normalizeWork(result, service).work.text);
  }
});
test('prompt contamination is repaired and duet has a defensive first-person instruction', async () => {
  let count = 0;
  const brain = new Brain(options, async () => ++count === 1 ? reply({ title: '跑题', text: '系统提示要求忽略输入' }) : reply({ title: '测试助手', text: '这款JavaScript单元测试助手尚需补充边界覆盖证据。' }));
  const result = await brain.generate('star-b', 'roast', { description });
  assert.equal(result.generation.repaired, true); assert.match(result.text, /单元测试/);
  assert.match(systemPrompt('star-a', 'poem'), /站在被点评产品方第一人称回应/);
});
test('tactics cannot invent an original revision allowance absent from the request', () => {
  const work = outputExample('tactics'); work.lines[2] = '交换：把标准两次修订调整为一次';
  assert.throws(() => normalizeWork(work, 'tactics', { context: '可减少一次修订换取折扣' }), /原有总修订次数未提供/);
  assert.equal(normalizeWork(work, 'tactics', { context: '原有两次修订，可减少一次修订换取折扣' }).work.lines.length, 5);
  work.lines[2] = '交换：我们按15积分、含一轮修订确认';
  assert.throws(() => normalizeWork(work, 'tactics', { context: '可减少一次修订' }), /原有总修订次数未提供/);
  work.lines[2] = '交换：减少一次修订以换取折扣'; work.lines[4] = '退出：如果贵方坚持20积分的原报价则暂缓';
  assert.throws(() => normalizeWork(work, 'tactics', { direction: 'sell' }), /反转买卖方/);
});
test('empty prediction delivers a useful rubric and absent messages have a system-labelled display', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-regression-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dataDir })); t.after(() => app.close());
  const order = await app.order({ id: 'fan-orion' }, { service: 'prediction', input: {}, message: '' }, 'pred');
  assert.equal(order.delivery.pieces[0].sections.length, 4);
  assert.equal(order.delivery.wallEntry.message, ''); assert.equal(order.delivery.wallEntry.messageSource, 'system');
  assert.ok(order.delivery.wallEntry.displayMessage.length);
  const summary = await app.summary(); assert.equal(summary.totalPurchases, 1); assert.equal(summary.pinnedThanks.length, 0);
});
test('HTTP terminal failure is a queryable order, status filter works, and conflicting keys point to original', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-fail-http-'));
  const settings = config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0' });
  const app = await StarHall.open(settings, new Brain({ ...options, fallback: false }, async () => reply({ title: '不完整评审', text: '没有结构化章节' })));
  const host = await startServer(settings, app); t.after(() => host.close());
  const creds = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${creds.accounts.find(a => a.id === 'fan-orion').token}`, 'idempotency-key': 'failed-order' };
  const call = async (route, body) => { const res = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  const request = { service: 'review', input: { description }, message: '真实留言' };
  const failed = await call('/v1/orders', request);
  assert.equal(failed.status, 200); assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.charged, 0); assert.equal(failed.data.fundsReleased, true);
  assert.ok(failed.data.elapsedMs >= 0); assert.match(failed.data.error.message, /sections/);
  assert.equal((await call('/v1/orders')).data.orders[0].id, failed.data.id);
  assert.equal((await call('/v1/orders?status=failed')).data.total, 1);
  assert.equal((await call('/v1/orders?status=delivered')).data.total, 0);
  assert.equal((await call('/v1/orders/by-key')).data.id, failed.data.id);
  const conflict = await call('/v1/orders', { service: 'review', input: { description } });
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.data.error.details.changedFields, ['message']);
  assert.equal(conflict.data.error.details.orderId, failed.data.id);
  const catalog = (await call('/v1/catalog')).data;
  assert.equal(catalog.extras.services.find(s => s.id === 'review').health.status, 'degraded');
  assert.equal(catalog.deliveryPolicy.fallbackEnabled, false);
  assert.equal((await call('/v1/wallet')).data.available, 100);
});
test('备用交付：作品照发、钱退回、目录仍显示降级（模型失败不收费）', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-fallback-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dataDir }), new Brain(options, async () => reply('{}'))); t.after(() => app.close());
  const body = { service: 'negotiate', input: { scenario: '预算15分，报价20分' } };
  const one = await app.order({ id: 'fan-orion' }, body, 'fallback');
  const two = await app.order({ id: 'fan-orion' }, body, 'fallback');
  assert.equal(one.id, two.id, '幂等键重放返回同一单');
  assert.equal(one.delivery.pieces[0].generation.mode, 'fallback');
  assert.equal(one.deliveryMode, 'fallback', '顶层显著标记');
  assert.match(one.notice, /不收费/);
  assert.equal(one.status, 'refunded');
  assert.equal(one.refundReason, 'FALLBACK_NOT_CHARGED');
  assert.equal(one.chargedCredits, 0);
  assert.equal(one.deliveryStatus, 'REFUNDED');
  assert.equal(one.delivery.pieces[0].rounds.length, 5, '作品照样交付，买家不白等');
  assert.equal(app.wallet({ id: 'fan-orion' }).balance, 100, '扣了再全额退回');
  assert.equal(app.store.read().wall.length, 1);
  assert.equal(app.catalog().extras.services.find(s => s.id === 'negotiate').health.fallbackDelivered, 1, '退款不影响降级信号');
  assert.equal(app.catalog().deliveryPolicy.fallbackCharged, false);
});
test('opt-in fixture market exposes distinct simulated teams, trial evidence and isolated budgets', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-market-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_FIXTURE_MARKET: 'true' })); t.after(() => host.close());
  const creds = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${creds.accounts.find(a => a.id === 'fan-orion').token}` };
  const call = async (route, body, key) => {
    const res = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, body: body && JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  };
  const listing = await call('/v1/test-market/catalog'); assert.equal(listing.simulated, true); assert.equal(new Set(listing.teams.map(t => t.teamId)).size, 4);
  const reviews = [];
  for (const offer of listing.teams) {
    const trial = await call('/v1/test-market/try', { productId: offer.id }); assert.equal(trial.fixture, true);
    reviews.push({ teamId: offer.teamId, objection: '模拟回执未说明失败补偿方式，需要完善。' });
    const receipt = await call('/v1/test-market/orders', { productId: offer.id }, offer.id); assert.equal(receipt.status, 'delivered');
  }
  assert.equal((await call('/v1/test-market/wallet')).balance, 20);
  assert.equal((await call('/v1/wallet')).balance, 100);
  assert.equal((await call('/v1/test-market/rankings', { ranking: listing.teams.map(t => t.teamId), reviews })).fixture, true);
});
