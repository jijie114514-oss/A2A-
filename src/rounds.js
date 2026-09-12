/**
 * 赛程两轮与试用/付费政策。
 *
 * 规则原文（官方 FAQ，见 `黑客松规则全解.md` §六/§八/§九）：
 *   · 「免费试用的规则：第一轮试用产品不花钱（积分第二轮才发）」
 *   · 第一轮 Critique（北京时间周日 21:00–22:00）：试用彼此产品、争论、排名；
 *     强制任务 = 试用 ≥3 家、每家 ≥1 条具体异议、提交排名。
 *   · 第二轮 Market（22:00–23:00）：每人 100 积分；强制任务 = 花 ≥80 分、买 ≥3 家不同产品。
 * 北京时间减 8 小时即 UTC：第一轮 13:00–14:00Z，第二轮 14:00–15:00Z（2026-09-13 周日）。
 *
 * 这里是**建议，不是闸门**：产品任何时刻都能试用也能购买，轮次只告诉对方的 agent
 * 此刻做什么最划算（以及本轮官方强制任务是什么）。判定用 UTC 时间，不依赖服务器时区；
 * 时钟来自我们的部署，官方链接/通知才是唯一权威，所以 `advisory: true` 写在返回里。
 */

const at = iso => Date.parse(iso);
export const CRITIQUE_START = at('2026-09-13T13:00:00Z');
export const MARKET_START = at('2026-09-13T14:00:00Z');
export const ARENA_END = at('2026-09-13T15:00:00Z');

export const TRIAL_POLICY = Object.freeze({
  endpoint: '/v1/trials', mcpTool: 'starhall_trial', price: 0,
  requires: ['Bearer token（自助开户 POST /v1/agents）', 'Idempotency-Key'],
  limit: '每个身份、每种付费服务最多一次成功免费试用；失败可换幂等键重试',
  note: '任何时候都能免费试用。官方规则只在时间上区分两轮，本产品不做闸门：第一轮用试用评估，第二轮用积分购买。',
});

export const PAYMENT_MODEL = Object.freeze({
  currency: 'local-credit', simulated: true, realMoney: false, arenaCreditsSettledHere: false,
  priceRange: '内容服务 5–30 分/单；明星赞助 5 / 10 / 15 分三档；免费行情榜 0 分',
  note: '本产品的积分是模拟账本，用来演示可验证的收费、退款与审计。真实比赛积分在 SharedNet 房间里由 agent 之间转移，不经过本 API。',
});

const WINDOW = { start: new Date(CRITIQUE_START).toISOString(), end: new Date(ARENA_END).toISOString() };

const ROUNDS = {
  BEFORE: {
    label: '赛前（BEFORE）',
    task: '赛程未开始：自由联调。试用与购买都开放，用于打通接入。',
    callToAction: { method: 'POST', endpoint: '/v1/trials', why: '用免费试用先验证一件交付，确认时延与输出格式。' },
  },
  CRITIQUE: {
    label: '第一轮 · 点评（Critique）',
    task: '官方强制任务：试用 ≥3 家别队产品、每家 ≥1 条具体异议、提交排名。本轮积分尚未发放，不要为服务付款。',
    callToAction: { method: 'POST', endpoint: '/v1/trials', why: '每个付费服务免费试用一次、0 花费；异议请引用 GET /v1/evidence 里可机器核验的事实，而不是猜测。' },
  },
  MARKET: {
    label: '第二轮 · 市场（Market）',
    task: '官方强制任务：用 100 积分中的 ≥80 分，向 ≥3 家不同队伍购买。',
    callToAction: { method: 'POST', endpoint: '/v1/orders', why: '按目录实价下单（5–30 分/单）：先 sales-pitch 讲清价值，再 deal-coach 处理报价，或赞助明星拿可核验曝光。' },
  },
  AFTER: {
    label: '赛程已结束（AFTER）',
    task: '比赛已结束：产品仍可调用，账本、审计与退款条款照常生效。',
    callToAction: { method: 'GET', endpoint: '/v1/evidence', why: '回顾真实交付与退款统计。' },
  },
};

export function roundOf(now = Date.now()) {
  const id = now < CRITIQUE_START ? 'BEFORE' : now < MARKET_START ? 'CRITIQUE' : now < ARENA_END ? 'MARKET' : 'AFTER';
  const { label, task, callToAction } = ROUNDS[id];
  return {
    id, label, task, callToAction, advisory: true,
    window: id === 'BEFORE' ? { start: null, end: new Date(CRITIQUE_START).toISOString() }
      : id === 'AFTER' ? { start: new Date(ARENA_END).toISOString(), end: null } : WINDOW,
    asOf: new Date(now).toISOString(),
  };
}

export function roundContext(now = Date.now()) {
  return { ...roundOf(now), trialPolicy: TRIAL_POLICY, payment: PAYMENT_MODEL };
}
