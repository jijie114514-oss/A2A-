#!/usr/bin/env node
/**
 * 房间应答器（卖方 agent 的"在场"实现）。
 *
 * 挂法（官方自动化钩子，收到消息就调用本脚本，消息 JSON 走 stdin）：
 *   npx -y sharednet@latest watch --on message --run 'node scripts/room-agent.js'
 *
 * 回答策略（按优先级）：
 *   1. 已知缺口台账（src/known-gaps.js）：被点到已知问题 → 给出「已修/仍存在 + 可核验证据」；
 *   2. 订单/回执类问题 → 给出可复算的账本口径；
 *   3. 其他实质问题 → 用本地模型组稿，但**只能用注入的 FACTS**（价格、证据数字、政策）；
 *   4. 纯事实问题（价格表/怎么调/试用规则）→ 模板直答，最快且零编造风险。
 *
 * 硬约束：不编造数字与热度、不承诺折扣、不替对方排名、不回复自己、按发送者限流；
 * 组稿结果还会做一次数字核对（回复里出现的金额必须出现在 FACTS 或缺口台账里）。
 */
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { matchGaps } from '../src/known-gaps.js';

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const value = (n, d) => { const hit = args.find(a => a.startsWith(`--${n}=`)); return hit ? hit.split('=').slice(1).join('=') : d; };
const BASE = value('base', process.env.STARHALL_PUBLIC_BASE_URL || 'https://starhall-a2a.vercel.app').replace(/\/+$/, '');
const logFile = value('log', path.resolve('artifacts/room-agent.log'));
const dry = flag('dry');
const quiet = flag('quiet');
const perSenderMs = Number(value('sender-gap-ms', 20000));
const maxPerHour = Number(value('max-per-hour', 40));

const log = e => { try { mkdirSync(path.dirname(logFile), { recursive: true }); appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), seat: SEAT, ...e }) + '\n'); } catch { /* 日志失败不影响应答 */ } };
const out = t => { if (!quiet) console.log(t); };

let payload; try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
const SEAT = payload.member_id || process.env.SHAREDNET_MEMBER_ID || '';

// 只回应「点名我们」的消息：房间里有大量别队互评、广告和对其他卖方的问答，逐条回复会刷屏、答非所问，
// 还会烧掉每小时配额（2026-09-13 进场实测：24 条回复里 22 条并未点名 StarHall）。
// 点名 = 提到产品名/榜单/我们的 seat，或这条消息是对我们自己消息的回复。
const state0 = (() => { try { return JSON.parse(readFileSync(path.resolve('artifacts/room-agent-state.json'), 'utf8')); } catch { return {}; } })();
const ownIds = new Set(state0.lastMessageIds || []);
// 只回三种：① 直接 @我们；② 明确在点评/质疑我们；③ 回复我们自己的消息。
// （宽松关键词会把「提到 StarHall」的监控榜单、别人的随口提及都算进来，回复变噪声）
const DIRECT = new RegExp('@\\s*(starhall|星辉舞台|i_D7Ss2Iofeo)' + (SEAT && SEAT !== 'i_D7Ss2Iofeo' ? `|@\\s*${SEAT}` : ''), 'i');
const ABOUT_US = /(?:review|点评|评价|批评|质疑|回应|答复)\s*[—–\-:：]?\s*(?:starhall|星辉舞台)|starhall\s*(?:的|的广告|广告|榜单|赞助|交付|试用|回执|证据)|星辉舞台的|你们(?:的)?(?:广告|榜单|赞助位|交付|试用|回执)/i;
const SPAM = /play_jackpot|GovStake Casino|To use GovStake, send|insufficient .{0,12}balance/i;
const addressedToUs = m => !SPAM.test(String(m.content || '')) && (DIRECT.test(String(m.content || '')) || ABOUT_US.test(String(m.content || '')) || (m.reply_to_message_id && ownIds.has(m.reply_to_message_id)));
const incoming = (payload.messages || []).filter(m => m?.content && m.sender_instance_id !== SEAT && addressedToUs(m));
const ignored = (payload.messages || []).filter(m => m?.content && m.sender_instance_id !== SEAT && !addressedToUs(m));
if (ignored.length && !quiet) out(`（跳过未点名消息 ${ignored.length} 条）`);
if (!incoming.length) { out('（没有需要回复的新消息）'); process.exit(0); }

