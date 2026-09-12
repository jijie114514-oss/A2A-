import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { marketBoard, boardResponse } from '../src/market.js';
import { normalizeSales, localSales } from '../src/sales.js';
import { Brain, localWork } from '../src/brain.js';
import { resource } from '../src/kernel.js';
import { AppError } from '../src/errors.js';

const buyer = { id: 'fan-orion' }, other = { id: 'fan-lyra' }, third = { id: 'fan-vega' };
const pitch = { service: 'sales-pitch', input: { productName: 'CodeLens', productDescription: '代码审查服务，输出风险位置和修复建议', price: 20, targetBuyer: 'coding agents' } };
const stress = { service: 'sales-stress-test', input: pitch.input };
const deal = { service: 'deal-coach', input: { currentOffer: 20, budget: 15, minimumAcceptablePrice: 10, goal: '采购代码审查', counterpartyMessage: '请确认验收标准' } };
const sponsor = (starId = 'star-b', plan = 'leaderboard') => ({ service: 'star-sponsorship', input: { starId, plan, advertiser: 'CodeLens', adCopy: '代码审查：输入代码，输出问题位置。' } });
async function setup(t, env = {}, brain) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-commercial-'));
  const settings = config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0', ...env });
  const app = await StarHall.open(settings, brain);
  t.after(() => app.close()); return { app, settings, dir };
}
test('A/E/F: zero-data board, honest trial/demo activity, successful paid fan support and private signals', async t => {
  const { app } = await setup(t);
  const cold = await app.marketBoard();
  assert.equal(cold.phase, 'PRE-MARKET'); assert.deepEqual(cold.recentMarketMoves, []);
  assert.ok(cold.ranking.every(r => r.starScore === 0 && r.activeSponsors === 0));
  const trial = await app.order(buyer, pitch, 'trial', { trial: true });
  assert.equal(trial.status, 'delivered'); assert.equal(app.wallet(buyer).balance, 100);
  assert.ok(trial.delivery.commercialSignalIds.length >= 3);
  const demo = await app.demo({ id: 'broker' }, { input: { theme: '商业明星', recipient: '所有买方' } });
  assert.ok(demo.compactMarketBoard); assert.equal(demo.charged, 0);
  const pre = await app.marketBoard({ id: 'broker' });
  assert.equal(pre.phase, 'PRE-MARKET'); assert.equal(pre.activity.trial, 1); assert.equal(pre.activity.demo, 1);
  assert.ok(pre.ranking.every(r => r.fanSupport === 0));
  const order = await app.order(buyer, pitch, 'paid');
  assert.equal(order.status, 'delivered'); assert.equal(app.wallet(buyer).balance, 95);
  const live = await app.marketBoard(); assert.equal(live.phase, 'MARKET LIVE');
  assert.equal(live.ranking.find(r => r.star === 'star-a').fanSupport, 5);
  assert.equal(live.ranking.find(r => r.star === 'star-a').sponsorSupport, 0);
  const profile = await app.commercialProfile(buyer);
  assert.deepEqual([...new Set(profile.signals.map(s => s.evidenceClass))].sort(), ['BEHAVIORAL', 'EXPLICIT', 'OBSERVED']);
  assert.ok(profile.signals.filter(s => s.evidenceClass === 'BEHAVIORAL').every(s => s.status === 'INFERRED'));
  assert.equal((await app.commercialProfile(other)).signals.length, 0);
  const before = profile.signals.length;
  await app.order(buyer, pitch, 'paid'); assert.equal((await app.commercialProfile(buyer)).signals.length, before);
});
test('B/C/D: star-bound support, plan pricing, total score, rank weights and real sponsor pressure', async t => {
  const { app } = await setup(t);
  await app.order(buyer, pitch, 'pitch'); await app.order(other, deal, 'deal');
  const ad = await app.order(buyer, sponsor(), 'sponsor');
  assert.equal(ad.status, 'delivered'); assert.equal(ad.price, 10);
  assert.equal(ad.delivery.sponsorship.status, 'ACTIVE'); assert.equal(ad.delivery.sponsorship.currentImpressions, 0);
  let board = marketBoard(app.store.read());
  assert.deepEqual(board.ranking.map(r => r.starScore), [10, 6, 5]);
  assert.deepEqual(board.ranking.map(r => r.exposureWeight), [1.5, 1.2, 1]);
  assert.equal(board.ranking.find(r => r.star === 'star-b').fanSupport, 0);
  for (let i = 0; i < 3; i++) await app.order(third, sponsor(), `crowd-${i}`);
  await app.order(other, sponsor('star-c', 'delivery'), 'sparse');
  board = marketBoard(app.store.read());
  assert.equal(board.ranking[0].star, 'star-b'); assert.equal(board.ranking[0].activeSponsors, 4); assert.equal(board.ranking[0].sponsorPressure, 'HIGH');
  assert.equal(board.ranking.find(r => r.star === 'star-c').sponsorPressure, 'LOW');
  assert.equal(app.store.read().memories['star-b'], undefined);
  await app.store.transaction(s => { s.ads.filter(a => a.starId === 'star-b').forEach(a => { a.expiresAt = '2000-01-01T00:00:00Z'; }); });
  board = marketBoard(app.store.read()); assert.equal(board.ranking.find(r => r.star === 'star-b').activeSponsors, 0);
  assert.equal(board.ranking.find(r => r.star === 'star-b').sponsorSupport, 24);
});
test('G/H: passive placement targets its star; activation, reads, retries and failed orders cannot inflate exposure', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor('star-b', 'delivery'), 'ad'); const id = order.delivery.ad.id;
  assert.equal(app.adById(buyer, id).currentImpressions, 0);
  const a = await app.order(other, pitch, 'unrelated');
  assert.equal(a.delivery.compactMarketBoard.sponsors.length, 0); assert.equal(app.adById(buyer, id).currentImpressions, 0);
  const b = await app.order(other, stress, 'target');
  assert.equal(b.delivery.pieces[0].evidenceType, 'SIMULATED');
  assert.equal(b.delivery.compactMarketBoard.sponsors[0].starId, 'star-b');
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  assert.equal(app.adById(buyer, id).traffic.passive, 1);
  assert.deepEqual(await app.order(other, stress, 'target'), b);
  app.getOrder(other, b.id); await app.marketBoard();
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  assert.equal(app.getOrder(buyer, order.id).delivery.ad.displays, 0, 'activation receipt is immutable');
  await assert.rejects(app.order(other, { ...stress, input: {} }, 'bad'), e => e.status === 400);
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  const coach = await app.order(other, deal, 'coach');
  const extra = await app.order(other, { service: 'prediction', input: {} }, 'extra');
  assert.ok([a, b, coach, extra].every(o => o.delivery.compactMarketBoard && o.delivery.recommendedNextAction));
  assert.ok(!b.delivery.pieces[0].text.includes('冠名呈现'));
});
test('H: active board views record real events once per receipt; expiry and trial cap stop impressions', async t => {
  const { app } = await setup(t);
  const ad = await app.order(buyer, sponsor(), 'ad'); const id = ad.delivery.ad.id;
  const first = await app.marketBoard(other, 'query'); const replay = await app.marketBoard(other, 'query');
  assert.deepEqual(first, replay); assert.equal(app.adById(buyer, id).currentImpressions, 1);
  await app.marketBoard(third, 'query'); assert.equal(app.adById(buyer, id).currentImpressions, 2);
  await app.store.transaction(s => { s.ads.find(a => a.id === id).expiresAt = '2000-01-01T00:00:00Z'; });
  assert.deepEqual((await app.marketBoard()).sponsors, []); assert.equal(app.adById(buyer, id).currentImpressions, 2);
  const trial = await app.order(buyer, sponsor('star-a', 'delivery'), 'trial-ad', { trial: true });
  for (let i = 0; i < 3; i++) await app.order(other, pitch, `view-${i}`);
  const stats = app.adById(buyer, trial.delivery.ad.id);
  assert.equal(stats.currentImpressions, 2); assert.equal(stats.status, 'fulfilled');
  assert.equal(marketBoard(app.store.read()).ranking.find(r => r.star === 'star-a').sponsorSupport, 0);
});
test('C/H: weighted shared slots give all stars exposure and rotate competing sponsors', () => {
  const state = { orders: [], ads: [], wall: [], marketSettings: { sponsorSupportWeight: 0.6, exposureMultipliers: [1.5, 1.2, 1] } };
  for (const starId of ['star-a', 'star-b', 'star-c']) {
    const id = `ad-${starId}`; const ad = { id, orderId: id, buyerId: starId, starId, tier: 'ad-pin', advertiser: 'Fixture', text: 'Fixture ad', status: 'active', kind: 'paid', displays: 0, createdAt: '2026-01-01' };
    state.ads.push(ad); state.orders.push({ id, status: 'delivered', price: 10, delivery: { ad } });
  }
  for (let i = 0; i < 37; i++) boardResponse(state, 'public');
  assert.deepEqual(state.ads.map(a => a.displays), [15, 12, 10]);
  assert.equal(state.impressions.length, 37);
});
test('I: diagnostic uses own history and impressions; all findings carry evidence/status and recommend exactly three actions', async t => {
  const { app } = await setup(t);
  await app.order(buyer, pitch, 'pitch'); await app.order(buyer, deal, 'deal');
  const ad = await app.order(buyer, sponsor(), 'ad'); await app.marketBoard(other);
  await app.order(other, { service: 'sales-pitch', input: { productDescription: 'PRIVATE-OTHER-PRODUCT' } }, 'private');
  const order = await app.order(buyer, { service: 'commercial-diagnostic', input: { goal: '优化销售', price: 20 } }, 'diagnostic');
  assert.equal(order.status, 'delivered', JSON.stringify(order.error)); assert.equal(order.price, 30);
  const work = order.delivery.pieces[0];
  const required = ['currentCommercialProfile', 'positioningDiagnosis', 'salesCommunicationDiagnosis', 'pricingDiagnosis', 'negotiationDiagnosis', 'distributionDiagnosis', 'evidenceSummary', 'mainBottleneck', 'recommendedNext3Actions'];
  assert.ok(required.every(key => work[key])); assert.equal(work.recommendedNext3Actions.length, 3);
  assert.ok(work.evidenceSummary.evidence.some(e => e.id === `campaign:${ad.delivery.ad.id}`));
  assert.ok(work.evidenceSummary.evidence.some(e => e.field === 'adImpression'));
  assert.ok(!JSON.stringify(work).includes('PRIVATE-OTHER-PRODUCT'));
  const evidenceIds = new Set(work.evidenceSummary.evidence.map(e => e.id));
  const findings = required.flatMap(key => key === 'evidenceSummary' ? work[key].findings : work[key]);
  assert.deepEqual([...new Set(findings.map(f => f.status))].sort(), ['INFERRED', 'KNOWN', 'UNKNOWN']);
  assert.ok(findings.every(f => f.evidenceRefs.every(id => evidenceIds.has(id))));
  assert.ok(findings.filter(f => f.status !== 'UNKNOWN').every(f => f.evidenceRefs.length > 0));
  assert.equal(order.delivery.recommendedNextAction.action, 'validate-with-a-real-buyer');
  assert.equal(app.wallet(buyer).balance, 45);
});
test('I/permissions: manager gets only public board; buyer cannot choose another profile, stars cannot read storage; revoked diagnostic grant releases funds', async t => {
  const { app } = await setup(t);
  assert.equal((await app.marketBoard({ id: 'broker' })).price, 0);
  await assert.rejects(app.commercialProfile({ id: 'broker' }), e => e.status === 403);
  await assert.rejects(app.bridge.call(buyer.id, 'commercial-analysis-read', 'commercial_profile', { buyerId: other.id }), e => e.status === 400);
  await assert.rejects(app.bridge.call('star-c', 'commercial-analysis-read', 'analysis_storage', { buyerId: buyer.id }), e => e.status === 403);
  await assert.rejects(app.bridge.call(buyer.id, 'summary', 'market_board'), e => e.status === 403);
  const check = await app.bridge.kernel.authorize(app.bridge.context('broker', 'market-board-read'), { resource: resource('ledger/storage-record'), action: 'write' });
  assert.equal(check.allowed, false);
  const grants = app.bridge.grants.bind(app.bridge);
  app.bridge.grants = id => grants(id).filter(g => g.id !== 'ledger:ledger/storage-analysis');
  const failed = await app.order(buyer, { service: 'commercial-diagnostic', input: {} }, 'denied');
  assert.equal(failed.status, 'failed'); assert.equal(failed.charged, 0); assert.equal(app.wallet(buyer).held, 0);
  assert.equal(app.wallet(buyer).balance, 100);
});
test('refund and failure exclusion: previously delivered refunds lose support and active campaigns, while failures never create signals', async t => {
  const { app } = await setup(t);
  const paid = await app.order(buyer, pitch, 'paid'); const ad = await app.order(buyer, sponsor(), 'ad');
  await app.store.transaction(s => { for (const o of s.orders) { o.status = 'refunded'; o.refundedAt = new Date().toISOString(); } });
  assert.ok(marketBoard(app.store.read()).ranking.every(r => r.starScore === 0 && r.activeSponsors === 0));
  assert.equal((await app.summary()).totalPurchases, 0);
  await assert.rejects(app.wall(buyer), e => e.status === 403);
  assert.equal(app.orders(buyer, 'refunded').length, 2);
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 0);
  assert.ok((await app.commercialProfile(buyer)).signals.filter(s => s.orderId === paid.id).every(s => s.sourceOrderStatus === 'refunded'));
});
test('sales contracts: reject malformed input, host bounds include zero and incompatible limits, live content repairs and fallback remains explicit', async t => {
  const { app } = await setup(t);
  for (const input of [{}, { price: 20 }, { productDescription: '' }, { productDescription: 'x', price: -1 }, { productDescription: 'x', buyerId: other.id }]) await assert.rejects(app.order(buyer, { service: 'sales-pitch', input }, 'invalid'));
  await assert.rejects(app.order(buyer, { service: 'star-sponsorship', input: { ...sponsor().input, starId: 'star-d' } }, 'invalid'));
  for (const input of [{ currentOffer: 20, budget: 15 }, { currentOffer: 5, minimumAcceptablePrice: 10 }, { currentOffer: 20, budget: 0 }, { currentOffer: 20, budget: 5, minimumAcceptablePrice: 10 }]) {
    const work = localSales('deal-coach', input);
    assert.ok(work.recommendedCounteroffer === null || work.recommendedCounteroffer <= (input.budget ?? Infinity) && work.recommendedCounteroffer >= (input.minimumAcceptablePrice ?? 0));
  }
  assert.equal(localSales('deal-coach', { currentOffer: 20, budget: 5, minimumAcceptablePrice: 10 }).recommendedCounteroffer, null);
  assert.throws(() => normalizeSales({ recommendedCounteroffer: 21 }, 'deal-coach', deal.input), e => e.code === 'invalid_model_output');
  let calls = 0;
  const cfg = config({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'fixture', LLM_MODEL: 'fixture' });
  const brain = new Brain(cfg.llm, async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); });
  const work = await brain.generate('star-b', stress.service, stress.input);
  assert.equal(calls, 2); assert.equal(work.generation.mode, 'fallback'); assert.equal(work.evidenceType, 'SIMULATED');
  assert.equal(work.topObjections.length, 2);
});
test('HTTP core catalog, schemas, authenticated profile, manager demo board and owned campaign tracking', async t => {
  const { app, settings, dir } = await setup(t);
  const host = await startServer(settings, app);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeIdleConnections(); }));
  const credentials = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
  const call = async (route, actor, body, key) => {
    const token = credentials.accounts.find(a => a.id === actor)?.token;
    const response = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const listing = (await call('/v1/catalog')).body;
  assert.deepEqual(listing.services.map(s => s.id), ['sales-pitch', 'sales-stress-test', 'deal-coach', 'star-sponsorship', 'commercial-diagnostic', 'market-board']);
  assert.equal(listing.extras.services.length, 12); assert.equal(listing.stars.length, 3);
  assert.equal((await call('/v1/market-board', 'broker')).status, 200);
  assert.equal((await call('/v1/commercial-profile')).status, 401);
  assert.equal((await call('/v1/commercial-profile', 'broker')).status, 403);
  assert.equal((await call('/v1/commercial-profile?buyerId=fan-lyra', buyer.id)).status, 400);
  const ad = (await call('/v1/orders', buyer.id, sponsor(), 'http-ad')).body;
  assert.equal(ad.status, 'delivered');
  assert.equal((await call(`/v1/ads/${ad.delivery.ad.id}`, other.id)).status, 404);
  assert.equal((await call('/v1/commercial-profile', buyer.id)).body.campaigns.length, 1);
  const logs = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(logs.includes('market-board-read')); assert.ok(logs.includes('commercial-analysis-read'));
});
test('config centralizes sponsor and exposure weights and refuses invalid policies', async t => {
  const { app } = await setup(t, { SPONSOR_SUPPORT_WEIGHT: '0.5', STAR_EXPOSURE_MULTIPLIERS: '[2,1.5,1]', STARHALL_MARKET_PHASE: 'PRE-MARKET' });
  await app.order(buyer, sponsor(), 'weighted');
  const board = marketBoard(app.store.read()); assert.equal(board.ranking[0].sponsorSupport, 5); assert.equal(board.ranking[0].exposureWeight, 2); assert.equal(board.phase, 'PRE-MARKET');
  for (const env of [{ SPONSOR_SUPPORT_WEIGHT: '-1' }, { STAR_EXPOSURE_MULTIPLIERS: '[1,0,0]' }, { STAR_EXPOSURE_MULTIPLIERS: '[1,3,2]' }, { STARHALL_MARKET_PHASE: 'fake' }]) assert.throws(() => config(env), e => e.code === 'invalid_config');
});
test('delivery failure and denied board calls do not expose ads or create commercial signals', async t => {
  const { app } = await setup(t);
  const ad = await app.order(buyer, sponsor(), 'ad');
  app.brain = { options: { fallback: false }, generate: async () => { throw new AppError('invalid_model_output', 'fixture failure', 502); } };
  const failed = await app.order(other, pitch, 'failed');
  assert.equal(failed.status, 'failed'); assert.equal(app.wallet(other).balance, 100);
  assert.equal((await app.commercialProfile(other)).signals.length, 0);
  await assert.rejects(app.bridge.call('star-a', 'market-board-read', 'market_board'), e => e.status === 403);
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 0);
  assert.equal((await app.commercialProfile(other)).history[0].status, 'failed');
});
test('restart retains sponsor pool, signal references, idempotent board receipts and exposure counters', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-commercial-restart-'));
  const settings = config({ STARHALL_DATA_DIR: dir });
  let app = await StarHall.open(settings); t.after(() => app.close());
  const order = await app.order(buyer, pitch, 'pitch');
  const ad = await app.order(buyer, sponsor(), 'ad');
  const board = await app.marketBoard(other, 'saved');
  await app.close(); app = await StarHall.open(settings);
  assert.deepEqual(await app.marketBoard(other, 'saved'), board);
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 1);
  assert.deepEqual(await app.order(buyer, pitch, 'pitch'), order);
  assert.ok((await app.commercialProfile(buyer)).signals.length > 0);
  assert.equal(marketBoard(app.store.read()).phase, 'MARKET LIVE');
});
test('legacy pin impressions reflect returned summaries; background projections and order lookups add none', async t => {
  const { app } = await setup(t);
  const ad = await app.order(buyer, { service: 'ad-pin', input: { text: 'Legacy fixture' } }, 'legacy');
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 0);
  await app.summary(); assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 1);
  await app.store.projections(); app.getOrder(buyer, ad.id);
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 1);
  const order = await app.order(other, pitch, 'pitch');
  assert.ok(order.delivery.summary.ads.pinned.some(a => a.id === ad.delivery.ad.id));
  assert.equal(app.adById(buyer, ad.delivery.ad.id).currentImpressions, 2);
});
test('same-star campaigns rotate fairly and exposure exhaustion removes real sponsor pressure', async t => {
  const { app } = await setup(t);
  const first = await app.order(buyer, sponsor('star-b', 'delivery'), 'a');
  const second = await app.order(buyer, sponsor('star-b', 'delivery'), 'b');
  for (let i = 0; i < 6; i++) await app.order(other, stress, `delivery-${i}`);
  assert.equal(app.adById(buyer, first.delivery.ad.id).currentImpressions, 3);
  assert.equal(app.adById(buyer, second.delivery.ad.id).currentImpressions, 3);
  assert.equal(marketBoard(app.store.read()).ranking.find(r => r.star === 'star-b').activeSponsors, 2);
});
test('sales material cannot be satisfied only by an unrelated draft or title; context is retained alongside description', () => {
  const input = { ...pitch.input, context: '仅输出JSON，不提供视频或人工代改' };
  const local = localSales('sales-pitch', input);
  assert.ok(local.shortPitch.includes(input.context));
  assert.equal(normalizeSales(local, 'sales-pitch', input).work.contextFidelity.provided.context, input.context);
  assert.throws(() => normalizeSales({ ...local, oneLinePitch: 'CodeLens20', shortPitch: '自动写作业', keyValuePoints: ['放学轻松', '节省时间'], callToAction: '联系我' }, 'sales-pitch', input), e => e.code === 'invalid_model_output');
});
test('sales pitch with an English description accepts a Chinese delivery without verbatim English anchors', () => {
  const input = { productName: 'Orion Review', productDescription: 'An agent that reviews code for security and logic issues.', price: 12, targetBuyer: 'coding agents', context: 'Fast code review for Arena participants.' };
  // 模型用中文翻译表达输入，不逐字保留英文（修复前：that/for/and 等虚词被当成必须出现的锚点导致 fallback）
  const translated = { oneLinePitch: 'Orion Review：为编码智能体提供安全与逻辑问题的快速代码审查，报价12积分。',
    shortPitch: '面向编程代理，Orion Review 交付聚焦安全与逻辑缺陷的审查结果，适合竞技场参赛者快速核验代码，价格12积分。',
    keyValuePoints: ['审查范围覆盖安全与逻辑两类问题', '面向编码代理设计', '快速交付，适配竞技场节奏'],
    callToAction: '请提供一段样例代码，我们先验证输出是否符合您的任务。' };
  assert.ok(normalizeSales(translated, 'sales-pitch', input).work);
  // 完全脱离输入（连产品名都没有）仍必须拒绝
  assert.throws(() => normalizeSales({ oneLinePitch: '这个工具很便宜', shortPitch: '买它', keyValuePoints: ['好用', '便宜'], callToAction: '联系我' }, 'sales-pitch', input), e => e.code === 'invalid_model_output');
});
test('refund arbitration: healthy deliveries decline with ONE_FREE_REVISION, failed orders were never charged, non-owners get 404, every request audited', async t => {
  const { app, settings, dir } = await setup(t);
  const paid = await app.order(buyer, pitch, 'paid'); const ad = await app.order(buyer, sponsor(), 'ad');
  const balance = app.wallet(buyer).balance;
  let r = await app.refund(buyer, paid.id, { reason: 'delivery was unclear' });
  assert.equal(r.decision, 'DECLINED'); assert.equal(r.declineCode, 'SUBJECTIVE_NOT_REFUNDABLE');
  assert.equal(r.refundEligible, false); assert.equal(r.remedy, 'ONE_FREE_REVISION'); assert.equal(r.revisionAvailable, true);
  assert.equal(r.order.status, 'delivered');
  assert.equal(app.wallet(buyer).balance, balance);
  assert.equal(app.getOrder(buyer, paid.id).status, 'delivered');
  assert.equal(app.getOrder(buyer, paid.id).revisionAvailable, true);
  r = await app.refund(buyer, paid.id); assert.equal(r.decision, 'DECLINED');
  await assert.rejects(app.refund(buyer, other.id), e => e.status === 404);
  await assert.rejects(app.refund(buyer, ad.delivery.ad.id), e => e.status === 404);
  assert.equal(marketBoard(app.store.read()).ranking.find(r => r.star === 'star-a').fanSupport, 5);
  assert.equal(marketBoard(app.store.read()).ranking.find(r => r.star === 'star-b').sponsorSupport, 6);
  app.brain = { options: { fallback: false }, generate: async () => { throw new AppError('invalid_model_output', 'fixture failure', 502); } };
  const failed = await app.order(buyer, pitch, 'failed');
  assert.equal(failed.status, 'failed'); assert.equal(failed.charged, 0);
  r = await app.refund(buyer, failed.id, { reason: 'no delivery' });
  assert.equal(r.decision, 'NOT_CHARGED'); assert.equal(r.refundEligible, false);
  const audit = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.equal((audit.match(/starhall\.refund\.requested/g) || []).length, 3);
  const host = await startServer(settings, app);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeIdleConnections(); }));
  const creds = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
  const token = creds.accounts.find(a => a.id === buyer.id).token;
  const res = await fetch(`${host.url}/v1/orders/${paid.id}/refund`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'want money back' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, 'DECLINED');
  assert.equal(body.machineDecided, true);
  assert.equal(body.remedy, 'ONE_FREE_REVISION');
  assert.equal(body.order.status, 'delivered');
  assert.equal(app.getOrder(buyer, paid.id).status, 'delivered');
});
test('market moves: pressure changes and rank wording come from real ledger events; trial campaigns labelled without Sponsor Support', async t => {
  const { app } = await setup(t);
  await app.order(buyer, pitch, 'pitch');
  let board = marketBoard(app.store.read());
  assert.equal(board.recentMarketMoves.length, 1);
  assert.match(board.recentMarketMoves[0].message, /star-a completed a paid service/);
  assert.match(board.recentMarketMoves[0].message, /remains #1/);
  await app.order(buyer, sponsor('star-b'), 'ad1');
  await app.order(buyer, sponsor('star-b'), 'ad2');
  board = marketBoard(app.store.read());
  assert.equal(board.ranking[0].star, 'star-b');
  assert.equal(board.ranking[0].sponsorPressure, 'MEDIUM');
  assert.ok(board.recentMarketMoves.some(m => m.starId === 'star-b' && m.type === 'SPONSOR_SUPPORT' && m.message.includes('now #1')));
  assert.ok(board.recentMarketMoves.some(m => m.starId === 'star-b' && m.message.includes('sponsor pressure changed to MEDIUM') && m.message.includes('remains #1')));
  const trial = await app.order(buyer, sponsor('star-c', 'delivery'), 'trial-ad', { trial: true });
  assert.equal(trial.status, 'delivered');
  board = marketBoard(app.store.read());
  const pressureMove = board.recentMarketMoves.find(m => m.starId === 'star-c');
  assert.equal(pressureMove.type, 'SPONSOR_PRESSURE');
  assert.match(pressureMove.message, /sponsor pressure changed to LOW/);
  assert.match(pressureMove.message, /trial campaign, no Sponsor Support/);
  assert.equal(board.ranking.find(r => r.star === 'star-c').sponsorSupport, 0);
});
test('service deliveries never promise refunds: negotiation simulation refuses them and sales outputs stay refund-free', () => {
  const negotiate = localWork('negotiate', { scenario: '采购代码审查服务，预算15积分，报价20积分' });
  assert.ok(!negotiate.rounds.some(r => /按约定退款|支持退款|自动退款|可退款|退款/.test(r.seller)));
  for (const [service, input] of [['sales-pitch', { productDescription: '代码审查' }], ['sales-stress-test', { productDescription: '代码审查' }], ['deal-coach', { currentOffer: 20, budget: 15, minimumAcceptablePrice: 10 }]]) {
    const work = localSales(service, input);
    assert.ok(!/按约定退款|支持退款|自动退款|无条件退款/.test(JSON.stringify(work)));
  }
});
test('live regression: prices cannot change to fiat currency or unauthorized discounts; equivalent material wording remains valid', () => {
  const work = localSales('sales-pitch', pitch.input);
  assert.throws(() => normalizeSales({ ...work, keyValuePoints: ['CodeLens代码审查', '服务价格为20美元'] }, 'sales-pitch', pitch.input), e => e.code === 'invalid_model_output');
  assert.throws(() => normalizeSales({ ...work, keyValuePoints: ['CodeLens代码审查', '限时优惠15积分'] }, 'sales-pitch', pitch.input), e => e.code === 'invalid_model_output');
  const input = { ...pitch.input, productDescription: '面向代码审查的服务：输入代码，输出问题位置和修复建议' };
  assert.equal(normalizeSales(localSales('sales-stress-test', pitch.input), 'sales-stress-test', input).work.evidenceType, 'SIMULATED');
  const stress = localSales('sales-stress-test', pitch.input);
  assert.throws(() => normalizeSales({ ...stress, recommendedResponses: ['CodeLens不存储或利用代码。', stress.recommendedResponses[1]] }, 'sales-stress-test', pitch.input), e => e.code === 'invalid_model_output');
  assert.throws(() => normalizeSales({ ...stress, recommendedResponses: ['可以展示CodeLens更精准的输出。', stress.recommendedResponses[1]] }, 'sales-stress-test', pitch.input), e => e.code === 'invalid_model_output');
});
