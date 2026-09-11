import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { createBrokerSession, recordBrokerReceipt, recordBrokerChecklist, brokerStatus, brokerNext } from '../src/broker.js';

const runId = 'test-run', at = '2026-09-10T02:05:00.000Z';
const clock = Date.parse('2026-09-10T03:01:00Z');
const settings = { runId, source: 'fixture', ownTeamId: 'starhall', schedule: null };
const schedule = { trialStart: '2026-09-10T02:00:00Z', trialEnd: '2026-09-10T02:20:00Z', marketStart: '2026-09-10T02:20:00Z', marketEnd: '2026-09-10T03:00:00Z' };
const receipt = (receiptId, teamId, amount, overrides = {}) => ({ runId, receiptId, teamId, amount, service: 'service', status: 'delivered', source: 'fixture', occurredAt: at, evidenceRef: `receipts/${receiptId}.json`, ...overrides });
const event = (eventId, kind, teamId, overrides = {}) => ({ runId, eventId, kind, teamId, source: 'fixture', occurredAt: at, evidenceRef: `events/${eventId}.json`, ...overrides });
function setup(overrides = {}) { const state = {}; createBrokerSession(state, { ...settings, ...overrides }); return state; }
function checkFirstRound(state) {
  for (const team of ['a', 'b', 'c']) {
    recordBrokerChecklist(state, event(`trial-${team}`, 'trial', team, { service: 'sample' }), clock);
    recordBrokerChecklist(state, event(`objection-${team}`, 'objection', team, { text: '实际交付未说明失败退款政策。' }), clock);
  }
  recordBrokerChecklist(state, event('ranking-1', 'ranking', undefined, { teams: ['a', 'b', 'c'], accepted: true }), clock);
}

test('broker counts distinct other teams, successful spend, replays and full refunds', () => {
  const state = setup();
  const r = receipt('r1', 'a', 30);
  recordBrokerReceipt(state, r, clock);
  assert.equal(recordBrokerReceipt(state, r, clock).replayed, true);
  recordBrokerReceipt(state, receipt('r2', 'a', 25), clock);
  recordBrokerReceipt(state, receipt('r3', 'b', 25), clock);
  recordBrokerReceipt(state, receipt('failed', 'c', 15, { status: 'failed' }), clock);
  recordBrokerReceipt(state, receipt('free', 'c', 0), clock);
  let status = brokerStatus(state, runId, clock);
  assert.equal(status.spent, 80); assert.equal(status.missing, 1); assert.equal(status.recordedObjectivesMet, false);
  assert.throws(() => recordBrokerReceipt(state, { ...r, amount: 31 }, clock), { code: 'receipt_conflict' });
  const refund = { ...r, status: 'refunded', occurredAt: '2026-09-10T02:30:00Z', evidenceRef: 'refund.json' };
  recordBrokerReceipt(state, refund, clock);
  assert.equal(recordBrokerReceipt(state, refund, clock).replayed, true);
  status = brokerStatus(state, runId, clock);
  assert.equal(status.spent, 50); assert.equal(status.receipts[0].history.length, 1);
  assert.throws(() => recordBrokerReceipt(state, r, clock), { code: 'receipt_conflict' });
  assert.throws(() => recordBrokerReceipt(state, receipt('x', 'starhall', 10), clock), { code: 'own_team' });
  assert.throws(() => recordBrokerReceipt(state, receipt('x', 'c', -10), clock), { code: 'invalid_input' });
  assert.throws(() => recordBrokerReceipt(state, receipt('x', 'c', 1.5), clock), { code: 'invalid_input' });
  assert.throws(() => recordBrokerReceipt(state, receipt('x', 'c', 10, { source: 'arena' }), clock), { code: 'source_mismatch' });
  assert.throws(() => recordBrokerReceipt(state, receipt('x', 'c', 10, { occurredAt: '2099-01-01T00:00:00Z' }), clock), { code: 'future_evidence' });
});

test('broker requires actual event evidence, objections for every tried team and a fresh accepted ranking', () => {
  const state = setup();
  assert.throws(() => recordBrokerChecklist(state, { runId, ranked: true }, clock), { code: 'invalid_input' });
  assert.throws(() => recordBrokerChecklist(state, event('o', 'objection', 'a', { text: '试用缺少错误响应说明。' }), clock), { code: 'missing_trial' });
  assert.throws(() => recordBrokerChecklist(state, event('t', 'trial', 'a', { service: 's', evidenceRef: '' }), clock), { code: 'invalid_input' });
  checkFirstRound(state);
  assert.deepEqual(brokerStatus(state, runId, clock).checklist, { tried3: true, objections3: true, ranked: true });
  recordBrokerChecklist(state, event('t4', 'trial', 'd', { service: 's', occurredAt: '2026-09-10T02:06:00Z' }), clock);
  const status = brokerStatus(state, runId, clock);
  assert.deepEqual(status.missingObjections, ['d']); assert.equal(status.checklist.objections3, false); assert.equal(status.checklist.ranked, false);
  assert.equal(recordBrokerChecklist(state, event('t4', 'trial', 'd', { service: 's', occurredAt: '2026-09-10T02:06:00Z' }), clock).replayed, true);
  assert.throws(() => recordBrokerChecklist(state, event('t4', 'trial', 'other', { service: 's' }), clock), { code: 'checklist_conflict' });
});

