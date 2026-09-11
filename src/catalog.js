import { object, string, ensure } from './errors.js';
import { COMMERCIAL_SERVICES, validateCommercial } from './commercial-catalog.js';
import { STAR_ROLES } from './market.js';

export const STARS = {
  'star-a': { name: '星A · 词曲家', persona: '你是星辉舞台词曲家。中文表达有节奏、有具体意象，避免空泛赞美。交付能直接使用的作品，署名「星A · 词曲家」。' },
  'star-b': { name: '星B · 毒舌评审', persona: '你是星辉舞台毒舌评审。幽默犀利，针对产品设计和论点，不攻击身份或个人。不编造试用经历、数据和竞赛结果。明确区分事实、推断与待验证项。' },
  'star-c': { name: '星C · 谈判大师', persona: '你是星辉舞台谈判大师。给出能当场使用的条件交换、底线、让步和退出话术。区分模拟与真实交易，不虚构成交。' },
};
const service = (id, star, name, price, seconds, fields, brief) => ({ id, star, name, price, currency: 'local-credit', maxDeliverySeconds: seconds, fields, brief });
// 广告位服务：无模型、即时生效，由平台账本（ledger）结算，不归属任何明星。
const ad = (id, name, price, seconds, brief) => ({ id, star: 'ledger', ad: true, name, price, currency: 'local-credit', maxDeliverySeconds: seconds, fields: ['text'], brief });
export const AD_SERVICES = [
  ad('ad-spot', '随单展示位', 8, 15, '广告随之后每次付费/试用交付展示10次（“本作品由XX队赞助”）；买家可查实时展示次数'),
  ad('ad-pin', '人气榜置顶位', 15, 15, '广告挂在免费人气榜顶部30分钟，按投放先后排序'),
  ad('ad-sponsor', '表演冠名', 20, 15, '接下来30分钟所有交付作品开头带“本作品由XX队冠名呈现”'),
];
export const SERVICES = [
  service('poem', 'star-a', '定制短诗 / 歌词', 10, 180, ['theme', 'recipient'], '约100字的定制短诗或歌词，含签名'),
  service('speech', 'star-a', '产品广告词 / 胜利致辞', 15, 180, ['occasion', 'recipient'], '可直接使用的广告词或致辞；产品名可放在场合中'),
  service('patron', 'star-a', '金主套餐', 20, 290, ['occasion', 'recipient'], '200–400字的完整表演作品，附置顶感谢'),
  service('roast', 'star-b', '专业吐槽', 8, 120, ['description'], '约300字，犀利但不虚构事实的产品吐槽'),
  service('review', 'star-b', '结构化产品评审', 15, 240, ['description'], '优势、具体异议、风险、改进建议和验证方法'),
  service('prediction', 'star-b', '冠军观察 / 选品锦囊', 5, 60, [], '有材料时给出条件性预测；无材料时提供评分尺、核验问题、候选比较表与预算止损建议'),
  service('negotiate', 'star-c', '模拟砍价对手', 15, 290, ['scenario'], '一次交付5回合买卖双方模拟对话及复盘；也可继续5次互动练习'),
  service('tactics', 'star-c', '谈判话术锦囊', 10, 120, ['direction'], '买方或卖方可用的开场、探底、交换、收口、退出话术'),
  service('duet', 'star-b', '吐槽 + 反击诗套餐', 15, 290, ['description', 'theme', 'recipient'], '星B点评目标产品，跨身份调用星A写反击诗；只扣一笔15分'),
  ...AD_SERVICES,
  ...COMMERCIAL_SERVICES,
];
export function getService(id) { return SERVICES.find(s => s.id === id); }
export function validateInput(s, input) {
  if (s.commercial) return validateCommercial(s, input);
  object(input, [...s.fields, 'context']);
  const clean = {};
  for (const key of s.fields) clean[key] = string(input[key], key, key === 'text' && s.ad ? 300 : 2000);
  if (input.context !== undefined && !s.ad) clean.context = string(input.context, 'context', 4000);
  if (s.id === 'tactics') ensure(['buy', 'sell'].includes(clean.direction), 'invalid_input', 'direction 只能为 buy 或 sell');
  return clean;
}
export const VERSION = '0.5.0-local';
function legacyCatalog() {
  const free = { id: 'summary', name: '人气榜基础版', price: 0, currency: 'local-credit', fields: [], maxDeliverySeconds: 5,
    brief: '免费查看真实打赏与试用动态；不产生付费订单或会员权限', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: { method: 'GET', path: '/v1/summary', purpose: 'summary' } };
  return { product: 'StarHall · 星辉舞台', version: VERSION, mode: 'local', payment: '本地模拟积分，无真实支付',
    services: [free, ...SERVICES.filter(s => !s.commercial).map(s => ({ ...s,
      inputSchema: s.ad ? { type: 'object', required: ['text'], additionalProperties: false,
        properties: { text: { type: 'string', minLength: 1, maxLength: 300, description: '广告词，将原样展示给其他买家；不得伪装成买家评价或虚构事实', examples: ['XX队代码审查服务：15分一次，5分钟内交付结构化报告。'] } } }
      : { type: 'object', required: s.fields, additionalProperties: false,
      properties: Object.fromEntries([...s.fields, 'context'].map(key => [key, { type: 'string', minLength: 1, maxLength: key === 'context' ? 4000 : 2000,
        ...(key === 'direction' ? { enum: ['buy', 'sell'], description: 'buy=作为买方压价；sell=作为卖方守价', examples: ['buy', 'sell'] } : {}),
        ...(key === 'context' ? { description: '本单必须使用的背景、产品范围和约束，不是可忽略的备注', examples: ['向别队购买代码审查服务，预算15积分，对方报价20积分，可减少一次修订。'] } : {}) }])) },
      call: { method: 'POST', path: '/v1/orders', purpose: 'market-tip', body: s.ad ? { service: s.id, input: { text: '<广告词>' } }
        : { service: s.id, input: s.id === 'tactics' ? { direction: 'buy', context: '向别队购买代码审查服务，预算15积分，对方报价20积分，可减少一次修订。' } : Object.fromEntries(s.fields.map(f => [f, `<${f}>`])) } } }))],
    trial: { method: 'POST', path: '/v1/trials', price: 0, requires: ['customer Bearer token', 'Idempotency-Key'], limit: '每个身份每种付费服务最多一次成功免费试用；失败可换键重试。试用不产生付费会员权益。' },
    free: { name: '人气榜基础版', price: 0, method: 'GET', path: '/v1/summary' },
    included: ['公开点名上墙', '完整打赏墙快照', '明星粉丝记忆'],
  };
}
export function catalog() {
  const legacy = legacyCatalog();
  const free = { ...legacy.services[0], id: 'market-board', name: 'StarHall Live Market Board', brief: '免费查看本队真实商业行情、明星支持与赞助压力。', call: { method: 'GET', path: '/v1/market-board', purpose: 'market-board-read' } };
  return { ...legacy, product: 'STARHALL — SELL BETTER IN THE ARENA', positioning: 'Three commercial stars, real local usage, sponsorship and evidence-based commercial analysis.',
    stars: Object.entries(STAR_ROLES).map(([starId, role]) => ({ starId, ...role })),
    services: [...COMMERCIAL_SERVICES.map(s => ({ ...s, call: { method: 'POST', path: '/v1/orders', purpose: 'market-tip', body: { service: s.id, input: s.example } } })), free],
    extras: { name: 'CELEBRITY EXTRAS', services: legacy.services.slice(1), note: 'Legacy unbound ads remain callable but are not the primary sponsorship model and do not create Sponsor Support.' },
    free: { name: free.name, price: 0, method: 'GET', path: '/v1/market-board', compatibilityPath: '/v1/summary' },
    included: ['Compact Market Board', 'one recommendedNextAction', 'own commercial signals for core sales services'] };
}
