import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { marketBoard } from '../src/market.js';

const buyer = { id: 'fan-orion' }, other = { id: 'fan-lyra' }, third = { id: 'fan-vega' };
const poem = { service: 'poem', input: { theme: '广告测试', recipient: '队伍' } };
const sponsor = (starId = 'star-b', plan = 'featured') => ({ service: 'star-sponsorship', input: { starId, plan, advertiser: 'CodeLens', adCopy: '代码审查：20积分，提供问题位置和修复建议。' } });
async function setup(t, env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-ads-'));
  const settings = config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0', ...env });
  const app = await StarHall.open(settings);
  t.after(() => app.close());
  return { app, settings, dir };
}
async function registerViewer(app, handle) {
  return (await app.registerAgent({ handle, name: handle, secret: 'viewer-secret-0123456789' })).account;
}

test('ad services deliver instantly, land in public summary, and are verified via /v1/ads shape', async t => {
  const { app } = await setup(t);
  assert.deepEqual((await app.summary()).ads.pinned, []);
  const before = app.wallet(buyer).balance;
  const order = await app.order(buyer, { service: 'ad-pin', input: { text: 'XX队代码审查：15分一次，5分钟交付。' } }, 'ad-pin-1');
  assert.equal(order.status, 'delivered');
  assert.equal(app.wallet(buyer).balance, before - 10);
  assert.equal(order.delivery.ad.tier, 'ad-pin');
  assert.equal(order.delivery.ad.status, 'active');
  assert.equal(order.delivery.ad.displays, 0);
  assert.ok(order.delivery.ad.expiresAt, 'paid ad campaigns carry a real window');
  assert.ok(order.elapsedMs < 15000);
  const summary = await app.summary(); // 匿名读：广告照常可见，但不计认证触达
  assert.equal(summary.ads.activeCount, 1);
  assert.equal(summary.ads.pinned.length, 1);
  assert.equal(summary.ads.pinned[0].team, '猎户座队');
  assert.equal(summary.ads.pinned[0].displays, 0);
  const mine = app.ads(buyer).ads;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].tier, 'ad-pin');
  assert.equal(mine[0].trackedImpressions, 1);
  assert.equal(mine[0].currentImpressions, 0);
  assert.equal(app.ads(other).ads.length, 0);
});

test('headline reach counts only unique authenticated buyers; self, platform and anonymous requests are listed separately', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor('star-b', 'leaderboard'), 'ad-class');
  const id = order.delivery.ad.id;
  await app.marketBoard(buyer, 'self-1');             // 广告主自己
  await app.marketBoard(buyer, 'self-2');
  await app.marketBoard();                            // 匿名轮询（卖方监视器）
  await app.marketBoard();
  await app.marketBoard({ id: 'broker' }, 'platform'); // 平台自己的经纪人
  await app.marketBoard(other, 'q1');                 // 同一个独立买家查三次
  await app.marketBoard(other, 'q2');
  await app.marketBoard(other, 'q3');
  const stats = app.adById(buyer, id);
  assert.equal(stats.currentImpressions, 1);
  assert.equal(stats.verifiedReach, 1);
  assert.equal(stats.uniqueViewers.independent, 1);
  assert.equal(stats.uniqueViewers.self, 1);
  assert.equal(stats.uniqueViewers.platform, 1);
  assert.equal(stats.uniqueViewers.anonymous, 1);
  assert.equal(stats.impressionsByClass.independent, 3);
  assert.equal(stats.impressionsByClass.self, 2);
  assert.equal(stats.impressionsByClass.platform, 1);
  assert.equal(stats.impressionsByClass.anonymous, 2);
  assert.equal(stats.trackedImpressions, 8);
  assert.equal(stats.inclusions.total, 8);
  assert.equal(stats.traffic.active + stats.traffic.passive, 1);
  assert.ok(stats.impressions.every(i => i.viewer && i.viewerClass && typeof i.counted === 'boolean'));
  assert.equal(stats.attribution.viewers, 1);
  assert.equal(stats.attribution.viewersWithLaterOrder, 0);
  assert.match(stats.attribution.note, /Correlation/);
});

