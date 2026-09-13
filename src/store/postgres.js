import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ensure, AppError } from '../errors.js';
import { MARKET_DEFAULTS } from '../market.js';
import { now, hash, emptyState, normalizeState, sweepExpired, enforceRateLimit, credentialsMatch } from './shared.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS starhall_state (
     id         smallint PRIMARY KEY DEFAULT 1,
     doc        jsonb    NOT NULL,
     version    bigint   NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CHECK (id = 1))`,
  `CREATE TABLE IF NOT EXISTS starhall_audit (
     seq     bigserial PRIMARY KEY,
     id      text NOT NULL,
     type    text NOT NULL,
     outcome text NOT NULL,
     actor   jsonb,
     purpose text,
     at      timestamptz NOT NULL,
     payload jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS starhall_audit_at_idx ON starhall_audit (at DESC)`,
];

/**
 * 云端驱动：状态是**单文档 jsonb + 乐观并发**，审计是 append-only 表。
 *
 * - `read()` 同步返回本实例缓存；每请求由 server 调 `refresh()` 取最新快照。
 * - `transaction(fn)` 每次重新读 doc/version，`fn` 在深拷贝上跑，`UPDATE ... WHERE version = $n`
 *   提交；影响行数为 0 表示被别的实例抢先，重读并**重跑 fn**（fn 不幂等，不能用旧 draft 复用）。
 * - 不使用进程锁；pending 订单靠租约超时（`expiresAt`）惰性判失败，冷启动不会误杀在飞订单。
 */
export class PostgresStore {
  #queue = Promise.resolve();
  #auditQueue = Promise.resolve();
  #state = null;
  #version = 0;
  #loadedAtAt = 0;
  constructor(options = {}) {
    ensure(options.databaseUrl, 'invalid_config', 'PostgresStore 需要 DATABASE_URL');
    this.url = options.databaseUrl;
    this.market = options.market || MARKET_DEFAULTS;
    this.mode = options.mode || 'cloud';
    this.store = 'postgres';
    this.dir = null;
    this.staleSince = null;
    this.dataSet = options.dataSet || null;
  }
  async open() {
    const { neon } = await import('@neondatabase/serverless');
    this.sql = neon(this.url);
    for (const statement of DDL) await this.sql.query(statement);
    const rows = await this.sql`SELECT doc, version FROM starhall_state WHERE id = 1`;
    if (!rows.length) {
      const doc = normalizeState(emptyState(), this.market);
      doc.mode = this.mode;
      await this.sql`INSERT INTO starhall_state (id, doc, version) VALUES (1, ${JSON.stringify(doc)}::jsonb, 0) ON CONFLICT (id) DO NOTHING`;
    }
    await this.#reload();
    return this;
  }
  read() {
    ensure(this.#state, 'store_not_ready', '存储尚未初始化', 503);
    return structuredClone(this.#state);
  }
  /**
   * 每请求刷新：多实例下保证读到最新版本，同时更新本实例的同步快照。
   *
   * 为什么要 TTL：每次刷新都是一次「整份文档」的 SELECT，而 Neon 免费版按**公网传输量**
   * 计费（5 GB/月，超了直接挂起，2026-09-13 我们就是这样被打挂的）。行情榜/证据页/健康检查
   * 这类轮询流量不需要毫秒级新鲜度，2 秒内的重复读走内存快照即可；写路径仍走
   * transaction()（每次重新读版本），认证路径在缓存未命中时会强制回源。
   *
   * 降级而非死亡：回源失败时保留最后一份好快照并把 staleSince 记下来，读端点继续服务，
   * 由 /readiness 与 /health 如实报告「陈旧」。写完仍然失败的是写请求，那才该报错。
   */
  async refresh({ force = false } = {}) {
    const ttl = Number(process.env.STARHALL_REFRESH_TTL_MS ?? 2000);
    if (!force && this.#state && Date.now() - this.#loadedAtAt < ttl) return this.read();
    try { await this.#reload(); this.#loadedAtAt = Date.now(); this.staleSince = null; }
    catch (error) {
      if (!this.#state) throw error;                       // 从未成功读过 → 真的不可用
      this.staleSince ||= Date.now();
      this.lastError = String(error.message).slice(0, 200);
    }
    return this.read();
  }
  get stale() { return Boolean(this.staleSince); }
  get lastLoadedAt() { return this.#loadedAtAt ? new Date(this.#loadedAtAt).toISOString() : null; }
  async #select() {
    const rows = await this.sql`SELECT doc, version FROM starhall_state WHERE id = 1`;
    if (!rows.length) throw new AppError('store_not_ready', '账本尚未初始化；请执行 node scripts/seed-cloud.js', 503);
    return { doc: rows[0].doc, version: Number(rows[0].version) };
  }
  async #reload() {
    const { doc, version } = await this.#select();
    this.#state = normalizeState(doc, this.market);
    this.#version = version;
    this.#loadedAtAt = Date.now();
  }
  /** 单文档结构意味着所有写都在同一行上竞争：并发开户/下单一定会撞版本号。
   *  饥饿重试（5 次、10–80ms）在几十个 agent 同时进场的场景下不够用——实测 10 并发开户只成功 3 个。
   *  这里改成足够长的重试预算 + 抖动退避：最坏多花几秒，但不把别人的 agent 挡在门外。 */
  transaction(fn) {
    const MAX_ATTEMPTS = 22;
    // 抖动要够大：所有写者同步重试会再次互撞。上限 800ms 让落后者有机会插队。
    const backoff = attempt => Math.min(800, 20 * 2 ** attempt) + Math.floor(Math.random() * 250);
    const work = this.#queue.then(async () => {
      let conflict;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { doc, version } = await this.#select();
        const draft = structuredClone(doc);
        sweepExpired(draft);
        const output = await fn(draft);
        const updated = await this.sql`UPDATE starhall_state SET doc = ${JSON.stringify(draft)}::jsonb, version = version + 1, updated_at = now()
          WHERE id = 1 AND version = ${version} RETURNING version`;
        if (updated.length) {
          this.#state = draft; this.#version = Number(updated[0].version); this.#loadedAtAt = Date.now(); this.staleSince = null;
          return structuredClone(output);
        }
        this.writeConflicts = (this.writeConflicts || 0) + 1;
        conflict = new AppError('write_conflict', `账本被其他实例抢先更新（连续 ${MAX_ATTEMPTS} 次），请稍后用同一个幂等键重试`, 409);
        await delay(backoff(attempt));
      }
      throw conflict;
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  audit(event) {
    const payload = { ...event, hostMode: this.mode };
    const work = this.#auditQueue.then(async () => {
      await this.sql`INSERT INTO starhall_audit (id, type, outcome, actor, purpose, at, payload)
        VALUES (${String(payload.id || randomUUID())}, ${String(payload.type || 'unknown')}, ${String(payload.outcome || 'unknown')},
                ${JSON.stringify(payload.actor ?? null)}::jsonb, ${payload.purpose ?? null}, ${payload.at || now()}::timestamptz,
                ${JSON.stringify(payload)}::jsonb)`;
    });
    this.#auditQueue = work.catch(() => {});
    return work;
  }
  /** 云端没有可写的持久文件系统：投影本来就能从 state 现算，这里只做一次探活。 */
  async projections() { await this.probe(); }
  async probe() {
    try { await this.sql`SELECT 1`; return true; } catch { return false; }
  }
  async seed() {
    const { doc } = await this.#select();
    const credentials = doc.credentials;
    ensure(credentials, 'missing_credentials', '云端账本还没有身份凭据；请先在本地执行 node scripts/seed-cloud.js 完成初始化', 503);
    ensure(credentialsMatch(credentials, doc), 'invalid_credentials', '凭据与云端存档不匹配');
    return credentials;
  }
  authenticate(token) {
    ensure(typeof token === 'string' && token.length <= 256, 'unauthorized', '需要有效的 Bearer token', 401);
    const state = this.read();
    const digest = Buffer.from(hash(token));
    const account = state.accounts.find(a => timingSafeEqual(Buffer.from(a.tokenHash), digest));
    ensure(account, 'unauthorized', '无效的身份凭据', 401);
    return { id: account.id, role: account.role, name: account.name };
  }
  /** 开户是今晚唯一的高并发写：几十个 agent 会在同一分钟进场。
   *  单文档的读-改-写在这种突发下必然互相撞版本（实测 20 并发：全部成功但 p95 14 秒）。
   *  这里把「新增账号」做成**单条原子语句**——追加、句柄唯一、名额上限都在 SQL 里判定，
   *  没有 version 谓词就不会饿死；只有「handle 已存在（轮换/冲突）」与「名额满」
   *  这两类少数情况才回落到通用事务路径，保证错误语义一字不差。 */
  async #registerAtomic({ handle, name, secret, credits, maxAccounts }) {
    const claim = hash(`${handle}:${secret}`);
    const token = randomBytes(32).toString('hex');
    const account = { id: `agent-${handle}`, name, role: 'customer', balance: credits, handle,
      claimHash: claim, tokenHash: hash(token), createdAt: now() };
    const rows = await this.sql`
      UPDATE starhall_state
         SET doc = jsonb_set(doc, '{accounts}', (doc->'accounts') || ${JSON.stringify([account])}::jsonb),
             version = version + 1, updated_at = now()
       WHERE id = 1
         AND jsonb_array_length(doc->'accounts') < ${maxAccounts}
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'accounts') a WHERE a->>'handle' = ${handle})
      RETURNING version, doc`;
    if (!rows.length) return null;
    this.#state = normalizeState(rows[0].doc, this.market);
    this.#version = Number(rows[0].version); this.#loadedAtAt = Date.now();
    return { account, created: true, token };
  }
  async registerAgent({ handle, name, secret, credits = 100, maxAccounts = 500 }) {
    const fast = await this.#registerAtomic({ handle, name, secret, credits, maxAccounts }).catch(() => null);
    const result = fast || await this.#registerAgentGeneric({ handle, name, secret, credits, maxAccounts });
    await this.audit({ id: randomUUID(), type: 'starhall.agent.registered', outcome: 'allowed', actor: { kind: 'agent', agentId: result.account.id },
      purpose: 'self-service-onboarding', created: result.created, at: now() });
    return result;
  }
  async #registerAgentGeneric({ handle, name, secret, credits = 100, maxAccounts = 500 }) {
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
    return { ...result, token };
  }
  async rateLimit({ bucket, key, perHour }) {
    const message = `开户请求过于频繁：每小时最多 ${perHour} 次，请稍后重试`;
    await this.transaction(state => enforceRateLimit(state, { bucket, key, perHour, message }));
  }
  async close() { await this.#queue; await this.#auditQueue; }
}
