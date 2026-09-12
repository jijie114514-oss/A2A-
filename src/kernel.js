import { randomUUID } from 'node:crypto';
import { SharedOSKernel, CapabilityAuthorizer, SharedOSExecutor, StandardRuntime, agentExecutionCapability, createEscalationTool } from '@aicoo/sharedos';
import { AppError } from './errors.js';
import { STARS, SERVICES } from './catalog.js';
import { now } from './store/shared.js';
import { eligiblePaid } from './market.js';
import { BROKER_TOOLS } from './broker.js';

export const address = id => ({ kind: 'agent', agentId: id });
export const OWNER = { kind: 'human', userId: 'starhall-local-owner' };
export const NAMESPACE_ID = 'starhall-local';
export const resource = (path, owner = OWNER) => ({ namespace: 'starhall', path: path.split('/'), owner });

/**
 * 把官方给的 tenant / owner / 节点地址接进内核，本地默认值不变。
 *
 * 内部标识（star-a、ledger、broker、fan-orion…）仍然是我们自己的账号与账本主键；
 * 只有交给内核的 Address 会换成官方指定值。未配置时地址等于内部标识，行为与本地版一致。
 * 权限矩阵本身不变：仍是同一批 grants、同一套 deny-by-default，只换签发人与主体地址。
 */
export function identityOf(options = {}) {
  const namespaceId = options.namespaceId || NAMESPACE_ID;
  const owner = options.owner || OWNER;
  const configured = options.addresses || {};
  const toAddress = value => (value && typeof value === 'object' ? structuredClone(value) : address(value));
  const key = value => JSON.stringify(value);
  const byInternal = new Map();
  const byAddress = new Map();
  const addr = id => {
    const known = byInternal.get(id);
    if (known) return known;
    const created = toAddress(configured[id] ?? id);
    byInternal.set(id, created);
    if (!byAddress.has(key(created))) byAddress.set(key(created), id);
    return created;
  };
  // 未知地址一律返回 undefined：grantSource 因此给出空集，内核 fail closed，而不是放宽授权。
  const internalOf = value => byAddress.get(key(value));
  return { namespaceId, owner, addresses: configured, addr, internalOf };
}