test('spot ads stop at their display cap and never count the same buyer twice', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, { service: 'ad-spot', input: { text: '便宜好用的结构化评审！' } }, 'ad-spot-1');
  const id = order.delivery.ad.id;
  for (let i = 0; i < 4; i++) {
    const delivery = (await app.order(other, poem, `poem-${i}`)).delivery;
    assert.ok(delivery.ads?.find(a => a.id === id), `第${i + 1}次交付应带广告`);
  }
  const deduped = app.adById(buyer, id);
  assert.equal(deduped.currentImpressions, 1);
  assert.equal(deduped.uniqueViewers.independent, 1);
  assert.equal(deduped.impressionsByClass.independent, 4);
  // 9 个新的独立买家 + 已有 1 个 = 10，达到上限并 fulfilled
  for (let i = 1; i <= 9; i++) {
    const viewer = await registerViewer(app, `spot-viewer-${i}`);
    await app.order(viewer, poem, `spot-${i}`);
  }
  const fulfilled = app.adById(buyer, id);
  assert.equal(fulfilled.currentImpressions, 10);
  assert.equal(fulfilled.status, 'fulfilled');
  const latecomer = await registerViewer(app, 'spot-viewer-late');
  const after = (await app.order(latecomer, poem, 'spot-late')).delivery;
  assert.equal(after.ads?.find(a => a.id === id), undefined);
});

test('sponsor ads prepend a crown line to delivered works and expire by time', async t => {
  const { app } = await setup(t);
  await app.order(buyer, { service: 'ad-sponsor', input: { text: '天琴座冠名支持本场演出。' } }, 'ad-sponsor-1');
  const order = await app.order(other, { service: 'poem', input: poem.input }, 'sponsored-poem');
  assert.ok(order.delivery.pieces[0].text.startsWith('【本作品由猎户座队冠名呈现】'));
  assert.equal(order.delivery.ads.find(a => a.tier === 'ad-sponsor').displays, 1);
  await app.store.transaction(s => { s.ads[0].expiresAt = new Date(Date.now() - 1000).toISOString(); });
  const next = await app.order(other, { service: 'poem', input: poem.input }, 'after-expiry');
  assert.equal(next.delivery.ads?.find(a => a.tier === 'ad-sponsor'), undefined);
  assert.ok(!next.delivery.pieces[0].text.startsWith('【本作品由'));
  assert.equal(app.ads(buyer).ads[0].status, 'expired');
});

test('trial ads are free, clearly labelled, and limited to two distinct verified buyers', async t => {
  const { app } = await setup(t);
  const before = app.wallet(other).balance;
  const trial = await app.order(other, { service: 'ad-spot', input: { text: '试投：我们的谈判服务。' } }, 'ad-trial', { trial: true });
  assert.equal(trial.status, 'delivered');
  assert.equal(trial.charged, 0);
  assert.equal(app.wallet(other).balance, before);
  assert.equal(trial.delivery.ad.kind, 'trial');
  assert.equal(trial.delivery.ad.displaysMax, 2);
  const first = await app.order(buyer, poem, 'trial-display-1');
  assert.equal(first.delivery.ads.find(a => a.tier === 'ad-spot').displays, 1);
  const latecomer = await registerViewer(app, 'trial-viewer-a');
  const second = await app.order(latecomer, poem, 'trial-display-2');
  assert.equal(second.delivery.ads.find(a => a.tier === 'ad-spot').displays, 2);
  const secondLatecomer = await registerViewer(app, 'trial-viewer-b');
  const third = await app.order(secondLatecomer, poem, 'trial-display-3');
  assert.equal(third.delivery.ads?.find(a => a.tier === 'ad-spot'), undefined);
  assert.equal(first.status, 'delivered');
  await assert.rejects(app.order(other, { service: 'ad-spot', input: { text: '再试一次。' } }, 'ad-trial-2', { trial: true }), e => e.code === 'trial_used');
});

