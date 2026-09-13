import { roundContext } from './rounds.js';
import { STARS } from './catalog.js';
import { DELIVERY_BUDGET_SECONDS } from './limits.js';

/**
 * 可机器核验的产品事实。第一轮（Critique）里，别的 agent 要给「具体异议」，
 * 与其猜，不如引用这里的事实；第二轮（Market）里，买家可以用它对比交付可靠性。
 *
 * 原则：只从账本与订单现算，不做营销加工；每条 claim 带 value 和 source（怎么算出来的）；
 * 同时显式列出**我们不主张什么**（impressions 不是阅读、模拟异议不是真实反馈、模拟积分不是支付），
 * 这样对方的异议可以准确命中边界，而不是打空气。
 */
const count = values => values.reduce((map, value) => (map[value] = (map[value] || 0) + 1, map), {});
const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null);
const round1 = n => (n === null ? null : Math.round(n * 10) / 10);

export function evidenceOf(state, options = {}) {
  const orders = state.orders || [];
  const settled = orders.filter(o => o.status !== 'pending');
  const delivered = settled.filter(o => o.status === 'delivered');
  const refunded = settled.filter(o => o.status === 'refunded' || o.refund?.refundApplied);
  const failed = settled.filter(o => o.status === 'failed');
  const latencies = settled.map(o => o.elapsedMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const pieces = delivered.flatMap(o => o.delivery?.pieces || []);
  const modes = count(pieces.map(p => p.generation?.mode || 'unknown'));
  const refundReasons = count(refunded.map(o => o.refund?.refundReason || 'UNSPECIFIED'));
  const trials = (state.wall || []).filter(w => w.kind === 'trial');
  const paidWall = (state.wall || []).filter(w => w.amount > 0 && (!w.kind || w.kind === 'paid'));

  // 按结局分组的时延与失败分布：只统计失败总数不够，买家需要知道「失败落在哪、为什么」。
  const latencyOf = subset => {
    const xs = subset.map(o => o.elapsedMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    return { samples: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs.at(-1) ?? null };
  };
  const failures = {
    total: failed.length,
    byReason: count(failed.map(o => o.error?.code || 'unspecified')),
    byService: count(failed.map(o => o.service)),
    note: 'failed = 未交付且未扣款（超时/中断/模型失败）。机器判定退款单已交付、已扣款再退回，单独统计，不计入 failed。',
  };

  const claims = [
    { claim: '已结算订单数（含试用、失败与退款）', value: settled.length, source: 'state.orders 中 status !== pending' },
    { claim: '成功交付数', value: delivered.length, source: 'state.orders 中 status === delivered' },
    { claim: '真实模型交付占比（live / 全部作品）', value: pieces.length ? round1(100 * (modes.live || 0) / pieces.length) : null, unit: '%', source: 'delivery.pieces[].generation.mode' },
    { claim: '备用作品数（模型失败时交付的本地模板，明确标记；付费单一律自动全额退款，不收钱）', value: modes.fallback || 0, source: 'generation.mode === fallback' },
    { claim: '机器判定退款数（客观失败或备用交付自动退，不依赖人工）', value: refunded.length, source: 'order.refund.refundApplied 或 status === refunded' },
    { claim: '退款原因分布', value: refundReasons, source: 'order.refund.refundReason' },
    { claim: '未扣款失败单数（超时/中断，预留积分已释放）', value: failed.length, source: 'status === failed' },
    { claim: '失败单按原因与服务的分布（见 failures 字段）', value: { byReason: failures.byReason, byService: failures.byService }, source: 'order.error.code 与 order.service' },
    { claim: '交付时延 p50 / p95 / max（毫秒）', value: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null, samples: latencies.length }, source: 'order.elapsedMs（下单到结算的墙钟时间）' },
    { claim: '免费试用次数', value: trials.length, source: 'wall 中 kind === trial' },
    { claim: '付费成交笔数与模拟积分', value: { orders: paidWall.length, credits: paidWall.reduce((sum, w) => sum + w.amount, 0) }, source: 'wall 中 amount > 0' },
    { claim: '注册身份数（含内部身份与外部 agent）', value: (state.accounts || []).length, source: 'state.accounts' },
    { claim: '交付硬预算（秒）', value: DELIVERY_BUDGET_SECONDS, source: 'src/limits.js，与订单 AbortController、目录 delivery.hardTimeoutSeconds 同源' },
    { claim: '广告位生效时间（秒）', value: 15, source: '广告不走模型，结算即生效' },
  ];

  return {
    product: 'STARHALL — 星辉舞台',
    asOf: new Date().toISOString(),
    round: roundContext(),
    claims,
    failures,
    latencyByOutcome: { delivered: latencyOf(delivered), refunded: latencyOf(refunded), failed: latencyOf(failed) },
    outcomes: { delivered: delivered.length, refunded: refunded.length, failed: failed.length, pending: orders.filter(o => o.status === 'pending').length },
    services: Object.keys(STARS).map(star => ({ star, name: STARS[star].name,
      deliveries: delivered.filter(o => o.delivery?.pieces?.some(p => p.star === star)).length,
      live: pieces.filter(p => p.star === star && p.generation?.mode === 'live').length,
      fallback: pieces.filter(p => p.star === star && p.generation?.mode === 'fallback').length })),
    prices: (options.services || []).map(s => ({ id: s.id, name: s.name, price: s.price ?? null,
      plans: s.plans ? Object.values(s.plans).map(p => p.price) : null, maxDeliverySeconds: s.maxDeliverySeconds ?? null })),
    whatWeDoNotClaim: [
      '展示次数（impressions）只统计「附进了交付或榜单响应」，不等于阅读、点击、转化或收入。',
      'Sales Stress Test 的异议是模型模拟的，不是真实买家反馈；交付里标记 evidenceType=SIMULATED。',
      '本产品的积分是模拟账本，不是支付；真实比赛积分在 SharedNet 房间结算，不经过本 API。',
      '预测类输出是条件性的选品框架，不是对比赛结果的承诺。',
      '这里没有第三方审计：以上数字都能被你自己用 GET /v1/orders、GET /v1/summary、GET /v1/market-board 复算，但来源仍然是本产品的账本。',
      '历史交付质量不代表未来请求一定成功；每个服务的健康状态见 GET /v1/catalog 的 health 字段。',
    ],
  };
}