// ── FACTS：只读产品公开端点，60 秒缓存 ───────────────────────────────────────
const cache = globalThis.__roomAgentCache ||= {};
const fetchJson = async (p, ttl = 60000) => {
  const hit = cache[p]; if (hit && Date.now() - hit.at < ttl) return hit.data;
  try { const r = await fetch(BASE + p, { headers: { accept: 'application/json' } }); const data = await r.json(); cache[p] = { at: Date.now(), data }; return data; } catch { return hit?.data ?? null; }
};
const catalog = await fetchJson('/v1/catalog');
const evidence = await fetchJson('/v1/evidence');
const health = await fetchJson('/health');
const claim = n => evidence?.claims?.find(c => c.claim.startsWith(n))?.value;
const priceLabel = s => (s.plans ? `${Object.values(s.plans).map(p => p.price).sort((a, b) => a - b).join('/')} 分（按 plan）` : `${s.price} 分`);
const payable = (catalog?.services || []).filter(s => s.price > 0 || s.plans);
const FACTS = [
  `产品：STARHALL — 星辉舞台；入口 ${BASE}/agent-card.json（发现）、${BASE}/v1/catalog（价格与输入 schema）`,
  `目录价：${payable.map(s => `${s.name} ${priceLabel(s)}`).join(' · ')}；免费行情榜 0 分`,
  `试用政策：${catalog?.round?.trialPolicy?.limit || '每个身份每个付费服务一次免费成功试用'}，0 花费；下单与试用都要 Idempotency-Key`,
  `交付：硬上限 ${catalog?.delivery?.hardTimeoutSeconds ?? 115} 秒；超时=失败且不扣款；模型未完成合格输出=交付备用作品且付费单自动全额退款（deliveryPolicy.fallbackCharged=${catalog?.deliveryPolicy?.fallbackCharged}）`,
  `公开可核验：成功交付 ${claim('成功交付数')} · live 占比 ${claim('真实模型交付占比')}% · 机器退款 ${claim('机器判定退款数')}（原因 ${JSON.stringify(claim('退款原因分布'))}）· 未扣款失败 ${claim('未扣款失败单数')} · 时延 p50/p95/max=${JSON.stringify(claim('交付时延 p50 / p95 / max（毫秒）'))}`,
  `失败分布：${JSON.stringify(evidence?.failures?.byReason)}；按结局时延样本 ${JSON.stringify(Object.fromEntries(Object.entries(evidence?.latencyByOutcome || {}).map(([k, v]) => [k, v.samples])))}`,
  `赞助三档绑定明星：5/10/15 分；headline 只计去重后的独立认证买家触达，自助/平台/匿名请求单列不计入；delivery 档窗口=自购买激活起 60 分钟，窗口内未达标机器自动退款；GET /v1/ads/:id 可核账（含 impressionId 与分类）`,
  `监视器读榜请带 X-StarHall-Impressions: none：响应当常、不创建曝光事件`,
  `积分口径：本产品是模拟账本；真实比赛积分在房间结算（sharednet pay/ledger），不经过本 API`,
  `当前轮次（我方时钟）：${catalog?.round?.id} — ${catalog?.round?.task || ''}`,
].join('\n');

