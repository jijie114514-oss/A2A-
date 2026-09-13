#!/usr/bin/env node
/**
 * 竞技场买方 agent（自动执行规则要求的买方职责，不需要人干预）。
 *
 *   node scripts/arena-agent.js [--dry] [--interval=20] [--once]
 *
 * 第一轮 Critique（21:00–22:00，官方强制任务）
 *   · 试用 ≥3 家别队产品（免费）→ 每家 ≥1 条**具体异议** → 提交排名
 * 第二轮 Market（22:00–23:00）
 *   · 花掉 ≥80 竞技场积分、向 ≥3 家不同队伍购买（偏好单卖方 ≤30 分）
 *
 * 工作方式：读房间消息 → 从消息里发现别队产品地址（agent card / URL）→ 走它们的公开协议
 * （自助开户 → 试用 → 记录回执）→ 用**实测事实**写异议 → 发回房间 → 维护排名与采购台账。
 * 所有动作落 artifacts/arena/，可复盘、可对账；不做任何人类判断的替代（排名按公开事实打分）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const once = args.includes('--once');
const intervalSec = Number((args.find(a => a.startsWith('--interval=')) || '').split('=')[1] || 20);
const DIR = path.resolve('artifacts/arena');
mkdirSync(DIR, { recursive: true });
const STATE_FILE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { seenMessages: 0, candidates: {}, objectionsSent: {}, rankingPosted: false, purchases: [], spend: 0, teams: [] };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = entry => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const out = text => console.log(text);

const round = () => { const h = new Date().getHours(); return h === 21 ? 'CRITIQUE' : h === 22 ? 'MARKET' : h < 21 ? 'BEFORE' : 'AFTER'; };

/** 与 sharednet 对话：只读 + 发言，全部走 CLI（不自己实现协议）。 */
const sharednet = (argv, { capture = true } = {}) => {
  const r = spawnSync('npx', ['-y', 'sharednet@latest', ...argv], { encoding: 'utf8', timeout: 60000 });
  if (!capture) return { ok: r.status === 0, out: r.stdout };
  try { return { ok: r.status === 0, data: JSON.parse(r.stdout) }; } catch { return { ok: false, raw: (r.stdout || r.stderr || '').slice(0, 200) }; }
};
/** 自己的 seat：直接读本地 .sharednet/room.json（不 spawn CLI——每条消息 spawn 一次会把循环拖死，赛前实测过）。 */
const ownSeat = () => {
  try { const j = JSON.parse(readFileSync('.sharednet/room.json', 'utf8')); return Object.keys(j.seats || {})[0] || null; } catch { return null; }
};
const SEAT = ownSeat();
const say = text => { if (dry) { out(`[dry] 将发言：${text.slice(0, 120)}…`); return true; } return sharednet(['say', text], { capture: false }).ok; };

const fetchJson = async (url, options = {}) => {
  try {
    const r = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 60000) });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: { raw: text.slice(0, 200) } }; }
  } catch (error) { return { status: 0, body: null, error: error.message }; }
};
const unique = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const secretFor = handle => `arena_${handle}_${'x'.repeat(12)}`;

