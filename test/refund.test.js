import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { marketBoard } from '../src/market.js';
import { verifyDelivery } from '../src/verification.js';
import { getService } from '../src/catalog.js';

const buyer = { id: 'fan-orion' }, other = { id: 'fan-lyra' };
const pitch = { service: 'sales-pitch', input: { productName: 'CodeLens', productDescription: '代码审查服务，输出风险位置和修复建议', price: 20, targetBuyer: 'coding agents' } };
const deal = { service: 'deal-coach', input: { currentOffer: 20, budget: 15, minimumAcceptablePrice: 10, goal: '采购代码审查', counterpartyMessage: '请确认验收标准' } };
const sponsor = (starId = 'star-b', plan = 'leaderboard') => ({ service: 'star-sponsorship', input: { starId, plan, advertiser: 'CodeLens', adCopy: '代码审查：输入代码，输出问题位置。' } });
async function setup(t, brain) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-refund-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir }), brain);
  t.after(() => app.close()); return { app, dir };
}
const corrupt = async (app, orderId, fn) => app.store.transaction(state => { fn(state.orders.find(o => o.id === orderId)); });
const boardRow = (state, star) => marketBoard(state).ranking.find(r => r.star === star);

// ── Test 1: normal delivery → no refund, revision available, Fan Support counted ──
test('Test 1: healthy Sales Pitch is not refunded, revision is available, Fan Support +8', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, pitch, 't1');
  assert.equal(order.status, 'delivered'); assert.equal(order.deliveryStatus, 'REVISION_AVAILABLE');
  assert.equal(order.refundEligible, false); assert.equal(order.refundReason, null);
  assert.equal(order.revisionAvailable, true); assert.equal(order.revisionUsed, false);
  assert.equal(order.remedy, 'ONE_FREE_REVISION'); assert.equal(order.chargedCredits, 5);
  assert.equal(boardRow(app.store.read(), 'star-a').fanSupport, 5);
});

// ── Test 2: empty delivery → automatic refund, Fan Support and revenue rolled back ──
test('Test 2: empty Sales Pitch delivery is machine-refunded with EMPTY_DELIVERY; support and revenue revert', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, pitch, 't2');
  assert.equal(app.wallet(buyer).balance, 95);
  await corrupt(app, order.id, o => { o.delivery.pieces[0].text = ''; });
  const verdict = verifyDelivery(app.store.read().orders.find(o => o.id === order.id), getService('sales-pitch'));
  assert.equal(verdict.ok, false); assert.equal(verdict.refundReason, 'EMPTY_DELIVERY');
  const r = await app.refund(buyer, order.id, { reason: 'empty' });
  assert.equal(r.decision, 'REFUNDED'); assert.equal(r.refundReason, 'EMPTY_DELIVERY');
  assert.equal(r.order.status, 'refunded'); assert.equal(r.order.deliveryStatus, 'REFUNDED');
  assert.equal(r.chargedCredits, 0); assert.equal(app.wallet(buyer).balance, 100);
  assert.equal(boardRow(app.store.read(), 'star-a').fanSupport, 0);
  assert.equal((await app.summary()).totalCredits, 0);
});

// ── Test 3/4: Deal Coach constraint violations → BUDGET_VIOLATION / PRICE_FLOOR_VIOLATION ──
test('Test 3: Deal Coach recommending above budget is machine-refunded with BUDGET_VIOLATION', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, deal, 't3');
  assert.equal(order.delivery.pieces[0].recommendedCounteroffer, 15);
  await corrupt(app, order.id, o => { o.delivery.pieces[0].recommendedCounteroffer = 18; });
  const r = await app.refund(buyer, order.id, { reason: '报价超预算' });
  assert.equal(r.decision, 'REFUNDED'); assert.equal(r.refundReason, 'BUDGET_VIOLATION');
  assert.equal(r.order.refundEligible, true); assert.equal(r.chargedCredits, 0);
  assert.equal(app.wallet(buyer).balance, 100);
  assert.equal(boardRow(app.store.read(), 'star-c').fanSupport, 0);
});
test('Test 4: Deal Coach recommending below the floor is machine-refunded with PRICE_FLOOR_VIOLATION', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, deal, 't4');
  await corrupt(app, order.id, o => { o.delivery.pieces[0].recommendedCounteroffer = 8; });
  const r = await app.refund(buyer, order.id, { reason: '低于底价' });
  assert.equal(r.decision, 'REFUNDED'); assert.equal(r.refundReason, 'PRICE_FLOOR_VIOLATION');
  assert.equal(app.wallet(buyer).balance, 100);
  assert.equal(boardRow(app.store.read(), 'star-c').fanSupport, 0);
});

