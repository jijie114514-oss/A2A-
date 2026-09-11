import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';

const buyer = { id: 'fan-orion' }; const other = { id: 'fan-lyra' }; const third = { id: 'fan-vega' };
const poem = { service: 'poem', input: { theme: '广告测试', recipient: '队伍' } };
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-ads-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir }));
  t.after(() => app.close());
  return { app };
}

test('ad services deliver instantly, land in public summary, and are verified via /v1/ads shape', async t => {
  const { app } = await setup(t);
  assert.deepEqual((await app.summary()).ads.pinned, []);
  const before = app.wallet(buyer).balance;
  const order = await app.order(buyer, { service: 'ad-pin', input: { text: 'XX队代码审查：15分一次，5分钟交付。' } }, 'ad-pin-1');
  assert.equal(order.status, 'delivered');
  assert.equal(app.wallet(buyer).balance, before - 15);
  assert.equal(order.delivery.ad.tier, 'ad-pin');
  assert.equal(order.delivery.ad.status, 'active');
  assert.equal(order.delivery.ad.displays, 0);
  assert.ok(order.elapsedMs < 15000);
  const summary = await app.summary();
  assert.equal(summary.ads.activeCount, 1);
  assert.equal(summary.ads.pinned.length, 1);
  assert.equal(summary.ads.pinned[0].team, '猎户座队');
  assert.ok(!summary.ads.pinned[0].text.includes('PRIVATE'));
  const mine = app.ads(buyer).ads;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].tier, 'ad-pin');
  assert.equal(app.ads(other).ads.length, 0);
});

test('spot ads display with each subsequent delivery and stop at their display cap', async t => {
  const { app } = await setup(t);
  await app.order(buyer, { service: 'ad-spot', input: { text: '便宜好用的结构化评审！' } }, 'ad-spot-1');
  for (let i = 1; i <= 10; i++) {
    const delivery = (await app.order(other, { service: 'poem', input: poem.input }, `poem-${i}`)).delivery;
    const shown = delivery.ads?.find(a => a.tier === 'ad-spot');
    assert.ok(shown, `第${i}次交付应带广告`);
    assert.equal(shown.displays, i);
  }
  const ad = app.ads(buyer).ads[0];
  assert.equal(ad.status, 'fulfilled');
  assert.equal(ad.displays, 10);
  const after = (await app.order(third, { service: 'roast', input: { description: '一个产品' } }, 'roast-after')).delivery;
  assert.equal(after.ads?.find(a => a.tier === 'ad-spot'), undefined);
  assert.equal(after.ads, undefined);
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

test('trial ads are free, clearly labelled, and limited (2 displays or 5 minutes)', async t => {
  const { app } = await setup(t);
  const before = app.wallet(other).balance;
  const trial = await app.order(other, { service: 'ad-spot', input: { text: '试投：我们的谈判服务。' } }, 'ad-trial', { trial: true });
  assert.equal(trial.status, 'delivered');
  assert.equal(trial.charged, 0);
  assert.equal(app.wallet(other).balance, before);
  assert.equal(trial.delivery.ad.kind, 'trial');
  assert.equal(trial.delivery.ad.displaysMax, 2);
  const first = await app.order(buyer, { service: 'poem', input: poem.input }, 'trial-display-1');
  const second = await app.order(buyer, { service: 'poem', input: poem.input }, 'trial-display-2');
  assert.equal(second.delivery.ads.find(a => a.tier === 'ad-spot').displays, 2);
  const third = await app.order(buyer, { service: 'poem', input: poem.input }, 'trial-display-3');
  assert.equal(third.delivery.ads?.find(a => a.tier === 'ad-spot'), undefined);
  assert.equal(first.status, 'delivered');
  await assert.rejects(app.order(other, { service: 'ad-spot', input: { text: '再试一次。' } }, 'ad-trial-2', { trial: true }), e => e.code === 'trial_used');
});

test('ad purchases do not pollute star rankings or star memories', async t => {
  const { app } = await setup(t);
  await app.order(buyer, { service: 'ad-pin', input: { text: 'XX队广告' } }, 'ad-clean');
  const summary = await app.summary();
  assert.equal(summary.ranking.reduce((n, s) => n + s.tips, 0), 0);
  assert.equal(summary.totalCredits, 15);
  assert.equal(summary.ads.totalPlaced, 1);
  assert.deepEqual(app.store.read().memories, {});
  const wall = await app.wall(buyer);
  assert.equal(wall.wall.length, 1);
  assert.equal(wall.wall[0].stars.length, 0);
});
