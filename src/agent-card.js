import { VERSION } from './catalog.js';

/**
 * 产品发现卡（agent card），给别人的 agent 在按惯例敲门时读。
 *
 * 设计原则照 SharedOS ADR 0021「read time, never stored」：卡片**每次请求都从实时目录
 * 重新计算**，不落地、不缓存。价格、免费/付费分层、输入 schema、健康状态、开户方式全部来自
 * `app.catalog()`，所以卡片永远不可能比服务本身更慷慨，也不会在权限或价格变化后继续撒谎。
 *
 * 这里只描述**产品**（卖什么、多少钱、怎么调、怎么开户）。内核级 agent card
 * （`SharedOSKernel.readAgentCard`：身份 + 实算 reach，需要 sharedos/directory 读授权）是另一回事，
 * 本文件不冒充它。
 */
const MCP_PROTOCOL = '2025-06-18';

export function buildAgentCard(app, options = {}) {
  const base = options.publicBaseUrl ? options.publicBaseUrl.replace(/\/+$/, '') : '';
  const link = path => `${base}${path}`;
  const listing = app.catalog();
  const core = listing.services.filter(s => s.id !== 'market-board');
  const free = [listing.services.find(s => s.id === 'market-board')].filter(Boolean);

  const planCost = service => service.plans ? Math.min(...Object.values(service.plans).map(p => p.price)) : null;
  const entry = service => ({
    id: service.id,
    name: service.name,
    tier: (service.price ?? planCost(service)) ? 'PAID' : 'FREE',
    cost: service.price ?? planCost(service) ?? 0,
    currency: 'local-credit',
    maxDeliverySeconds: service.maxDeliverySeconds ?? null,
    summary: service.brief,
    inputSchema: service.inputSchema,
    ...(service.plans ? { plans: Object.fromEntries(Object.entries(service.plans).map(([key, plan]) => [key,
      { price: plan.price, placement: plan.placement, impressions: plan.impressions ?? null, minutes: plan.minutes ?? null }])) } : {}),
    ...(service.health ? { health: service.health.status } : {}),
  });

  return {
    schemaVersion: 'v1',
    name: listing.product,
    tagline: listing.positioning,
    description: '三位商业明星：星A把产品讲清楚，星B预演买家异议，星C处理报价与谈判；消费与赞助形成真实分数，曝光进入买方自己的证据诊断。积分与顾客均为本地模拟，真实赛事 credit 在 SharedNet 房间结算。',
    version: VERSION,
    url: base || null,
    protocols: { mcp: MCP_PROTOCOL, mcpTransport: 'streamable-http', http: 'v1' },
    endpoints: {
      agentCard: link('/agent-card.json'),
      wellKnown: link('/.well-known/agent-card.json'),
      mcp: link('/mcp'),
      mcpAlias: link('/api/mcp'),
      catalog: link('/v1/catalog'),
      marketBoard: link('/v1/market-board'),
      trial: link('/v1/trials'),
      order: link('/v1/orders'),
      orderStatus: link('/v1/orders/by-key'),
      refund: link('/v1/orders/{id}/refund'),
      revision: link('/v1/orders/{id}/revision'),
      register: options.openRegistration ? link('/v1/agents') : null,
      health: link('/health'),
    },
    identity: {
      namespaceId: app.bridge.identity.namespaceId,
      owner: app.bridge.identity.owner,
      stars: (listing.stars || []).map(s => ({ starId: s.starId, role: s.role, audience: s.audience })),
      internalAgents: ['ledger', 'broker'],
      purposes: ['arena-demo', 'market-tip', 'ledger-update', 'escalation-review'],
    },
    pricing: {
      currency: 'local-credit',
      simulated: true,
      model: listing.payment,
      free: free.map(entry),
      matrix: Object.fromEntries(core.map(s => [s.id, { tier: 'PAID', cost: s.price ?? planCost(s), currency: 'local-credit',
        ...(s.plans ? { plans: Object.keys(s.plans) } : {}) }])),
      extras: Object.fromEntries(listing.extras.services.map(s => [s.id, { tier: s.price ? 'PAID' : 'FREE', cost: s.price ?? 0, currency: 'local-credit' }])),
      trial: { once: true, price: 0, perService: true, endpoint: link('/v1/trials'), note: '每个身份每种付费服务最多一次成功免费试用。' },
    },
    services: [...core, ...free, ...listing.extras.services].map(entry),
    interfaces: {
      mcp: {
        transport: 'streamable-http',
        url: link('/mcp'),
        accept: 'application/json, text/event-stream',
        stateless: true,
        tools: options.mcpTools || [],
        note: 'MCP 与 JSON HTTP 调用同一套内核授权、账本与审计，没有第二条绕过 grants 的路径。',
      },
      http: { base: base || null, contract: link('/v1/catalog'), auth: 'Authorization: Bearer <token>', idempotencyHeader: 'Idempotency-Key' },
    },
    onboarding: options.openRegistration
      ? { requiresHuman: false, method: 'POST', path: link('/v1/agents'), mcpTool: 'starhall_register',
          body: { handle: '<3-64 位小写字母数字-_>', name: '<展示名，可选>', secret: '<自己生成的 16+ 字符密钥>' },
          note: '自助开户，返回 token；服务端只保存摘要。同一 handle 配同一 secret 再次调用只轮换 token。' }
      : { requiresHuman: true, note: '本部署未开放自助开户。' },
    policies: {
      refund: '机器仲裁：客观失败或违反交付约定自动退款；主观不满意不退款，但提供一次免费修订。',
      revision: '已交付的付费内容单可申请一次免费修订，不扣款、不增加销量。',
      idempotency: '下单与试用都需要幂等键；重试必须复用同一个键和同一份内容，服务器返回原订单。',
      delivery: listing.deliveryPolicy,
      honesty: '没有真实消费与赞助时不展示虚构人气；涨粉、广告曝光与排名只反映真实记录。',
    },
    kernel: {
      sdk: '@aicoo/sharedos@0.1.0-alpha.5',
      note: '每次调用都由内核按 grants 重新授权并写审计；reach 由内核在读的时候计算，不落地。',
    },
  };
}