// ── 意图 ────────────────────────────────────────────────────────────────────
const INTENTS = [
  ['receipt', /回执|订单号|orderId|扣了|扣分|余额|钱包|对账|查单|[\w-]{8}-[\w-]{4}-[\w-]{4}-[\w-]{4}-[\w-]{12}/],
  ['objection', /异议|不足|缺点|担心|风险|但是|可是|不过|缺少|没有给|看不到|无法判断|不够|质疑|问题在|修复|已修|仍存在|降级|fallback|超时|conflict of interest|pay.?to.?win|利益冲突|买榜|付费置顶|批评|点评|critique|review\s*[—–:-]|评审|does not demonstrate|doesn't demonstrate|not demonstrate|publish a/i],
  ['sponsor', /赞助|冠名|广告位|曝光|sponsor/i],
  // 事实类问题必须排在 buy 之前：『你们卖什么、多少钱？我准备下单』是在问价与菜单，
  // 不是在下单流程咨询（2026-09-13 赛前实测踩到过：把报价问题答成了下单三步）。
  ['pricing', /价格|多少钱|报价|价目|定价|price|贵/i],
  ['catalog', /卖什么|有什么|什么服务|商品|能力|能做什么/i],
  ['trial', /试用|免费|trial/i],
  ['howto', /怎么调|怎么用|接口|api\b|mcp|agent.?card|文档|链接|接入/i],
  ['buy', /我要买|下单|购买|买一|来一单|支付|付款|\bpay\s+(?:p_|a_|i_|\d)/i],
  ['rank', /排名|评分|投票|rank|第几/i],
  ['greeting', /你好|您好|就位|在吗|介绍一下|\bhi\b|hello/i],
];
const intentOf = t => (INTENTS.find(([, re]) => re.test(t)) || ['unknown'])[0];
// 纯咨询/推销类问题优先走模板（卖点 + 事实，不甩缺口台账）；只有真的像异议/对账时才走缺口应答。
const TEMPLATE_FIRST = new Set(['sponsor', 'pricing', 'catalog', 'greeting', 'howto', 'trial', 'buy', 'rank']);
const quote = t => String(t).replace(/\s+/g, ' ').slice(0, 40);

// ── 组稿（只用 FACTS，本地模型；失败则退回模板） ──────────────────────────────
const ark = { url: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''), key: process.env.LLM_API_KEY || '', model: process.env.LLM_MODEL || '' };
const SYSTEM = `你是 STARHALL 星辉舞台团队在竞技场房间里的卖方 agent。用中文回答其他 agent。
硬规则：① 只能使用 FACTS 里的数字与事实，不得引入任何 FACTS 之外的价格、比例、案例或人气；② 不承诺折扣、不承诺未实现的能力、不替对方排名打分；③ 先直接回答对方问的那件事，再给一个可执行的下一步（接口或命令）；④ 复述对方原话不超过 15 字；⑤ 全文 ≤ 220 字，不要客套，不要 markdown 标题。`;
async function compose(text, facts) {
  if (!ark.url || !ark.key || !ark.model) return null;
  const body = { model: ark.model, max_output_tokens: 700, store: false, stream: false,
    ...(process.env.LLM_THINKING && process.env.LLM_THINKING !== 'default' ? { thinking: { type: process.env.LLM_THINKING } } : {}),
    input: [{ role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
      { role: 'user', content: [{ type: 'input_text', text: `FACTS:\n${facts}\n\n对方消息：${text}\n\n只输出回复正文。` }] }] };
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(`${ark.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ark.key}` }, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const parts = (data.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text);
    const text_ = parts.join('\n').trim();
    return text_ || null;
  } catch { return null; }
}
/** 数字核对：回复里出现的金额必须能在 FACTS 或缺口台账里找到。 */
function numbersGrounded(reply, facts) {
  const allowed = new Set([...facts.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => m[1]));
  for (const m of reply.matchAll(/(\d+(?:\.\d+)?)\s*(?:分|积分|credits?)/gi)) if (!allowed.has(m[1])) return false;
  return true;
}

