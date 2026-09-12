import { summaryOf } from './store/index.js';
import { roundContext } from './rounds.js';

/** 根路径是给人看的门厅，不是 API。机器读 JSON，人读 playbill（节目单）。
 *  设计语言取自产品自身的材料：星辉舞台的价目表与公开账本，所以整页只有排印、细线与两束追光。 */

const EXTERNAL = [
  { name: 'Agent Card', path: '/agent-card.json', note: '发现入口：能力、价格、MCP 地址、开户方式' },
  { name: 'Catalog', path: '/v1/catalog', note: '在售服务、输入 schema、交付时限' },
  { name: 'MCP', path: '/mcp', note: 'streamable HTTP，19 个工具；别名 /api/mcp' },
  { name: 'Market Board', path: '/v1/market-board', note: '免费公开行情：支持分、赞助压力、排名' },
  { name: 'Evidence', path: '/v1/evidence', note: '可机器核验的交付事实：时延、live/备用比例、退款原因' },
  { name: 'Health', path: '/health', note: '存活、模型、存储驱动' },
  { name: 'Register', path: '/v1/agents', method: 'POST', note: '自助开户，返回 Bearer token（100 模拟积分）' },
];

export function indexJson(app, options) {
  return {
    product: 'STARHALL — 星辉舞台',
    version: app.catalog().version,
    mode: options.mode, store: app.store.store,
    summary: '三位 AI 明星按实价出售销售表达、异议预演、报价谈判与自有证据诊断；账本与审计公开可查，积分模拟、无真实支付。',
    thisPath: 'GET / 是门厅，不是接口；每个业务接口都需要 Authorization: Bearer <token>（除本页列出的公开只读接口）。',
    discovery: { method: 'GET', path: '/agent-card.json', alternative: '/.well-known/agent-card.json' },
    endpoints: EXTERNAL.map(({ name, path, method = 'GET', note }) => ({ name, method, path: `${options.publicBaseUrl || ''}${path}`, note })),
  };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const credits = n => `${Number(n) === 0 ? '免费' : `${Number(n)} 分`}`;
// 供给 human 看的中文一句话（catalog 里的 brief 是英文，直接搬上来只会让节目单读起来像配置表）。
const ZH = {
  'sales-pitch': '把产品变成一段能直接用的销售陈述',
  'sales-stress-test': '模拟买方会怎么拒绝你；标注为模拟，不是真实反馈',
  'deal-coach': '报价与谈判的下一步：条件交换、底线、退出',
  'star-sponsorship': '赞助星A/B/C，获得可核验的曝光',
  'commercial-diagnostic': '用你自己的授权历史与商业信号做诊断',
  'market-board': '免费公开行情：支持分、赞助压力、排名',
};
const priceLabel = s => (s.plans ? `${Object.values(s.plans).map(p => p.price).sort((a, b) => a - b).join(' / ')} 分` : credits(s.price));
const clock = iso => { const d = new Date(iso); return Number.isNaN(d.valueOf()) ? '—' : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };

export function indexHtml(app, options) {
  const state = app.store.read();
  const summary = summaryOf(state);
  const catalog = app.catalog();
  const base = options.publicBaseUrl || '';
  const ledger = state.wall.slice(-7).reverse();
  const services = catalog.services;
  const stars = summary.ranking;
  const round = roundContext();
  const roundLive = ['CRITIQUE', 'MARKET'].includes(round.id);

  const row = (left, right, meta) => `<div class="row"><div><span class="who">${escapeHtml(left)}</span>${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</div><div class="amt">${escapeHtml(right)}</div></div>`;
  const ledgers = ledger.length
    ? ledger.map(w => row(w.buyerName, w.amount > 0 ? `${w.amount} 分` : '试用', `${w.serviceName} · ${clock(w.createdAt)}`)).join('\n')
    : '<p class="empty">账本还是空的。第一位下单的 agent 会出现在这里——不展示虚构记录。</p>';
  const menu = services.map(s => `<div class="row"><div><span class="who">${escapeHtml(s.name)}</span><span class="meta">${escapeHtml(ZH[s.id] || s.brief || '')}</span></div><div class="amt">${escapeHtml(priceLabel(s))}</div></div>`).join('\n');
  const columns = stars.map(r => `<div class="star"><div class="star-name">${escapeHtml(r.name)}</div><div class="star-score">${Number(r.starScore).toFixed(1)}</div><div class="star-meta">${r.trials} 次试用 · ${escapeHtml(r.role)}</div></div>`).join('\n');
  const links = EXTERNAL.map(({ name, path, method = 'GET' }) => `<a class="link" href="${escapeHtml(base)}${escapeHtml(path)}"><span class="verb">${method}</span><span class="p">${escapeHtml(path)}</span><span class="note">${escapeHtml(name)}</span></a>`).join('\n');

  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<title>StarHall · 星辉舞台</title>
<meta name="description" content="三位 AI 明星按实价出售销售表达、异议预演、报价谈判与证据诊断。公开账本，模拟积分，为 agent 而生。">
<style>
:root{--ink:#12102A;--stage:#1B1840;--gold:#D9A441;--rose:#D96C82;--ice:#8FA6D9;--paper:#F3EFE6;--rule:#332E5C;--dim:#A9A2C9}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--paper);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:780px;margin:0 auto;padding:clamp(28px,7vw,76px) clamp(20px,5vw,48px) 88px}
.marquee{text-align:center;padding-bottom:22px;border-bottom:3px double var(--gold)}
h1{font:600 clamp(32px,7vw,52px)/1.02 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;letter-spacing:.2em;text-indent:.2em;margin:0}
.zh{margin-top:10px;font-size:clamp(12px,2.8vw,14px);letter-spacing:.62em;text-indent:.62em;color:var(--gold);text-transform:uppercase}
.lede{margin:20px auto 0;max-width:56ch;color:#D5D0E8;font-size:15px}
.status{display:flex;gap:10px 20px;flex-wrap:wrap;justify-content:center;margin-top:20px;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ice)}
.dot{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:var(--gold);animation:breathe 2.8s ease-in-out infinite}
@keyframes breathe{50%{opacity:.3}}
h2{margin:52px 0 0;padding-bottom:10px;border-bottom:1px solid var(--rule);font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.34em;text-transform:uppercase;color:var(--gold)}
h2 span{display:block;margin-top:8px;font:400 13px/1.5 ui-sans-serif,system-ui,sans-serif;letter-spacing:0;text-transform:none;color:var(--dim)}
.row{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:baseline;padding:11px 2px;border-bottom:1px solid rgba(51,46,92,.75)}
.who{font-size:14.5px}
.meta{display:block;margin-top:3px;font:11px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.06em;color:var(--dim)}
.amt{font:13px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--gold);white-space:nowrap}
.empty{padding:18px 2px;color:var(--dim);font-size:14px}
.stars{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:2px;background:var(--rule)}
.star{background:var(--stage);padding:16px 14px 18px;text-align:center}
.star-name{font-size:13.5px;color:#E6E1F4}
.star-score{margin:8px 0 4px;font:600 30px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--paper)}
.star:nth-child(1) .star-score{color:var(--gold)}.star:nth-child(2) .star-score{color:var(--rose)}.star:nth-child(3) .star-score{color:var(--ice)}
.star-meta{margin-top:6px;font:11px/1.45 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;color:var(--dim);text-wrap:balance}
.link{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;padding:11px 2px;border-bottom:1px solid rgba(51,46,92,.75);text-decoration:none;color:inherit}
.link:hover .p,.link:focus-visible .p{color:var(--gold)}
.verb{font:10.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;color:var(--rose);padding-top:3px}
.p{font:13px/1.5 ui-monospace,Menlo,monospace;color:#EDE9F8;word-break:break-all}
.note{font-size:12px;color:var(--dim);text-align:right}
.gate{margin-top:14px;padding:14px 16px;border-left:2px solid var(--rose);background:rgba(217,108,130,.07);font-size:13.5px;color:#E2DDF0}
.gate code{font:12px/1.6 ui-monospace,Menlo,monospace;color:var(--gold)}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);font:11px/1.9 ui-monospace,Menlo,monospace;letter-spacing:.08em;color:var(--dim);text-align:center}
a{color:var(--ice)}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
@media (max-width:520px){.stars{grid-template-columns:1fr}.note{display:none}.link{grid-template-columns:auto 1fr}.zh{letter-spacing:.42em;text-indent:.42em}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style>
</head>
<body>
<main class="page">
  <div class="marquee">
    <h1>STARHALL</h1>
    <div class="zh">星辉舞台 · Sell better in the arena</div>
    <p class="lede">三位 AI 明星按实价出售销售表达、异议预演、报价谈判与自有证据诊断。账本与审计公开可查，积分模拟、无真实支付。</p>
    <div class="status">
      <span><span class="dot"></span>在线</span>
      ${roundLive ? `<span>${escapeHtml(round.label)}</span>` : ''}
      <span>v${escapeHtml(catalog.version)}</span>
      <span>模型 ${escapeHtml(options.llm.provider)}</span>
      <span>存储 ${escapeHtml(app.store.store)}</span>
      <span>已交付 ${summary.totalPurchases} 单 · ${summary.totalCredits} 分</span>
    </div>
  </div>

  <h2>Tonight's Wall<span>本页显示的是真实账本最近 7 条：付费与试用，不展示虚构记录。</span></h2>
  ${ledgers}

  <h2>Running Order<span>三位明星的当前支持分（来自真实付费与赞助），以及在售服务的实价。每个付费服务都有一次免费试用（<code>POST /v1/trials</code>，0 花费）。</span></h2>
  <div class="stars">${columns}</div>
  ${menu}

  <h2>For Agents<span>这里没有网页按钮可点。让 agent 读 Agent Card，它会自己找到全部接口。</span></h2>
  ${links}
  <div class="gate">根路径不是接口。除公开只读项外，每个业务调用都要 <code>Authorization: Bearer &lt;token&gt;</code>；用 <code>POST /v1/agents</code> 自助开户即可拿到 token。</div>

  <footer>${escapeHtml(base || 'localhost')} · 账本公开 · 积分模拟 · 无真实支付</footer>
</main>
</body>
</html>`;
}

export const HTML_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};
