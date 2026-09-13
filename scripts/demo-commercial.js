import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';

const live = process.argv.includes('--live');
await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', live ? 'commercial-live-' : 'commercial-demo-'));
const settings = config({ ...process.env, STARHALL_DATA_DIR: dir, STARHALL_MARKET_PHASE: 'AUTO',
  SPONSOR_SUPPORT_WEIGHT: '0.6', STAR_EXPOSURE_MULTIPLIERS: '[1.5,1.2,1]', ...(!live ? { LLM_PROVIDER: 'mock' } : {}) });
if (live) assert.notEqual(settings.llm.provider, 'mock', '--live requires a configured live provider');
const app = await StarHall.open(settings);
const buyer = { id: 'fan-orion' }, other = { id: 'fan-lyra' };
try {
  const catalog = app.catalog();
  const opening = await app.marketBoard({ id: 'broker' });
  assert.equal(opening.phase, 'PRE-MARKET');
  const trial = await app.order(buyer, { service: 'deal-coach', input: { currentOffer: 20, budget: 15, goal: '购买代码审查' } }, 'trial-deal', { trial: true });
  assert.equal(trial.status, 'delivered');
  const preMarket = await app.marketBoard();
  const buy = async (actor, service, input, key = service) => {
    const order = await app.order(actor, { service, input }, key);
    assert.equal(order.status, 'delivered', JSON.stringify(order.error));
    console.log(`${service}: ${order.status}, ${order.price} credits, ${order.delivery.pieces[0].generation.mode}, ${order.elapsedMs}ms`);
    return order;
  };
  const product = { productName: 'CodeLens', productDescription: '面向代码审查的服务：输入代码，输出问题位置和修复建议', price: 20, targetBuyer: 'coding agents' };
  const pitch = await buy(buyer, 'sales-pitch', product);
  const stress = await buy(buyer, 'sales-stress-test', product);
  const deal = await buy(buyer, 'deal-coach', { currentOffer: 20, minimumAcceptablePrice: 15, goal: '销售CodeLens代码审查服务，对方希望降低价格', counterpartyMessage: '15积分能做吗？', context: '现有范围是问题位置和修复建议；不承诺未确认的功能或退款' });
  const sponsorship = await buy(buyer, 'star-sponsorship', { starId: 'star-b', plan: 'leaderboard', advertiser: 'CodeLens', adCopy: 'CodeLens代码审查：20积分，提供问题位置与修复建议。' });
  const afterSponsorship = await app.marketBoard(other, 'actual-board-visit');
  const passiveDelivery = await buy(other, 'deal-coach', { currentOffer: 20, budget: 15, goal: '预算内采购代码审查' });
  const diagnostic = await buy(buyer, 'commercial-diagnostic', { ...product, goal: '依据我的使用记录与投放，确定下一步验证动作' });
  const liveMarket = await app.marketBoard(other, 'final-board-visit');
  const tracking = app.adById(buyer, sponsorship.delivery.ad.id);
  const profile = await app.commercialProfile(buyer);
  assert.equal(app.wallet(buyer).balance, 39); // 5+6+10+10+30 = 61 分（沿用当前目录实价）
  // 触达按去重的独立认证买家计：本演练里只有 fan-lyra 一个独立买家看过（active 1，passive 0）。
  assert.equal(tracking.currentImpressions, 1);
  assert.equal(tracking.verifiedReach, 1);
  assert.equal(tracking.traffic.active, 1); assert.equal(tracking.traffic.passive, 0);
  assert.equal(tracking.uniqueViewers.independent, 1);
  assert.ok(tracking.inclusions.total >= 3, '原始包含次数仍可审计，但不进 headline');
  assert.ok(passiveDelivery.delivery.compactMarketBoard.sponsors.some(s => s.adId === sponsorship.delivery.ad.id));
  assert.equal(liveMarket.ranking.find(r => r.starId === 'star-b').sponsorSupport, 6, 'leaderboard 10 分 × SPONSOR_SUPPORT_WEIGHT 0.6');
  const report = { version: '0.5.0-local', mode: 'local', liveRequested: live, generatedAt: new Date().toISOString(),
    note: 'Isolated local credits and real local ledger events. No external Arena sales or human ad reading are claimed.',
    catalog, opening, preMarket, trial, pitch, stress, deal, sponsorship, afterSponsorship, passiveDelivery,
    compactBoard: passiveDelivery.delivery.compactMarketBoard, diagnostic, liveMarket, tracking, profile, wallet: app.wallet(buyer), allAssertionsPassed: true };
  const target = path.join(dir, 'commercial-report.json');
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.resolve('artifacts', live ? 'commercial-live-latest.json' : 'commercial-demo-latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Complete: ${target}`);
} finally { await app.close(); }
