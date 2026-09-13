import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/store/postgres.js';

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
