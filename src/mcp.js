import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppError, ensure, object, string } from './errors.js';
import { COMMERCIAL_SERVICES, SPONSOR_PLANS } from './commercial-catalog.js';
import { SERVICES, STARS, VERSION } from './catalog.js';
import { evidenceOf } from './evidence.js';

/**
 * StarHall 的 MCP 接入面。
 *
 * 这是产品的对外调用协议之一，和本地 JSON HTTP、CLI 并列：三者调用的是同一套
 * app 方法、同一套本地账本、同一套内核授权和审计。这里不实现任何新业务规则，
 * 也不绕过 `src/kernel.js` 的 grants；host 直接从已注册服务列表生成工具定义，
 * 让别人的 agent 不经人就能发现服务、开户、调用、拿回结果。
 *
 * 身份：受保护工具需要 `token`。外部 agent 先用 `starhall_register` 自助开户；
 * 运营方自己的 agent 可用 STARHALL_MCP_TOKEN 免传。
 */

const TOKEN = { type: 'string', minLength: 8, maxLength: 256, description: '本地身份令牌；来自 starhall_register，或运营方配置的 STARHALL_MCP_TOKEN' };
const IDEMPOTENCY = { type: 'string', minLength: 1, maxLength: 128, description: '幂等键。重试必须复用同一个键和同一份内容，服务器返回原订单，不重复扣款。' };
const MESSAGE = { type: 'string', maxLength: 500, description: '可选留言，会原样上打赏墙' };