// ── Test 5: subjective dissatisfaction → one free revision, no charge, no extra support ──
test('Test 5: one free revision: no refund, no recharge, one-time only, no extra Fan Support', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, pitch, 't5');
  const balance = app.wallet(buyer).balance;
  const rev = await app.revisionRequest(buyer, order.id, { notes: '风格更简洁一些' }, 'rev-1');
  assert.equal(rev.chargedCredits, 0); assert.equal(rev.revisionAvailable, false); assert.equal(rev.revisionUsed, true);
  assert.ok(rev.revision.pieces.length > 0); assert.equal(app.wallet(buyer).balance, balance);
  assert.equal(boardRow(app.store.read(), 'star-a').fanSupport, 5, 'revision must not add Fan Support');
  assert.equal(app.store.read().orders.filter(o => o.buyerId === buyer.id && o.status === 'delivered').length, 1, 'no new paid order');
  // 修订用完后，退款回执不能再宣告 remedy（否则买家 agent 照着调会拿到 409 revision_used）
  const after = await app.refund(buyer, order.id, { reason: '还是想退款' });
  assert.equal(after.decision, 'DECLINED'); assert.equal(after.remedy, null); assert.equal(after.revisionAvailable, false);
  const replay = await app.revisionRequest(buyer, order.id, { notes: '风格更简洁一些' }, 'rev-1');
  assert.equal(replay.replayed, true); assert.equal(replay.revision.id, rev.revision.id);
  assert.equal(app.wallet(buyer).balance, balance);
  await assert.rejects(app.revisionRequest(buyer, order.id, { notes: '再来一次' }, 'rev-2'), e => e.code === 'revision_used');
  const fresh = app.getOrder(buyer, order.id);
  assert.equal(fresh.status, 'delivered'); assert.equal(fresh.revisionUsed, true); assert.equal(fresh.revisionAvailable, false);
  assert.equal(fresh.refundEligible, false);
});

// ── Test 6: advertisement not activated → ADVERTISEMENT_ACTIVATION_FAILED, Sponsor Support rolled back ──
test('Test 6: inactive sponsorship with zero impressions is refunded; Sponsor Support reverts', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor(), 't6');
  assert.equal(order.delivery.sponsorship.status, 'ACTIVE');
  assert.equal(boardRow(app.store.read(), 'star-b').sponsorSupport, 6);
  await app.store.transaction(s => { s.ads.find(a => a.id === order.delivery.ad.id).status = 'inactive'; });
  const r = await app.refund(buyer, order.id, { reason: '广告未激活' });
  assert.equal(r.decision, 'REFUNDED'); assert.equal(r.refundReason, 'ADVERTISEMENT_ACTIVATION_FAILED');
  assert.equal(app.wallet(buyer).balance, 100);
  assert.equal(boardRow(app.store.read(), 'star-b').sponsorSupport, 0);
  assert.equal(boardRow(app.store.read(), 'star-b').activeSponsors, 0);
  assert.equal(boardRow(app.store.read(), 'star-b').sponsorPressure, 'NONE');
  assert.equal(app.adById(buyer, order.delivery.ad.id).status, 'refunded');
});

// ── Test 7: impressions already served → refundEligible false ──
test('Test 7: sponsorship with real impressions is not refundable', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor(), 't7');
  for (let i = 0; i < 3; i++) await app.marketBoard(other, `view-${i}`);
  assert.equal(app.adById(buyer, order.delivery.ad.id).currentImpressions, 3);
  const r = await app.refund(buyer, order.id, { reason: '广告没效果' });
  assert.equal(r.decision, 'DECLINED'); assert.equal(r.declineCode, 'IMPRESSIONS_ALREADY_SERVED');
  assert.equal(r.refundEligible, false); assert.equal(r.refundReason, null);
  assert.equal(app.wallet(buyer).balance, 90);
  assert.equal(boardRow(app.store.read(), 'star-b').sponsorSupport, 6, 'sponsor support survives once impressions were served');
});

