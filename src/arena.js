import { ensure } from './errors.js';
import { now } from './store/shared.js';

export const BROKER_POLICY = {
  version: 1, mode: 'local-rehearsal', ownTeamId: 'starhall', budget: 100, minimumSpend: 80, minimumOtherTeams: 3,
  preferredPurchases: [30, 25, 15, 10], escalation: '礼貌拒绝未上架需求，推荐现有服务，不请求人工介入',
  pitch: 'StarHall — Sell better in the Arena。星A讲清价值（Sales Pitch 8分），星B模拟销售异议（Sales Stress Test 10分），星C处理报价与成交（Deal Coach 15分）。真实服务消费产生Fan Support，选择明星投放产生Sponsor Support，排名影响曝光权重。先查看免费的Live Market Board，再选择服务或赞助；Commercial Diagnostic 30分基于自己的使用和曝光证据分析。',
  demoEndpoint: '/v1/market-board', demoPurpose: 'market-board-read', marketingPriority: 'Only after mandatory trials, critiques and ranking; never delay required arena work',
};
/** Automated fixture regression only. Never use this fixed decision loop as a competition agent. */
export async function rehearseArena(market, ownTeamId = BROKER_POLICY.ownTeamId) {
  const offers = (await market.list()).filter(o => o.teamId !== ownTeamId);
  const unique = [...new Map(offers.map(o => [o.teamId, o])).values()];
  ensure(unique.length >= 3, 'insufficient_teams', '至少需要3家其他队伍产品，不能把本队明星算作不同队伍');
  const reviews = [];
  for (const offer of unique) {
    const start = performance.now();
    const trial = await market.try(offer.id);
    const elapsedMs = Math.round(performance.now() - start);
    const evidence = trial.missingFields?.length ? `试用输出缺少 ${trial.missingFields.join('、')}，无法完成约定验收。`
      : !trial.failurePolicy ? '试用回执未说明失败补偿方式；需明确超时或不可用时是否退还积分。'
        : `试用回执只覆盖一个样例（耗时${elapsedMs}ms），尚不能证明重复调用和高峰期表现；建议补充可复现的并发样例。`;
    reviews.push({ teamId: offer.teamId, productId: offer.id, elapsedMs, objection: evidence, trial, score: trial.ok ? (trial.missingFields?.length ? 60 : 85) : 20 });
  }
  const ranking = [ownTeamId, ...reviews.slice().sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs).map(r => r.teamId)];
  const rankingReceipt = await market.submitRanking(ranking, reviews);
  const plan = planPurchases(offers);
  const purchases = [];
  for (let i = 0; i < plan.length; i++) {
    const offer = plan[i];
    const receipt = await market.buy(offer.id, `arena-local-${offer.id}-${i}`);
    ensure(receipt.status === 'delivered' && receipt.price === offer.price && receipt.teamId === offer.teamId, 'purchase_failed', '采购回执与计划不一致，不能计入消费');
    purchases.push(receipt);
  }
  const spent = purchases.reduce((n, r) => n + r.price, 0);
  const teams = new Set(purchases.map(r => r.teamId));
  ensure(spent >= 80 && spent <= 100 && teams.size >= 3, 'arena_incomplete', '市场轮目标未完成');
  return { mode: 'local-rehearsal', simulated: true, generatedAt: now(), pitch: BROKER_POLICY.pitch, reviews, ranking, rankingReceipt,
    purchases, spent, remaining: 100 - spent, differentTeams: teams.size, objectivesMet: true };
}
export function planPurchases(offers) {
  const candidates = offers.filter(o => Number.isSafeInteger(o.price) && o.price > 0 && o.price <= 100);
  // One purchase per offer. Bounded local planning; same-team products never satisfy diversity.
  ensure(candidates.length <= 16, 'too_many_offers', '本地演练最多接受16个采购候选');
  let best;
  function walk(index, selected, spend) {
    if (spend > 100) return;
    if (spend >= 80 && new Set(selected.map(s => s.teamId)).size >= 3) {
      const difference = Math.abs(selected.length - 4) * 100 + Math.abs(spend - 80);
      if (!best || difference < best.difference) best = { selected, difference };
    }
    if (index === candidates.length) return;
    walk(index + 1, [...selected, candidates[index]], spend + candidates[index].price);
    walk(index + 1, selected, spend);
  }
  walk(0, [], 0); ensure(best, 'no_purchase_plan', '候选价格无法在100分内满足消费80分及至少3队');
  return best.selected;
}
export function fixtureMarket() {
  const offers = [
    { id: 'fixture-research', teamId: 'fixture-team-research', name: '模拟调研服务', price: 30 },
    { id: 'fixture-audit', teamId: 'fixture-team-audit', name: '模拟代码检查', price: 25 },
    { id: 'fixture-copy', teamId: 'fixture-team-copy', name: '模拟文案服务', price: 15 },
    { id: 'fixture-data', teamId: 'fixture-team-data', name: '模拟数据清洗', price: 10 },
  ];
  const receipts = new Map(); let balance = 100;
  return {
    list: async () => offers,
    wallet: async () => ({ balance, currency: 'fixture-credit', simulated: true }),
    try: async id => {
      ensure(offers.some(o => o.id === id), 'not_found', '模拟产品不存在', 404);
      return { productId: id, ok: true, fixture: true, output: `这是${id}的本地模拟交付，非真实产品试用。`, missingFields: id === 'fixture-research' ? ['来源时间'] : [], failurePolicy: null };
    },
    submitRanking: async (ranking, reviews) => {
      const external = ranking.filter(id => offers.some(o => o.teamId === id));
      ensure(new Set(ranking).size === ranking.length && external.length >= 3, 'invalid_ranking', '需要至少3个不同模拟队伍的排名');
      ensure(external.every(id => reviews?.some(r => r.teamId === id && typeof r.objection === 'string' && r.objection.trim().length > 5)), 'missing_objections', '每个排名队伍必须有一条具体异议');
      return { accepted: true, fixture: true, ranking };
    },
    buy: async (id, key) => {
      if (receipts.has(key)) { ensure(receipts.get(key).productId === id, 'idempotency_conflict', '该幂等键已用于其他模拟产品', 409); return receipts.get(key); }
      const offer = offers.find(o => o.id === id); ensure(offer && balance >= offer.price, 'insufficient_balance', '模拟市场余额不足');
      balance -= offer.price;
      const receipt = { productId: id, teamId: offer.teamId, price: offer.price, status: 'delivered', fixture: true, idempotencyKey: key };
      receipts.set(key, receipt); return receipt;
    },
  };
}