// ── 模板（纯事实问题走这里） ─────────────────────────────────────────────────
const REPLIES = {
  greeting: () => `StarHall 卖方 agent 在线。服务：${payable.map(s => `${s.name} ${priceLabel(s)}`).join(' · ')}；每个付费服务可免费试用一次（0 花费）。\n重点是可核验的广告与榜单：5 分 delivery＝10 个去重独立认证买家触达（自购买激活起 60 分钟未达标，机器自动全额退款）· 10 分 leaderboard 置顶 30 分钟 · 15 分 featured 冠名 30 分钟；赞助计 Sponsor Support（×0.6）推高明星排名与曝光权重 1.5/1.2/1.0。免费榜单 ${BASE}/v1/market-board 实时看排名、支持分与广告压力（读了不计数）。入口与输入示例 ${BASE}/agent-card.json。给我一句你的产品，我按实价试一轮？`,
  catalog: () => `在售：${payable.map(s => `${s.name} ${priceLabel(s)}`).join(' · ')}。重点：广告位 5/10/15 分——delivery＝10 个去重独立认证买家触达（自购买激活起 60 分钟未达标，机器自动全额退款）、leaderboard 榜单置顶 30 分钟、featured 冠名 30 分钟；赞助计 Sponsor Support（×0.6）推高明星排名与曝光权重 1.5/1.2/1.0。免费榜单 ${BASE}/v1/market-board 实时看排名、支持分与广告压力。输入 schema 与交付时限见 ${BASE}/v1/catalog；发现入口 ${BASE}/agent-card.json。`,
  pricing: () => `目录实价（不浮动、不打折）：${payable.map(s => `${s.name} ${priceLabel(s)}`).join(' · ')}，以 ${BASE}/v1/catalog 为准，我这句只是转述。试用 0 花费。广告三档 5/10/15 分可推高明星排名与曝光权重，delivery 档另带 60 分钟未达标机器自动全额退款；免费榜单 ${BASE}/v1/market-board。`,
  howto: () => `三条路：① MCP：POST ${BASE}/mcp（tools/list 列工具）；② JSON HTTP：${BASE}/v1/catalog 的 call 字段；③ Agent Card：${BASE}/agent-card.json。身份用 POST ${BASE}/v1/agents 自助开户；下单/试用都要 Idempotency-Key（重试复用同一个键）。`,
  trial: () => `试用：每个身份、每个付费服务一次成功免费试用（0 花费，失败可换幂等键重试）。调用 POST ${BASE}/v1/trials，带 Bearer token 与 idempotency-key。也可以把产品一句话给我，我直接替你跑一轮并给回执。`,
  buy: () => `下单三步：① 开户 POST ${BASE}/v1/agents；② POST ${BASE}/v1/orders {service,input,message?}，带 Bearer 与 Idempotency-Key；③ 同一键 GET ${BASE}/v1/orders/by-key 查回原单。input 示例见 ${BASE}/v1/catalog。客观失败与备用交付都不收费；成功交付有一次免费修订。`,
  receipt: () => `账目口径：订单只能本人查（GET ${BASE}/v1/orders，带自己的 token），按幂等键查用 /v1/orders/by-key。公开可复算：${BASE}/v1/evidence —— 成功交付 ${claim('成功交付数')}、live 占比 ${claim('真实模型交付占比')}%、退款 ${claim('机器判定退款数')} 起（原因 ${JSON.stringify(claim('退款原因分布'))}）。有对不上的数字把订单号发我，我按账本核。`,
  sponsor: () => `赞助三档（绑定一位明星，价格见目录）：5 分 delivery＝10 个去重独立认证买家触达，窗口自购买激活起 60 分钟，未达标机器自动全额退款（IMPRESSIONS_NOT_DELIVERED）· 10 分 leaderboard 置顶 30 分钟 · 15 分 featured 冠名 30 分钟，买下即生效。触达只计「去重的独立认证买家」（同一身份一个活动只计 1 次）；你自己的请求、平台自己和匿名轮询在响应里单列，不计入 headline。赞助计 Sponsor Support（×0.6），推高该明星排名与曝光权重（1.5/1.2/1.0）；免费榜单 ${BASE}/v1/market-board 看排名与压力。每笔曝光可在 GET ${BASE}/v1/ads 复算（含逐条事件、分类与后续下单相关性——相关性，不是因果）。监视器请带 X-StarHall-Impressions: none，读了不计数。`,
  rank: () => `排名由你决定，我不替你打分也不刷票。可核验材料：${BASE}/v1/evidence（交付数、live 占比、时延与退款原因分布）与 ${BASE}/v1/catalog（每个服务的 health 与 fallbackReasons）。有缺口直接说，我宁可你写具体异议。`,
};
const safeFallback = () => `这条我需要核实具体细节，先给你能自证的部分：目录价与输入 schema 在 ${BASE}/v1/catalog，公开交付与退款统计在 ${BASE}/v1/evidence（成功交付 ${claim('成功交付数')}、机器退款 ${claim('机器判定退款数')} 起）。你指的那一点我会在房间里补一条带出处的答复。`;

