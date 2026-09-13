import { randomUUID } from 'node:crypto';
import { roundContext } from './rounds.js';

export const MARKET_DEFAULTS = { sponsorSupportWeight: 0.6, exposureMultipliers: [1.5, 1.2, 1], phase: 'AUTO', deliveryAdMinutes: 60 };
/** 平台自己的身份：它们的请求不算外部触达。 */
export const PLATFORM_VIEWERS = Object.freeze(['broker', 'star-a', 'star-b', 'star-c', 'ledger']);
/**
 * 曝光分类（测试端 2026-09-13 反馈）：
 *   independent = 其他已认证买家（唯一计入 headline 与计费的触达）
 *   self        = 广告主自己的请求/订单（自产流量，不算触达）
 *   platform    = StarHall 自己的经纪人/明星/账本（自家流量）
 *   anonymous   = 没有 token 的请求（含固定周期轮询的监视脚本，不算认证触达）
 */
export function viewerClassOf(ad, viewer) {
  if (!viewer || viewer === 'public' || viewer === 'anonymous') return 'anonymous';
  if (viewer === ad.buyerId) return 'self';
  if (PLATFORM_VIEWERS.includes(viewer)) return 'platform';
  return 'independent';
}
export const STAR_ROLES = {
  'star-a': { role: 'Sales Communication', audience: 'Agents preparing to sell and explain product value' },
  'star-b': { role: 'Sales Stress Test', audience: 'Agents testing their own offers, objections and risks' },
  'star-c': { role: 'Deal Closing', audience: 'Agents working on pricing, negotiation and closing' },
};
const round = n => Math.round(n * 10000) / 10000;
export const eligiblePaid = o => o?.status === 'delivered' && (!o.kind || o.kind === 'paid') && o.price > 0 && !o.refundedAt && !o.refund && !o.refunded;
export function activeAd(state, ad, at = Date.now()) {
  const order = state.orders.find(o => o.id === ad.orderId);
  return ad.status === 'active' && (!ad.expiresAt || Date.parse(ad.expiresAt) > at) && (!ad.displaysMax || ad.displays < ad.displaysMax)
    && order?.status === 'delivered' && !order.refundedAt && !order.refund && !order.refunded;
}
export function marketBoard(state, at = Date.now()) {
  const settings = { ...MARKET_DEFAULTS, ...state.marketSettings };
  const paid = state.orders.filter(eligiblePaid);
  const pool = (state.ads || []).filter(a => a.starId && activeAd(state, a, at));
  const ranking = Object.entries(STAR_ROLES).map(([star, role]) => {
    const fanOrders = paid.filter(o => o.delivery?.wallEntry?.allocations?.[star] > 0 && !o.delivery?.ad);
    const fanSupport = fanOrders.reduce((n, o) => n + o.delivery.wallEntry.allocations[star], 0);
    const sponsorCredits = paid.filter(o => o.delivery?.ad?.starId === star).reduce((n, o) => n + o.price, 0);
    const sponsorSupport = round(sponsorCredits * settings.sponsorSupportWeight);
    const activeSponsors = pool.filter(a => a.starId === star).length;
    return { star, starId: star, ...role, fanSupport, sponsorSupport, starScore: round(fanSupport + sponsorSupport),
      tips: fanOrders.length, credits: fanSupport, activeSponsors,
      sponsorPressure: activeSponsors === 0 ? 'NONE' : activeSponsors === 1 ? 'LOW' : activeSponsors < 4 ? 'MEDIUM' : 'HIGH' };
  }).sort((a, b) => b.starScore - a.starScore || a.star.localeCompare(b.star));
  for (const [i, row] of ranking.entries()) {
    row.rank = i + 1; row.exposureWeight = settings.exposureMultipliers[i];
    const prior = state.marketSnapshot?.find(r => r.star === row.star);
    row.momentum = !prior || prior.starScore === row.starScore ? '→' : prior.starScore < row.starScore ? '↑' : '↓';
    row.scoreDelta = prior ? round(row.starScore - prior.starScore) : 0;
  }
  return { name: 'StarHall Live Market Board', scope: 'StarHall only; not Arena-wide trends', price: 0,
    phase: settings.phase === 'AUTO' ? (state.marketStartedAt || paid.length ? 'MARKET LIVE' : 'PRE-MARKET') : settings.phase,
    ranking, activity: { trial: state.wall.filter(w => w.kind === 'trial').length, demo: state.wall.filter(w => w.kind === 'demo').length,
      recent: state.wall.filter(w => ['trial', 'demo'].includes(w.kind)).slice(-5).reverse().map(w => ({ type: w.kind.toUpperCase(), service: w.service, at: w.createdAt })) },
    recentMarketMoves: (state.marketMoves || []).slice(-8).reverse(),
    policy: { ...settings, momentumBasis: 'score change since last successful delivery', tieBreak: 'starId ascending, not evidence of popularity',
      sponsorPressureBasis: 'active campaigns including labelled trials; NONE=0, LOW=1, MEDIUM=2–3, HIGH>=4',
      impressionDefinition: 'impression = ad included in a committed delivery or board response. Reach counts unique authenticated external buyers only; self, platform and unauthenticated requests are recorded separately. Not proof of reading or conversion.',
      countPolicy: 'authenticated independent buyer = 1 count per campaign (deduplicated); send X-StarHall-Impressions: none to read without creating impressions.' }, asOf: new Date(at).toISOString() };
}
export function recordMarketMove(state, order, before) {
  state.marketSnapshot = before.ranking.map(({ star, starScore }) => ({ star, starScore }));
  if (order.status !== 'delivered') return;
  if (eligiblePaid(order)) state.marketStartedAt ||= order.completedAt;
  state.marketMoves ||= [];
  const board = marketBoard(state);
  for (const row of board.ranking) {
    const prev = before.ranking.find(b => b.star === row.star);
    const scoreDelta = round(row.starScore - prev.starScore);
    const pressureChanged = row.sponsorPressure !== prev.sponsorPressure;
    if (scoreDelta === 0 && !pressureChanged) continue;
    const parts = [];
    if (scoreDelta > 0) parts.push(order.delivery.ad ? `${row.star} received a new sponsor` : `${row.star} completed a paid service`);
    else if (scoreDelta < 0) parts.push(`${row.star} support decreased by ${-scoreDelta}`);
    if (pressureChanged) parts.push(`${row.star} sponsor pressure changed to ${row.sponsorPressure}${eligiblePaid(order) ? '' : '（trial campaign, no Sponsor Support）'}`);
    const rankWord = row.rank === prev.rank ? `remains #${row.rank}` : `now #${row.rank}`;
    const type = scoreDelta !== 0 ? (order.delivery.ad?.starId === row.star ? 'SPONSOR_SUPPORT' : 'FAN_SUPPORT') : 'SPONSOR_PRESSURE';
    state.marketMoves.push({ id: `${order.id}:${row.star}`, orderId: order.id, at: order.completedAt, starId: row.star,
      type, scoreDelta, rank: row.rank, sponsorPressure: row.sponsorPressure, fromPaid: eligiblePaid(order), kind: order.kind,
      message: `${parts.join('; ')}; score ${row.starScore}, ${rankWord}` });
  }
}
/** A refund reverts support; record the real revert event, never describing it as new support. */
export function recordRefundMove(state, order, refundReason, beforeBoard) {
  state.marketMoves ||= [];
  const board = marketBoard(state);
  const stars = order.delivery?.ad?.starId ? [order.delivery.ad.starId] : (order.delivery?.wallEntry?.stars || []);
  for (const star of stars) {
    const row = board.ranking.find(r => r.star === star);
    if (!row) continue;
    const prev = beforeBoard.ranking.find(r => r.star === star);
    const scoreDelta = prev ? round(row.starScore - prev.starScore) : 0;
    state.marketMoves.push({ id: `${order.id}:refund:${star}`, orderId: order.id, at: order.refund?.refundedAt || new Date().toISOString(), starId: star,
      type: 'REFUND_REVERT', refundReason, scoreDelta, rank: row.rank, sponsorPressure: row.sponsorPressure,
      message: order.delivery?.ad ? `${star} sponsorship refunded (${refundReason}); score ${row.starScore}, now #${row.rank}`
        : `${star} paid support reverted (${refundReason}); score ${row.starScore}, now #${row.rank}` });
  }
}
// Smooth weighted round-robin across stars, then least-served campaign within a star.
// Scheduler and impressions share the same ledger transaction as their response.
function selectAd(state, candidates, slot) {
  if (!candidates.length) return null;
  state.exposureScheduler ||= {};
  const scores = state.exposureScheduler[slot] ||= {};
  const rows = marketBoard(state).ranking.filter(r => candidates.some(a => a.starId === r.star));
  for (const key of Object.keys(scores)) if (!rows.some(r => r.star === key)) delete scores[key];
  let total = 0;
  for (const row of rows) { scores[row.star] = (scores[row.star] || 0) + row.exposureWeight; total += row.exposureWeight; }
  rows.sort((a, b) => scores[b.star] - scores[a.star] || a.star.localeCompare(b.star));
  const selected = rows[0].star; scores[selected] -= total;
  return candidates.filter(a => a.starId === selected).sort((a, b) => a.displays - b.displays || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}
export function expose(state, { surfaceId, traffic, stars = [], compact = false, skipAdId = null, viewer = null, count = true }) {
  state.impressions ||= [];
  const shown = [];
  const slots = [...new Set(stars)].map(star => ({ key: `delivery:${star}`, filter: a => a.starId === star && ['ad-spot', 'ad-sponsor'].includes(a.tier) }));
  slots.push({ key: compact ? 'compact' : 'market-board', filter: a => a.tier === 'ad-pin' || a.tier === 'ad-sponsor' });
  for (const slot of slots) {
    const candidates = state.ads.filter(a => a.starId && a.id !== skipAdId && !shown.some(s => s.adId === a.id) && activeAd(state, a));
    const ad = selectAd(state, candidates.filter(slot.filter), slot.key);
    if (!ad) continue;
    const eventId = `${surfaceId}:${ad.id}`;
    // count=false 用于卖方自己的监视器：广告照常展示，但不写入任何曝光事件（"你们越勤奋，广告数据越假"）。
    const event = count ? recordImpression(state, ad, { id: eventId, traffic, surface: slot.key, surfaceId, viewer }) : null;
    shown.push({ adId: ad.id, starId: ad.starId, placement: slot.key, advertiser: ad.advertiser, adCopy: ad.text, kind: ad.kind, sponsored: true,
      impressionId: event ? event.id : null, counted: Boolean(event?.counted) });
  }
  return shown;
}
/** 只记账一次曝光事件。headline 只计「去重的独立认证买家」；self/platform/anonymous 一律记录但不计数。 */
function recordImpression(state, ad, { id, traffic, surface, surfaceId, viewer }) {
  state.impressions ||= [];
  const existing = state.impressions.find(i => i.id === id);
  if (existing) return existing;
  const viewerClass = viewerClassOf(ad, viewer);
  const counted = viewerClass === 'independent' && !state.impressions.some(i => i.adId === ad.id && i.counted && i.viewer === viewer);
  const at = new Date().toISOString();
  const event = { id, adId: ad.id, buyerId: ad.buyerId, starId: ad.starId ?? null, traffic, surface, surfaceId, at,
    evidenceClass: 'OBSERVED', viewer: viewer || 'anonymous', viewerClass, counted };
  state.impressions.push(event);
  if (counted) {
    ad.displays = (ad.displays || 0) + 1;
    ad.lastDisplayAt = at;
    if (ad.displaysMax && ad.displays >= ad.displaysMax) ad.status = 'fulfilled';
  }
  return event;
}
export function compactBoard(state, surfaceId, stars = [], skipAdId = null, viewer = null) {
  const sponsors = expose(state, { surfaceId, traffic: 'PASSIVE', stars, compact: true, skipAdId, viewer });
  const board = marketBoard(state);
  return { phase: board.phase, ranking: board.ranking.map(({ starId, rank, starScore, momentum }) => ({ starId, rank, starScore, momentum })),
    sponsors, fullBoard: { method: 'GET', path: '/v1/market-board', price: 0 } };
}
export function boardResponse(state, actorId, key, { countImpressions = true } = {}) {
  state.boardReceipts ||= {};
  const scope = key ? JSON.stringify([actorId, key]) : null;
  if (scope && state.boardReceipts[scope]) return state.boardReceipts[scope];
  const surfaceId = `board:${randomUUID()}`;
  const sponsors = expose(state, { surfaceId, traffic: 'ACTIVE', viewer: actorId, count: countImpressions });
  // 轮次也放在榜单回执里：买方 agent 轮询行情时顺带知道此刻该试用还是该购买。
  const result = { ...marketBoard(state), round: roundContext(), surfaceId: countImpressions ? surfaceId : null, sponsors,
    impressionPolicy: countImpressions ? 'counted (authenticated independent buyers only; self/platform/anonymous are recorded but excluded from reach)'
      : 'not-counted (X-StarHall-Impressions: none — this response created no impression events)' };
  if (scope) state.boardReceipts[scope] = result;
  return result;
}
export function campaignStats(state, ad) {
  const impressions = (state.impressions || []).filter(i => i.adId === ad.id);
  const order = state.orders.find(o => o.id === ad.orderId);
  const refunded = order?.status === 'refunded' || Boolean(order?.refund?.refundApplied);
  const classes = { independent: [], self: [], platform: [], anonymous: [] };
  for (const impression of impressions) (classes[impression.viewerClass] || classes.anonymous).push(impression);
  const counted = impressions.filter(i => i.counted);
  // 归因只给出「同一账本里，看过之后又下过单的买家」——相关性，不是因果，0 也是合法结果。
  const firstCounted = new Map();
  for (const impression of counted) if (!firstCounted.has(impression.viewer)) firstCounted.set(impression.viewer, impression);
  const laterOrders = [];
  for (const [viewer, first] of firstCounted)
    for (const candidate of state.orders)
      if (candidate.buyerId === viewer && Date.parse(candidate.createdAt) > Date.parse(first.at))
        laterOrders.push({ viewer, orderId: candidate.id, service: candidate.service, kind: candidate.kind, at: candidate.createdAt });
  return { ...ad, status: refunded ? 'refunded' : activeAd(state, ad) ? 'active' : ad.status === 'active' ? 'expired' : ad.status,
    refunded, ...(order?.refund ? { refundReason: order.refund.refundReason } : {}),
    currentImpressions: ad.displays, verifiedReach: ad.displays, trackedImpressions: impressions.length,
    traffic: { active: counted.filter(i => i.traffic === 'ACTIVE').length, passive: counted.filter(i => i.traffic === 'PASSIVE').length },
    inclusions: { total: impressions.length, active: impressions.filter(i => i.traffic === 'ACTIVE').length, passive: impressions.filter(i => i.traffic === 'PASSIVE').length },
    impressionsByClass: Object.fromEntries(Object.entries(classes).map(([kind, list]) => [kind, list.length])),
    uniqueViewers: Object.fromEntries(Object.entries(classes).map(([kind, list]) => [kind, new Set(list.map(i => i.viewer)).size])),
    attribution: { viewers: firstCounted.size, viewersWithLaterOrder: new Set(laterOrders.map(o => o.viewer)).size, laterOrders,
      note: 'Same-ledger time ordering: viewers who placed an order after their first verified impression. Correlation only — not proof the ad caused the order, and 0 is a valid result.' },
    impressions: impressions.map(({ buyerId, ...impression }) => impression), trackingEndpoint: `/v1/ads/${ad.id}` };
}
export function recordLegacyImpression(state, ad, surfaceId, traffic, surface, viewer = null) {
  return recordImpression(state, ad, { id: `${surfaceId}:${ad.id}`, traffic, surface, surfaceId, viewer });
}
