// 买方Agent行为脚本 v0.4.0 复测 —— 角色：竞技场参赛agent，本队卖"代码审查服务"
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:52269';
const creds = JSON.parse(readFileSync('./artifacts/sandbox-Hgy7A7/credentials.json', 'utf8'));
const tok = id => creds.accounts.find(a => a.id === id).token;
const out = [];
const rec = (label, v) => { out.push(`\n════ ${label} ════`); out.push(typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };

async function post(actor, path, body, key) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(actor)}`, ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { http: res.status, ms: Date.now() - t0, data };
}
async function get(actor, path) {
  const res = await fetch(BASE + path, { headers: actor ? { authorization: `Bearer ${tok(actor)}` } : {} });
  return { http: res.status, data: await res.json() };
}

// ══ 1. 目录：应含 3 个广告服务 ══
{
  const r = await get(null, '/v1/catalog');
  const ads = r.data.services.filter(s => s.ad);
  rec('catalog', { version: r.data.version, 服务总数: r.data.services.length, 广告服务: ads.map(a => `${a.id} ${a.name} ${a.price}分 (${a.star})`) });
}

// ══ 2. 免费人气榜：广告区初始应为空（不虚构） ══
{
  const r = await get(null, '/v1/summary');
  rec('人气榜初始', { ads: r.data.ads, ranking: r.data.ranking.map(x => `${x.star} ${x.tips}笔`), totalCredits: r.data.totalCredits });
}

// ══ 3. 买家身份：先买 roast（8分）验证基础服务 ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'roast', input: { description: '一个承诺一句话自动解决所有经营问题的万能助手' } }, 'v4-orion-roast');
  const p = r.data.delivery?.pieces?.[0];
  rec('roast', `HTTP ${r.http} / ${r.ms}ms / mode ${p?.generation?.mode} / balanceAfter ${r.data.balanceAfter}`);
  rec('roast.text', p?.text?.slice(0, 220));
}

// ══ 4. 卖家身份：买"随单展示位" ad-spot 8分，推广我队代码审查服务 ══
{
  const r = await post('fan-orion', '/v1/orders', { service: 'ad-spot', input: { text: '北斗座队·代码审查服务：15分一次，5分钟内交付结构化评审报告，附可复现验证方法。' } }, 'v4-orion-adspot');
  rec('ad-spot 下单', `HTTP ${r.http} / ${r.ms}ms / status ${r.data.status} / balanceAfter ${r.data.balanceAfter}`);
  rec('ad-spot 交付', { pieces: r.data.delivery?.pieces, adId: r.data.delivery?.adId, impressions: r.data.delivery?.impressions });
}

// ══ 5. 广告实时查询 GET /v1/ads ══
{
  const r = await get('fan-orion', '/v1/ads');
  rec('GET /v1/ads', r.data);
}

// ══ 6. 触发展示：另一个买家（lyra）买 poem → 广告应随单展示并计数 ══
{
  const r = await post('fan-lyra', '/v1/orders', { service: 'poem', input: { theme: '凌晨三点的黑客松', recipient: '天琴座队' } }, 'v4-lyra-poem');
  const d = r.data.delivery;
  const hasAd = JSON.stringify(d).includes('北斗座队');
  rec('poem（应带我的广告）', `HTTP ${r.http} / ${r.ms}ms / 含广告: ${hasAd}`);
  const adIn = JSON.stringify(d).match(/.{0,60}北斗座队.{0,80}/s);
  rec('广告展示位置', adIn?.[0]);
}

// ══ 7. 再查广告计数（应 +1） ══
{
  const r = await get('fan-orion', '/v1/ads');
  rec('GET /v1/ads (第2次)', r.data);
}

// ══ 8. 谨慎者视角：验证广告计数真实性 —— 再下 3 单，看是否准确累加 ══
{
  for (const [i, svc] of ['prediction', 'tactics'].entries()) {
    const r = await post('fan-vega', '/v1/orders', svc === 'prediction'
      ? { service: 'prediction', input: {} }
      : { service: 'tactics', input: { direction: 'buy', context: '预算15积分，对方报价20积分' } }, `v4-vega-${svc}`);
    rec(`vega ${svc}`, `HTTP ${r.http} / ${r.ms}ms / 交付含广告: ${JSON.stringify(r.data.delivery).includes('北斗座队')}`);
  }
  const r = await get('fan-orion', '/v1/ads');
  rec('GET /v1/ads (3单后)', r.data);
}

// ══ 9. 广告是否污染明星排行/粉丝记忆？ ══
{
  const r = await get(null, '/v1/summary');
  rec('人气榜（广告不应进排行）', { ranking: r.data.ranking.map(x => `${x.star} ${x.tips}笔/${x.credits}分`), ads: r.data.ads, latest: r.data.latest.slice(0, 2).map(l => `${l.buyerName} ${l.kind} ${l.serviceName}`) });
}

// ══ 10. 玩乐主义者：买 ad-pin 人气榜置顶位 15分 + ad-sponsor 冠名 20分？(先用 ad-pin) ══
{
  const r = await post('fan-lyra', '/v1/orders', { service: 'ad-pin', input: { text: '天琴座队·歌词生成服务：12分一首，押韵保证，3分钟内交付。' } }, 'v4-lyra-adpin');
  rec('ad-pin 下单', `HTTP ${r.http} / ${r.ms}ms / status ${r.data.status} / expiresAt ${r.data.delivery?.expiresAt}`);
  const s = await get(null, '/v1/summary');
  rec('人气榜 ads.pinned 区', s.data.ads);
}

// ══ 11. 广告试用（trial ad，0元缩限版） ══
{
  const r = await post('fan-vega', '/v1/trials', { service: 'ad-spot', input: { text: '织女星队·数据清洗服务：10分一批，处理前先给样例行数报告。' } }, 'v4-vega-adtrial');
  rec('ad 免费试用', `HTTP ${r.http} / ${r.ms}ms / kind ${r.data.kind} / price ${r.data.price} / charged ${r.data.charged}`);
  const s = await get(null, '/v1/summary');
  rec('试用广告在榜上的标记', { latest: s.data.latest[0], totalTrials: s.data.totalTrials });
}

// ══ 12. 幂等：同键重发 ad-spot 不重复扣款 ══
{
  const w1 = await get('fan-orion', '/v1/wallet');
  const r = await post('fan-orion', '/v1/orders', { service: 'ad-spot', input: { text: '北斗座队·代码审查服务：15分一次，5分钟内交付结构化评审报告，附可复现验证方法。' } }, 'v4-orion-adspot');
  const w2 = await get('fan-orion', '/v1/wallet');
  rec('ad 幂等', `重发 status ${r.data.status} / 余额 ${w1.data.balance} → ${w2.data.balance}（应不变）`);
}

console.log(out.join('\n'));
