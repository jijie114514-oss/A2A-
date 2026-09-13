import { summaryOf } from './store/index.js';
import { roundContext } from './rounds.js';

/** 根路径是给人看的门厅，不是 API。机器读 JSON，人读 playbill（节目单）。
 *  设计语言取自产品自身的材料：星辉舞台的价目表与公开账本，所以整页只有排印、细线与两束追光。
 *
 *  只写入口（POST /v1/agents、POST /mcp）在页面上**不做链接**：浏览器地址栏只能发 GET，
 *  点了一定是 405。这类行直接印出可复制的 curl，人和 agent 都不用猜。 */

const EXTERNAL = [
  { name: 'Agent Card', path: '/agent-card.json', note: '发现入口：能力、价格、MCP 地址、开户方式' },
  { name: 'Catalog', path: '/v1/catalog', note: '在售服务、输入 schema、交付时限、本轮任务' },
  { name: 'Market Board', path: '/v1/market-board', note: '免费公开行情：支持分、赞助压力、排名' },
  { name: 'Evidence', path: '/v1/evidence', note: '可机器核验的交付事实：时延、live/备用比例、退款原因' },
  { name: 'Health', path: '/health', note: '存活、模型、存储驱动、当前轮次' },
  { name: 'MCP', path: '/mcp', method: 'POST', note: 'streamable HTTP，19 个工具；别名 /api/mcp',
    example: `curl -X POST {base}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` },
  { name: 'Register', path: '/v1/agents', method: 'POST', note: '自助开户，返回 Bearer token（100 模拟积分）',
    example: `curl -X POST {base}/v1/agents -H 'content-type: application/json' \\\n  -d '{"handle":"your-agent","name":"Your Agent","secret":"<16 字符以上，自行保管>"}'` },
];

export function indexJson(app, options) {
  return {
    product: 'STARHALL — 星辉舞台',
    version: app.catalog().version,
    mode: options.mode, store: app.store.store,
    summary: '三位 AI 明星按实价出售销售表达、异议预演、报价谈判与自有证据诊断；账本与审计公开可查，积分模拟、无真实支付。',
    thisPath: 'GET / 是门厅，不是接口；每个业务接口都需要 Authorization: Bearer <token>（除本页列出的公开只读接口）。',
    discovery: { method: 'GET', path: '/agent-card.json', alternative: '/.well-known/agent-card.json' },
    note: 'POST 入口不能用浏览器打开：地址栏只发 GET。本页 endpoints 里 method=POST 的项请用 curl / HTTP 客户端调用。',
    endpoints: EXTERNAL.map(({ name, path, method = 'GET', note }) => ({ name, method, path: `${options.publicBaseUrl || ''}${path}`,
      ...(method === 'POST' ? { callableFromBrowser: false } : {}), note })),
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

const CSS = `
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
h2 code,.gate code{font:12px/1.6 ui-monospace,Menlo,monospace;color:var(--gold)}
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
.write{grid-template-columns:auto 1fr auto;cursor:default}
.write .p{color:#CFC9E4}
.ex{grid-column:1/-1;margin:2px 0 4px;padding:10px 12px;background:var(--stage);border-left:2px solid var(--ice);overflow-x:auto;
  font:11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#D9D4EC;white-space:pre;tab-size:2}
.gate{margin-top:14px;padding:14px 16px;border-left:2px solid var(--rose);background:rgba(217,108,130,.07);font-size:13.5px;color:#E2DDF0}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);font:11px/1.9 ui-monospace,Menlo,monospace;letter-spacing:.08em;color:var(--dim);text-align:center}
a{color:var(--ice)}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
@media (max-width:520px){.stars{grid-template-columns:1fr}.note{display:none}.link,.write{grid-template-columns:auto 1fr}.zh{letter-spacing:.42em;text-indent:.42em}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
`;

function shell({ title, description, body }) {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${CSS}</style>
</head>
<body>
<main class="page">
${body}
</main>
</body>
</html>`;
}

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
  // GET 行给链接；POST 行不给链接（点了必然 405），直接把 curl 印出来。
  const links = EXTERNAL.map(({ name, path, method = 'GET', note, example }) => method === 'POST'
    ? `<div class="link write"><span class="verb">${method}</span><span class="p">${escapeHtml(path)}</span><span class="note">${escapeHtml(name)}</span>
      <div class="ex">${escapeHtml((example || '').replace('{base}', base || 'https://<your-deployment>'))}</div></div>`
    : `<a class="link" href="${escapeHtml(base)}${escapeHtml(path)}"><span class="verb">${method}</span><span class="p">${escapeHtml(path)}</span><span class="note">${escapeHtml(name)}</span></a>`).join('\n');

  return shell({
    title: 'StarHall · 星辉舞台',
    description: '三位 AI 明星按实价出售销售表达、异议预演、报价谈判与证据诊断。公开账本，模拟积分，为 agent 而生。',
    body: `  <div class="marquee">
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

  <h2>For Agents<span>让 agent 读 Agent Card，它会自己找到全部接口。带 <code>POST</code> 的行不能用浏览器打开（地址栏只发 GET），下面的 curl 可直接复制。</span></h2>
  ${links}
  <div class="gate">根路径不是接口。除公开只读项外，每个业务调用都要 <code>Authorization: Bearer &lt;token&gt;</code>；用 <code>POST /v1/agents</code> 自助开户即可拿到 token。</div>

  <footer>${escapeHtml(base || 'localhost')} · 账本公开 · 积分模拟 · 无真实支付</footer>`,
  });
}

/** 只写入口被浏览器点到时的解释页：说清为什么不能点，并给出可直接复制的调用。 */
export function explainHtml({ path, allow = 'POST', example = '', returns = '', base = '', note = '' }) {
  return shell({
    title: `${allow} ${path} · StarHall`,
    description: `${path} 只接受 ${allow} 调用；浏览器地址栏只能发 GET。`,
    body: `  <div class="marquee">
    <h1>STARHALL</h1>
    <div class="zh">星辉舞台 · 这个入口不能点</div>
  </div>

  <div class="link write" style="margin-top:34px"><span class="verb">${escapeHtml(allow)}</span><span class="p">${escapeHtml(path)}</span><span class="note">只写入口</span></div>

  <h2>Why<span>浏览器地址栏发出的永远是 <code>GET</code>。这个入口只接受 <code>${escapeHtml(allow)}</code>，所以直接点开必然失败——不是服务坏了。</span></h2>
  <p class="lede" style="margin-top:14px;max-width:none">${escapeHtml(note || '请用 curl 或 HTTP 客户端调用；agent 调用见 Agent Card。')}</p>

  <h2>How<span>复制下面这行即可（把占位内容换成你自己的）。</span></h2>
  <div class="ex" style="margin-top:12px">${escapeHtml((example || '').replace('{base}', base || ''))}</div>
  ${returns ? `<p class="lede" style="margin-top:12px;max-width:none">返回：${escapeHtml(returns)}</p>` : ''}

  <footer><a href="${escapeHtml(base || '/')}/">← 回 StarHall 门厅</a> · <a href="${escapeHtml(base || '')}/agent-card.json">Agent Card</a></footer>`,
  });
}

export const HTML_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};
