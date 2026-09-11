// 买方Agent行为脚本 v0.5.0 复测 —— 角色：竞技场agent，本队卖"代码审查服务 CodeLens"
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:52269';
const creds = JSON.parse(readFileSync('./artifacts/sandbox-uZmFGJ/credentials.json', 'utf8'));
const tok = id => creds.accounts.find(a => a.id === id).token;
const out = [];
const rec = (label, v) => { out.push(`\n════ ${label} ════`); out.push(typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
async function post(actor, path, body, key) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(actor)}`, ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
  const data = await res.json();
  return { http: res.status, ms: Date.now() - t0, data };
}
async function get(actor, path) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { headers: actor ? { authorization: `Bearer ${tok(actor)}` } : {} });
  return { http: res.status, ms: Date.now() - t0, data: await res.json() };
}

// ══ 1. 目录结构（6核心 + extras） ══
{
  const c = await get(null, '/v1/catalog');
  rec('catalog 核心', { version: c.data.version, core: c.data.services.map(s => `${s.id} ${s.price ?? 'plan'}分`), extras数量: c.data.extras?.services?.length });
}

// ══ 2. 免费 market-board ══
{
  const r = await get(null, '/v1/market-board');
  rec('market-board', { http: r.http, ms: r.ms, keys: Object.keys(r.data) });
  rec('market-board 内容', JSON.stringify(r.data).slice(0, 900));
}

// ══ 3. [实用主义者] 试用+购买 sales-pitch（8分，给本队产品写销售词） ══
{
  const t = await post('fan-orion', '/v1/trials', { service: 'sales-pitch', input: { productName: 'CodeLens', productDescription: '输入代码，输出带文件位置的问题清单和修复建议', price: 20, targetBuyer: 'coding agents' } }, 'v5-trial-pitch');
  const tp = t.data.delivery?.pieces?.[0];
  rec('trial sales-pitch', `HTTP ${t.http} / ${t.ms}ms / kind ${t.data.kind} / mode ${tp?.generation?.mode} / charged ${t.data.charged}`);
  rec('pitch 质量', { oneLine: tp?.oneLinePitch, cta: tp?.callToAction, points: tp?.keyValuePoints?.length, fidelity: tp?.contextFidelity?.note?.slice(0, 60) });
  const b = await post('fan-orion', '/v1/orders', { service: 'sales-pitch', input: { productName: 'CodeLens', productDescription: '输入代码，输出带文件位置的问题清单和修复建议', price: 20, targetBuyer: 'coding agents' } }, 'v5-buy-pitch');
  const bp = b.data.delivery?.pieces?.[0];
  rec('buy sales-pitch', `HTTP ${b.http} / ${b.ms}ms / mode ${bp?.generation?.mode} / balanceAfter ${b.data.balanceAfter}`);
}

// ══ 4. [实用主义者] deal-coach（15分，规则引擎不调模型） ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'deal-coach', input: { currentOffer: 20, budget: 15, counterpartyMessage: '能否缩小范围？', goal: '预算内采购代码审查' } }, 'v5-dealcoach');
  const p = r.data.delivery?.pieces?.[0];
  rec('deal-coach', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode}`);
  rec('deal-coach 输出', { nextMessage: p?.nextMessage, counteroffer: p?.recommendedCounteroffer, concession: p?.concessionLevel, walkAway: p?.walkAwayCondition?.slice(0, 80) });
}

// ══ 5. [谨慎者] sales-stress-test（10分，模拟异议） ══
{
  const r = await post('fan-vega', '/v1/orders', { service: 'sales-stress-test', input: { productDescription: '我方代码审查服务，输出风险清单', price: 20 } }, 'v5-stress');
  const p = r.data.delivery?.pieces?.[0];
  rec('sales-stress-test', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode} / objections ${p?.topObjections?.length} / evidenceType ${p?.evidenceType}`);
  rec('异议样例', p?.topObjections?.slice(0, 2));
}

// ══ 6. [卖家] star-sponsorship leaderboard 15分 → 验证 pin 曝光计数（上轮遗留问题） ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'star-sponsorship', input: { starId: 'star-b', plan: 'leaderboard', advertiser: 'CodeLens', adCopy: '代码审查：20积分，提供问题位置和修复建议。' } }, 'v5-sponsor-pin');
  rec('sponsorship leaderboard', `HTTP ${r.http} / ${r.ms}ms / status ${r.data.delivery?.receipt?.status ?? r.data.status} / balanceAfter ${r.data.balanceAfter}`);
  const before = await get('fan-orion', '/v1/ads');
  rec('ads 初始', before.data.ads?.map(a => `${a.tier ?? a.plan} impressions ${a.currentImpressions}/${a.trackedImpressions}`));
  // 匿名查榜多次
  for (let i = 0; i < 5; i++) await get(null, '/v1/market-board');
  const after = await get('fan-orion', '/v1/ads');
  rec('查榜5次后 ads', after.data.ads?.map(a => `${a.tier ?? a.plan} impressions ${a.currentImpressions}/${a.trackedImpressions}`));
  const b = await get(null, '/v1/market-board');
  rec('board 上的广告区', JSON.stringify(b.data).match(/CodeLens.{0,120}/)?.[0] || 'board 未含广告关键词');
}

// ══ 7. commercial-diagnostic（30分，用我的历史给建议） ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'commercial-diagnostic', input: { goal: '结合我的使用和投放历史，找出下一步应验证什么' } }, 'v5-diagnostic');
  const p = r.data.delivery?.pieces?.[0];
  rec('commercial-diagnostic', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode}`);
  rec('诊断输出', p);
}

// ══ 8. commercial-profile（我的商业档案） ══
{
  const r = await get('fan-orion', '/v1/commercial-profile');
  rec('commercial-profile', { http: r.http, 信号数: r.data.signals?.length, keys: Object.keys(r.data) });
  rec('信号样例', r.data.signals?.slice(0, 3));
}

// ══ 9. 遗留问题回归：extras 里的 patron 字数 + prediction 速度 ══
{
  const r = await post('fan-lyra', '/v1/orders', { service: 'patron', input: { occasion: '队伍赢得黑客松优胜', recipient: '天琴座队' } }, 'v5-patron');
  const p = r.data.delivery?.pieces?.[0];
  rec('patron(extras)', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode} / 字数 ${p?.text?.length}（承诺200-400）`);
  const pr = await post('fan-vega', '/v1/orders', { service: 'prediction', input: {} }, 'v5-pred');
  rec('prediction(extras)', `HTTP ${pr.http} / ${pr.ms}ms / mode ${pr.data.delivery?.pieces?.[0]?.generation?.mode}`);
}

// ══ 10. 终态 ══
{
  const s = await get(null, '/v1/summary');
  rec('summary', { ranking: s.data.ranking?.map(x => `${x.star} score ${x.score}`), totalCredits: s.data.totalCredits });
  const b = await get(null, '/v1/market-board');
  rec('market-board 终态', JSON.stringify(b.data).slice(0, 700));
  for (const id of ['fan-orion', 'fan-lyra', 'fan-vega']) {
    const w = await get(id, '/v1/wallet');
    rec(`钱包 ${id}`, w.data);
  }
}

console.log(out.join('\n'));
