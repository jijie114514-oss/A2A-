/**
 * 政策追溯：把「模型失败不收费」补到政策生效前已经扣过款的备用交付单上。
 *
 *   node --env-file-if-exists=.env scripts/backfill-fallback-refunds.js          # 只看（默认 dry-run）
 *   node --env-file-if-exists=.env scripts/backfill-fallback-refunds.js --apply  # 真的退
 *
 * 判定条件（机器可核验，不靠人记）：order.kind === 'paid' && order.status === 'delivered'
 *   && 至少一个 piece 的 generation.mode === 'fallback' && 尚未退款。
 * 每单走 store.transaction + applyRefund（与线上同一套逻辑：回滚积分、粉丝支持、市场动作），
 * 并写一条审计。幂等：已退款的单直接跳过。
 */
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store/index.js';
import { config } from '../src/config.js';
import { StarHall } from '../src/app.js';

const apply = process.argv.includes('--apply');
const settings = config(process.env);
const app = await StarHall.open(settings);

const targets = app.store.read().orders.filter(o => o.kind === 'paid' && o.status === 'delivered'
  && (o.delivery?.pieces || []).some(p => p.generation?.mode === 'fallback')
  && !o.refund?.refundApplied);
console.log(`${settings.store} · 备用交付且已扣款的付费单：${targets.length} 单${apply ? '' : '（dry-run，未执行）'}`);
for (const o of targets) console.log(`  ${o.id} ${String(o.service).padEnd(22)} ${o.price} 分 buyer=${o.buyerId} at=${o.completedAt}`);

for (const target of targets) {
  if (!apply) continue;
  const result = await app.store.transaction(state => {
    const order = state.orders.find(o => o.id === target.id);
    const changed = app.applyRefund(state, order, 'FALLBACK_NOT_CHARGED', 'policy-backfill', '模型失败不收费政策追溯到本单', `backfill:${order.id}`);
    return changed;
  });
  await app.store.audit({ id: randomUUID(), type: 'starhall.refund.backfilled', orderId: target.id, outcome: result ? 'refunded' : 'skipped', reason: 'FALLBACK_NOT_CHARGED', price: target.price, at: new Date().toISOString() });
  console.log(`  ${result ? '已退款' : '跳过'} ${target.id}（${target.price} 分）`);
}

if (apply) {
  const after = app.store.read();
  const buyers = [...new Set(targets.map(t => t.buyerId))];
  for (const buyerId of buyers) {
    const account = after.accounts.find(a => a.id === buyerId);
    console.log(`余额：${buyerId} = ${account?.balance}`);
  }
}
await app.close();
