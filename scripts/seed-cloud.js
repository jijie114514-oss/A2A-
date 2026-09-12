/**
 * 云端账本初始化：建表 → 写入初始身份凭据（broker + 三个模拟顾客）。
 *
 *   DATABASE_URL=postgresql://... node scripts/seed-cloud.js [--rotate] [--reset]
 *
 * - 幂等：已有凭据时只做校验并打印账号，不重新铸币。
 * - --rotate：保留账号、余额与历史，只轮换令牌（旧 token 立即失效）。
 * - --reset：清空整份账本（订单、余额、墙上记录都会消失），仅用于上线前演练。
 * 令牌只在这里打印一次，云端存档里只保存摘要。
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { createStore, defaultCredentials, hash, now, emptyState, normalizeState } from '../src/store/index.js';
import { config } from '../src/config.js';

const flags = new Set(process.argv.slice(2));
const settings = config(process.env);
if (settings.store !== 'postgres') {
  console.error(`当前 STARHALL_STORE=${settings.store}；seed-cloud 只用于云端账本（postgres）。本地初始化请用 npm run init。`);
  process.exit(2);
}
const keep = ['broker', 'fan-orion', 'fan-lyra', 'fan-vega'];

const store = createStore(settings);
const sql = (await import('@neondatabase/serverless')).neon(settings.databaseUrl);
await store.open().catch(error => { console.error(`连不上云端账本：${error.message}`); process.exit(1); });

if (flags.has('--reset')) {
  const doc = normalizeState(emptyState(), settings.market);
  doc.mode = settings.mode;
  await sql`UPDATE starhall_state SET doc = ${JSON.stringify(doc)}::jsonb, version = version + 1, updated_at = now() WHERE id = 1`;
  await sql`TRUNCATE starhall_audit`.catch(() => {});
  await store.refresh();
  console.log('云端账本已清空（--reset）。');
}

let state = store.read();
let credentials = state.credentials;
const rotate = flags.has('--rotate');

if (credentials && !rotate) {
  console.log('云端凭据已存在（幂等跳过）。需要换令牌时加 --rotate。');
} else if (credentials && rotate) {
  credentials = { mode: settings.mode, accounts: [] };
  for (const existing of state.accounts.filter(a => keep.includes(a.id))) {
    credentials.accounts.push({ id: existing.id, name: existing.name, role: existing.role, balance: existing.balance, token: randomBytes(32).toString('hex') });
  }
  await store.transaction(s => { s.credentials = credentials; s.accounts = credentials.accounts.map(({ token, ...a }) => ({ ...a, tokenHash: hash(token) })); });
  console.log('已轮换内部身份令牌（余额与历史保留）。');
} else {
  credentials = defaultCredentials(settings.mode);
  // 凭据先写、账号后铸：初始化中断不会静默重铸余额。
  await store.transaction(s => { s.credentials = credentials; s.accounts = credentials.accounts.map(({ token, ...a }) => ({ ...a, tokenHash: hash(token) })); });
  await store.audit({ id: randomUUID(), type: 'starhall.cloud.seeded', outcome: 'allowed', purpose: 'cloud-initialization', at: now(), accounts: credentials.accounts.map(a => a.id) });
  console.log('云端账本已初始化。');
}

state = store.read();
const summary = {
  mode: settings.mode, store: store.store,
  accounts: state.accounts.map(a => ({ id: a.id, role: a.role, balance: a.balance, handle: a.handle || null })),
  orders: state.orders.length, wall: state.wall.length,
};
console.log(JSON.stringify(summary, null, 2));

if (state.credentials) {
  console.log('\n内部身份令牌（只显示这一次；请立即保存到密码管理器）:');
  for (const account of state.credentials.accounts) console.log(`  ${account.id.padEnd(12)} role=${String(account.role).padEnd(8)} token=${account.token}`);
  console.log('\n外部 agent 自助开户：POST /v1/agents（部署侧需 STARHALL_OPEN_REGISTRATION=true）');
} else {
  console.log('\n注意：本次没有生成新的凭据（已存在且未 --rotate）——旧令牌不会再次打印。');
}
await store.close();
