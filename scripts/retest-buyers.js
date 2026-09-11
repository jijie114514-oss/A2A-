import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { rehearseArena, fixtureMarket } from '../src/arena.js';
import { normalizeWork } from '../src/output.js';

await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', 'buyers-'));
const live = process.argv.includes('--live');
const settings = config({ ...process.env, STARHALL_DATA_DIR: dir, STARHALL_PORT: '0', ...(live ? {} : { LLM_PROVIDER: 'mock' }) });
assert.ok(!live || settings.llm.provider !== 'mock', '--live 需要已配置的真实模型');
const host = await startServer(settings);
const credentials = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
const call = async (actor, method, route, body, key) => {
  const response = await fetch(host.url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.accounts.find(a => a.id === actor).token}`, ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data)); return data;
};
const description = '自动写软件单元测试的AI助手：输入JavaScript函数，输出Jest测试代码；尚未提供覆盖率数据。';
const scenario = '我方买家预算15积分，对方卖家报价20积分，向别队采购四分钟内交付的代码审查服务；可减少一次修订换取折扣。';
const inputs = { review: { description }, roast: { description }, negotiate: { scenario },
  tactics: { direction: 'buy', context: scenario }, poem: { theme: '凌晨三点完成测试代码', recipient: '猎户座队' },
  patron: { occasion: '项目发布', recipient: '团队工程师' }, speech: { occasion: '软件测试助手发布', recipient: '开发者' },
  duet: { description: 'StarHall是卖诗、吐槽和谈判三种服务的AI明星打赏平台', theme: '用交付回应质疑', recipient: 'StarHall', context: '三种服务分别由词曲家、毒舌评审、谈判大师提供；不能把平台缩成单一吐槽服务。' }, prediction: {} };
const profiles = [
  { name: '实用主义者', actor: 'fan-orion', services: ['review', 'negotiate', 'tactics', 'tactics', 'review', 'negotiate'] },
  { name: '玩乐主义者', actor: 'fan-lyra', services: ['patron', 'duet', 'poem', 'speech', 'roast', 'roast', 'prediction'] },
  { name: '谨慎者', actor: 'fan-vega', services: ['prediction', 'review', 'tactics', 'patron', 'duet', 'speech'] },
];
const report = { mode: live ? 'live-api-local-credits' : 'mock', scriptedRegression: true, attractivenessNotScored: true,
  startedAt: new Date().toISOString(), profiles: [], issues: [], allDelivered: false };
try {
  console.log(`Regression directory: ${dir}`);
  for (const profile of profiles) {
    const before = await call(profile.actor, 'GET', '/v1/wallet'); assert.equal(before.balance, 100); assert.equal(before.held, 0);
    const record = { name: profile.name, actor: profile.actor, startingBalance: before.balance, orders: [], practice: [] }; report.profiles.push(record);
    for (let i = 0; i < profile.services.length; i++) {
      const service = profile.services[i];
      let input = service === 'tactics' && i === 3 ? { ...inputs.tactics, direction: 'sell' } : inputs[service];
      if (service === 'prediction' && profile.actor === 'fan-vega') input = { context: '20家参赛产品，StarHall是唯一娱乐平台，出售诗、吐槽和谈判服务；仅有产品说明，没有实测数据。' };
      if (service === 'review' && i < 2) input = { description: 'StarHall是AI明星打赏平台', context: '卖诗、吐槽和谈判三种服务，按交付扣本地积分；请评价组合价值和调用可靠性。' };
      const body = { service, input };
      const order = await call(profile.actor, 'POST', '/v1/orders', body, `regression-${i}`);
      record.orders.push(order);
      const modes = order.delivery?.pieces.map(p => p.generation.mode).join('+') || order.error?.code;
      console.log(`${profile.name} ${service}: ${order.status} / ${modes} / ${order.elapsedMs}ms`);
      await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
      if (order.status !== 'delivered') { report.issues.push({ profile: profile.name, orderId: order.id, error: order.error }); continue; }
      if (order.delivery.pieces.some(p => p.generation.mode === 'fallback')) report.issues.push({ profile: profile.name, orderId: order.id, issue: 'fallback_delivery_requires_quality_review' });
      for (const piece of order.delivery.pieces) {
        normalizeWork(piece, piece.service, input);
        assert.ok(piece.inputComparison, '交付须包含输入对照');
      }
      assert.equal(order.shoutout, order.delivery.shoutout); assert.ok(order.shoutout);
      assert.equal((await call(profile.actor, 'POST', '/v1/orders', body, `regression-${i}`)).id, order.id);
      if (service === 'review') assert.equal(order.delivery.pieces[0].sections.length >= 5, true);
      if (service === 'tactics') assert.ok(order.delivery.pieces[0].lines.length >= 5);
      if (service === 'negotiate') assert.equal(order.delivery.pieces[0].rounds.length, 5);
      if (service === 'prediction') {
        const work = JSON.stringify(order.delivery.pieces[0]);
        assert.match(work, /100/); assert.match(work, /80/); assert.match(work, /积分/);
        assert.ok(!/人民币|工程样机|量产计划/.test(work));
      }
    }
    if (profile.actor === 'fan-orion') {
      const session = record.orders.find(o => o.delivery?.practice)?.delivery.practice.sessionId;
      if (session) for (const [i, message] of ['我的预算15分，是否可减少一次修订？', '可以当天提供完整材料，请明确包含哪些评审项目。', '我接受一次修订，但需要具体异议与验证建议。', '如果超过四分钟，交付与扣费如何处理？', '请复述最终价格、范围、时限和未达标处理。'].entries()) {
        const turn = await call(profile.actor, 'POST', `/v1/practice/${session}/turns`, { message }, `turn-${i}`);
        record.practice.push(turn); assert.equal(turn.round, i + 1);
        if (turn.response.generation.mode === 'fallback') report.issues.push({ profile: profile.name, session, round: i + 1, issue: 'practice_fallback_requires_quality_review' });
        console.log(`互动 ${i + 1}/5: ${turn.response.generation.mode}`);
      }
    }
    record.wallet = await call(profile.actor, 'GET', '/v1/wallet');
    record.spent = 100 - record.wallet.balance;
    const listing = await call(profile.actor, 'GET', '/v1/orders'); assert.equal(listing.orders.length, profile.services.length);
    assert.equal(record.wallet.held, 0);
    if (record.orders.every(o => o.status === 'delivered')) assert.ok(record.spent >= 80 && record.spent <= 100);
    if (record.spent) assert.ok((await call(profile.actor, 'GET', '/v1/wall')).wall.length);
    record.fullWallAccessible = record.spent > 0;
  }
  report.summary = await call('fan-orion', 'GET', '/v1/summary');
  report.catalog = await call('fan-orion', 'GET', '/v1/catalog');
  report.separateFixtureArena = await rehearseArena(fixtureMarket());
  report.allDelivered = report.profiles.every(p => p.orders.every(o => o.status === 'delivered'));
  report.allPaidPiecesLive = report.profiles.every(p => p.orders.every(o => o.delivery?.pieces.every(w => w.generation.mode === 'live')));
  report.allPracticeLive = report.profiles.every(p => p.practice.every(t => t.response.generation.mode === 'live'));
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ allDelivered: report.allDelivered, allPaidPiecesLive: report.allPaidPiecesLive, spending: report.profiles.map(p => ({ name: p.name, spent: p.spent })), issues: report.issues.length, report: path.join(dir, 'report.json') }));
  if (!report.allDelivered || (live && (!report.allPaidPiecesLive || !report.allPracticeLive))) process.exitCode = 1;
} catch (e) { report.issues.push({ error: e.message }); process.exitCode = 1; console.error(e.message); }
finally { await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2)); await host.close(); }