test('purchase strategy separates products, orders and sellers and recomputes concentration after refunds', () => {
  const state = setup();
  const first = receipt('p1', 'a', 20, { service: 'same-product' });
  recordBrokerReceipt(state, first, clock);
  recordBrokerReceipt(state, first, clock);
  recordBrokerReceipt(state, receipt('p2', 'a', 15, { service: 'same-product' }), clock);
  recordBrokerReceipt(state, receipt('p3', 'a', 10, { service: 'other-product' }), clock);
  recordBrokerReceipt(state, receipt('failed', 'b', 40, { status: 'failed' }), clock);
  recordBrokerReceipt(state, receipt('free', 'c', 0), clock);
  let status = brokerStatus(state, runId, clock);
  assert.equal(status.purchaseCount, 3); assert.equal(status.productCount, 2); assert.equal(status.productsMissing, 1);
  assert.equal(status.teamsBought.length, 1); assert.equal(status.sellerSpend[0].spent, 45);
  assert.equal(status.sellerSpend[0].preferredRemaining, 0);
  assert.ok(status.alerts.some(a => a.code === 'SELLER_SPEND_CONCENTRATED'));
  assert.ok(!status.alerts.some(a => a.code === 'HIGH_PRICE_PURCHASE'));
  recordBrokerReceipt(state, { ...first, status: 'refunded', evidenceRef: 'refund-p1.json' }, clock);
  status = brokerStatus(state, runId, clock);
  assert.equal(status.productCount, 2); assert.equal(status.sellerSpend[0].spent, 25);
  assert.equal(status.sellerSpend[0].preferredRemaining, 5);
  assert.ok(!status.alerts.some(a => a.code === 'SELLER_SPEND_CONCENTRATED'));
  recordBrokerReceipt(state, receipt('p2', 'a', 15, { service: 'same-product', status: 'refunded' }), clock);
  status = brokerStatus(state, runId, clock);
  assert.equal(status.productCount, 1); assert.equal(status.productsMissing, 2);
});

test('purchase preferences warn without invalidating necessary exceptions or buying a fourth team after completion', () => {
  const state = setup(); checkFirstRound(state);
  for (const [team, amount] of [['a', 30], ['b', 25], ['c', 25]]) recordBrokerReceipt(state, receipt(team, team, amount), clock);
  let status = brokerStatus(state, runId, clock);
  assert.equal(status.recordedObjectivesMet, true); assert.equal(status.productCount, 3);
  assert.equal(status.purchasePolicy.preferredTeams, 4);
  assert.ok(!status.alerts.some(a => ['ABOVE_PREFERRED_TOTAL', 'HIGH_PRICE_PURCHASE', 'SELLER_SPEND_CONCENTRATED'].includes(a.code)));
  assert.match(brokerNext({ ...status, phase: 'MARKET' }).advice, /停止.*不为凑第4家/);
  const exceptional = setup(); checkFirstRound(exceptional);
  for (const [team, amount] of [['a', 31], ['b', 25], ['c', 25]]) recordBrokerReceipt(exceptional, receipt(team, team, amount,
    { note: '已比较当前可履约产品，缺少其他满足时限的选择。' }), clock);
  status = brokerStatus(exceptional, runId, clock);
  assert.equal(status.recordedObjectivesMet, true); assert.equal(status.spent, 81);
  assert.ok(status.alerts.some(a => a.code === 'ABOVE_PREFERRED_TOTAL'));
  assert.ok(status.alerts.some(a => a.code === 'HIGH_PRICE_PURCHASE'));
  assert.ok(status.alerts.some(a => a.code === 'SELLER_SPEND_CONCENTRATED'));
  assert.equal(status.automaticPurchases, false);
  assert.equal(status.qualificationConfirmed, false);
});

