import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeWork, outputExample } from '../src/output.js';
import { localWork, Brain } from '../src/brain.js';
import { contentText } from '../src/grounding.js';
import { StarHall } from '../src/app.js';
import { startServer } from '../src/server.js';
import { config } from '../src/config.js';

test('context must occur in actual lines, not just an echoed preamble; physical-goods drift rejected', () => {
  const input = { direction: 'buy', context: '向别队买代码审查服务' };
  const work = outputExample('tactics'); work.text = input.context;
  assert.throws(() => normalizeWork(work, 'tactics', input), /正文未应用/);
  work.lines[0] = '开场：这份代码审查怎么验收？';
  work.lines[2] = '交换：我今天提货，请赠送配件';
  assert.throws(() => normalizeWork(work, 'tactics', input), /提货/);
  work.lines[2] = '交换：减少审查范围能否换取折扣？';
  const comparison = normalizeWork(work, 'tactics', input).work.inputComparison;
  assert.equal(comparison.fields[0].provided, input.context);
  assert.ok(comparison.fields[0].points.every(p => p.matched && contentText(work, 'tactics').includes(p.evidence)));
});
test('supplied prediction context yields a conditional assessment, not a claim of absent materials', () => {
  const input = { context: '20家参赛产品，StarHall是唯一娱乐平台' };
  const work = localWork('prediction', input);
  work.sections[1].content += '未提供具体候选产品材料';
  assert.throws(() => normalizeWork(work, 'prediction', input), /已经提供 context/);
  work.sections[1].content = '尚无实际试用结果；用同一输入比较对手。';
  assert.ok(normalizeWork(work, 'prediction', input).work.inputComparison.fields[0].points.every(p => p.matched));
});
test('review cannot replace tipping with video; duet roast must retain all three services', () => {
  const input = { description: 'AI明星打赏平台' };
  const work = localWork('review', input); work.sections[1].content = '应提高视频生成分辨率和帧率';
  assert.throws(() => normalizeWork(work, 'review', input), /视频生成/);
  const multi = { description: '卖诗、吐槽和谈判三种服务的平台' };
  assert.throws(() => normalizeWork({ title: '三种服务', text: '这是一家吐槽平台，笑点之外交付怎么验收？' }, 'roast', multi), /正文未应用/);
  assert.ok(normalizeWork({ title: '三种服务', text: '诗给面子，吐槽要准，谈判要有条件交换；三个柜台不能只共用一份口号。' }, 'roast', multi).work);
});
test('placeholder gets one repair, and unfilled templates never count as live output', async () => {
  let calls = 0;
  const input = { direction: 'buy', context: '采购代码审查服务' };
  const brain = new Brain({ provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'test', timeoutMs: 1000, fallback: false }, async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.equal(JSON.parse(request.messages[1].content).taskMaterial[0].provided, input.context);
    const work = localWork('tactics', input);
    if (calls === 1) work.lines[3] = '收口：按【待双方确认的金额】支付';
    else assert.match(request.messages[0].content, /模板占位符/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(work) } }] }));
  });
  const work = await brain.generate('star-c', 'tactics', input);
  assert.equal(work.generation.mode, 'live'); assert.equal(work.generation.attempts, 2);
  assert.ok(!JSON.stringify(work).includes('【待'));
});
test('negotiation cannot invent revision totals or accept a price exceeding the supplied budget', () => {
  const input = { scenario: '采购代码审查服务，预算15积分，报价20积分，可减少一次修订' };
  const work = localWork('negotiate', input);
  work.rounds[4].buyer = '我同意18积分成交。';
  assert.throws(() => normalizeWork(work, 'negotiate', input), /超过输入预算15/);
  work.rounds[4].buyer = '18积分超过预算，无法成交。';
  assert.ok(normalizeWork(work, 'negotiate', input).work);
  work.rounds[1].buyer = '从两次修订减到一次，换取折扣。';
  assert.throws(() => normalizeWork(work, 'negotiate', input), /修订总次数/);
  work.rounds[1].buyer = '原约定是2次修订，减少后为1次修订。';
  assert.throws(() => normalizeWork(work, 'negotiate', input), /修订总次数/);
});
test('practice preserves seller role and does not confuse an opening quote with the accepted price', () => {
  const input = { scenario: '代码审查报价20积分，买方预算15积分，可减少一次修订', message: '我接受一次修订，但需要具体异议与验证建议' };
  const work = { title: '对手回应', text: '我方预算只有15积分，代码审查能否少一次修订？', coaching: '明确验收标准' };
  assert.throws(() => normalizeWork(work, 'practice', input), /角色反转/);
  work.text = '原报价20积分，你已接受一次修订，我可以在15积分内提供代码审查、具体异议和验证建议，请确认范围。';
  assert.ok(normalizeWork(work, 'practice', input).work);
  work.text = '双方已确认18积分成交，包含一次修订。';
  assert.throws(() => normalizeWork(work, 'practice', input), /超过输入预算/);
});
test('the official Chinese product name is accepted as evidence for StarHall', () => {
  const work = { title: '星辉舞台的答卷', text: '我们明星的诗回答质疑，吐槽磨亮棱角，谈判守住承诺；打赏要靠下一次兑现。' };
  const result = normalizeWork(work, 'poem', { description: 'StarHall的AI明星提供诗、吐槽、谈判服务', recipient: 'StarHall', theme: '用交付回应质疑' }).work;
  assert.ok(result.inputComparison.fields.every(f => f.points.every(p => p.matched)));
  const poetic = normalizeWork({ title: '星辉舞台', text: '我们的诗用交付说话，吐槽与谈判各有方向，打赏要值得。' }, 'poem', { description: 'StarHall的AI明星卖诗、吐槽与谈判', theme: '用交付回应质疑' }).work;
  assert.equal(poetic.inputComparison.fields.find(f => f.field === 'theme').minimumMatches, 1);
  assert.throws(() => normalizeWork({ title: '泛泛作品', text: '春风又绿江南岸。' }, 'poem', { theme: '用交付回应质疑' }), /至少应用一个主题要点/);
});
test('defensive poem cannot invent refund buttons or claim an unwritten return policy', () => {
  const input = { description: 'StarHall卖诗、吐槽、谈判', theme: '用交付回应', recipient: 'StarHall', stance: 'defend' };
  const work = { title: 'StarHall', text: '诗、吐槽、谈判靠交付回应；退款按钮就在旁边，返工规则里写着。' };
  assert.throws(() => normalizeWork(work, 'poem', input), /未提供的功能承诺/);
  work.text = '我们卖诗、吐槽、谈判，承认验证还不够全。把下一次交付摆在面前，让结果回应质疑。——星A';
  assert.ok(normalizeWork(work, 'poem', input).work);
  work.text += '我们没有退款按钮，也没有自动返工。';
  assert.ok(normalizeWork(work, 'poem', input).work);
});
test('duet propagates context to both stars; health attributes each child separately and shoutout is queryable', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-context-'));
  const received = [];
  const brain = { options: { fallback: true }, generate: async (star, service, input) => {
    received.push({ star, service, input });
    return { ...localWork(service, input), generation: { mode: star === 'star-a' ? 'fallback' : 'live' } };
  } };
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir }), brain); t.after(() => app.close());
  const input = { description: '卖诗、吐槽和谈判的平台', theme: '回应质疑', recipient: 'StarHall', context: '三种服务由不同明星提供' };
  const order = await app.order({ id: 'fan-orion' }, { service: 'duet', input }, 'duet');
  assert.equal(order.status, 'delivered'); assert.equal(received.length, 2);
  for (const call of received) assert.equal(call.input.context, input.context);
  assert.equal(received[1].input.stance, 'defend'); assert.ok(received[1].input.critique);
  assert.equal(order.shoutout, order.delivery.shoutout); assert.ok(order.shoutout.includes('8分'));
  assert.equal(app.getOrder({ id: 'fan-orion' }, order.id).shoutout, order.shoutout);
  const health = Object.fromEntries(app.catalog().extras.services.map(s => [s.id, s.health]));
  assert.equal(health.roast.liveDelivered, 1); assert.equal(health.poem.fallbackDelivered, 1); assert.equal(health.duet.fallbackDelivered, 1);
});
test('HTTP trials are idempotent, persist and cannot inflate sales or grant member wall; paid keys are independent', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-trial-'));
  const settings = config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0' });
  const host = await startServer(settings); t.after(() => host.close());
  const creds = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
  const headers = { authorization: `Bearer ${creds.accounts.find(a => a.id === 'fan-orion').token}`, 'content-type': 'application/json', 'idempotency-key': 'one' };
  const call = async (route, body, key = 'one') => {
    const res = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { ...headers, 'idempotency-key': key }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const body = { service: 'patron', input: { occasion: '上线', recipient: '测试队' } };
  const catalog = (await call('/v1/catalog')).body;
  assert.equal(catalog.services.find(s => s.id === 'market-board').price, 0);
  assert.deepEqual(catalog.extras.services.find(s => s.id === 'tactics').inputSchema.properties.direction.enum, ['buy', 'sell']);
  const replies = await Promise.all(Array.from({ length: 5 }, () => call('/v1/trials', body)));
  assert.ok(replies.every(r => r.status === 200 && r.body.status === 'delivered'));
  assert.equal(new Set(replies.map(r => r.body.id)).size, 1);
  const trial = replies[0].body;
  assert.equal(trial.charged, 0); assert.equal(trial.delivery.fullWall, undefined); assert.equal(trial.delivery.wallEntry.pinned, false);
  assert.equal((await call('/v1/trials/by-key')).body.id, trial.id);
  assert.equal((await call('/v1/wall')).status, 403);
  assert.equal((await call('/v1/trials', body, 'two')).body.error.code, 'trial_used');
  const summary = (await call('/v1/summary')).body;
  assert.equal(summary.totalTrials, 1); assert.equal(summary.totalPurchases, 0); assert.equal(summary.totalCredits, 0); assert.equal(summary.pinnedThanks.length, 0);
  assert.equal(summary.ranking.reduce((n, s) => n + s.tips, 0), 0);
  assert.equal((await call('/v1/wallet')).body.balance, 100);
  const paid = (await call('/v1/orders', body)).body;
  assert.notEqual(paid.id, trial.id); assert.equal(paid.charged, 12); assert.equal((await call('/v1/orders/by-key')).body.id, paid.id);
  assert.equal((await call('/v1/wall')).status, 200);
  await host.close();
  const reopened = await StarHall.open(settings); t.after(() => reopened.close());
  assert.equal(reopened.orderByKey({ id: 'fan-orion' }, 'one', true).id, trial.id);
  await assert.rejects(reopened.order({ id: 'fan-orion' }, body, 'new', { trial: true }), e => e.code === 'trial_used');
});
test('broker demo records honest zero-credit activity through star and ledger, without broker ledger access', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-demo-count-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir })); t.after(() => app.close());
  const demo = await app.demo({ id: 'broker' }, { input: { theme: '开场', recipient: '所有队伍' } });
  assert.equal(demo.wallEntry.kind, 'demo');
  const summary = await app.summary(); assert.equal(summary.totalDemos, 1); assert.equal(summary.totalTrials, 0); assert.equal(summary.totalPurchases, 0);
  await assert.rejects(app.summary({ id: 'broker' }), e => e.status === 403);
});
