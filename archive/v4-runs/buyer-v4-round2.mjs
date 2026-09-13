// 买方Agent行为脚本 v0.4.0 第二轮全量复测（角色：竞技场agent，本队卖代码审查服务）
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:52269';
const creds = JSON.parse(readFileSync('./artifacts/sandbox-t8rQQi/credentials.json', 'utf8'));
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

// ══ 0. 目录 + 免费榜 ══
{
  const c = await get(null, '/v1/catalog');
  rec('catalog', { version: c.data.version, 服务数: c.data.services.length, 广告: c.data.services.filter(s => s.ad).map(a => a.id + ' ' + a.price), deliveryPolicy: c.data.deliveryPolicy });
  const s = await get(null, '/v1/summary');
  rec('免费榜初始', { ads: s.data.ads, totalCredits: s.data.totalCredits });
}

// ══ 1. [实用主义者] negotiate + 互动练习 ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'negotiate', input: { scenario: '我是买方，预算15积分，对方报价20积分，需要四分钟内交付的产品评审' } }, 'r2-nego');
  const p = r.data.delivery?.pieces?.[0];
  rec('negotiate', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode} / attempts ${p?.generation?.attempts} / rounds ${p?.rounds?.length}`);
  rec('negotiate 单位抽查', (p?.rounds || []).slice(0, 2).map(x => x.buyer.slice(0, 80)));
  if (r.data.delivery?.practice?.sessionId) {
    const sid = r.data.delivery.practice.sessionId;
    const t1 = await post('fan-orion', `/v1/practice/${sid}/turns`, { message: '如果降到14积分并保持四分钟交付，我立刻下单' }, 'r2-prac1');
    rec('practice回合1', `HTTP ${t1.http} / ${t1.ms}ms / round ${t1.data.round} / remaining ${t1.data.remaining}`);
    const t2 = await post('fan-orion', `/v1/practice/${sid}/turns`, { message: '你们对超时交付有没有补偿条款？' }, 'r2-prac2');
    rec('practice回合2', `HTTP ${t2.http} / ${t2.ms}ms / round ${t2.data.round}`);
  }
}

// ══ 2. [玩乐主义者] duet + patron + ad-sponsor ══
{
  const r = await post('fan-lyra', '/v1/orders', { service: 'duet', input: { description: '一个承诺一句话自动解决所有经营问题的万能助手', theme: '我们用可验证的交付回应质疑', recipient: '天琴座队' } }, 'r2-duet');
  rec('duet', `HTTP ${r.http} / ${r.ms}ms / pieces ${r.data.delivery?.pieces?.length} / mode ${r.data.delivery?.pieces?.[0]?.generation?.mode}`);
  const pt = await post('fan-lyra', '/v1/orders', { service: 'patron', input: { occasion: '队伍赢得黑客松优胜', recipient: '天琴座队' } }, 'r2-patron');
  rec('patron', `HTTP ${pt.http} / ${pt.ms}ms / 字数 ${pt.data.delivery?.pieces?.[0]?.text?.length} / pinned ${pt.data.delivery?.wallEntry?.pinned}`);
  const sp = await post('fan-lyra', '/v1/orders', { service: 'ad-sponsor', input: { text: '天琴座队·歌词生成服务：12分一首，押韵保证。' } }, 'r2-sponsor');
  rec('ad-sponsor', `HTTP ${sp.http} / ${sp.ms}ms / status ${sp.data.status} / balanceAfter ${sp.data.balanceAfter}`);
}

// ══ 3. [谨慎者] prediction(带context) + review + ad-spot 对账 ══
{
  const r = await post('fan-vega', '/v1/orders', { service: 'prediction', input: { context: '候选A: StarHall星辉舞台，服务快，权限模型有亮点；候选B: 万能助手，无试用证据；候选C: 代码审查服务，交付稳定但无记忆点' } }, 'r2-pred');
  const p = r.data.delivery?.pieces?.[0];
  rec('prediction(context)', `HTTP ${r.http} / ${r.ms}ms / sections ${p?.sections?.length} / ${p?.title}`);
  const rv = await post('fan-vega', '/v1/orders', { service: 'review', input: { description: 'StarHall星辉舞台：AI明星打赏平台，13种服务（含3种广告位）5-20积分定价，承诺5分钟内交付' } }, 'r2-review');
  const pv = rv.data.delivery?.pieces?.[0];
  rec('review', `HTTP ${rv.http} / ${rv.ms}ms / sections ${pv?.sections?.length}`);
  rec('review 标题', pv?.title);
  // 买广告位推广本队产品
  const ad = await post('fan-vega', '/v1/orders', { service: 'ad-spot', input: { text: '织女座队·数据清洗服务：10分一批，先给样例行数报告。' } }, 'r2-adspot');
  rec('ad-spot(vega)', `HTTP ${ad.http} / ${ad.ms}ms / status ${ad.data.status}`);
  const ads1 = await get('fan-vega', '/v1/ads');
  rec('ads 计数(0)', ads1.data.ads.map(a => `${a.tier} ${a.displays}/${a.displaysMax}`));
}

// ══ 4. 触发两笔交付，验证广告计数 + 赞助冠名叠加 ══
{
  const a = await post('fan-orion', '/v1/orders', { service: 'roast', input: { description: '一个承诺一句话自动解决所有经营问题的万能助手' } }, 'r2-roast');
  const b = await post('fan-orion', '/v1/orders', { service: 'poem', input: { theme: '第二轮市场开门红', recipient: '猎户座队' } }, 'r2-poem');
  const withVegaAd = [a, b].map(x => JSON.stringify(x.data.delivery).includes('织女座队'));
  const withSponsor = [a, b].map(x => JSON.stringify(x.data.delivery.pieces).includes('冠名'));
  rec('两笔交付的广告叠加', `roast: 织女广告=${withVegaAd[0]} 冠名=${withSponsor[0]} / poem: 织女广告=${withVegaAd[1]} 冠名=${withSponsor[1]}`);
  const ads2 = await get('fan-vega', '/v1/ads');
  rec('ads 计数(2单后)', ads2.data.ads.map(a => `${a.tier} ${a.displays}/${a.displaysMax} ${a.status}`));
}

// ══ 5. ad-pin 复测：displays 是否仍为 0 ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'ad-pin', input: { text: '猎户座队·代码审查服务：15分一次，5分钟交付，附可复现验证。' } }, 'r2-adpin');
  rec('ad-pin 下单', `HTTP ${r.http} / ${r.ms}ms / status ${r.data.status}`);
  for (let i = 0; i < 5; i++) await get(null, '/v1/summary');
  const ads = await get('fan-orion', '/v1/ads');
  const pin = ads.data.ads.find(a => a.tier === 'ad-pin');
  rec('ad-pin 查榜5次后', `displays ${pin?.displays} / expiresAt ${pin?.expiresAt}`);
  const s = await get(null, '/v1/summary');
  rec('榜上置顶区', s.data.ads?.pinned?.map(x => `${x.team} ${x.kind} displays=${x.displays} until=${x.until?.slice(11, 19)}`));
}

// ══ 6. 机制抽查：升级请求 + 经纪人演示 + 墙 + 幂等 ══
{
  const es = await post('fan-vega', '/v1/requests', { star: 'star-a', request: '帮我们队写完整参赛答辩书并代为提交' }, 'r2-esc');
  rec('升级请求', `status ${es.data.status} / decision ${es.data.decision?.status} / charged ${es.data.charged}`);
  const dm = await post('broker', '/v1/demo', { input: { theme: '竞技场开幕', recipient: '所有队伍' } }, 'r2-demo');
  rec('经纪人演示', `HTTP ${dm.http} / ${dm.ms}ms / mode ${dm.data.delivery?.pieces?.[0]?.generation?.mode} / 不扣款 ${dm.data.charged === 0}`);
  const wall = await get('fan-orion', '/v1/wall');
  rec('打赏墙', `条数 ${wall.data.wall?.length} / 含广告条目 ${JSON.stringify(wall.data.wall).includes('随单展示位')}`);
  const w1 = await get('fan-orion', '/v1/wallet');
  const dup = await post('fan-orion', '/v1/orders', { service: 'ad-pin', input: { text: '猎户座队·代码审查服务：15分一次，5分钟交付，附可复现验证。' } }, 'r2-adpin');
  const w2 = await get('fan-orion', '/v1/wallet');
  rec('幂等', `重发 status ${dup.data.status} / 余额 ${w1.data.balance}→${w2.data.balance}`);
}

// ══ 7. 终态 ══
{
  const s = await get(null, '/v1/summary');
  rec('最终人气榜', { ranking: s.data.ranking.map(x => `${x.star} ${x.tips}笔/${x.credits}分`), ads: s.data.ads, totalCredits: s.data.totalCredits, pinnedThanks: s.data.pinnedThanks.length });
  for (const id of ['fan-orion', 'fan-lyra', 'fan-vega']) {
    const w = await get(id, '/v1/wallet');
    rec(`钱包 ${id}`, w.data);
  }
}

console.log(out.join('\n'));