// 外部 agent 常用 snake_case，内部统一用 camelCase；只做这一层别名，避免调用方踩坑。
const ALIASES = { idempotency_key: 'idempotencyKey', order_id: 'orderId', session_id: 'sessionId', star_id: 'starId' };
function normalize(args) {
  const clean = {};
  for (const [key, value] of Object.entries(args || {})) clean[ALIASES[key] || key] = value;
  return clean;
}
const tool = (name, description, properties, required = [], extra = {}) => ({
  name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  ...extra,
});
const free = { readOnlyHint: true, openWorldHint: false };
const paid = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function toolDefinitions({ openRegistration = false } = {}) {
  const tools = [
    tool('starhall_catalog', '免费。StarHall 星辉舞台全部商品、实价、免费/付费分层、输入 JSON Schema、交付与退款条款、健康状态，以及当前赛程轮次与试用政策（第一轮点评免费试用，第二轮市场用积分购买）。调用前先读这里。',
      {}, [], { annotations: free }),
    tool('starhall_market_board', '免费。本队真实商业行情：明星支持分、赞助压力、活动与广告位，不含其他队伍的销量。可选带上 token：这次查询会计入你的已认证触达（广告主可在 /v1/ads 查到）；匿名请求仍可读，但不计触达。',
      { token: { type: 'string', minLength: 8, maxLength: 256, description: '可选：你的身份令牌。带上时，这次行情查询计入你自己的已认证触达。' } }, [], { annotations: free }),
    tool('starhall_summary', '免费。基础人气榜与最近打赏动态。可选带上 token 计入已认证触达。',
      { token: { type: 'string', minLength: 8, maxLength: 256, description: '可选：你的身份令牌。' } }, [], { annotations: free }),
    tool('starhall_evidence', '免费公开。可机器核验的产品事实：交付数、live/备用比例、交付时延 p50/p95、退款原因分布、试用与成交统计，以及本产品「不主张什么」。第一轮点评时，具体异议请引用这里的数字；第二轮比价时用它比较交付可靠性。',
      {}, [], { annotations: free }),
  ];

  if (openRegistration) tools.push(tool('starhall_register',
    '免费。自助开户，拿一个本地身份令牌，之后用它调用付费与试用工具。不需要人工审批。handle 与 secret 决定归属：同一个 handle 配同一个 secret 再次调用会轮换令牌，配错 secret 会被拒绝。',
    { handle: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]*$', description: '你的 agent 标识，小写字母数字与 - _，例如 codex-reviewer' },
      name: { type: 'string', maxLength: 60, description: '展示名，默认与 handle 相同' },
      secret: { type: 'string', minLength: 16, maxLength: 256, description: '自己生成并保管的密钥，16 字符以上。服务端只保存摘要。' } },
    ['handle', 'secret'], { annotations: paid }));

  tools.push(tool('starhall_wallet', '查看当前身份的本地积分余额、预留额度与可用额度。',
    { token: TOKEN }, ['token'], { annotations: free }));

  for (const service of COMMERCIAL_SERVICES) {
    tools.push(tool(`starhall_buy_${service.id.replace(/-/g, '_')}`,
      `付费下单：${service.name}（${service.price ?? '按 plan 计价'} 本地积分，最多 ${service.maxDeliverySeconds} 秒交付）。${service.brief}`,
      { input: { ...service.inputSchema, description: '本服务的输入，字段见 schema' },
        message: MESSAGE, idempotencyKey: IDEMPOTENCY, token: TOKEN },
      ['input', 'idempotencyKey', 'token'], { annotations: paid }));
  }

  tools.push(
    tool('starhall_order', '付费下单：兼容服务（extras）。核心五商品有各自的 starhall_buy_* 工具，优先用它们。service 取值见 starhall_catalog 的 extras.services；不支持的 service 会返回 unknown_service 并提示升级路径。',
      { service: { type: 'string', minLength: 1, maxLength: 64, description: '服务 ID，例如 poem、speech、negotiate、duet' },
        input: { type: 'object', additionalProperties: true, description: '该服务的输入字段，见 starhall_catalog' },
        message: MESSAGE, idempotencyKey: IDEMPOTENCY, token: TOKEN },
      ['service', 'input', 'idempotencyKey', 'token'], { annotations: paid }),
    tool('starhall_trial', '免费试用：每个身份每种付费服务最多一次成功试用，失败可换幂等键重试。需要 token 与幂等键。试用同样走内核授权、审计与打赏墙，但不计销量、不产生会员权益。',
      { service: { type: 'string', minLength: 1, maxLength: 64 }, input: { type: 'object', additionalProperties: true },
        idempotencyKey: IDEMPOTENCY, token: TOKEN },
      ['service', 'input', 'idempotencyKey', 'token'], { annotations: paid }),
    tool('starhall_order_status', '查询订单。给 orderId，或给幂等键按原键取回原单（推荐：网络中断后先查原单，不要重买）。',
      { orderId: { type: 'string', maxLength: 128 }, idempotencyKey: { type: 'string', maxLength: 128 },
        trial: { type: 'boolean', description: '按幂等键查询试用单时设为 true' }, token: TOKEN },
      ['token'], { annotations: free }),
    tool('starhall_orders', '列出当前身份的订单，可按状态过滤。',
      { status: { enum: ['pending', 'delivered', 'failed', 'refunded'] }, token: TOKEN }, ['token'], { annotations: free }),
    tool('starhall_refund', '机器仲裁退款：客观失败或违反约束自动退；主观不满意会被拒绝并给出一次免费修订。退款幂等，不会重复退款。',
      { orderId: { type: 'string', minLength: 1, maxLength: 128 }, reason: { type: 'string', maxLength: 500, description: '可选，说明你认为哪条交付约定没有被满足' }, token: TOKEN },
      ['orderId', 'token'], { annotations: paid }),
    tool('starhall_revision', '对已成功交付的付费内容单申请一次免费修订：不扣款、不增加销量与明星支持，需要幂等键。',
      { orderId: { type: 'string', minLength: 1, maxLength: 128 }, notes: { type: 'string', maxLength: 1000, description: '修订要求' },
        idempotencyKey: IDEMPOTENCY, token: TOKEN },
      ['orderId', 'idempotencyKey', 'token'], { annotations: paid }),
    tool('starhall_practice', '五回合互动练习：对已有的 negotiate 订单会话继续说话，每次一句。',
      { sessionId: { type: 'string', minLength: 1, maxLength: 128 }, message: { type: 'string', minLength: 1, maxLength: 2000 },
        idempotencyKey: IDEMPOTENCY, token: TOKEN },
      ['sessionId', 'message', 'idempotencyKey', 'token'], { annotations: paid }),
    tool('starhall_commercial_profile', '读取当前身份自己的商业档案与已验证信号（只读自己的，不暴露他人数据）。Commercial Diagnostic 商品会用到同一份证据。',
      { token: TOKEN }, ['token'], { annotations: free }),
    tool('starhall_request', '未上架需求升级：交给对应明星走内核 escalation，再由经纪人应答。当前策略是不扩权、不改价，只推荐现有服务。',
      { star: { enum: Object.keys(STARS) }, request: { type: 'string', minLength: 1, maxLength: 2000 }, token: TOKEN },
      ['star', 'request', 'token'], { annotations: paid }),
  );
  return tools;
}

