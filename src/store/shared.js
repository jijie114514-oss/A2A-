import { createHash, randomBytes } from 'node:crypto';
import { ensure } from '../errors.js';
import { STARS, getService } from '../catalog.js';
import { marketBoard, MARKET_DEFAULTS, eligiblePaid, activeAd } from '../market.js';

/** 三个驱动（file / memory / postgres）共用：纯函数与领域约定都放这里，禁止复制三份。 */
export const hash = text => createHash('sha256').update(text).digest('hex');
export const now = () => new Date().toISOString();

/** 订单租约：超过这个时间仍 pending 的单子由惰性清理判失败。必须大于单笔最坏处理时间（115 秒）。 */
export const ORDER_LEASE_MS = 300_000;

export const STORE_NAMES = ['file', 'memory', 'postgres'];

export function emptyState() {
  return { version: 1, accounts: [], orders: [], wall: [], memories: {}, practice: [], events: [], ads: [],
    commercialSignals: [], impressions: [], marketMoves: [], rateLimits: {} };
}

/** 旧存档升级 + 每个驱动都会跑的归一化；不改任何已完成的订单。 */
export function normalizeState(state, market = MARKET_DEFAULTS) {
  if (!Array.isArray(state.ads)) state.ads = [];
  state.marketSettings = structuredClone(market);
  state.commercialSignals ||= []; state.impressions ||= []; state.marketMoves ||= []; state.rateLimits ||= {};
  state.marketStartedAt ||= state.orders.find(eligiblePaid)?.completedAt || null;
  return state;
}

/** 惰性租约清理：进程重启/多实例都不再靠「启动时判死」，只认订单自己的 expiresAt。 */
export function sweepExpired(state, at = Date.now()) {
  let changed = false;
  for (const order of state.orders.filter(o => o.status === 'pending' && o.expiresAt && Date.parse(o.expiresAt) < at)) {
    order.status = 'failed';
    order.error = { code: 'interrupted', message: '订单超出处理租约，已释放预留积分，请使用新的幂等键重试' };
    order.completedAt = new Date(at).toISOString();
    changed = true;
  }
  return changed;
}

export function summaryOf(state) {
  const paid = state.wall.filter(w => w.amount > 0 && (!w.kind || w.kind === 'paid') && eligiblePaid(state.orders.find(o => o.id === w.id)));
  const trials = state.wall.filter(w => w.kind === 'trial');
  const ranking = marketBoard(state).ranking.map(row => ({ ...row, name: STARS[row.star].name, trials: trials.filter(w => w.stars.includes(row.star)).length }));
  const ads = state.ads || [];
  const activeAds = ads.filter(a => activeAd(state, a));
  const latest = state.wall.slice(-20).reverse().map(({ buyerName, stars, amount, serviceName, createdAt, kind }) => ({ buyerName, stars, amount, serviceName, createdAt, kind: kind || 'paid' }));
  return { mode: state.mode || 'local', ranking, latest, totalPurchases: paid.length, totalCredits: paid.reduce((n, w) => n + w.amount, 0), totalTrials: trials.length, totalDemos: state.wall.filter(w => w.kind === 'demo').length,
    ads: { pinned: activeAds.filter(a => !a.starId && a.tier === 'ad-pin').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(a => ({ id: a.id, team: a.buyerName, text: a.text, kind: a.kind, until: a.expiresAt, displays: a.displays })), activeCount: activeAds.length, totalPlaced: ads.length, note: '置顶广告按投放先后排序；没有真实投放时列表为空，不展示虚构广告。' },
    pinnedThanks: paid.filter(w => w.pinned).slice(-3).reverse().map(w => ({ buyerName: w.buyerName, thanks: `感谢 ${w.buyerName} 的金主支持！`, createdAt: w.createdAt })),
    patronOffer: { service: 'patron', price: getService('patron').price, message: '金主套餐交付完整作品并进入感谢区；当前没有金主时不展示虚构记录。' } };
}

/** 开户限流：状态文档内按小时窗口计数，跨实例（Postgres）与单实例（file/memory）语义一致。
 *  0 表示不限制。窗口内的键会顺手清理，避免状态文档被无限撑大。 */
export function enforceRateLimit(state, { bucket, key, perHour, at = Date.now(), message }) {
  if (!perHour) return;
  const windows = (state.rateLimits[bucket] ||= {});
  const recent = (windows[key] || []).filter(stamp => at - stamp < 3600_000);
  ensure(recent.length < perHour, 'rate_limited', message || `请求过于频繁：每小时最多 ${perHour} 次，请稍后重试`, 429);
  recent.push(at);
  windows[key] = recent;
  for (const [candidate, stamps] of Object.entries(windows)) if (stamps.every(stamp => at - stamp >= 3600_000)) delete windows[candidate];
}

/** 首次初始化时的本地身份：主理人（经纪人）与三个模拟顾客。凭据先落盘、再铸余额。 */
export function defaultCredentials(mode = 'local') {
  return { mode, accounts: [
    { id: 'broker', name: '星辉经纪人', role: 'broker', balance: 100 },
    { id: 'fan-orion', name: '猎户座队', role: 'customer', balance: 100 },
    { id: 'fan-lyra', name: '天琴座队', role: 'customer', balance: 100 },
    { id: 'fan-vega', name: '织女星队', role: 'customer', balance: 100 },
  ].map(a => ({ ...a, token: randomBytes(32).toString('hex') })) };
}

export function credentialsMatch(credentials, state) {
  return Array.isArray(credentials?.accounts) && credentials.accounts.length > 0
    && credentials.accounts.every(a => state.accounts.some(b => a.id === b.id && hash(a.token) === b.tokenHash));
}

export function applyCredentials(state, credentials) {
  state.accounts = credentials.accounts.map(({ token, ...a }) => ({ ...a, tokenHash: hash(token) }));
  state.credentials = credentials;
}