test('broker isolates sessions, enforces schedule and reports deterministic deadlines without actions', () => {
  const state = setup({ schedule });
  assert.equal(createBrokerSession(state, { ...settings, schedule }).replayed, true);
  assert.throws(() => createBrokerSession(state, settings), { code: 'session_conflict' });
  assert.throws(() => setup({ source: 'arena' }), { code: 'missing_schedule' });
  assert.throws(() => setup({ schedule: { ...schedule, trialStart: '2026-09-10T02:00:00' } }), { code: 'invalid_input' });
  checkFirstRound(state);
  for (const [team, amount] of [['a', 30], ['b', 25], ['c', 25]]) recordBrokerReceipt(state, receipt(team, team, amount, { occurredAt: '2026-09-10T02:40:00Z' }), clock);
  let status = brokerStatus(state, runId, clock);
  assert.equal(status.recordedObjectivesMet, true); assert.equal(status.qualificationConfirmed, false); assert.equal(status.phase, 'ENDED');
  assert.equal(brokerNext(status).automaticPurchases, false);
  createBrokerSession(state, { ...settings, runId: 'new-run' });
  assert.equal(brokerStatus(state, 'new-run', clock).spent, 0);
  assert.equal(brokerStatus(state, runId, clock).spent, 80);
  const late = setup({ schedule });
  recordBrokerReceipt(late, receipt('early', 'a', 80), clock);
  assert.equal(brokerStatus(late, runId, clock).spent, 0);
  recordBrokerChecklist(late, event('late', 'trial', 'a', { service: 's', occurredAt: '2026-09-10T02:30:00Z' }), clock);
  assert.equal(brokerStatus(late, runId, clock).teamsTried.length, 0);
  status = brokerStatus(late, runId, Date.parse('2026-09-10T02:45:00Z'));
  assert.ok(status.alerts.some(a => a.code === 'MARKET_DEADLINE'));
  assert.ok(status.alerts.some(a => a.code === 'BEHIND_HALF'));
  assert.ok(status.alerts.some(a => a.code === 'TRIAL_INCOMPLETE'));
  assert.equal(brokerStatus(late, runId, Date.parse('2026-09-10T01:00:00Z')).phase, 'BEFORE');
  assert.ok(brokerStatus(late, runId, Date.parse('2026-09-10T02:10:00Z')).alerts.some(a => a.code === 'TRIAL_DEADLINE'));
  const overspent = setup(); recordBrokerReceipt(overspent, receipt('too-much', 'a', 101), clock);
  assert.ok(brokerStatus(overspent, runId, clock).alerts.some(a => a.code === 'OVER_BUDGET'));
});

test('broker HTTP auth, atomic concurrent replay, persistent restart, CLI and sales ledger isolation', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-broker-'));
  const options = config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0' });
  let host = await startServer(options); t.after(() => host.close());
  const credentials = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  const token = actor => credentials.accounts.find(a => a.id === actor).token;
  const request = async (route, body, actor = 'broker') => {
    const res = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(actor ? { authorization: `Bearer ${token(actor)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await request('/broker/status?runId=test-run', undefined, null)).status, 401);
  assert.equal((await request('/broker/session', settings, 'fan-orion')).status, 403);
  assert.equal((await request('/broker/session', settings)).status, 200);
  assert.equal((await request('/broker/status?runId=test-run', undefined, 'fan-orion')).status, 403);
  assert.equal((await request('/broker/status?runId=test-run&runId=other')).status, 400);
  assert.equal((await request('/broker/status?runId=missing')).status, 404);
  const occurredAt = new Date(Date.now() - 1000).toISOString(), input = receipt('http-1', 'team-a', 30, { occurredAt });
  const results = await Promise.all(Array.from({ length: 8 }, () => request('/broker/receipt', input)));
  assert.ok(results.every(r => r.status === 200)); assert.equal(results.filter(r => !r.body.replayed).length, 1);
  assert.equal((await request('/broker/status?runId=test-run')).body.spent, 30);
  assert.equal((await request('/broker/next?runId=test-run')).body.automaticPurchases, false);
  await assert.rejects(host.app.bridge.call('broker', 'summary', 'broker_status', { runId }), { status: 403 });
  await assert.rejects(host.app.bridge.call('star-a', 'broker-tracking', 'broker_status', { runId }), { status: 403 });
  const before = host.app.store.read();
  assert.equal(before.orders.length, 0); assert.equal(before.wall.length, 0); assert.ok(before.accounts.every(a => a.balance === 100));
  await host.close(); host = await startServer(options);
  assert.equal((await request('/broker/status?runId=test-run')).body.spent, 30);
  assert.equal((await request('/broker/receipt', input)).body.replayed, true);
  const connectionFile = path.join(dataDir, 'connection.json');
  await writeFile(connectionFile, JSON.stringify({ baseUrl: host.url, credentialsFile: path.join(dataDir, 'credentials.json') }));
  const output = await promisify(execFile)(process.execPath, ['scripts/broker-cli.js', 'status', runId, connectionFile], { windowsHide: true, timeout: 10000 });
  assert.equal(JSON.parse(output.stdout).spent, 30); assert.ok(!output.stdout.includes(token('broker')));
});
