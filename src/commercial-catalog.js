import { object, string, ensure } from './errors.js';
import { DELIVERY_BUDGET_SECONDS } from './limits.js';

const text = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength });
const amount = { type: 'number', minimum: 0, maximum: 1000000 };
// 赞助分档：交付随单展示 / 人气榜置顶 / 表演冠名。价格与旧版广告位（ad-spot、ad-pin、ad-sponsor）保持一致，
// 避免同一档位出现两个价。比赛前按真实市场带（同行 1–12 分）下调，diagnostic 保持 30 不变。
export const SPONSOR_PLANS = {
  delivery: { price: 5, tier: 'ad-spot', placement: 'delivery', impressions: 10, minutes: null },
  leaderboard: { price: 10, tier: 'ad-pin', placement: 'leaderboard', impressions: null, minutes: 30 },
  featured: { price: 15, tier: 'ad-sponsor', placement: 'featured-naming', impressions: null, minutes: 30 },
};
const productProperties = { productName: text(160), productDescription: text(4000), price: amount, targetBuyer: text(500), context: text(4000) };
const productSchema = { type: 'object', properties: productProperties, additionalProperties: false, anyOf: [{ required: ['productDescription'] }, { required: ['context'] }] };
const make = (id, star, name, price, brief, inputSchema, example) => ({ id, star, name, price, brief, inputSchema, example, commercial: true, fields: [], currency: 'local-credit', maxDeliverySeconds: DELIVERY_BUDGET_SECONDS });
export const COMMERCIAL_SERVICES = [
  make('sales-pitch', 'star-a', 'Sales Pitch', 5, 'Turn your product into a clear Agent-ready sales pitch.', productSchema,
    { productName: 'CodeLens', productDescription: '输入代码，输出带文件位置的审查报告', price: 20, targetBuyer: 'coding agents' }),
  make('sales-stress-test', 'star-b', 'Sales Stress Test', 6, 'Simulate why buyers may reject your own offer. SIMULATED, not observed buyer feedback.', productSchema,
    { productDescription: '我方代码审查服务，输出风险清单', price: 20 }),
  make('deal-coach', 'star-c', 'Deal Coach', 10, 'Get the next move for pricing and negotiation.', {
    type: 'object', additionalProperties: false, properties: { currentOffer: amount, counterpartyMessage: text(), budget: amount, minimumAcceptablePrice: amount, goal: text(), context: text(4000) },
    anyOf: ['currentOffer', 'counterpartyMessage', 'goal', 'context'].map(field => ({ required: [field] })),
  }, { currentOffer: 20, budget: 15, counterpartyMessage: '能否缩小范围？', goal: '预算内采购代码审查' }),
  { ...make('star-sponsorship', 'ledger', 'Star Sponsorship', null, 'Sponsor Star A, B or C and receive verified exposure.', {
    type: 'object', required: ['starId', 'plan', 'advertiser', 'adCopy'], additionalProperties: false,
    properties: { starId: { enum: ['star-a', 'star-b', 'star-c'] }, plan: { enum: Object.keys(SPONSOR_PLANS) }, advertiser: text(100), adCopy: text(300) },
  }, { starId: 'star-b', plan: 'leaderboard', advertiser: 'CodeLens', adCopy: '代码审查：20积分，提供问题位置和修复建议。' }), ad: true, plans: SPONSOR_PLANS, maxDeliverySeconds: 15 },
  make('commercial-diagnostic', 'star-c', 'Commercial Diagnostic', 30, 'Analyze your authorized StarHall history and verified commercial signals.', {
    type: 'object', additionalProperties: false, properties: { ...productProperties, goal: text() },
  }, { goal: '结合我的使用和投放历史，找出下一步应验证什么' }),
];
export function validateCommercial(s, input) {
  object(input, Object.keys(s.inputSchema.properties));
  const clean = {};
  for (const [key, rule] of Object.entries(s.inputSchema.properties)) {
    if (input[key] === undefined) continue;
    if (rule.type === 'number') {
      ensure(typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 1000000, 'invalid_input', `${key} 需要0–1000000之间的有限数值`);
      clean[key] = input[key];
    } else { clean[key] = string(input[key], key, rule.maxLength || 64); if (rule.enum) ensure(rule.enum.includes(clean[key]), 'invalid_input', `${key} 只允许 ${rule.enum.join('/')}`); }
  }
  for (const key of s.inputSchema.required || []) ensure(clean[key] !== undefined, 'invalid_input', `缺少 ${key}`);
  if (s.inputSchema.anyOf) ensure(s.inputSchema.anyOf.some(c => c.required.every(k => clean[k] !== undefined)), 'invalid_input', '至少提供 productDescription/context，或交易场景的一项有效输入');
  return clean;
}