export class LocalKernel {
  constructor(store, options = {}) {
    this.store = store;
    this.identity = identityOf(options);
    this.namespaceId = this.identity.namespaceId;
    this.owner = this.identity.owner;
    this.kernel = new SharedOSKernel({ authorizer: new CapabilityAuthorizer(),
      grantSource: { load: async access => {
        const internalId = this.identity.internalOf(access.actor);
        if (internalId === undefined) return [];
        return this.grants(internalId).filter(g => g.namespaceId === access.namespaceId && JSON.stringify(g.issuer) === JSON.stringify(access.authority));
      } },
      audit: { record: event => store.audit(event) },
      onAuditError: () => { this.auditFailed = true; },
    });
    this.kernel.registerTool(createEscalationTool());
  }
  context(actor, purpose, traceId = randomUUID()) {
    return { namespaceId: this.namespaceId, actor: this.identity.addr(actor), authority: this.owner, owner: this.owner, purpose, traceId, now: now(), enabledToolNamespaces: ['starhall', 'sharedos'] };
  }
  grants(id) {
    const grants = [];
    const subject = this.identity.addr(id);
    const add = (path, actions, purposes) => grants.push({ id: `${id}:${path}`, namespaceId: this.namespaceId, subject, issuer: this.owner,
      capabilities: [{ resource: resource(path, this.owner), actions, scope: 'exact' }], constraints: { purposes }, issuedAt: '2026-01-01T00:00:00.000Z' });
    const state = this.store.read();
    const account = state.accounts.find(a => a.id === id);
    const internal = [...Object.keys(STARS), 'ledger', 'broker'];
    if (internal.includes(id)) grants.push({ id: `${id}:execution`, namespaceId: this.namespaceId, subject, issuer: this.owner,
      capabilities: [agentExecutionCapability(subject, this.owner)], constraints: { purposes: ['arena-demo', 'market-tip', 'ledger-update', 'escalation-review', 'summary', 'full-wall', ...(id === 'ledger' ? ['market-board-read', 'commercial-analysis-read'] : id === 'star-c' ? ['commercial-analysis-read'] : [])] }, issuedAt: '2026-01-01T00:00:00.000Z' });
    if (id === 'public' || account?.role === 'customer') add('ledger/summary', ['invoke'], ['summary']);
    if (id === 'public' || id === 'broker' || account?.role === 'customer') add('ledger/market-board', ['invoke'], ['market-board-read']);
    if (account?.role === 'customer') {
      add('ledger/commercial-profile', ['invoke'], ['commercial-analysis-read']);
      for (const s of SERVICES) add(`services/${s.id}`, ['invoke'], ['market-tip']);
      add('services/practice', ['invoke'], ['market-tip']);
      for (const star of Object.keys(STARS)) add(`requests/${star}`, ['invoke'], ['escalation-review']);
      if (state.orders.some(o => o.buyerId === id && eligiblePaid(o))) add('ledger/full-wall', ['invoke'], ['full-wall']);
    }
    if (id === 'broker') { add('services/demo', ['invoke'], ['arena-demo']); add('broker/review', ['invoke'], ['escalation-review']); }
    if (id === 'broker') for (const name of BROKER_TOOLS) add(`broker/tracking/${name}`, ['invoke'], ['broker-tracking']);
    if (id in STARS) {
      grants.push({ id: `${id}:escalate`, namespaceId: this.namespaceId, subject, issuer: this.owner,
        capabilities: [{ resource: { namespace: 'sharedos', path: ['escalation'], owner: this.owner }, actions: ['request'], scope: 'exact' }],
        constraints: { purposes: ['escalation-review'] }, issuedAt: '2026-01-01T00:00:00.000Z' });
      add(`memory/${id}`, ['read'], ['market-tip', 'arena-demo']);
      add(`generate/${id}`, ['invoke'], ['market-tip', 'arena-demo']);
      add('ledger/record', ['invoke'], ['ledger-update']);
      add('broker/escalation', ['invoke'], ['escalation-review']);
    }
    if (id === 'star-b') add('services/collaborate', ['invoke'], ['market-tip']);
    if (id === 'star-a') add('ledger/record-demo', ['invoke'], ['ledger-update']);
    if (id === 'star-c') add('ledger/order-analysis', ['invoke'], ['commercial-analysis-read']);
    if (id === 'ledger') {
      add('ledger/storage-market-board', ['write'], ['market-board-read']);
      add('ledger/storage-analysis', ['read'], ['commercial-analysis-read']);
      add('ledger/record', ['invoke'], ['ledger-update']);
      add('ledger/storage-demo', ['write'], ['ledger-update']);
      add('ledger/storage-summary', ['read'], ['summary']);
      add('ledger/storage-summary-exposure', ['write'], ['summary']);
      add('ledger/storage-wall', ['read'], ['full-wall']);
      add('ledger/storage-record', ['write'], ['ledger-update']);
    }
    return grants;
  }
  /** 地址 → 内部标识。未配置官方地址时即使恒等，配置后由这里归一。 */
  actorIdOf(context) { return this.identity.internalOf(context?.actor) ?? context?.actor?.agentId; }
  register(name, path, action, handler) {
    this.kernel.registerTool({
      definition: { name: `starhall.${name}`, namespace: 'starhall', source: 'starhall-local', readWrite: ['read'].includes(action) ? 'read' : 'write',
        description: `StarHall ${name}`, inputSchema: { type: 'object' }, requiredCapability: { resource: resource(path, this.owner), action } },
      parseArguments: args => args,
      invoke: async (context, call, signal) => {
        const base = { callId: call.id, tool: call.tool, completedAt: now() };
        // 交给内核与审计的是官方地址；产品逻辑（账号、账本、角色比对）仍用内部标识。
        // 翻译只发生在这里一次，两边不会各拿一半而错位。
        const internal = this.identity.internalOf(context.actor);
        const ctx = internal === undefined ? context : { ...context, actor: address(internal) };
        try { signal.throwIfAborted(); const output = await handler(ctx, call.arguments, signal); return { ...base, completedAt: now(), status: 'succeeded', output }; }
        catch (error) { return { ...base, completedAt: now(), status: 'failed', error: { code: error instanceof AppError ? error.code : 'operation_failed', message: error instanceof AppError ? error.message : '本地操作失败', retryable: false }, metadata: { httpStatus: error.status || 500 } }; }
      },
    });
  }
  async call(actor, purpose, name, args = {}, traceId, signal) {
    const context = this.context(actor, purpose, traceId);
    const result = await this.kernel.invokeTool(context, { id: randomUUID(), tool: `starhall.${name}`, arguments: args, traceId: context.traceId, requestedAt: now() }, { signal });
    if (result.status !== 'succeeded') throw new AppError(result.error.code, result.error.message, result.status === 'denied' ? 403 : result.metadata?.httpStatus || 500);
    return result.output;
  }
  async turn(actor, sender, purpose, traceId, program, signal) {
    const context = this.context(actor, purpose, traceId);
    const iterator = program();
    const driver = { open: async () => ({ next: async input => {
      if (input.type === 'tool_result' && input.result.status !== 'succeeded') return { type: 'fail', error: input.result.error, metadata: input.result.metadata };
      const step = await iterator.next(input.type === 'tool_result' ? input.result.output : undefined);
      if (step.done) return { type: 'complete', output: step.value ?? {} };
      if (step.value.escalate) return { type: 'escalate', reason: step.value.escalate };
      return { type: 'tool_call', call: { id: randomUUID(), tool: `starhall.${step.value.tool}`, arguments: step.value.args || {}, traceId, requestedAt: now() } };
    }, close: async () => { await iterator.return(); } }) };
    const result = await new SharedOSExecutor(this.kernel, new StandardRuntime(driver), { defaultMaxSteps: 12, defaultMaxToolCalls: 10, defaultTimeoutMs: 110000 }).execute({
      version: '1', executionId: randomUUID(), agent: this.identity.addr(actor), context,
      message: { version: '1', id: randomUUID(), sender: this.identity.addr(sender), receiver: this.identity.addr(actor), purpose, traceId, payload: { text: '执行已验证的 StarHall 本地任务' }, createdAt: now() },
      tools: [...await this.kernel.listTools(context)],
    }, { signal });
    if (result.status === 'escalated') return { status: 'escalated', escalation: result.escalation };
    if (result.status !== 'succeeded') throw new AppError(result.error?.code || 'turn_failed', result.error?.message || '执行未完成', result.status === 'denied' ? 403 : result.metadata?.httpStatus || 500);
    return result.output;
  }
}