// ── 限流状态 ────────────────────────────────────────────────────────────────
const stateFile = path.resolve('artifacts/room-agent-state.json');
let state = { lastBySender: {}, sentAt: [] };
try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 重置 */ }
const persist = () => { try { mkdirSync(path.dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); } catch { /* 无所谓 */ } };

const say = text => {
  if (dry) { out(`[dry] ${text}`); return { ok: true, dry: true }; }
  const r = spawnSync('npx', ['-y', 'sharednet@latest', 'say', text], { encoding: 'utf8', timeout: 60000 });
  if (r.status === 0) {
    const id = (r.stdout || '').match(/"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/)?.[1];
    if (id) { state.lastMessageIds = [...(state.lastMessageIds || []).filter(x => x !== id), id].slice(-20); persist(); }
  }
  return { ok: r.status === 0, err: (r.stderr || '').slice(0, 200) };
};

for (const message of incoming) {
  const sender = message.sender_instance_id || message.sender_principal_id || 'unknown';
  if (!addressedToUs(message)) {
    log({ event: 'skipped-unaddressed', sender, sequence: message.sequence, incoming: message.content });
    continue;
  }
  const intent = intentOf(message.content);
  const gaps = matchGaps(message.content, 3);
  // 评审/点评类消息即使夹带「怎么接入」「多少钱」这类关键词，也必须走可核验答复，不能被咨询模板短路。
  const reviewLike = /review\s*[—–:-]|评审|批评|点评|critique|does not demonstrate|doesn't demonstrate|publish a/i.test(message.content);
  let reply; let source;
  if (gaps.length && (reviewLike || !TEMPLATE_FIRST.has(intent))) {
    const label = { fixed: '已处理完', structural: '结构性、不是我们能单方面修的', open: '仍然存在、不糊弄' };
    reply = gaps.map((gap, i) => `${gaps.length > 1 ? `${i + 1}) ` : ''}${label[gap.status]}：${gap.reply}`).join('\n')
      + `\n可核验：${[...new Set(gaps.flatMap(g => g.evidence))].slice(0, 3).join('；')}`;
    source = `gap:${gaps.map(g => g.id).join('+')}`;
  }
  else if (REPLIES[intent]) { reply = REPLIES[intent](); source = `template:${intent}`; }
  else {
    const composed = await compose(message.content, FACTS);
    if (composed && numbersGrounded(composed, FACTS)) { reply = composed; source = 'model'; }
    else { reply = safeFallback(); source = composed ? 'model-ungrounded→fallback' : 'model-unavailable→fallback'; }
  }

  const now = Date.now();
  const last = state.lastBySender[sender] || 0;
  state.sentAt = (state.sentAt || []).filter(t => now - t < 3600_000);
  if (now - last < perSenderMs || state.sentAt.length >= maxPerHour) {
    out(`[跳过] ${now - last < perSenderMs ? '同一发送者间隔过短' : '本小时上限'} | ${sender} seq=${message.sequence}`);
    log({ event: 'skipped', sender, sequence: message.sequence, intent, source });
    continue;
  }

  out(`[${intent}/${source}] ${sender} seq=${message.sequence}: ${quote(message.content)}`);
  const result = say(reply);
  state.lastBySender[sender] = now; state.sentAt.push(now);
  log({ event: 'replied', sender, sequence: message.sequence, intent, source, gaps: gaps.map(g => g.id), incoming: message.content, reply, ok: result.ok, err: result.err || null });
  out(result.ok ? `→ 已回复（${reply.length} 字）` : `→ 失败：${result.err}`);
}
persist();
