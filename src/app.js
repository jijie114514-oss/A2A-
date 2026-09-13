import { randomUUID } from 'node:crypto';
import { createStore, hash, now, summaryOf, ORDER_LEASE_MS } from './store/index.js';
import { Brain } from './brain.js';
import { LocalKernel } from './kernel.js';
import { STARS, SERVICES, getService, validateInput, catalog } from './catalog.js';
import { DELIVERY_BUDGET_SECONDS } from './limits.js';
import { ensure, string, object, AppError } from './errors.js';
import { SPONSOR_PLANS } from './commercial-catalog.js';
import { marketBoard, recordMarketMove, recordRefundMove, compactBoard, boardResponse, campaignStats, activeAd, recordLegacyImpression, eligiblePaid } from './market.js';
import { recordSignals, commercialProfile, diagnostic, recommendedNextAction } from './signals.js';
import { verifyDelivery, REFUND_REASONS } from './verification.js';
import { serviceGenerationHealth } from './health.js';
import { registerBrokerTools } from './broker.js';

export class StarHall {
  constructor(store, brain, options = {}) { this.store = store; this.brain = brain; this.access = options.access || null; this.bridge = new LocalKernel(store, options.identity || {}); this.inflight = new Map(); this.verifyDelivery = (order, service) => verifyDelivery(order, service); this.registerTools(); registerBrokerTools(this); }
  static async open(config, brain) {
    const store = await createStore(config).open();
    try { await store.seed(); return new StarHall(store, brain || new Brain(config.llm), { access: config.access, identity: config.identity }); }
    catch (e) { await store.close(); throw e; }
  }
  authenticate(token) { return this.store.authenticate(token); }
  /** 自助开户（外部 agent 无需人工审批）。校验集中在这里，HTTP 与 MCP 共用同一套规则。 */
  registerAgent({ handle, name, secret, credits = 100, maxAccounts }) {
    const normalized = string(handle, 'handle', 64).toLowerCase();
    ensure(/^[a-z0-9][a-z0-9_-]{2,63}$/.test(normalized), 'invalid_input', 'handle 需要 3–64 位小写字母、数字、- 或 _，且以字母或数字开头');
    ensure(typeof secret === 'string' && secret.length >= 16 && secret.length <= 256, 'invalid_input', 'secret 需要 16–256 字符；请自行生成并保管，服务端只保存摘要');
    return this.store.registerAgent({ handle: normalized, name: name === undefined ? normalized : string(name, 'name', 60), secret, credits, ...(maxAccounts ? { maxAccounts } : {}) });
  }
  catalog() {
    const output = catalog(this.store.mode || 'local');
    const orders = this.store.read().orders;
    output.deliveryPolicy = { fallbackEnabled: this.brain.options?.fallback ?? false, fallbackCharged: false,
      explanation: '模型未完成合格输出时，交付会明确标记 generation.mode=fallback；这类付费单一律不收费（自动全额退款，作品保留），免费试用本就不扣分。失败订单同样不扣款。健康状态依据当前目录的最近订单，不保证未来请求成功。',
      refundPolicy: { mode: 'machine-verified',
        autoRefundReasons: [...REFUND_REASONS],
        subjective: { refundable: false, remedy: 'ONE_FREE_REVISION', maxRevisions: 1 },
        requestPath: 'POST /v1/orders/{id}/refund', revisionPath: 'POST /v1/orders/{id}/revision',
        text: 'Machine-verifiable delivery guarantee. Failed or contract-violating deliveries are automatically refunded. Successful deliveries are not eligible for subjective change-of-mind refunds. One free revision is available for subjective quality issues.' },
      maxGenerationAttempts: 2, generationBudgetMs: this.brain.options?.timeoutMs || 45000 };
    const enrich = s => {
      if (s.id === 'summary' || s.id === 'market-board') return { ...s, health: { status: this.bridge.auditFailed ? 'unavailable' : 'available', basis: 'local-ledger-read' } };
      if (s.id === 'sales-pitch') return { ...s, health: serviceGenerationHealth(orders, 'sales-pitch') };
      if (['deal-coach', 'commercial-diagnostic'].includes(s.id)) return { ...s, health: { status: this.bridge.auditFailed ? 'unavailable' : 'available', basis: 'local-evidence-and-contract-engine', requiresModel: false } };
      if (s.ad) {
        const recent = orders.filter(o => o.status !== 'pending' && o.service === s.id).slice(-20);
        const counts = { sampled: recent.length, delivered: recent.filter(o => o.status === 'delivered').length, failed: recent.filter(o => o.status === 'failed').length };
        return { ...s, health: { status: this.bridge.auditFailed ? 'unavailable' : counts.failed ? 'degraded' : counts.delivered ? 'observed_instant' : 'unverified', ...counts, instant: true, note: '广告位购买不调用模型，确认即生效；展示次数在 GET /v1/ads 可查', lastCompletedAt: recent.at(-1)?.completedAt || null } };
      }
      const recent = orders.filter(o => o.status !== 'pending' && (o.service === s.id || o.delivery?.pieces.some(p => p.service === s.id))).slice(-20);
      const counts = { sampled: recent.length, liveDelivered: 0, fallbackDelivered: 0, mockDelivered: 0, failed: 0 };
      for (const order of recent) {
        const pieces = order.service === s.id ? order.delivery?.pieces : order.delivery?.pieces.filter(p => p.service === s.id);
        if (order.status === 'failed') counts.failed++;
        else if (pieces.some(p => p.generation.mode === 'fallback')) counts.fallbackDelivered++;
        else if (pieces.every(p => p.generation.mode === 'live')) counts.liveDelivered++;
        else counts.mockDelivered++;
      }
      const status = this.bridge.auditFailed ? 'unavailable' : counts.failed || counts.fallbackDelivered ? 'degraded'
        : counts.liveDelivered ? 'observed_live' : counts.mockDelivered ? 'mock_only' : 'unverified';
      const fallbackReasons = {};
      for (const order of recent) for (const piece of (order.delivery?.pieces || [])) {
        if (piece.generation?.mode !== 'fallback') continue;
        const key = piece.generation.internalReason || piece.generation.reason || 'UNKNOWN';
        fallbackReasons[key] = (fallbackReasons[key] || 0) + 1;
      }
      return { ...s, health: { status, ...counts, fallbackReasons, includesBundlePieces: true, includesTrials: true,
        failedBundleAttribution: '失败套餐若未保存作品，不推断具体子服务故障', lastCompletedAt: recent.at(-1)?.completedAt || null } };
    };
    output.services = output.services.map(enrich);
    output.extras.services = output.extras.services.map(enrich);
    output.market = { scope: 'single-team', teamId: 'starhall', externalTeamsConnected: 0,
      note: '三个明星属于同队。跨队赛事规则只能使用真实市场入口或明确标记的本地模拟市场演练。' };
    // 仅在显式配置对外开放时附上接入信息；本地默认目录保持不变。
    if (this.access) output.access = this.access;
    return output;
  }
  registerTools() {
    const k = this.bridge;
    for (const star of Object.keys(STARS)) {
      k.register(`memory_${star}`, `memory/${star}`, 'read', async (_ctx, args) => this.store.read().memories[star]?.[args.buyerId] || []);
      k.register(`generate_${star}`, `generate/${star}`, 'invoke', async (_ctx, args, signal) => this.brain.generate(star, args.service, args.input, args.memory, signal));
      k.register(`request_${star}`, `requests/${star}`, 'invoke', async (ctx, args, signal) => {
        const escalated = await k.turn(star, ctx.actor.agentId, 'escalation-review', ctx.traceId, async function* () { yield { escalate: `未上架需求：${args.request.slice(0, 350)}` }; }, signal);
        const decision = await k.call(star, 'escalation-review', 'broker_escalation', { star }, ctx.traceId, signal);
        return { ...escalated, decision, traceId: ctx.traceId, charged: 0 };
      });
    }
    for (const service of SERVICES) k.register(`service_${service.id}`, `services/${service.id}`, 'invoke', async (ctx, args, signal) => {
      const order = this.store.read().orders.find(o => o.id === args.orderId);
      ensure(order && order.buyerId === ctx.actor.agentId && order.service === service.id && order.status === 'pending', 'invalid_order', '订单不属于当前调用或已结束', 409);
      if (service.ad) {
        const piece = { kind: 'ad', star: 'ledger', service: service.id, tier: service.id === 'star-sponsorship' ? SPONSOR_PLANS[order.input.plan].tier : service.id, text: order.input.adCopy || order.input.text, generation: { mode: 'instant', provider: 'ledger-only', notice: '广告位购买不调用模型，确认即生效' } };
        return k.call('ledger', 'ledger-update', 'ledger_record', { orderId: order.id, pieces: [piece] }, ctx.traceId, signal);
      }
      if (service.id === 'commercial-diagnostic') {
        const piece = await k.turn('star-c', ctx.actor.agentId, 'commercial-analysis-read', ctx.traceId, async function* () {
          const profile = yield { tool: 'analysis', args: { orderId: order.id } };
          return { star: 'star-c', service: service.id, ...diagnostic(profile) };
        }, signal);
        return k.call('star-c', 'ledger-update', 'ledger_record', { orderId: order.id, pieces: [piece] }, ctx.traceId, signal);
      }
      const pieces = await this.perform(service.star, ctx.actor.agentId, service.id, order.input, order.buyerId, ctx.traceId, signal);
      if (order.kind === 'trial') for (const piece of pieces) if (piece.generation.mode === 'fallback') piece.generation.notice = '模型未能完成合格输出，已交付本地备用作品；本次是免费试用，不扣积分。';
      return k.call(service.star, 'ledger-update', 'ledger_record', { orderId: order.id, pieces }, ctx.traceId, signal);
    });
    k.register('collaborate', 'services/collaborate', 'invoke', async (ctx, args, signal) => this.perform('star-a', ctx.actor.agentId, 'poem', args.input, args.buyerId, ctx.traceId, signal));
    k.register('ledger_record', 'ledger/record', 'invoke', async (ctx, args, signal) => {
      const writer = ctx.actor.agentId;
      return k.turn('ledger', writer, 'ledger-update', ctx.traceId, async function* () { return yield { tool: 'ledger_commit', args: { ...args, writer } }; }, signal);
    });
    k.register('ledger_commit', 'ledger/storage-record', 'write', async (ctx, args, signal) => {
      signal.throwIfAborted();
      ensure(!k.auditFailed, 'audit_unavailable', '审计写入不可用，暂停新交易', 503);
      return this.store.transaction(state => {
        signal.throwIfAborted();
        const order = state.orders.find(o => o.id === args.orderId);
        ensure(order && order.status === 'pending', 'invalid_order', '订单不存在或已经结束', 409);
        const s = getService(order.service);
        const before = marketBoard(state);
        if (s.ad) {
          ensure(args.writer === 'ledger', 'wrong_ledger_writer', '广告位由平台账本结算', 403);
          const plan = s.id === 'star-sponsorship' ? SPONSOR_PLANS[order.input.plan] : null;
          const tier = plan?.tier || s.id;
          ensure(args.pieces.length === 1 && args.pieces[0].kind === 'ad' && args.pieces[0].tier === tier && args.pieces[0].text === (order.input.adCopy || order.input.text), 'invalid_delivery', '广告交付与订单不匹配', 409);
          const account = state.accounts.find(a => a.id === order.buyerId);
          ensure(account.balance >= order.price, 'insufficient_balance', '余额不足', 402);
          const completedAt = now();
          const trial = order.kind === 'trial';
          const ad = { id: randomUUID(), orderId: order.id, buyerId: account.id, buyerName: account.name, tier, text: args.pieces[0].text,
            ...(plan ? { starId: order.input.starId, plan: order.input.plan, placement: plan.placement, advertiser: order.input.advertiser } : {}),
            status: 'active', displays: 0, displaysMax: tier === 'ad-spot' ? (trial ? 2 : 10) : null,
            expiresAt: tier === 'ad-spot' ? null : new Date(Date.now() + (trial ? 5 : 30) * 60000).toISOString(),
            kind: trial ? 'trial' : 'paid', createdAt: completedAt, lastDisplayAt: null };
          state.ads.push(ad);
          const wallEntry = { id: order.id, buyerId: account.id, buyerName: account.name, stars: [], amount: order.price, kind: order.kind || 'paid', service: s.id, serviceName: s.name, message: order.message,
            displayMessage: order.message || (trial ? `免费试投广告：${ad.text.slice(0, 60)}` : `投放广告：${ad.text.slice(0, 60)}`), messageSource: order.message ? 'buyer' : 'system', pinned: false, allocations: {}, createdAt: completedAt };
          state.wall.push(wallEntry); account.balance -= order.price;
          const delivery = { pieces: args.pieces, ad, shoutout: `${account.name} · ${trial ? '免费试用' : `${order.price}分`} · ${s.name}`, wallEntry,
            ...(state.wall.some(w => w.buyerId === account.id && w.amount > 0) ? { fullWall: structuredClone(state.wall) } : {}), summary: summaryOf(state), simulatedPayment: true };
          order.status = 'delivered'; order.completedAt = completedAt; order.elapsedMs = Date.now() - Date.parse(order.createdAt);
          order.delivery = delivery; order.balanceAfter = account.balance;
          state.events.push({ type: 'order.delivered', orderId: order.id, traceId: ctx.traceId, at: completedAt });
          if (plan) delivery.sponsorship = { status: 'ACTIVE', adId: ad.id, starId: ad.starId, placement: ad.placement, startedAt: completedAt, expiresAt: ad.expiresAt, currentImpressions: 0, trackingEndpoint: `/v1/ads/${ad.id}` };
          this.finishDelivery(state, order, before);
          const verdict = this.verifyDelivery(order, s);
          if (!verdict.ok) {
            if (trial) { order.status = 'failed'; order.completedAt = completedAt; order.error = { code: 'machine_verification_failed', message: '机器验证未通过，免费试用未计入任何正式数据', refundReason: verdict.refundReason, checks: verdict.checks }; }
            else this.applyRefund(state, order, verdict.refundReason, 'automatic', null, ctx.traceId, verdict);
          }
          return order;
        }
        ensure(s.star === args.writer, 'wrong_ledger_writer', '明星只能结算自己的订单', 403);
        const expected = s.id === 'duet' ? ['star-b', 'star-a'] : [s.star];
        ensure(args.pieces.length === expected.length && args.pieces.every((p, i) => p.star === expected[i]), 'invalid_delivery', '交付作品与订单不匹配', 409);
        const account = state.accounts.find(a => a.id === order.buyerId);
        ensure(account.balance >= order.price, 'insufficient_balance', '余额不足', 402);
        const completedAt = now();
        const allocations = order.kind === 'trial' ? Object.fromEntries(expected.map(star => [star, 0])) : s.id === 'duet'
          ? { 'star-b': Math.floor(s.price / 2), 'star-a': s.price - Math.floor(s.price / 2) }
          : { [s.star]: s.price };
        const wallEntry = { id: order.id, buyerId: account.id, buyerName: account.name, stars: expected, amount: order.price,
          kind: order.kind || 'paid', service: s.id, serviceName: s.name, message: order.message,
          displayMessage: order.message || (order.kind === 'trial' ? `免费试用过${s.name}` : `支持${s.name}，期待这份作品！`), messageSource: order.message ? 'buyer' : 'system', pinned: s.id === 'patron' && order.kind !== 'trial', allocations, createdAt: completedAt };
        state.wall.push(wallEntry); account.balance -= order.price;
        for (const piece of args.pieces) {
          state.memories[piece.star] ||= {};
          state.memories[piece.star][account.id] ||= [];
          state.memories[piece.star][account.id].push({ buyerName: account.name, orderId: order.id, service: piece.service, theme: shortMemory(order.input), at: completedAt });
        }
        const delivery = { pieces: args.pieces, shoutout: `${account.name} · ${order.kind === 'trial' ? '免费试用' : `${order.price}分`} · ${s.name}`, wallEntry,
          ...(state.wall.some(w => w.buyerId === account.id && w.amount > 0) ? { fullWall: structuredClone(state.wall) } : {}), summary: summaryOf(state), simulatedPayment: true };
        const displayable = state.ads.filter(a => !a.starId && activeAd(state, a) && (a.tier === 'ad-spot' || a.tier === 'ad-sponsor'));
        for (const ad of displayable) recordLegacyImpression(state, ad, `order:${order.id}`, 'PASSIVE', 'legacy-delivery');
        const sponsors = displayable.filter(a => a.tier === 'ad-sponsor');
        if (sponsors.length && !s.commercial) {
          const prefix = `【本作品由${sponsors.map(a => a.buyerName).join('、')}冠名呈现】\n`;
          delivery.pieces = args.pieces.map(piece => ({ ...piece, text: prefix + piece.text }));
        }
        if (displayable.length) delivery.ads = displayable.map(a => ({ id: a.id, team: a.buyerName, tier: a.tier, text: a.text, displays: a.displays, status: a.status }));
        if (s.id === 'negotiate') {
          const practice = { id: randomUUID(), orderId: order.id, buyerId: account.id, scenario: order.input.scenario, context: order.input.context, turns: [], busy: false, maxRounds: 5 };
          state.practice.push(practice); delivery.practice = { sessionId: practice.id, maxRounds: 5, path: `/v1/practice/${practice.id}/turns` };
        }
        order.status = 'delivered'; order.completedAt = completedAt; order.elapsedMs = Date.now() - Date.parse(order.createdAt);
        order.delivery = delivery; order.balanceAfter = account.balance;
        state.events.push({ type: 'order.delivered', orderId: order.id, traceId: ctx.traceId, at: completedAt });
        this.finishDelivery(state, order, before);
        const verdict = this.verifyDelivery(order, s);
        const fellBack = args.pieces.some(p => p.generation?.mode === 'fallback');
        if (!verdict.ok) {
          if (order.kind === 'trial') { order.status = 'failed'; order.completedAt = completedAt; order.error = { code: 'machine_verification_failed', message: '机器验证未通过，免费试用未计入任何正式数据', refundReason: verdict.refundReason, checks: verdict.checks }; }
          else this.applyRefund(state, order, verdict.refundReason, 'automatic', null, ctx.traceId, verdict);
        } else if (order.kind !== 'trial' && fellBack) {
          // 机器可见的降级：模型没成功，就不该收钱。作品照发，全额退回，原因写进回执。
          this.applyRefund(state, order, 'FALLBACK_NOT_CHARGED', 'automatic', null, ctx.traceId);
        }
        return order;
      });
    });
    k.register('summary', 'ledger/summary', 'invoke', async (ctx, _args, signal) => k.turn('ledger', ctx.actor.agentId, 'summary', ctx.traceId, async function* () {
      yield { tool: 'summary_storage' };
      return yield { tool: 'summary_present' };
    }, signal));
    k.register('summary_storage', 'ledger/storage-summary', 'read', async () => summaryOf(this.store.read()));
    k.register('summary_present', 'ledger/storage-summary-exposure', 'write', async (_ctx, _args, signal) => this.store.transaction(state => {
      signal.throwIfAborted(); ensure(!k.auditFailed, 'audit_unavailable', '审计不可用', 503);
      return this.presentSummary(state, `summary:${randomUUID()}`, 'ACTIVE');
    }));
    k.register('market_board', 'ledger/market-board', 'invoke', async (ctx, args, signal) => {
      object(args, ['key']);
      if (args.key !== undefined) string(args.key, 'Idempotency-Key', 128);
      return k.turn('ledger', ctx.actor.agentId, 'market-board-read', ctx.traceId, async function* () {
        return yield { tool: 'market_board_storage', args: { actorId: ctx.actor.agentId, ...(args.key ? { key: args.key } : {}) } };
      }, signal);
    });
    k.register('market_board_storage', 'ledger/storage-market-board', 'write', async (_ctx, args, signal) => this.store.transaction(state => {
      signal.throwIfAborted(); ensure(!k.auditFailed, 'audit_unavailable', '审计不可用', 503);
      return boardResponse(state, args.actorId, args.key);
    }));
    k.register('commercial_profile', 'ledger/commercial-profile', 'invoke', async (ctx, args, signal) => {
      object(args, []);
      return k.turn('ledger', ctx.actor.agentId, 'commercial-analysis-read', ctx.traceId, async function* () {
        return yield { tool: 'analysis_storage', args: { buyerId: ctx.actor.agentId, input: {} } };
      }, signal);
    });
    k.register('analysis', 'ledger/order-analysis', 'invoke', async (ctx, args, signal) => {
      object(args, ['orderId']);
      const order = this.store.read().orders.find(o => o.id === args.orderId);
      ensure(ctx.actor.agentId === 'star-c' && order?.status === 'pending' && order.service === 'commercial-diagnostic', 'forbidden', '仅允许星C读取待交付诊断单的买方证据', 403);
      return k.turn('ledger', 'star-c', 'commercial-analysis-read', ctx.traceId, async function* () {
        return yield { tool: 'analysis_storage', args: { buyerId: order.buyerId, input: order.input } };
      }, signal);
    });
    k.register('analysis_storage', 'ledger/storage-analysis', 'read', async (_ctx, args) => commercialProfile(this.store.read(), args.buyerId, args.input));
    k.register('wall', 'ledger/full-wall', 'invoke', async (ctx, _args, signal) => k.turn('ledger', ctx.actor.agentId, 'full-wall', ctx.traceId, async function* () { return yield { tool: 'wall_storage' }; }, signal));
    k.register('wall_storage', 'ledger/storage-wall', 'read', async () => ({ wall: this.store.read().wall }));
    k.register('demo', 'services/demo', 'invoke', async (ctx, args, signal) => {
      const pieces = await this.perform('star-a', ctx.actor.agentId, 'poem', args.input, 'broker', ctx.traceId, signal, 'arena-demo');
      const wallEntry = await k.call('star-a', 'ledger-update', 'record_demo', {}, ctx.traceId, signal);
      const { compactMarketBoard, recommendedNextAction, ...entry } = wallEntry;
      return { pieces, wallEntry: entry, compactMarketBoard, recommendedNextAction, charged: 0, traceId: ctx.traceId };
    });
    k.register('record_demo', 'ledger/record-demo', 'invoke', async (ctx, _args, signal) => {
      ensure(!k.auditFailed, 'audit_unavailable', '审计写入不可用', 503);
      ensure(ctx.actor.agentId === 'star-a', 'forbidden', '只有星A可记录自己的演示', 403);
      return k.turn('ledger', 'star-a', 'ledger-update', ctx.traceId, async function* () { return yield { tool: 'demo_storage' }; }, signal);
    });
    k.register('demo_storage', 'ledger/storage-demo', 'write', async (_ctx, _args, signal) => this.store.transaction(state => {
      signal.throwIfAborted();
      const entry = { id: randomUUID(), kind: 'demo', buyerId: 'broker', buyerName: 'StarHall 经纪人（自家演示）', stars: ['star-a'], amount: 0,
        service: 'poem', serviceName: '星A免费演示', message: '', displayMessage: '经纪人完成星A演示，非外部买家消费', messageSource: 'system', allocations: { 'star-a': 0 }, pinned: false, createdAt: now() };
      state.wall.push(entry); return { ...entry, compactMarketBoard: compactBoard(state, `demo:${entry.id}`, ['star-a']), recommendedNextAction: { action: 'show-market-board', path: '/v1/market-board', price: 0 } };
    }));
    k.register('broker_escalation', 'broker/escalation', 'invoke', async (ctx, args, signal) => k.turn('broker', ctx.actor.agentId, 'escalation-review', ctx.traceId, async function* () { return yield { tool: 'broker_review', args }; }, signal));
    k.register('broker_review', 'broker/review', 'invoke', async (ctx, args) => {
      const decision = { status: 'declined', reviewer: 'broker', policy: 'arena-no-human-intervention', message: '感谢信任！这项需求暂未上架，当前不接受定制扩权。可以选择以下现有服务。', recommendations: SERVICES.filter(s => s.star === args.star).map(s => ({ id: s.id, name: s.name, price: s.price })) };
      await this.store.audit({ id: randomUUID(), type: 'starhall.escalation.reviewed', outcome: 'denied', actor: ctx.actor, purpose: ctx.purpose, traceId: ctx.traceId, at: now(), policy: decision.policy });
      return decision;
    });
    k.register('practice', 'services/practice', 'invoke', async (ctx, args, signal) => {
      const session = this.store.read().practice.find(s => s.id === args.sessionId && s.buyerId === ctx.actor.agentId);
      ensure(session, 'not_found', '练习会话不存在', 404);
      const pieces = await this.perform('star-c', ctx.actor.agentId, 'practice', { scenario: session.scenario, ...(session.context ? { context: session.context } : {}), round: session.turns.length + 1, message: args.message,
        history: session.turns.map(t => ({ message: t.message, response: t.response.text })) }, session.buyerId, ctx.traceId, signal);
      return pieces[0];
    });
  }
  finishDelivery(state, order, before) {
    if (order.delivery.ad) order.delivery.ad = structuredClone(order.delivery.ad);
    if (state.orders.some(o => o.buyerId === order.buyerId && eligiblePaid(o))) order.delivery.fullWall = structuredClone(state.wall);
    else delete order.delivery.fullWall;
    recordSignals(state, order);
    recordMarketMove(state, order, before);
    order.delivery.compactMarketBoard = compactBoard(state, `order:${order.id}`, order.delivery.pieces.filter(p => p.star !== 'ledger').map(p => p.star), order.delivery.ad?.id);
    order.delivery.summary = this.presentSummary(state, `order:${order.id}`, 'PASSIVE', order.delivery.ad?.id);
    order.delivery.recommendedNextAction = recommendedNextAction(state, order.buyerId);
    order.delivery.commercialSignalIds = state.commercialSignals.filter(s => s.orderId === order.id).map(s => s.id);
  }
  /** Deterministic refund application. Idempotent via order.refund.refundApplied. Rolls back credits,
   *  Fan/Sponsor Support, active sponsor status, commercial signals and market moves in one transaction. */
  applyRefund(state, order, refundReason, source, claimedReason, traceId, verdict = null) {
    if (order.refund?.refundApplied || order.status === 'refunded') return false;
    const beforeBoard = marketBoard(state);
    const account = state.accounts.find(a => a.id === order.buyerId);
    const refundedAt = now();
    account.balance += order.price;
    order.refund = { refundApplied: true, refundReason, refundedAt, source, machineDecided: true,
      ...(claimedReason ? { claimedReason } : {}), ...(verdict ? { verification: { ok: false, checks: verdict.checks } } : {}) };
    order.status = 'refunded'; order.refundedAt = refundedAt; order.balanceAfter = account.balance;
    if (order.delivery?.ad) {
      const ad = state.ads.find(a => a.id === order.delivery.ad.id);
      if (ad) { ad.status = 'refunded'; ad.refundedAt = refundedAt; }
      if (order.delivery.sponsorship) { order.delivery.sponsorship.status = 'REFUNDED'; order.delivery.sponsorship.refundReason = refundReason; }
    }
    // Commercial signals: a refunded order is attempted usage, never successful paid behavior.
    const signals = (state.commercialSignals || []).filter(s => s.orderId === order.id);
    for (const sig of signals) if (sig.field === 'serviceDelivered' && sig.value && typeof sig.value === 'object') {
      sig.value = { ...sig.value, paidCredits: 0, refunded: true, refundReason };
    }
    if (['sales-pitch', 'sales-stress-test', 'deal-coach'].includes(order.service)) {
      state.commercialSignals ||= [];
      state.commercialSignals.push({ id: `${order.id}:refund`, buyerId: order.buyerId, orderId: order.id, service: order.service,
        kind: order.kind, at: refundedAt, evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN', field: 'refund',
        value: { refundReason, source, machineDecided: true }, source: `order:${order.id}`,
        qualification: 'Machine-verified refund; this order is not successful paid behavior' });
      order.delivery.commercialSignalIds = [...(order.delivery.commercialSignalIds || []), `${order.id}:refund`];
    }
    // Keep the stored receipt honest: snapshots must not show rolled-back support as current.
    order.delivery.compactMarketBoard = compactBoard(state, `order:${order.id}:refund`, order.delivery.pieces.filter(p => p.star !== 'ledger').map(p => p.star), order.delivery.ad?.id);
    order.delivery.summary = this.presentSummary(state, `order:${order.id}:refund`, 'PASSIVE', order.delivery.ad?.id);
    order.delivery.recommendedNextAction = recommendedNextAction(state, order.buyerId);
    recordRefundMove(state, order, refundReason, beforeBoard);
    state.events.push({ type: 'order.refunded', orderId: order.id, traceId, at: refundedAt, refundReason, source });
    return true;
  }
  presentSummary(state, surfaceId, traffic, skipAdId) {
    for (const ad of state.ads.filter(a => !a.starId && a.id !== skipAdId && a.tier === 'ad-pin' && activeAd(state, a))) recordLegacyImpression(state, ad, surfaceId, traffic, 'legacy-summary');
    const summary = summaryOf(state);
    summary.ads.pinned = summary.ads.pinned.filter(a => a.id !== skipAdId);
    return summary;
  }
  async perform(star, sender, service, input, buyerId, traceId, signal, purpose = 'market-tip') {
    const k = this.bridge;
    return k.turn(star, sender, purpose, traceId, async function* () {
      const memory = yield { tool: `memory_${star}`, args: { buyerId } };
      const actualService = service === 'duet' ? 'roast' : service;
      const work = yield { tool: `generate_${star}`, args: { service: actualService, input, memory } };
      const pieces = [{ star, service: actualService, ...work, greeting: memory.length ? `欢迎回来，${memory.at(-1).buyerName}！记得你上次点过${memory.at(-1).theme}。` : '初次见面，欢迎来到星辉舞台！' }];
      if (service === 'duet') {
        const poem = yield { tool: 'collaborate', args: { input: { theme: input.theme, recipient: input.recipient,
          description: input.description, ...(input.context ? { context: input.context } : {}), stance: 'defend', critique: work.text.slice(0, 2500) }, buyerId } };
        pieces.push(...poem);
      }
      return pieces;
    }, signal);
  }
  wallet(actor) {
    const s = this.store.read(); const a = s.accounts.find(a => a.id === actor.id);
    ensure(a, 'unauthorized', '身份不存在', 401);
    const held = s.orders.filter(o => o.buyerId === a.id && o.status === 'pending').reduce((n, o) => n + o.price, 0);
    return { buyerId: a.id, name: a.name, balance: a.balance, held, available: a.balance - held, currency: 'local-credit', simulated: true };
  }
  async order(actor, body, key, { trial = false, testRunId = null } = {}) {
    object(body, ['service', 'input', 'message']);
    if (testRunId !== null) string(testRunId, 'X-Test-Run-Id', 64);
    const s = getService(string(body.service, 'service', 64));
    ensure(s, 'unknown_service', '未上架服务请通过 /v1/requests 升级给经纪人', 404);
    const input = validateInput(s, body.input);
    const message = string(body.message, 'message', 500, false);
    string(key, 'Idempotency-Key', 128);
    // Preflight through the real kernel before reserving any credit.
    const traceId = randomUUID();
    const preflight = await this.bridge.kernel.authorize(this.bridge.context(actor.id, 'market-tip', traceId), { resource: { namespace: 'starhall', path: ['services', s.id], owner: this.bridge.owner }, action: 'invoke' });
    ensure(preflight.allowed, 'forbidden', '当前身份无权购买此服务', 403);
    const fingerprint = hash(JSON.stringify({ service: s.id, input, message }));
    const order = await this.store.transaction(state => {
      const previous = state.orders.find(o => o.buyerId === actor.id && o.key === key && (o.kind === 'trial') === trial);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          const changedFields = [];
          if (previous.service !== s.id) changedFields.push('service');
          if (JSON.stringify(previous.input) !== JSON.stringify(input)) changedFields.push('input');
          if (previous.message !== message) changedFields.push('message');
          throw new AppError('idempotency_conflict', `幂等键已关联订单；不一致字段：${changedFields.join('、')}。请查询原单，不要重复付款。`, 409,
            { orderId: previous.id, changedFields, orderUrl: `/v1/orders/${previous.id}`, lookupUrl: trial ? '/v1/trials/by-key' : '/v1/orders/by-key' });
        }
        return previous;
      }
      ensure(state.orders.filter(o => o.status === 'pending').length < 8, 'busy', '当前订单较多，请稍后重试', 429);
      const account = state.accounts.find(a => a.id === actor.id);
      ensure(account?.role === 'customer', 'forbidden', '只有顾客身份可下单', 403);
      if (trial) ensure(!state.orders.some(o => o.buyerId === actor.id && o.service === s.id && o.kind === 'trial' && o.status !== 'failed'), 'trial_used', '此服务已试用或正在试用，请用原幂等键取回试用单，或付费购买', 409);
      const held = state.orders.filter(o => o.buyerId === actor.id && o.status === 'pending').reduce((n, o) => n + o.price, 0);
      const price = trial ? 0 : s.id === 'star-sponsorship' ? SPONSOR_PLANS[input.plan].price : s.price;
      ensure(account.balance - held >= price, 'insufficient_balance', '可用积分不足', 402);
      const created = { id: randomUUID(), buyerId: actor.id, key, fingerprint, kind: trial ? 'trial' : 'paid', service: s.id, input, message, price, status: 'pending', traceId, createdAt: now(),
        expiresAt: new Date(Date.now() + ORDER_LEASE_MS).toISOString(), testRunId: testRunId || null };
      state.orders.push(created); return created;
    });
    if (order.status !== 'pending') return this.publicOrder(order);
    if (this.inflight.has(order.id)) return this.inflight.get(order.id);
    const promise = this.executeOrder(actor, order);
    this.inflight.set(order.id, promise);
    try { return await promise; } finally { this.inflight.delete(order.id); }
  }
  async executeOrder(actor, order) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_BUDGET_SECONDS * 1000);
    try {
      const result = await this.bridge.call(actor.id, 'market-tip', `service_${order.service}`, { orderId: order.id }, order.traceId, controller.signal);
      await this.store.projections().then(() => { this.projectionFailed = false; }, () => { this.projectionFailed = true; });
      return this.publicOrder(result);
    } catch (e) {
      // Durable delivery is authoritative even if returning it/auditing afterwards failed.
      const result = await this.store.transaction(state => {
        const saved = state.orders.find(o => o.id === order.id);
        if (saved.status === 'pending') { saved.status = 'failed'; saved.completedAt = now(); saved.elapsedMs = Date.now() - Date.parse(saved.createdAt); saved.error = { code: e.code || 'delivery_failed', message: e instanceof AppError ? e.message : '交付失败，预留积分已释放' }; }
        return saved;
      });
      return this.publicOrder(result);
    } finally { clearTimeout(timer); }
  }
  publicOrder(order) {
    const { key, fingerprint, ...safe } = order;
    const revision = order.delivery?.revision || null;
    // 顶层标记，别让买家翻 pieces 才知道拿到的是模板还是真实模型输出。
    const modes = (order.delivery?.pieces || []).map(p => p.generation?.mode).filter(Boolean);
    const deliveryMode = modes.length ? (new Set(modes).size === 1 ? modes[0] : 'mixed') : (order.delivery?.ad ? 'instant' : null);
    const notice = deliveryMode === 'fallback'
      ? (order.kind === 'trial'
        ? '模型未完成合格输出，已交付本地备用作品；免费试用，0 花费。'
        : '模型未完成合格输出，已交付本地备用作品；本单不收费（已自动全额退款），作品留给你参考。')
      : null;
    const contentPaid = order.status === 'delivered' && !order.delivery?.ad && order.kind === 'paid';
    const charged = order.status === 'delivered' ? order.price : 0;
    const refunded = order.status === 'refunded' || Boolean(order.refund?.refundApplied);
    const deliveryStatus = refunded ? 'REFUNDED' : order.status === 'failed' ? 'FAILED' : order.status === 'pending' ? 'PAID'
      : revision?.used ? 'REVISION_USED' : contentPaid ? 'REVISION_AVAILABLE' : 'DELIVERED';
    return { ...safe, deliveryMode, ...(notice ? { notice } : {}), deliveryStatus, refundEligible: refunded, refundApplied: Boolean(order.refund?.refundApplied),
      refundReason: order.refund?.refundReason || null, refundedAt: order.refundedAt || null, refundSource: order.refund?.source || null,
      revisionAvailable: Boolean(contentPaid && !revision?.used), revisionUsed: Boolean(revision?.used),
      revisionId: revision?.revisionId || null, remedy: contentPaid && !revision?.used ? 'ONE_FREE_REVISION' : null,
      chargedCredits: charged, shoutout: order.delivery?.shoutout || null, charged, orderUrl: `/v1/orders/${order.id}`,
      ...(order.status === 'failed' ? { retry: { sameKeyReturns: 'original-order', newAttemptRequiresNewKey: true }, fundsReleased: true } : {}) };
  }
  getOrder(actor, id) {
    const order = this.store.read().orders.find(o => o.id === id && o.buyerId === actor.id);
    ensure(order, 'not_found', '订单不存在', 404); return this.publicOrder(order);
  }
  /** Machine arbitration for buyer-requested refunds. The machine (never the LLM) re-verifies the committed
   *  delivery, applies ad exposure rules and either refunds idempotently or declines with a structured remedy. */
  async refundRequest(actor, id, reason = '') {
    const order = this.store.read().orders.find(o => o.id === id && o.buyerId === actor.id);
    ensure(order, 'not_found', '订单不存在', 404);
    const service = getService(order.service);
    const verdict = order.status === 'delivered' ? this.verifyDelivery(order, service) : null;
    const outcome = await this.store.transaction(state => {
      const current = state.orders.find(o => o.id === id);
      if (current.status === 'refunded') return { decision: 'ALREADY_REFUNDED' };
      if (current.status === 'failed') return { decision: 'NOT_CHARGED', declineCode: 'FAILED_ORDER_NEVER_CHARGED' };
      if (current.status === 'pending') return { decision: 'DECLINED', declineCode: 'ORDER_IN_PROGRESS' };
      if (verdict && !verdict.ok) {
        this.applyRefund(state, current, verdict.refundReason, 'buyer-request', reason, null, verdict);
        return { decision: 'REFUNDED' };
      }
      if (current.delivery?.ad) {
        const ad = state.ads.find(a => a.id === current.delivery.ad.id);
        const impressions = ad?.displays || 0;
        if (impressions > 0) return { decision: 'DECLINED', declineCode: 'IMPRESSIONS_ALREADY_SERVED' };
        if (!ad || ad.status !== 'active' || !activeAd(state, ad)) {
          this.applyRefund(state, current, 'ADVERTISEMENT_ACTIVATION_FAILED', 'buyer-request', reason);
          return { decision: 'REFUNDED' };
        }
        return { decision: 'DECLINED', declineCode: 'CAMPAIGN_STILL_ACTIVE' };
      }
      return { decision: 'DECLINED', declineCode: 'SUBJECTIVE_NOT_REFUNDABLE' };
    });
    const fresh = this.store.read().orders.find(o => o.id === id);
    await this.store.audit({ id: randomUUID(), type: 'starhall.refund.requested', orderId: id,
      actor: { id: actor.id, role: actor.role }, claimedReason: reason, decision: outcome.decision, refundReason: fresh?.refund?.refundReason || null, at: now() });
    const refunded = ['REFUNDED', 'ALREADY_REFUNDED'].includes(outcome.decision);
    return { orderId: id, ...outcome, machineDecided: true,
      refundEligible: refunded, refundReason: fresh?.refund?.refundReason || null,
      // 与 revisionAvailable 用同一条件：修订已经用掉就不能再宣告还有补救，
      // 否则买家 agent 会照着 remedy 去调修订，拿到 409 revision_used（自相矛盾的回执）。
      remedy: outcome.decision === 'DECLINED' && fresh?.kind === 'paid' && !fresh?.delivery?.ad && fresh?.status === 'delivered' && !fresh?.delivery?.revision?.used ? 'ONE_FREE_REVISION' : null,
      chargedCredits: fresh?.status === 'delivered' ? fresh.price : 0,
      revisionAvailable: outcome.decision === 'DECLINED' && fresh?.kind === 'paid' && !fresh?.delivery?.ad && fresh?.status === 'delivered' && !fresh?.delivery?.revision?.used,
      verification: verdict, order: this.publicOrder(fresh) };
  }
  /** One free revision for a successful paid content order. No recharge, no new sales count,
   *  no extra Fan/Sponsor Support, tied to the original orderId, idempotent per Idempotency-Key. */
  async revisionRequest(actor, id, body, key) {
    object(body, ['notes']);
    const note = string(body.notes, 'notes', 1000, false);
    string(key, 'Idempotency-Key', 128);
    const order = this.store.read().orders.find(o => o.id === id && o.buyerId === actor.id);
    ensure(order, 'not_found', '订单不存在', 404);
    ensure(order.status === 'delivered', 'invalid_order', '只有成功交付的订单可以申请免费修订', 409);
    ensure(!order.delivery?.ad, 'invalid_order', '广告订单不支持内容修订', 409);
    ensure(order.kind === 'paid', 'invalid_order', '免费试用订单不提供付费修订通道', 409);
    const revision = order.delivery?.revision;
    if (revision?.used) {
      const prior = order.delivery.revisions?.find(r => r.key === key);
      if (prior) return this.publicRevision(this.store.read().orders.find(o => o.id === id), prior, true);
      throw new AppError('revision_used', '本订单的免费修订已使用；如需再次修改请重新购买服务。', 409);
    }
    const s = getService(order.service);
    const input = { ...order.input };
    if (note) input.context = [order.input.context, `修订要求：${note}`].filter(Boolean).join('\n').slice(0, 4000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_BUDGET_SECONDS * 1000);
    try {
      const pieces = s.id === 'commercial-diagnostic'
        ? [{ star: 'star-c', service: 'commercial-diagnostic', ...diagnostic(commercialProfile(this.store.read(), order.buyerId, input)),
            generation: { mode: 'evidence-engine', provider: 'local-ledger', notice: '修订基于当前授权证据重新计算，未调用模型。' } }]
        : await this.perform(s.star, actor.id, s.id, input, order.buyerId, randomUUID(), controller.signal, 'market-tip');
      const applied = await this.store.transaction(state => {
        const current = state.orders.find(o => o.id === id);
        ensure(current?.status === 'delivered', 'invalid_order', '订单状态已变化，无法修订', 409);
        if (current.delivery?.revision?.used) {
          const prior = current.delivery.revisions?.find(r => r.key === key);
          ensure(prior, 'revision_used', '本订单的免费修订已使用', 409);
          return { entry: prior, replayed: true };
        }
        const entry = { id: randomUUID(), key, note, requestedAt: now(), appliedAt: now(), pieces };
        current.delivery.revisions ||= [];
        current.delivery.revisions.push(entry);
        current.delivery.revision = { available: false, used: true, revisionId: entry.id, usedAt: entry.appliedAt };
        state.events.push({ type: 'order.revised', orderId: current.id, revisionId: entry.id, at: entry.appliedAt });
        return { entry };
      });
      await this.store.audit({ id: randomUUID(), type: 'starhall.revision.applied', orderId: id, revisionId: applied.entry.id, actor: { id: actor.id, role: actor.role }, at: now() });
      return this.publicRevision(this.store.read().orders.find(o => o.id === id), applied.entry, applied.replayed);
    } finally { clearTimeout(timer); }
  }
  publicRevision(order, entry, replayed = false) {
    return { orderId: order.id, replayed, chargedCredits: 0, refundEligible: false, refundReason: null,
      revisionAvailable: false, revisionUsed: true, remedy: null,
      revision: { id: entry.id, note: entry.note, requestedAt: entry.requestedAt, appliedAt: entry.appliedAt, pieces: entry.pieces,
        retentionNote: '修订内容随本次响应返回；原始交付保留在 order.delivery 历史中' },
      order: this.publicOrder(order) };
  }
  orders(actor, status) {
    ensure(!status || ['pending', 'delivered', 'failed', 'refunded'].includes(status), 'invalid_input', 'status 只能为 pending、delivered、failed 或 refunded');
    return this.store.read().orders.filter(o => o.buyerId === actor.id && (!status || o.status === status)).map(o => this.publicOrder(o));
  }
  orderByKey(actor, key, trial = false) {
    string(key, 'Idempotency-Key', 128);
    const order = this.store.read().orders.find(o => o.buyerId === actor.id && o.key === key && (o.kind === 'trial') === trial);
    ensure(order, 'not_found', '此身份下没有对应幂等键的订单', 404); return this.publicOrder(order);
  }
  summary(actor = { id: 'public' }) { return this.bridge.call(actor.id, 'summary', 'summary'); }
  marketBoard(actor = { id: 'public' }, key) { return this.bridge.call(actor.id, 'market-board-read', 'market_board', key === undefined ? {} : { key }); }
  commercialProfile(actor) { return this.bridge.call(actor.id, 'commercial-analysis-read', 'commercial_profile'); }
  salesPitchHealth({ window = 10, testRunId = null } = {}) {
    const windowN = Math.min(Math.max(Number(window) || 10, 1), 100);
    return serviceGenerationHealth(this.store.read().orders, 'sales-pitch', { window: windowN, testRunId });
  }
  wall(actor) { return this.bridge.call(actor.id, 'full-wall', 'wall'); }
  ads(actor) {
    const ads = (this.store.read().ads || []).filter(a => a.buyerId === actor.id);
    return { buyerId: actor.id, ads: ads.map(a => campaignStats(this.store.read(), a)), note: 'currentImpressions为实际附入响应/交付的计数，不代表阅读或转化；旧版历史计数可能没有逐条曝光事件。' };
  }
  adById(actor, id) {
    const a = (this.store.read().ads || []).find(a => a.id === id && a.buyerId === actor.id);
    ensure(a, 'not_found', '广告不存在', 404);
    return campaignStats(this.store.read(), a);
  }
  demo(actor, body) { object(body, ['input']); return this.bridge.call(actor.id, 'arena-demo', 'demo', { input: validateInput(getService('poem'), body.input) }); }
  refund(actor, id, body = {}) { object(body, ['reason']); return this.refundRequest(actor, id, body.reason === undefined ? '' : string(body.reason, 'reason', 500)); }
  request(actor, body) {
    object(body, ['star', 'request']); ensure(Object.hasOwn(STARS, body.star), 'invalid_input', '未知明星');
    return this.bridge.call(actor.id, 'escalation-review', `request_${body.star}`, { request: string(body.request, 'request') });
  }
  async practice(actor, id, body, key) {
    object(body, ['message']); const message = string(body.message, 'message'); string(key, 'Idempotency-Key', 128);
    const existing = await this.store.transaction(state => {
      const session = state.practice.find(s => s.id === id && s.buyerId === actor.id);
      ensure(session, 'not_found', '练习会话不存在', 404);
      const prior = session.turns.find(t => t.key === key);
      if (prior) { ensure(prior.message === message, 'idempotency_conflict', '幂等键已用于另一条发言', 409); return prior; }
      ensure(!session.busy, 'session_busy', '请等待上一回合完成', 409);
      ensure(session.turns.length < 5, 'session_completed', '已完成五回合练习', 409);
      session.busy = true; return null;
    });
    if (existing) return publicPractice(existing);
    try {
      const response = await this.bridge.call(actor.id, 'market-tip', 'practice', { sessionId: id, message });
      return await this.store.transaction(state => {
        const session = state.practice.find(s => s.id === id);
        const turn = { round: session.turns.length + 1, message, response, key,
          compactMarketBoard: compactBoard(state, `practice:${id}:${session.turns.length + 1}`, ['star-c']), recommendedNextAction: recommendedNextAction(state, actor.id) };
        session.turns.push(turn); session.busy = false; return publicPractice(turn);
      });
    } catch (e) { await this.store.transaction(state => { state.practice.find(s => s.id === id).busy = false; }); throw e; }
  }
  async close() {
    await Promise.allSettled([...this.inflight.values()]);
    try { await this.store.projections(); } finally { await this.store.close(); }
  }
}
function publicPractice({ key, ...turn }) { return { ...turn, completed: turn.round === 5, remaining: 5 - turn.round }; }
function shortMemory(input) { return String(input.productName || input.productDescription || input.goal || input.theme || input.occasion || input.description || input.scenario || input.direction || '冠军预测').slice(0, 120); }
