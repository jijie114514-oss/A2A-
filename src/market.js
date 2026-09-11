import { randomUUID } from 'node:crypto';

export const MARKET_DEFAULTS = { sponsorSupportWeight: 0.6, exposureMultipliers: [1.5, 1.2, 1], phase: 'AUTO' };
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
      impressionDefinition: 'ad included in a committed delivery or board response; not proof of reading or conversion' }, asOf: new Date(at).toISOString() };
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
export function expose(state, { surfaceId, traffic, stars = [], compact = false, skipAdId = null }) {
  state.impressions ||= [];
  const shown = [];
  const slots = [...new Set(stars)].map(star => ({ key: `delivery:${star}`, filter: a => a.starId === star && ['ad-spot', 'ad-sponsor'].includes(a.tier) }));
  slots.push({ key: compact ? 'compact' : 'market-board', filter: a => a.tier === 'ad-pin' || a.tier === 'ad-sponsor' });
  for (const slot of slots) {
    const candidates = state.ads.filter(a => a.starId && a.id !== skipAdId && !shown.some(s => s.adId === a.id) && activeAd(state, a));
    const ad = selectAd(state, candidates.filter(slot.filter), slot.key);
    if (!ad) continue;
    const eventId = `${surfaceId}:${ad.id}`;
    if (!state.impressions.some(i => i.id === eventId)) {
      ad.displays++; ad.lastDisplayAt = new Date().toISOString();
      if (ad.displaysMax && ad.displays >= ad.displaysMax) ad.status = 'fulfilled';
      state.impressions.push({ id: eventId, adId: ad.id, buyerId: ad.buyerId, starId: ad.starId, traffic, surface: slot.key, surfaceId, at: ad.lastDisplayAt, evidenceClass: 'OBSERVED' });
    }
    shown.push({ adId: ad.id, starId: ad.starId, placement: slot.key, advertiser: ad.advertiser, adCopy: ad.text, kind: ad.kind, sponsored: true, impressionId: eventId });
  }
  return shown;
}
export function compactBoard(state, surfaceId, stars = [], skipAdId = null) {
  const sponsors = expose(state, { surfaceId, traffic: 'PASSIVE', stars, compact: true, skipAdId });
  const board = marketBoard(state);
  return { phase: board.phase, ranking: board.ranking.map(({ starId, rank, starScore, momentum }) => ({ starId, rank, starScore, momentum })),
    sponsors, fullBoard: { method: 'GET', path: '/v1/market-board', price: 0 } };
}
export function boardResponse(state, actorId, key) {
  state.boardReceipts ||= {};
  const scope = key ? JSON.stringify([actorId, key]) : null;
  if (scope && state.boardReceipts[scope]) return state.boardReceipts[scope];
  const surfaceId = `board:${randomUUID()}`;
  const sponsors = expose(state, { surfaceId, traffic: 'ACTIVE' });
  const result = { ...marketBoard(state), surfaceId, sponsors };
  if (scope) state.boardReceipts[scope] = result;
  return result;
}
export function campaignStats(state, ad) {
  const impressions = (state.impressions || []).filter(i => i.adId === ad.id);
  const order = state.orders.find(o => o.id === ad.orderId);
  const refunded = order?.status === 'refunded' || Boolean(order?.refund?.refundApplied);
  return { ...ad, status: refunded ? 'refunded' : activeAd(state, ad) ? 'active' : ad.status === 'active' ? 'expired' : ad.status,
    refunded, ...(order?.refund ? { refundReason: order.refund.refundReason } : {}),
    currentImpressions: ad.displays, trackedImpressions: impressions.length, traffic: {
      active: impressions.filter(i => i.traffic === 'ACTIVE').length, passive: impressions.filter(i => i.traffic === 'PASSIVE').length },
    impressions: impressions.map(({ buyerId, ...i }) => i), trackingEndpoint: `/v1/ads/${ad.id}` };
}
export function recordLegacyImpression(state, ad, surfaceId, traffic, surface) {
  state.impressions ||= [];
  const id = `${surfaceId}:${ad.id}`;
  if (state.impressions.some(i => i.id === id)) return;
  ad.displays++; ad.lastDisplayAt = new Date().toISOString();
  if (ad.displaysMax && ad.displays >= ad.displaysMax) ad.status = 'fulfilled';
  state.impressions.push({ id, adId: ad.id, buyerId: ad.buyerId, starId: null, traffic, surface, surfaceId, at: ad.lastDisplayAt, evidenceClass: 'OBSERVED' });
}
