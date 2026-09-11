import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ensure } from './errors.js';
import { STARS } from './catalog.js';
import { marketBoard, MARKET_DEFAULTS, eligiblePaid, activeAd } from './market.js';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const now = () => new Date().toISOString();
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export function summaryOf(state) {
  const paid = state.wall.filter(w => w.amount > 0 && (!w.kind || w.kind === 'paid') && eligiblePaid(state.orders.find(o => o.id === w.id)));
  const trials = state.wall.filter(w => w.kind === 'trial');
  const ranking = marketBoard(state).ranking.map(row => ({ ...row, name: STARS[row.star].name, trials: trials.filter(w => w.stars.includes(row.star)).length }));
  const ads = state.ads || [];
  const activeAds = ads.filter(a => activeAd(state, a));
  const latest = state.wall.slice(-20).reverse().map(({ buyerName, stars, amount, serviceName, createdAt, kind }) => ({ buyerName, stars, amount, serviceName, createdAt, kind: kind || 'paid' }));
  return { mode: 'local', ranking, latest, totalPurchases: paid.length, totalCredits: paid.reduce((n, w) => n + w.amount, 0), totalTrials: trials.length, totalDemos: state.wall.filter(w => w.kind === 'demo').length,
    ads: { pinned: activeAds.filter(a => !a.starId && a.tier === 'ad-pin').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(a => ({ id: a.id, team: a.buyerName, text: a.text, kind: a.kind, until: a.expiresAt, displays: a.displays })), activeCount: activeAds.length, totalPlaced: ads.length, note: '置顶广告按投放先后排序；没有真实投放时列表为空，不展示虚构广告。' },
    pinnedThanks: paid.filter(w => w.pinned).slice(-3).reverse().map(w => ({ buyerName: w.buyerName, thanks: `感谢 ${w.buyerName} 的金主支持！`, createdAt: w.createdAt })),
    patronOffer: { service: 'patron', price: 20, message: '金主套餐交付完整作品并进入感谢区；当前没有金主时不展示虚构记录。' } };
}
export class Store {
  #queue = Promise.resolve();
  #auditQueue = Promise.resolve();
  #projectionQueue = Promise.resolve();
  #state;
  #lock;
  constructor(dir, market = MARKET_DEFAULTS) { this.dir = dir; this.market = market; }
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
      catch (e) { if (e.code !== 'ENOENT') throw e; this.#state = { version: 1, accounts: [], orders: [], wall: [], memories: {}, practice: [], events: [] }; }
      ensure(this.#state.version === 1 && Array.isArray(this.#state.orders), 'invalid_state', '本地存档版本无效');
      await this.transaction(state => {
        if (!Array.isArray(state.ads)) state.ads = [];
        state.marketSettings = structuredClone(this.market);
        state.commercialSignals ||= []; state.impressions ||= []; state.marketMoves ||= [];
        state.marketStartedAt ||= state.orders.find(eligiblePaid)?.completedAt || null;
        for (const order of state.orders.filter(o => o.status === 'pending')) {
          order.status = 'failed'; order.error = { code: 'interrupted', message: '上次进程中断，已释放预留积分，请使用新的幂等键重试' }; order.completedAt = now();
        }
        for (const session of state.practice) session.busy = false;
      });
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  read() { return structuredClone(this.#state); }
  transaction(fn) {
    const work = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
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
      try { await file.writeFile(JSON.stringify({ ...event, hostMode: 'local' }) + '\n'); await file.sync(); } finally { await file.close(); }
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
  async seed() {
    let credentials;
    try { credentials = JSON.parse(await readFile(path.join(this.dir, 'credentials.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (credentials) {
      ensure(credentials.accounts.every(a => this.#state.accounts.some(b => a.id === b.id && hash(a.token) === b.tokenHash)), 'invalid_credentials', '凭据与存档不匹配');
      return credentials;
    }
    ensure(this.#state.accounts.length === 0, 'missing_credentials', '凭据文件缺失，不能自动重置现有身份');
    credentials = { mode: 'local', accounts: [
      { id: 'broker', name: '星辉经纪人', role: 'broker', balance: 100 },
      { id: 'fan-orion', name: '猎户座队', role: 'customer', balance: 100 },
      { id: 'fan-lyra', name: '天琴座队', role: 'customer', balance: 100 },
      { id: 'fan-vega', name: '织女星队', role: 'customer', balance: 100 },
    ].map(a => ({ ...a, token: randomBytes(32).toString('hex') })) };
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
  async close() {
    await this.#queue; await this.#auditQueue; await this.#projectionQueue;
    if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(path.join(this.dir, 'process.lock')); }
  }
}
