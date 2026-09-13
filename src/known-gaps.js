/**
 * 已知缺口台账：竞技场里被点评是必然的，关键是被点到之后能不能**当场给出可核验的答复**。
 * 每条都写清 status / 证据 / 一句话答复；卖方 agent 回答异议时只能引用这里与产品事实，不许自由发挥。
 */
export const KNOWN_GAPS = [
  { id: 'paid-fallback-no-remedy', keys: [/备用|fallback|模板|降级|模型失败/i, /收费|扣分|退款|退钱/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修：付费单若交付备用作品（generation.mode=fallback）一律自动全额退款，退款原因 FALLBACK_NOT_CHARGED，作品照发；目录 deliveryPolicy.fallbackCharged 现在是 false。回执顶层新增 deliveryMode 与 notice，不用翻 pieces 就知道拿到的是模板。',
    evidence: ['GET /v1/catalog → deliveryPolicy.fallbackCharged=false', 'GET /v1/evidence → 退款原因分布含 FALLBACK_NOT_CHARGED'] },
  { id: 'validator-false-reject', keys: [/校验|误杀|自行添加|报价|预算/i, /MODEL_VALIDATION_FAILED|repairReasons/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修：输入里给过的金额（预算、对方报价、底价）在正文引用不再被判「自行添加报价」，只有凭空出现的数字才拒绝。你那份输入（price 20 + context 预算15）现在一次通过：sales-pitch 与 sales-stress-test 都是 attempts=1、mode=live。',
    evidence: ['test/sales-validation.test.js 用你当时逐字输入做回归', 'GET /v1/catalog → 对应服务的 health.fallbackReasons 不再累积'] },
  { id: 'context-as-product-description', keys: [/context|背景|约束/i, /正文|拼|塞|描述/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修：销售类服务的 context 锚点改成非必填（只展示不强制），模型不再被逼着把背景塞进 pitch 正文；context 仍会出现在 inputComparison 里供你核对。',
    evidence: ['test/sales-validation.test.js「context 是背景与约束」用例'] },
  { id: 'deal-coach-walkaway-direction', keys: [/walk.?away|退出|底价|预算/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修：退出条件现在分方向。预算=底价时只说「可行区间只有 X 这一点」；只给预算说买方视角、只给底价说卖方视角；底价高于预算直接说区间不存在。',
    evidence: ['test/sales-validation.test.js「退出条件分方向」用例'] },
  { id: 'catalog-health-no-predictive-power', keys: [/健康|health|预测力|live ?rate|失败原因/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修：目录里每个服务的 health 现在带 fallbackReasons（按 internalReason 计数），并且已退款/备用交付仍然计入降级信号，不会因为退款而显得"健康"。',
    evidence: ['GET /v1/catalog → services[].health.fallbackReasons'] },
  { id: 'ad-reach-self-pollution', keys: [/广告|曝光|触达|sponsor|impression/i, /自己|自产|刷|轮询|独立|去重|监控|watch/i],
    status: 'fixed', fixedAt: '2026-09-13',
    reply: '已修（买方 2026-09-13 实测：17 次曝光里 13 次是卖方自己的 15 秒轮询、4 次是买方自己的订单）：headline 只计去重后的独立认证买家触达；广告主自己、平台身份与匿名轮询在 GET /v1/ads 的 inclusions / impressionsByClass / uniqueViewers 里单列，不再进总数；同一 buyerId 在一个 campaign 内只计 1 次。监视器可带 X-StarHall-Impressions: none，读了不计数（我们的 watch-arena 已默认带）。delivery 档按去重独立认证触达计费；窗口从**购买激活时刻**起算 60 分钟（不是从首次曝光，也不会因有人看过而延长），窗口结束仍 verifiedReach < displaysMax 时机器自动全额退款（IMPRESSIONS_NOT_DELIVERED），无需买家申请。',
    evidence: ['GET /v1/ads/:id → verifiedReach / trackedImpressions / impressionsByClass / uniqueViewers / attribution', 'test/ads.test.js 10 项（分类、去重、no-count 头、自动退款、归因）', 'GET /v1/market-board 带 X-StarHall-Impressions: none → impressionPolicy=not-counted、surfaceId=null'] },
  { id: 'model-grounding-still-can-degrade', keys: [/长尾|分布|失败率|可靠性|稳定/i],
    status: 'open',
    reply: '仍然存在：模型没满足交付契约时只能降级为备用作品。现在的兜底是「降级不收费 + 公开失败原因分布」；模型侧我们会继续收窄 prompt 与 grounding；没有把失败样本藏起来，GET /v1/evidence 的 failures 与 latencyByOutcome 都能复算。',
    evidence: ['GET /v1/evidence → failures{byReason,byService} 与 latencyByOutcome'] },
  { id: 'single-seller-room', keys: [/≥3 ?家|三家|外队|跨队|排名/i],
    status: 'structural',
    reply: '这是房间结构问题，不是产品能力：本房间只有我们一家卖方，因此「≥3 家外队排名」无法在这里成立。我们不伪造多队对比；真实竞技场里请按实到队伍数排名。',
    evidence: ['GET /v1/catalog → market.scope=single-team, externalTeamsConnected=0'] },
  { id: 'no-sharedos-cloud-reporting', keys: [/sharedos ?cloud|托管内核|tenant|审计/i],
    status: 'open',
    reply: '仍然存在：我们的权限决策写在自己的账本与审计表里（每次调用重新授权、deny-by-default），尚未上报到 SharedOS Cloud 控制台——需要官方给 tenant id / owner address 与事件集成方式。我们不会假装已经接入。',
    evidence: ['docs/DEPLOY-VERCEL-REFACTOR.md、README 的"未完成项"'] },
];

/** 命中缺口台账：一条消息常常同时点好几件事（买方那次就是三条异议），所以返回全部命中的，
 *  按命中关键词数排序，由调用方决定答几条。 */
export function matchGaps(text, limit = 3) {
  return KNOWN_GAPS
    .map(gap => ({ gap, score: gap.keys.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0) }))
    .filter(hit => hit.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(hit => hit.gap);
}
export const matchGap = text => matchGaps(text, 1)[0] || null;
