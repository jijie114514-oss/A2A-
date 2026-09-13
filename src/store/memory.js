import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensure } from '../errors.js';
import { MARKET_DEFAULTS } from '../market.js';
import { now, hash, emptyState, normalizeState, sweepExpired, enforceRateLimit, defaultCredentials, credentialsMatch } from './shared.js';

/** 测试与本地演练驱动：与 file 同语义（无锁、无落盘），进程结束即消失。 */
export class MemoryStore {
  #queue = Promise.resolve();
  #audit = [];
  #state;
  constructor(options = {}) {
    this.market = options.market || MARKET_DEFAULTS;
    this.mode = options.mode || 'local';
    this.store = 'memory';
    this.dataSet = null;
    this.dir = null;
  }
  async open() {
    this.#state = normalizeState(emptyState(), this.market);
    this.#state.mode = this.mode;
    this.credentials = null;
    return this;
  }
  read() { return structuredClone(this.#state); }
  async refresh() { return this.read(); }
  get stale() { return false; }
  get lastLoadedAt() { return new Date().toISOString(); }
  transaction(fn) {
    const work = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      sweepExpired(draft);
      const output = await fn(draft);
      this.#state = draft;
      return structuredClone(output);
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  audit(event) { this.#audit.push({ ...event, hostMode: this.mode, at: event.at || now() }); return Promise.resolve(); }
  projections() { return Promise.resolve(); }
  async probe() { return true; }
  async seed() {
    if (this.credentials) { ensure(credentialsMatch(this.credentials, this.#state), 'invalid_credentials', '凭据与存档不匹配'); return this.credentials; }
    ensure(this.#state.accounts.length === 0, 'missing_credentials', '内存存档已有身份，不能自动重置');
    this.credentials = defaultCredentials(this.mode);
    await this.transaction(s => { s.accounts = this.credentials.accounts.map(({ token, ...a }) => ({ ...a, tokenHash: hash(token) })); });
    return this.credentials;
  }
  authenticate(token) {
    ensure(typeof token === 'string' && token.length <= 256, 'unauthorized', '需要有效的 Bearer token', 401);
    const digest = Buffer.from(hash(token));
    const account = this.#state.accounts.find(a => timingSafeEqual(Buffer.from(a.tokenHash), digest));
    ensure(account, 'unauthorized', '无效的本地身份凭据', 401);
    return { id: account.id, role: account.role, name: account.name };
  }
  async registerAgent({ handle, name, secret, credits = 100, maxAccounts = 500 }) {
    const claim = hash(`${handle}:${secret}`);
    const token = randomBytes(32).toString('hex');
    const result = await this.transaction(state => {
      const existing = state.accounts.find(a => a.handle === handle);
      if (existing) {
        ensure(existing.role === 'customer', 'forbidden', '该 handle 属于平台内部身份，不开放开户', 403);
        const sameClaim = typeof existing.claimHash === 'string' && existing.claimHash.length === claim.length && timingSafeEqual(Buffer.from(existing.claimHash), Buffer.from(claim));
        ensure(sameClaim, 'handle_taken', '该 handle 已被另一个 secret 注册；请更换 handle，或用注册时的原 secret 调用以轮换令牌', 409);
        existing.tokenHash = hash(token); existing.tokenRotatedAt = now();
        return { account: structuredClone(existing), created: false };
      }
      ensure(state.accounts.length < maxAccounts, 'registration_closed', '本部署开户名额已满，请稍后重试或联系运营方', 503);
      const account = { id: `agent-${handle}`, name, role: 'customer', balance: credits, handle, claimHash: claim, tokenHash: hash(token), createdAt: now() };
      state.accounts.push(account);
      return { account: structuredClone(account), created: true };
    });
    await this.audit({ id: randomUUID(), type: 'starhall.agent.registered', outcome: 'allowed', actor: { kind: 'agent', agentId: result.account.id },
      purpose: 'self-service-onboarding', created: result.created, at: now() });
    return { ...result, token };
  }
  async rateLimit({ bucket, key, perHour }) {
    const message = `开户请求过于频繁：每小时最多 ${perHour} 次，请稍后重试`;
    await this.transaction(state => enforceRateLimit(state, { bucket, key, perHour, message }));
  }
  async close() { await this.#queue; }
}