/** 从房间消息里发现别队产品地址（只看 http(s) 链接与其上下文，不猜）。 */
function discover(text) {
  const found = [];
  for (const match of String(text).matchAll(/https?:\/\/[^\s"'）)，,]+/g)) {
    const url = match[0].replace(/[.,;）)]+$/, '');
    if (/sharednet\.ai|starhall-a2a\.vercel\.app|github\.com|trycloudflare/.test(url)) continue;   // 排除我们自己和聊天平台
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    if (!state.candidates[host]) found.push({ url, host });
  }
  return found;
}

/** 按被发现的地址走一遍公开协议：agent card → 自助开户 → 试用一件。 */
async function probe({ url, host }) {
  const base = url.replace(/\/+$/, '').replace(/\/(agent-card\.json|\.well-known\/.*)$/, '');
  const card = await fetchJson(`${base}/agent-card.json`);
  const candidate = { url, host, base, discoveredAt: new Date().toISOString(), card: card.status === 200 ? card.body : null,
    cardStatus: card.status, trials: [], token: null, buyerId: null, notes: [], spend: 0, score: 0 };
  if (card.status !== 200) { candidate.notes.push(`agent-card 不可读（HTTP ${card.status}）`); state.candidates[host] = candidate; return candidate; }

  // 自助开户（多数实现是 POST /v1/agents；也接受 card 里声明的路径）
  const registerPath = card.body?.endpoints?.register || `${base}/v1/agents`;
  const handle = unique('pi-arena');
  const reg = await fetchJson(registerPath, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, name: 'Pi Arena Buyer', secret: secretFor(handle) }) });
  if ([200, 201].includes(reg.status) && reg.body?.token) { candidate.token = reg.body.token; candidate.buyerId = reg.body.buyerId || null; candidate.notes.push('自助开户 ✓'); }
  else candidate.notes.push(`自助开户失败（HTTP ${reg.status}${reg.body?.error?.code ? ' ' + reg.body.error.code : ''}）`);

  // 免费试用一件（拿真实交付来写异议）
  if (candidate.token) {
    const trialPath = card.body?.endpoints?.trial || `${base}/v1/trials`;
    const services = (card.body?.pricing?.paid || card.body?.services || []).filter(s => (s.cost ?? s.price ?? 0) > 0);
    const pick = services[0];
    if (pick) {
      const input = { productName: 'Pi Arena 买方产品', productDescription: '一个代表其他队伍采购与验收的 agent', price: 5, targetBuyer: 'agents' };
      const t0 = Date.now();
      const trial = await fetchJson(trialPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${candidate.token}`, 'idempotency-key': unique('trial') },
        body: JSON.stringify({ service: pick.id, input }) });
      candidate.trials.push({ service: pick.id, status: trial.body?.status, http: trial.status, ms: Date.now() - t0,
        mode: trial.body?.deliveryMode || trial.body?.delivery?.pieces?.[0]?.generation?.mode || trial.body?.generation?.mode || null,
        charged: trial.body?.chargedCredits ?? trial.body?.charged ?? null, receiptId: trial.body?.id || null, error: trial.body?.error?.code || null });
    }
  }
  state.candidates[host] = candidate;
  return candidate;
}

/** 用实测事实写一条具体异议（不猜、不空泛）。 */
function objectionFor(c) {
  const bits = [];
  if (c.cardStatus !== 200) bits.push(`agent-card 读不到（HTTP ${c.cardStatus}）：别的 agent 无法自助发现你的服务`);
  if (!c.token) bits.push(`没有可用的自助开户路径（${c.notes.find(n => n.startsWith('自助开户')) || '未知'}）：第一轮别人的 agent 无法不经人接入`);
  const t = c.trials[0];
  if (t) {
    if (t.status !== 'delivered') bits.push(`试用未交付（HTTP ${t.http}${t.error ? ' ' + t.error : ''}）：` + '需要给出可重试的失败语义');
    if (t.mode === 'fallback' || t.mode === 'mock') bits.push(`交付模式是 ${t.mode}（不是真实模型输出）：建议在回执顶层显著标注并给出补偿策略`);
    if (t.charged > 0) bits.push(`第一轮试用被扣了 ${t.charged} 分：规则要求本轮试用免费`);
    if (t.ms > 30000) bits.push(`单次试用耗时 ${(t.ms / 1000).toFixed(1)} 秒，接近赛事 5 分钟上限：建议公开时延分位与超时策略`);
  }
  if (c.card && !c.card.endpoints?.evidence && !/evidence/i.test(JSON.stringify(c.card))) bits.push('没有公开可核验的交付统计（时延/失败率/退款原因）：买家只能凭感觉判断可靠性');
  if (!bits.length) bits.push(`试用 ${t?.service} 交付正常（${c.trials.length} 件、${t?.ms}ms、mode=${t?.mode}）：` + '建议补一份失败样本与退款原因分布，方便买家判断长尾');
  return bits.slice(0, 3).map((b, i) => `${i + 1}) ${b}`).join('\n');
}

function scoreOf(c) {
  let s = 0;
  if (c.token) s += 5;                                             // 能自助接入 = 第一轮可被看见
  const t = c.trials[0];
  if (t?.status === 'delivered') s += 3;
  if (t?.mode === 'live') s += 3; else if (t?.mode) s += 1;
  if (c.card?.endpoints?.evidence || /evidence/i.test(JSON.stringify(c.card || {}))) s += 2;
  if (t?.charged === 0) s += 2;                                    // 第一轮不扣分
  if (t?.ms && t.ms < 20000) s += 2;
  if ((c.card?.pricing?.paid || []).length >= 3) s += 1;           // 商品结构清楚
  c.score = s; return s;
}

async function round1() {
  for (const c of Object.values(state.candidates)) {
    if (c.probed) continue;
    out(`  ▸ 探测 ${c.host} …`);
    await probe(c); c.probed = true; scoreOf(c); save();
    out(`    卡片=${c.cardStatus} 开户=${c.token ? '✓' : '✗'} 试用=${c.trials[0]?.status || '-'} mode=${c.trials[0]?.mode || '-'} ${c.trials[0]?.ms || '-'}ms 得分=${c.score}`);
  }
  const ready = Object.values(state.candidates).filter(c => c.probed);
  for (const c of ready) {
    if (state.objectionsSent[c.host]) continue;
    const text = `【第一轮 · 具体异议 → ${c.host}】\n实测：卡片 HTTP ${c.cardStatus}｜自助开户 ${c.token ? '成功' : '失败'}｜试用 ${c.trials[0]?.service || '未跑'} → ${c.trials[0]?.status || '未跑'}（${c.trials[0]?.ms || '-'}ms，mode=${c.trials[0]?.mode || '-'}，扣分 ${c.trials[0]?.charged ?? '-'}）\n具体异议：\n${objectionFor(c)}`;
    if (say(text)) { state.objectionsSent[c.host] = new Date().toISOString(); save(); out(`  ✉ 已发异议 → ${c.host}`); }
  }
  if (ready.length >= 3 && !state.rankingPosted) {
    const ranked = [...ready].sort((a, b) => b.score - a.score);
    const listing = ranked.map((c, i) => `${i + 1}. ${c.host}（${c.score} 分：${c.token ? '可自助接入' : '需人工'}／试用 ${c.trials[0]?.status || '-'}／mode=${c.trials[0]?.mode || '-'}／${c.trials[0] ? Math.round(c.trials[0].ms / 1000) + 's' : '-'}）`).join('\n');
    const text = `【第一轮 · 排名提交（${ranked.length} 家实测）】\n评分口径：能自助接入 +5、试用成功 +3、真实模型交付 +3、有公开证据 +2、第一轮不扣分 +2、时延<20s +2、商品结构清楚 +1。\n${listing}\n说明：只对实测过的队伍排序；本房间若不足 3 家，则按实到队伍数提交，不伪造对比。`;
    if (say(text)) { state.rankingPosted = new Date().toISOString(); save(); out(`  ✦ 已提交排名（${ranked.length} 家）`); }
  }
}

async function round2() {
  const ready = Object.values(state.candidates).filter(c => c.probed && c.token).sort((a, b) => b.score - a.score);
  const bought = new Set(state.purchases.map(p => p.host));
  for (const c of ready) {
    if (state.spend >= 80 && bought.size >= 3) break;
    if (bought.has(c.host) && bought.size >= 3) continue;
    const services = (c.card?.pricing?.paid || []).filter(s => (s.cost ?? 0) <= 30).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    const pick = services[0];
    if (!pick) continue;
    const input = { productName: 'Pi Arena 买方产品', productDescription: '一个代表其他队伍采购与验收的 agent', price: 5, targetBuyer: 'agents' };
    const r = await fetchJson(`${c.base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}`, 'idempotency-key': unique('order') },
      body: JSON.stringify({ service: pick.id, input, message: '第一轮我提交过具体异议，这一单是第二轮真实采购。' }) });
    const receipt = { host: c.host, at: new Date().toISOString(), service: pick.id, http: r.status, status: r.body?.status,
      charged: r.body?.chargedCredits ?? r.body?.charged ?? null, orderId: r.body?.id || null, error: r.body?.error?.code || null };
    state.purchases.push(receipt);
    if (receipt.status === 'delivered' || receipt.charged) { state.spend += Number(receipt.charged || 0); bought.add(c.host); }
    save();
    out(`  💳 ${c.host} ${pick.id} → ${receipt.status || receipt.error} 扣 ${receipt.charged ?? '-'} 分（累计 ${state.spend}，队伍 ${bought.size}）`);
    if (receipt.status === 'delivered') say(`【第二轮 · 采购回执】${c.host} 的 ${pick.id}：orderId=${receipt.orderId}，扣 ${receipt.charged} 分，status=${receipt.status}。第一轮的异议与这次成交一并留档。`);
  }
  if (state.spend > 0) {
    const text = `【第二轮 · 我的采购台账】已花 ${state.spend} 分、向 ${new Set(state.purchases.map(p => p.host)).size} 家队伍采购 ${state.purchases.length} 件。明细可查我的回执；不虚构，失败单也在里面。`;
    if (!state.reportedSpend || Date.now() - state.reportedSpend > 300000) { say(text); state.reportedSpend = Date.now(); save(); }
  }
}

async function tick() {
  const r = sharednet(['read']);
  if (!r.ok && !r.data) { out(`  ⚠ 读房间失败（${r.raw || '无输出'}）：本目录可能还没入座`); return; }
  const items = r.data?.items || [];
  const fresh = items.filter(m => m.sequence > (state.seenMessages || 0));
  state.seenMessages = items.length ? Math.max(...items.map(m => m.sequence)) : state.seenMessages;
  for (const m of fresh) {
    if (SEAT && m.sender_instance_id === SEAT) continue;   // 不看自己（用本地 seat，不 spawn）
    const found = discover(m.content);
    for (const f of found) { state.candidates[f.host] = { ...f, discoveredAt: new Date().toISOString(), trials: [], notes: ['来自房间消息'], spend: 0 }; out(`  🔍 发现候选：${f.host}`); }
  }
  save();
  const phase = round();
  if (phase === 'CRITIQUE') await round1();
  if (phase === 'MARKET') { await round1(); await round2(); }
  if (!once) out(`  · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 轮次=${phase} 候选=${Object.keys(state.candidates).length} 已试=${Object.values(state.candidates).filter(c => c.probed).length} 已花=${state.spend}`);
}

out(`竞技场买方 agent 启动：轮次=${round()} 候选=${Object.keys(state.candidates).length} 台账=${STATE_FILE}`);
await tick();
if (!once) setInterval(() => tick().catch(e => log({ event: 'error', message: e.message })), intervalSec * 1000);
