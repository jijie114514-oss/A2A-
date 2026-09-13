import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensure } from '../errors.js';
import { MARKET_DEFAULTS } from '../market.js';
import { now, hash, emptyState, normalizeState, sweepExpired, enforceRateLimit, summaryOf, defaultCredentials, credentialsMatch } from './shared.js';

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

/** 本地单进程驱动：保留 process.lock 互斥与「重启即中断」的语义，行为与 0.5.0-local 一致。 */
export class FileStore {
  #queue = Promise.resolve();
  #auditQueue = Promise.resolve();
  #projectionQueue = Promise.resolve();
  #state;
  #lock;
  #lastLoaded;
  constructor(options = {}) {
    this.dir = options.dataDir || path.resolve('data');
    this.market = options.market || MARKET_DEFAULTS;
    this.mode = options.mode || 'local';
    this.store = 'file';
    this.dataSet = path.basename(this.dir);
    this.#lastLoaded = new Date().toISOString();
  }
  async open() {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'process.lock');
    try { this.#lock = await open(file, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('数据目录锁无法读取，请确认没有运行中的实例后处理 process.lock'); }
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      ensure(!alive, 'data_locked', '数据目录正被另一进程占用，请先停止服务器或使用独立 STARHALL_DATA_DIR', 409);
      await unlink(file); this.#lock = await open(file, 'wx');
    }
    await this.#lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
    try {
      try { this.#state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; this.#state = emptyState(); }
      ensure(this.#state.version === 1 && Array.isArray(this.#state.orders), 'invalid_state', '本地存档版本无效');
      this.#state.mode ||= this.mode;
      await this.transaction(state => {
        normalizeState(state, this.market);
        // 单进程本地语义：能走到这里说明上次进程已经中断，在飞的预留在启动时立即释放。
        for (const order of state.orders.filter(o => o.status === 'pending')) {
          order.status = 'failed'; order.error = { code: 'interrupted', message: '上次进程中断，已释放预留积分，请使用新的幂等键重试' }; order.completedAt = now();
        }
        for (const session of state.practice) session.busy = false;
      });
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  read() { return structuredClone(this.#state); }
  /** file 驱动没有跨实例状态，每请求刷新是空操作（快照就在进程内存里）。 */
  async refresh() { return this.read(); }
  get stale() { return false; }
  get lastLoadedAt() { return this.#lastLoaded; }
  transaction(fn) {
    const work = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      sweepExpired(draft);
      const output = await fn(draft);
      await atomicJson(path.join(this.dir, 'state.json'), draft);
      this.#state = draft;
      return structuredClone(output);
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  audit(event) {
    const work = this.#auditQueue.then(async () => {
      const file = await open(path.join(this.dir, 'audit.jsonl'), 'a', 0o600);
      try { await file.writeFile(JSON.stringify({ ...event, hostMode: this.mode }) + '\n'); await file.sync(); } finally { await file.close(); }
    });
    this.#auditQueue = work.catch(() => {});
    return work;
  }
  projections() {
    const work = this.#projectionQueue.then(async () => {
      const s = this.read();
      await atomicJson(path.join(this.dir, 'ledger', 'summary.json'), summaryOf(s));
      await atomicJson(path.join(this.dir, 'ledger', 'wall.json'), s.wall);
      for (const [star, memories] of Object.entries(s.memories)) await atomicJson(path.join(this.dir, 'stars', star, 'memory.json'), memories);
      for (const order of s.orders.filter(o => o.status === 'delivered')) {
        for (const piece of order.delivery.pieces) {
          if (piece.kind === 'ad') continue;
          await atomicJson(path.join(this.dir, 'stars', piece.star, 'works', `${order.id}.json`), piece);
        }
      }
    });
    this.#projectionQueue = work.catch(() => {});
    return work;
  }
  async probe() { return true; }
  async seed() {
    let credentials;
    try { credentials = JSON.parse(await readFile(path.join(this.dir, 'credentials.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (credentials) {
      ensure(credentialsMatch(credentials, this.#state), 'invalid_credentials', '凭据与存档不匹配');
      return credentials;
    }
    ensure(this.#state.accounts.length === 0, 'missing_credentials', '凭据文件缺失，不能自动重置现有身份');
    credentials = defaultCredentials(this.mode);
    // Credentials first: an interrupted initialization never silently remints balances.
    await atomicJson(path.join(this.dir, 'credentials.json'), credentials);
    await this.transaction(s => { s.accounts = credentials.accounts.map(({ token, ...a }) => ({ ...a, tokenHash: hash(token) })); });
    return credentials;
  }
  authenticate(token) {
    ensure(typeof token === 'string' && token.length <= 256, 'unauthorized', '需要有效的 Bearer token', 401);
    const digest = Buffer.from(hash(token));
    const account = this.#state.accounts.find(a => timingSafeEqual(Buffer.from(a.tokenHash), digest));
    ensure(account, 'unauthorized', '无效的本地身份凭据', 401);
    return { id: account.id, role: account.role, name: account.name };
  }
  /** 自助开户：外部 agent 不经人工审批即可拿到本地顾客身份。
   *  handle + secret 决定归属：同一对再次调用只轮换令牌，secret 不匹配则拒绝。
   *  令牌只返回一次，存档里只留摘要；账号初始余额与既有顾客一致（本地模拟积分）。 */
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
  async close() {
    await this.#queue; await this.#auditQueue; await this.#projectionQueue;
    if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(path.join(this.dir, 'process.lock')); }
  }
}