// ── Test 8: idempotent refund: single credit-back, single rollback, single refund event ──
test('Test 8: repeated refund requests credit back and roll back exactly once', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, deal, 't8');
  await corrupt(app, order.id, o => { o.delivery.pieces[0].recommendedCounteroffer = 18; });
  const first = await app.refund(buyer, order.id, { reason: '超预算' });
  assert.equal(first.decision, 'REFUNDED');
  const second = await app.refund(buyer, order.id, { reason: '再退一次' });
  assert.equal(second.decision, 'ALREADY_REFUNDED');
  assert.equal(app.wallet(buyer).balance, 100, 'credits returned exactly once');
  assert.equal(boardRow(app.store.read(), 'star-c').fanSupport, 0);
  const state = app.store.read();
  const refundedEvents = state.events.filter(e => e.type === 'order.refunded' && e.orderId === order.id);
  assert.equal(refundedEvents.length, 1, 'exactly one refund event');
  const refundMoves = (state.marketMoves || []).filter(m => m.orderId === order.id && m.type === 'REFUND_REVERT');
  assert.equal(refundMoves.length, 1, 'exactly one revert move');
  const refundSignals = state.commercialSignals.filter(s => s.orderId === order.id && s.field === 'refund');
  assert.equal(refundSignals.length, 1);
  assert.equal(second.order.refundApplied, true);
});

// ── Test 9: Market Board recomputes after refund ──
test('Test 9: board score, rank, support and pressure all recompute after a sponsorship refund', async t => {
  const { app } = await setup(t);
  await app.order(buyer, pitch, 't9-pitch');
  const ad = await app.order(buyer, sponsor(), 't9-ad');
  let board = marketBoard(app.store.read());
  assert.equal(board.ranking[0].star, 'star-b');
  assert.equal(board.ranking[0].sponsorSupport, 6);
  assert.equal(board.ranking[0].activeSponsors, 1);
  assert.equal(board.ranking[0].sponsorPressure, 'LOW');
  await app.store.transaction(s => { s.ads.find(a => a.id === ad.delivery.ad.id).status = 'inactive'; });
  const r = await app.refund(buyer, ad.id, { reason: '未激活' });
  assert.equal(r.decision, 'REFUNDED');
  board = marketBoard(app.store.read());
  assert.equal(board.ranking.find(x => x.star === 'star-b').sponsorSupport, 0);
  assert.equal(board.ranking.find(x => x.star === 'star-b').activeSponsors, 0);
  assert.equal(board.ranking.find(x => x.star === 'star-b').sponsorPressure, 'NONE');
  assert.equal(board.ranking[0].star, 'star-a', 'rank reverts to the star with real support');
  assert.ok(board.recentMarketMoves.some(m => m.type === 'REFUND_REVERT' && m.starId === 'star-b' && /sponsorship refunded/.test(m.message)));
});

// ── Test 10: Commercial Diagnostic treats REFUNDED orders as attempts, not success ──
test('Test 10: a refunded Deal Coach is attempted usage, not successful paid behavior, in the diagnostic', async t => {
  const { app } = await setup(t);
  const dealOrder = await app.order(buyer, deal, 't10-deal');
  await app.order(buyer, pitch, 't10-pitch');
  await corrupt(app, dealOrder.id, o => { o.delivery.pieces[0].recommendedCounteroffer = 8; });
  const r = await app.refund(buyer, dealOrder.id, { reason: '低于底价' });
  assert.equal(r.refundReason, 'PRICE_FLOOR_VIOLATION');
  const profile = await app.commercialProfile(buyer);
  assert.equal(profile.totals.successfulPaidOrders, 1, 'refunded order excluded from successful paid totals');
  assert.equal(profile.totals.paidCredits, 5);
  const dealHistory = profile.history.find(h => h.orderId === dealOrder.id);
  assert.equal(dealHistory.status, 'refunded'); assert.equal(dealHistory.credits, 0);
  const usageSignal = profile.signals.find(s => s.orderId === dealOrder.id && s.field === 'serviceDelivered');
  assert.equal(usageSignal.value.paidCredits, 0); assert.equal(usageSignal.value.refunded, true);
  assert.ok(profile.signals.some(s => s.orderId === dealOrder.id && s.field === 'refund' && s.value.refundReason === 'PRICE_FLOOR_VIOLATION'));
  const order = await app.order(buyer, { service: 'commercial-diagnostic', input: { goal: '检查退款后的画像' } }, 't10-diag');
  assert.equal(order.status, 'delivered');
  const work = order.delivery.pieces[0];
  assert.ok(work.pricingDiagnosis.some(f => f.status === 'UNKNOWN' && /No completed deal-coach history/.test(f.finding)), 'refunded deal-coach must not read as a completed use');
  assert.ok(work.evidenceSummary.evidence.some(e => e.field === 'refund' && e.value.refundReason === 'PRICE_FLOOR_VIOLATION'));
  assert.ok(work.evidenceSummary.evidence.some(e => e.field === 'transaction' && e.value.service === 'deal-coach' && e.value.status === 'refunded'));
});

