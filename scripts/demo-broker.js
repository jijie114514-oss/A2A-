// Deterministic fixture verification, NOT an agent or a competition purchasing loop.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

await mkdir('artifacts', { recursive: true });
const dataDir = await mkdtemp(path.resolve('artifacts', 'broker-check-'));
const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_FIXTURE_MARKET: 'true' }));
try {
  const credentials = JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'));
  const token = credentials.accounts.find(a => a.id === 'broker').token;
  const trace = [], runId = 'fixture-verification';
  const request = async (route, body, key) => {
    const response = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const output = await response.json(); assert.equal(response.status, 200, JSON.stringify(output));
    trace.push({ route, input: body, output }); return output;
  };
  await request('/broker/session', { runId, source: 'fixture', ownTeamId: 'starhall', schedule: null });
  const before = await request(`/broker/status?runId=${runId}`);
  const offers = (await request('/v1/test-market/catalog')).teams;
  const reviews = [];
  for (const offer of offers) {
    const trial = await request('/v1/test-market/try', { productId: offer.id });
    const objection = trial.missingFields.length ? `交付缺少${trial.missingFields.join('、')}，无法核对资料时效。` : '回执未说明失败补偿方式，需要明确退款条件。';
    reviews.push({ teamId: offer.teamId, objection });
    const evidenceRef = `trace.json#/${trace.length - 1}/output`;
    await request('/broker/checklist', { runId, eventId: `trial-${offer.id}`, kind: 'trial', teamId: offer.teamId, service: offer.id,
      source: 'fixture', occurredAt: new Date().toISOString(), evidenceRef });
  }
  const ranking = await request('/v1/test-market/rankings', { ranking: offers.map(o => o.teamId), reviews });
  const rankingEvidence = `trace.json#/${trace.length - 1}/output`;
  // Fixture ranking endpoint accepts the critiques together with the ranking.
  const occurredAt = new Date().toISOString();
  for (const review of reviews) await request('/broker/checklist', {
      runId, eventId: `objection-${review.teamId}`, kind: 'objection', teamId: review.teamId, text: review.objection,
      source: 'fixture', occurredAt, evidenceRef: rankingEvidence });
  await request('/broker/checklist', { runId, eventId: 'ranking', kind: 'ranking', teams: ranking.ranking, accepted: ranking.accepted, source: 'fixture', occurredAt, evidenceRef: rankingEvidence });
  for (const offer of offers) {
    const key = `fixture-${offer.id}`;
    const receipt = await request('/v1/test-market/orders', { productId: offer.id }, key);
    const input = { runId, receiptId: receipt.idempotencyKey, teamId: receipt.teamId, amount: receipt.price, service: receipt.productId,
      status: receipt.status, source: 'fixture', occurredAt: new Date().toISOString(), evidenceRef: `trace.json#/${trace.length - 1}/output` };
    await request('/broker/receipt', input); await request('/broker/receipt', input);
  }
  const after = await request(`/broker/status?runId=${runId}`);
  const wallet = await request('/v1/test-market/wallet');
  assert.equal(after.spent, 80); assert.equal(after.teamsBought.length, 4); assert.equal(after.recordedObjectivesMet, true);
  assert.equal(wallet.balance, 20); assert.equal(host.app.store.read().orders.length, 0);
  const report = { simulated: true, decisionMaker: 'fixed-fixture-test', isAgentEvaluation: false, scheduleTestedHere: false,
    runId, before: { spent: before.spent, checklist: before.checklist }, after: { spent: after.spent, remaining: after.remaining, teamsBought: after.teamsBought, checklist: after.checklist, recordedObjectivesMet: after.recordedObjectivesMet },
    qualificationConfirmed: false, restartAndDeadlines: 'Covered separately by test/broker.test.js', traceFile: path.join(dataDir, 'trace.json') };
  await writeFile(path.join(dataDir, 'trace.json'), JSON.stringify(trace, null, 2));
  await writeFile(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportFile: path.join(dataDir, 'report.json') }, null, 2));
} finally { await host.close(); }
