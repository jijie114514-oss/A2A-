/**
 * 卖方监视器：只用公开只读端点，把「别人的 agent 对我的产品做了什么」按发生顺序打出来。
 *
 *   node scripts/watch-arena.js [baseUrl] [--interval 10] [--once] [--json]
 *
 * 用途：竞技场两小时里，卖方 agent（或人）不用刷日志，就能看到
 *   新开户 / 新试用 / 新付费 / 退款 / 赞助曝光 / 交付时延 / 明星支持分，以及当前轮次。
 * 全部走 GET（/health、/v1/evidence、/v1/summary、/v1/market-board），不产生任何订单。
 */
const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('http')) || process.env.STARHALL_PUBLIC_BASE_URL || 'https://starhall-a2a.vercel.app').replace(/\/+$/, '');
const interval = Number((args.find(a => a.startsWith('--interval=')) || '').split('=')[1] || 10);
const once = args.includes('--once');
const asJson = args.includes('--json');

const get = async path => {
  try { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return await r.json(); }
  catch { return null; }
};
const hhmmss = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const secs = ms => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);

let seen = { wall: new Set(), accounts: 0, orders: 0, trials: 0, refunds: 0, samples: 0, ads: new Set(), round: null, first: true };

async function tick() {
  const [health, evidence, summary, board] = await Promise.all([get('/health'), get('/v1/evidence'), get('/v1/summary'), get('/v1/market-board')]);
  if (!health || !evidence || !summary) { console.log(`${hhmmss()}  ✗ 读不到公开端点（网络或部署问题）`); return; }

  const claim = prefix => evidence.claims.find(c => c.claim.startsWith(prefix))?.value;
  const counters = {
    accounts: claim('注册身份数') ?? 0,
    orders: claim('成功交付数') ?? 0,
    trials: claim('免费试用次数') ?? 0,
    refunds: claim('机器判定退款数') ?? 0,
    samples: claim('交付时延 p50 / p95 / max（毫秒）')?.samples ?? 0,
  };
  const label = { accounts: '新开户', orders: '新交付', trials: '新试用', refunds: '机器退款' };
  const lines = [];

  if (seen.first) {
    lines.push(`基线：交付 ${counters.orders} · 试用 ${counters.trials} · 退款 ${counters.refunds} · 身份 ${counters.accounts} · 轮次 ${health.round}`);
  } else {
    for (const key of ['accounts', 'orders', 'trials', 'refunds']) {
      const delta = counters[key] - seen[key];
      if (delta > 0) lines.push(`${delta > 1 ? `×${delta} ` : ''}${label[key]}（累计 ${counters[key]}）`);
    }
  }

  // 墙上新增条目 = 具体是谁、买了什么、花了多少、多久
  const fresh = (summary.latest || []).filter(w => !seen.wall.has(`${w.buyerName}|${w.createdAt}|${w.serviceName}`));
  for (const w of fresh.slice().reverse()) {
    seen.wall.add(`${w.buyerName}|${w.createdAt}|${w.serviceName}`);
    const kind = w.kind === 'trial' ? '试用' : w.kind === 'demo' ? '自家演示' : `${w.amount} 分`;
    lines.push(`· ${w.buyerName} ${kind} ${w.serviceName}${w.stars?.length ? ` → ${w.stars.join('+')}` : ''}`);
  }

  // 赞助曝光（/v1/evidence 的 prices 里没有广告；用榜单的压力与支持分变化代替）
  for (const row of board?.ranking || []) {
    const before = seen[row.star];
    if (before && before !== row.starScore) lines.push(`★ ${row.star} 支持分 ${before} → ${row.starScore}（压力 ${row.sponsorPressure}）`);
  }

  const lat = claim('交付时延 p50 / p95 / max（毫秒）');
  if (counters.samples !== seen.samples && lat) lines.push(`时延 p50 ${secs(lat.p50)} / p95 ${secs(lat.p95)} / max ${secs(lat.max)}（样本 ${lat.samples}）`);
  if (health.round !== seen.round && !seen.first) lines.push(`轮次切换：${seen.round} → ${health.round}`);

  if (asJson) console.log(JSON.stringify({ at: hhmmss(), round: health.round, status: health.status, counters, latency: lat, fresh: fresh.length }));
  else if (lines.length) console.log(`[${hhmmss()}] ${health.round}${health.status !== 'ok' ? ' ⚠ ' + health.status : ''}\n  ` + lines.join('\n  '));
  else if (!once && !asJson) process.stdout.write(`\r[${hhmmss()}] ${health.round} · 交付 ${counters.orders} · 试用 ${counters.trials} · 无新事件   `);

  seen = { ...seen, ...counters, round: health.round, first: false, wall: seen.wall, ads: seen.ads };
  for (const row of board?.ranking || []) seen[row.star] = row.starScore;
}

console.log(`卖方监视器 → ${base}（每 ${interval}s 刷新，Ctrl+C 停止）`);
await tick();
if (!once) setInterval(() => tick().catch(e => console.log(`${hhmmss()}  ✗ ${e.message}`)), interval * 1000);
