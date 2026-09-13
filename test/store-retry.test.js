import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/store/postgres.js';
import { hash } from '../src/store/shared.js';

/**
 * 单文档存储的所有写都在同一行上竞争，并发开户/下单必然撞版本号。
 * 2026-09-13 实测：10 个并行开户只有 3 个成功（其余 409 write_conflict），
 * 原因是重试预算太短。这里用假 sql 驱动把「连续冲突」造出来，锁住新的重试行为。
 */
function fakeSql({ conflicts }) {
  let version = 0; let updates = 0; let remaining = conflicts;
  const state = { version: 1, accounts: [], orders: [], wall: [], memories: {}, practice: [], events: [], ads: [], commercialSignals: [], impressions: [], marketMoves: [], rateLimits: {} };
  const sql = (strings, ...values) => {
    const text = strings.join('$?').trim();
    if (/^SELECT doc, version FROM starhall_state/.test(text)) return Promise.resolve([{ doc: state, version }]);
    if (/^UPDATE starhall_state/.test(text)) {
      if (remaining-- > 0) return Promise.resolve([]);   // 模拟被别的实例抢先
      version += 1; updates += 1; return Promise.resolve([{ version }]);
    }
    return Promise.resolve([]);
  };
  sql.query = () => Promise.resolve([]);
  return { sql, get version() { return version; }, get updates() { return updates; } };
}

const store = fake => { const s = new PostgresStore({ databaseUrl: 'postgresql://user:pass@example.invalid/db' }); s.sql = fake.sql; return s; };

test('乐观并发：连续撞版本也能靠重试提交，且 fn 会被重跑', async () => {
  const fake = fakeSql({ conflicts: 6 });
  let runs = 0;
  const result = await store(fake).transaction(state => { runs++; state.accounts.push({ id: `run-${runs}` }); return `ok-${runs}`; });
  assert.equal(result, 'ok-7', '重试要重新读版本并重跑 fn（不能用旧 draft 复用）');
  assert.equal(runs, 7);
  assert.equal(fake.updates, 1, '只提交一次');
  assert.equal(fake.version, 1);
});

test('乐观并发：超过重试预算才报 write_conflict，并带可操作提示', async () => {
  const fake = fakeSql({ conflicts: 99 });
  const s = store(fake);
  await assert.rejects(s.transaction(state => { state.accounts.push({ id: 'never' }); }), error => {
    assert.equal(error.code, 'write_conflict');
    assert.match(error.message, /同一个幂等键重试/);
    return true;
  });
  assert.ok(s.writeConflicts >= 14, `应记录冲突次数，实际 ${s.writeConflicts}`);
});

test('开户走单条原子语句：无版本谓词，突发并发不会饿死', async () => {
  // 假驱动：记录发了哪些语句；原子 UPDATE 返回新文档（模拟追加成功）
  const statements = [];
  const state = { version: 1, accounts: [], orders: [], wall: [], memories: {}, practice: [], events: [], ads: [], commercialSignals: [], impressions: [], marketMoves: [], rateLimits: {} };
  const sql = (strings, ...values) => {
    const text = strings.join('$?').trim();
    statements.push(text);
    if (/^UPDATE starhall_state/.test(text) && /jsonb_array_length/.test(text)) {
      const account = JSON.parse(values[0])[0];
      state.accounts.push(account);
      return Promise.resolve([{ version: 1, doc: state }]);
    }
    return Promise.resolve([]);
  };
  sql.query = () => Promise.resolve([]);
  const store = new PostgresStore({ databaseUrl: 'postgresql://user:pass@example.invalid/db' });
  store.sql = sql;
  const result = await store.registerAgent({ handle: 'burst-1', name: '突发', secret: 's'.repeat(24) });
  assert.equal(result.created, true);
  assert.equal(result.account.handle, 'burst-1');
  assert.ok(result.token && result.token.length >= 32);
  assert.match(statements[0], /jsonb_array_length/, '必须用单条语句做上限与唯一性判定');
  assert.ok(!/WHERE.*version = /.test(statements[0]), '不能依赖 version 谓词（那才会饿死）');
});

test('开户回落路径：handle 已存在时仍走通用事务并保留错误语义', async () => {
  const secret = 'x'.repeat(24);
  const state = { version: 1, accounts: [{ id: 'agent-dup', handle: 'dup', role: 'customer', claimHash: hash(`dup:${secret}`), tokenHash: 'x', balance: 100 }],
    orders: [], wall: [], memories: {}, practice: [], events: [], ads: [], commercialSignals: [], impressions: [], marketMoves: [], rateLimits: {} };
  let atomicTried = false; let selected = 0;
  const sql = (strings, ...values) => {
    const text = strings.join('$?').trim();
    if (/^UPDATE starhall_state/.test(text) && /jsonb_array_length/.test(text)) { atomicTried = true; return Promise.resolve([]); }   // 唯一性不满足
    if (/^SELECT doc, version FROM starhall_state/.test(text)) return Promise.resolve([{ doc: state, version: selected }]);
    if (/^UPDATE starhall_state/.test(text)) { selected += 1; return Promise.resolve([{ version: selected }]); }                       // 通用路径提交成功
    return Promise.resolve([]);
  };
  sql.query = () => Promise.resolve([]);
  const store = new PostgresStore({ databaseUrl: 'postgresql://user:pass@example.invalid/db' });
  store.sql = sql;
  await assert.rejects(store.registerAgent({ handle: 'dup', name: '重复', secret: 'y'.repeat(24) }), error => {
    assert.equal(error.code, 'handle_taken', 'secret 不匹配必须是 handle_taken，不能变成内部错误');
    return true;
  });
  assert.equal(atomicTried, true, '先试原子路径');
  const rotated = await store.registerAgent({ handle: 'dup', name: '重复', secret });
  assert.equal(rotated.created, false, '同 handle+同 secret 走轮换');
});