// ── machine verification unit coverage ──
test('verifyDelivery covers empty, schema, missing components, budget, floor and ad activation without an LLM', () => {
  const pitchSvc = getService('sales-pitch');
  const makeOrder = (service, piece) => ({ id: 'o1', service: service.id, input: {}, status: 'delivered', delivery: { pieces: [piece] } });
  assert.equal(verifyDelivery({ id: 'o1', service: 'sales-pitch', input: {}, delivery: { pieces: [] } }, pitchSvc).refundReason, 'EMPTY_DELIVERY');
  assert.equal(verifyDelivery(makeOrder(pitchSvc, { text: 'x' }), pitchSvc).refundReason, 'REQUIRED_COMPONENT_MISSING');
  assert.equal(verifyDelivery(makeOrder(getService('sales-stress-test'), { text: 'x', topObjections: ['a'], recommendedResponses: ['b'], severity: ['HIGH'], whyBuyerMayObject: ['c'], whatToFixBeforeSelling: ['d'] }), getService('sales-stress-test')).refundReason, 'REQUIRED_COMPONENT_MISSING');
  assert.equal(verifyDelivery(makeOrder(getService('sales-stress-test'), { text: 'x', topObjections: ['a', 'b'], whyBuyerMayObject: ['c', 'd'], severity: ['HIGH', 'LOW'], recommendedResponses: ['e', 'f'], whatToFixBeforeSelling: ['g', 'h'], evidenceType: 'OBSERVED' }), getService('sales-stress-test')).refundReason, 'SCHEMA_VALIDATION_FAILED');
  const dealSvc = getService('deal-coach');
  assert.equal(verifyDelivery(makeOrder(dealSvc, { text: 'x', recommendedCounteroffer: 18, nextMessage: 'n', strategy: 's', concessionLevel: 'c', walkAwayCondition: 'w', risk: 'r' }), dealSvc).ok, true);
  assert.equal(verifyDelivery({ id: 'o1', service: 'deal-coach', input: { budget: 15 }, status: 'delivered', delivery: { pieces: [{ text: 'x', recommendedCounteroffer: 18, nextMessage: 'n', strategy: 's', concessionLevel: 'c', walkAwayCondition: 'w', risk: 'r' }] } }, dealSvc).refundReason, 'BUDGET_VIOLATION');
  assert.equal(verifyDelivery({ id: 'o1', service: 'deal-coach', input: { minimumAcceptablePrice: 10 }, status: 'delivered', delivery: { pieces: [{ text: 'x', recommendedCounteroffer: 8, nextMessage: 'n', strategy: 's', concessionLevel: 'c', walkAwayCondition: 'w', risk: 'r' }] } }, dealSvc).refundReason, 'PRICE_FLOOR_VIOLATION');
  const adSvc = getService('star-sponsorship');
  assert.equal(verifyDelivery({ id: 'o1', service: 'star-sponsorship', input: {}, status: 'delivered', delivery: { pieces: [{ kind: 'ad', text: 'ad' }], ad: { status: 'pending' }, sponsorship: { status: 'PENDING' } } }, adSvc).refundReason, 'ADVERTISEMENT_ACTIVATION_FAILED');
  assert.equal(verifyDelivery({ id: 'o1', service: 'star-sponsorship', input: {}, status: 'delivered', delivery: { pieces: [{ kind: 'ad', text: 'ad' }], ad: { status: 'active', starId: 'star-b' }, sponsorship: { status: 'ACTIVE', starId: 'star-b' } } }, adSvc).ok, true);
});

// ── automatic (commit-time) refund path: verification override exercises the delivery-time guard ──
test('automatic refund at delivery time: machine failure triggers refund without a buyer request', async t => {
  const { app } = await setup(t);
  const real = app.verifyDelivery;
  app.verifyDelivery = () => ({ ok: false, refundReason: 'OTHER_MACHINE_VERIFIED_FAILURE', checks: [], machineDecided: true });
  try {
    const order = await app.order(buyer, pitch, 'auto');
    assert.equal(order.status, 'refunded'); assert.equal(order.deliveryStatus, 'REFUNDED');
    assert.equal(order.refundReason, 'OTHER_MACHINE_VERIFIED_FAILURE'); assert.equal(order.chargedCredits, 0);
    assert.equal(app.wallet(buyer).balance, 100);
    assert.equal(boardRow(app.store.read(), 'star-a').fanSupport, 0);
    assert.ok(app.store.read().events.some(e => e.type === 'order.refunded' && e.orderId === order.id));
  } finally { app.verifyDelivery = real; }
});