test('delivery campaigns refund automatically when verified reach stays under target inside the window', async t => {
  const { app } = await setup(t);
  const ad = await app.order(buyer, sponsor('star-b', 'delivery'), 'delivery-ad');
  const id = ad.delivery.ad.id;
  assert.equal(ad.delivery.ad.displaysMax, 10);
  assert.equal(ad.delivery.sponsorship.expiresAt, ad.delivery.ad.expiresAt);
  await app.order(other, { service: 'sales-stress-test', input: { productDescription: 'CodeLens 代码审查服务，输出风险清单' } }, 'view-1');
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  await app.marketBoard(buyer, 'self-view'); // 广告主自己读榜不算触达
  await app.marketBoard();                    // 匿名读也不算
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  await app.store.transaction(s => { s.ads.find(a => a.id === id).expiresAt = new Date(Date.now() - 1000).toISOString(); });
  await app.marketBoard(third, 'reconcile');
  const stats = app.adById(buyer, id);
  assert.equal(stats.status, 'refunded');
  assert.equal(stats.refundReason, 'IMPRESSIONS_NOT_DELIVERED');
  assert.equal(app.getOrder(buyer, ad.id).status, 'refunded');
  assert.equal(app.wallet(buyer).balance, 100);
  assert.equal(marketBoard(app.store.read()).ranking.find(r => r.starId === 'star-b').sponsorSupport, 0);
});

test('time-based campaigns with zero verified reach are refundable after expiry even with self/anonymous traffic', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor('star-b', 'featured'), 'featured-ad');
  const id = order.delivery.ad.id;
  await app.marketBoard(buyer, 'self-only');
  await app.marketBoard();
  const before = app.adById(buyer, id);
  assert.ok(before.trackedImpressions >= 2);
  assert.equal(before.currentImpressions, 0);
  await app.store.transaction(s => { s.ads.find(a => a.id === id).expiresAt = new Date(Date.now() - 1000).toISOString(); });
  const r = await app.refund(buyer, order.id, { reason: '广告没有触达独立买家' });
  assert.equal(r.decision, 'REFUNDED');
  assert.equal(r.refundReason, 'ADVERTISEMENT_ACTIVATION_FAILED');
  assert.equal(app.wallet(buyer).balance, 100);
});

test('attribution links verified viewers to later orders without claiming causality', async t => {
  const { app } = await setup(t);
  const order = await app.order(buyer, sponsor('star-b', 'featured'), 'attribute-ad');
  await app.marketBoard(other, 'view');
  await new Promise(resolve => setTimeout(resolve, 5));
  await app.order(other, poem, 'later-order');
  const stats = app.adById(buyer, order.delivery.ad.id);
  assert.equal(stats.attribution.viewers, 1);
  assert.equal(stats.attribution.viewersWithLaterOrder, 1);
  assert.equal(stats.attribution.laterOrders[0].viewer, 'fan-lyra');
  assert.equal(stats.attribution.laterOrders[0].service, 'poem');
  assert.match(stats.attribution.note, /not proof the ad caused the order/);
});

test('X-StarHall-Impressions: none serves the ad but records no impression even for a verified buyer (HTTP)', async t => {
  const { app, settings, dir } = await setup(t);
  const order = await app.order(buyer, sponsor('star-b', 'featured'), 'no-count');
  const id = order.delivery.ad.id;
  const host = await startServer(settings, app);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeIdleConnections(); }));
  const credentials = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
  const token = credentials.accounts.find(a => a.id === other.id).token;
  const read = headers => fetch(host.url + '/v1/market-board', { headers });
  const quiet = await (await read({ authorization: `Bearer ${token}`, 'x-starhall-impressions': 'none' })).json();
  assert.ok(quiet.sponsors.length >= 1, '广告照常展示');
  assert.match(quiet.impressionPolicy, /^not-counted/);
  assert.equal(quiet.surfaceId, null);
  assert.equal(app.adById(buyer, id).trackedImpressions, 0);
  await read({ authorization: `Bearer ${token}` });
  assert.equal(app.adById(buyer, id).currentImpressions, 1);
  assert.equal(app.adById(buyer, id).trackedImpressions, 1);
});

test('ad purchases do not pollute star rankings or star memories', async t => {
  const { app } = await setup(t);
  await app.order(buyer, { service: 'ad-pin', input: { text: 'XX队广告' } }, 'ad-clean');
  const summary = await app.summary();
  assert.equal(summary.ranking.reduce((n, s) => n + s.tips, 0), 0);
  assert.equal(summary.totalCredits, 10);
  assert.equal(summary.ads.totalPlaced, 1);
  assert.deepEqual(app.store.read().memories, {});
  const wall = await app.wall(buyer);
  assert.equal(wall.wall.length, 1);
  assert.equal(wall.wall[0].stars.length, 0);
});