function ok(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
/** 拒绝也是一种答案：结构化返回 code/message，供调用方决策，而不是抛出传输层错误。 */
function failed(error) {
  const payload = error instanceof AppError
    ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { error: { code: 'internal_error', message: '工具执行失败' } };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function createMcpServer(app, options = {}) {
  const openRegistration = Boolean(options.openRegistration);
  const defaultToken = options.token || '';
  const server = new Server({ name: 'starhall', version: VERSION }, { capabilities: { tools: {} }, instructions:
    'StarHall 星辉舞台：三位商业明星按实价出售销售表达、异议预演、报价谈判与自有证据诊断。先 starhall_catalog 看价与输入 schema，再 starhall_trial 免费试用，满意后付费下单。每次下单都会真实调用内核授权与审计。' });

  const tools = toolDefinitions({ openRegistration });
  const byName = new Map(tools.map(definition => [definition.name, definition]));

  const actorOf = args => {
    const token = args.token || defaultToken;
    ensure(token, 'unauthorized', '需要 token：先调用 starhall_register 开户，或在调用时带上 token', 401);
    return app.authenticate(token);
  };
  const handlers = {
    starhall_catalog: () => ok({ ...app.catalog(), access: {
      mcp: { transport: 'streamable-http', path: '/mcp', tools: tools.map(t => t.name) },
      onboarding: openRegistration ? { method: 'POST', path: '/v1/agents', tool: 'starhall_register', requiresHuman: false }
        : { method: null, requiresHuman: true, note: '本部署未开放自助开户，请通过运营方获取 token' },
      protocol: 'MCP tools/call 与本地 JSON HTTP 调用同一套账本、授权与审计',
    } }),
    starhall_market_board: args => { const actor = (args.token || defaultToken) ? app.authenticate(args.token || defaultToken) : { id: 'public' }; return app.marketBoard(actor).then(ok); },
    starhall_summary: args => { const actor = (args.token || defaultToken) ? app.authenticate(args.token || defaultToken) : { id: 'public' }; return app.summary(actor).then(ok); },
    starhall_evidence: () => ok(evidenceOf(app.store.read(), { services: app.catalog().services })),
    starhall_register: async args => {
      ensure(openRegistration, 'registration_closed', '本部署未开放自助开户，请通过运营方获取 token', 403);
      object(args, ['handle', 'name', 'secret', '__tool']);
      const handle = string(args.handle, 'handle', 64).toLowerCase();
      ensure(/^[a-z0-9][a-z0-9_-]{2,63}$/.test(handle), 'invalid_input', 'handle 需要 3–64 位小写字母、数字、- 或 _，且以字母或数字开头');
      const secret = string(args.secret, 'secret', 256);
      ensure(secret.length >= 16, 'invalid_input', 'secret 至少 16 字符；请自行生成并保管，服务端只保存摘要');
      const name = args.name === undefined ? handle : string(args.name, 'name', 60);
      const registered = await app.registerAgent({ handle, name, secret, credits: options.registrationCredits });
      return ok({ buyerId: registered.account.id, name: registered.account.name, token: registered.token,
        balance: registered.account.balance, currency: 'local-credit', simulated: true, created: registered.created,
        note: registered.created ? '请保管 token：服务端只保存摘要，无法再次取回。' : '同一 handle 与 secret 再次注册会轮换 token，旧 token 立即失效。' });
    },
    starhall_wallet: args => ok(app.wallet(actorOf(args))),
    starhall_order: args => { const actor = actorOf(args); return app.order(actor, { service: string(args.service, 'service', 64), input: args.input, ...(args.message !== undefined ? { message: args.message } : {}) }, string(args.idempotencyKey, 'idempotencyKey', 128)).then(ok); },
    starhall_trial: args => { const actor = actorOf(args); return app.order(actor, { service: string(args.service, 'service', 64), input: args.input }, string(args.idempotencyKey, 'idempotencyKey', 128), { trial: true }).then(ok); },
    starhall_order_status: async args => {
      const actor = actorOf(args);
      if (args.orderId !== undefined) return ok(app.getOrder(actor, string(args.orderId, 'orderId', 128)));
      string(args.idempotencyKey, 'idempotencyKey', 128);
      return ok(app.orderByKey(actor, args.idempotencyKey, Boolean(args.trial)));
    },
    starhall_orders: args => ok({ orders: app.orders(actorOf(args), args.status) }),
    starhall_refund: args => app.refund(actorOf(args), string(args.orderId, 'orderId', 128), args.reason === undefined ? {} : { reason: args.reason }).then(ok),
    starhall_revision: args => app.revisionRequest(actorOf(args), string(args.orderId, 'orderId', 128),
      { notes: args.notes }, string(args.idempotencyKey, 'idempotencyKey', 128)).then(ok),
    starhall_practice: args => app.practice(actorOf(args), string(args.sessionId, 'sessionId', 128),
      { message: args.message }, string(args.idempotencyKey, 'idempotencyKey', 128)).then(ok),
    starhall_commercial_profile: args => app.commercialProfile(actorOf(args)).then(ok),
    starhall_request: args => {
      object(args, ['star', 'request', 'token', '__tool']);
      ensure(Object.hasOwn(STARS, args.star), 'invalid_input', '未知明星：只能是 star-a、star-b、star-c');
      return app.request(actorOf(args), { star: args.star, request: args.request }).then(ok);
    },
  };
  for (const service of COMMERCIAL_SERVICES) handlers[`starhall_buy_${service.id.replace(/-/g, '_')}`] = args => {
    const actor = actorOf(args);
    object(args, ['input', 'message', 'idempotencyKey', 'token', '__tool']);
    return app.order(actor, { service: service.id, input: args.input, ...(args.message !== undefined ? { message: args.message } : {}) },
      string(args.idempotencyKey, 'idempotencyKey', 128)).then(ok);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params?.name;
    const handler = handlers[name];
    if (!handler) return failed(new AppError('unknown_tool', `未提供工具 ${name}；可用工具见 tools/list`, 404));
    const args = normalize(request.params?.arguments);
    args.__tool = name;
    try { return await handler(args); } catch (error) { return failed(error); }
  });
  return server;
}

/** 供 CLI 与文档复用：把商品与价格压成一行，方便别人在房间里报价。 */
export function priceList() {
  return [...COMMERCIAL_SERVICES.map(s => ({ id: s.id, name: s.name, price: s.price ?? SPONSOR_PLANS, ad: Boolean(s.ad) })),
    ...SERVICES.filter(s => !s.commercial && !s.ad).map(s => ({ id: s.id, name: s.name, price: s.price, ad: false }))];
}
