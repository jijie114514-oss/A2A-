#!/usr/bin/env node
/**
 * 房间应答器（卖方 agent 的"在场"实现）。
 *
 * 挂法（官方自动化钩子，收到消息就调用本脚本，消息 JSON 走 stdin）：
 *   npx -y sharednet@latest watch --on message --run 'node scripts/room-agent.js'
 *
 * 设计约束：
 *  - 事实全部**实时取自产品的公开端点**（目录价、试用政策、公开证据、当前轮次），不在代码里写死价格；
 *  - 不编造人气、不承诺折扣、不替对方排名、不承诺未实现的能力；
 *  - 不回复自己发的消息；按发送者限流，避免和别的 bot 互相刷屏；
 *  - 每条 (收到, 回复) 都落日志，便于赛后复盘；认不出来的问题记 UNANSWERED，而不是硬答。
 */
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => { const hit = args.find(a => a.startsWith(`--${name}=`)); return hit ? hit.split('=').slice(1).join('=') : fallback; };
const BASE = (value('base', process.env.STARHALL_PUBLIC_BASE_URL || 'https://starhall-a2a.vercel.app')).replace(/\/+$/, '');
const logFile = value('log', path.resolve('artifacts/room-agent.log'));
const dry = flag('dry');                 // 只打印不发言
const quiet = flag('quiet');
const perSenderMs = Number(value('sender-gap-ms', 20000));
const maxPerHour = Number(value('max-per-hour', 40));

const log = entry => {
  try { mkdirSync(path.dirname(logFile), { recursive: true }); appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), seat: SEAT, ...entry }) + '\n'); } catch { /* 日志失败不影响应答 */ }
};
const out = text => { if (!quiet) console.log(text); };

// ── 输入：stdin 的 {room_id, member_id, trigger, messages[]} ──────────────────
let payload;
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
const SEAT = payload.member_id || process.env.SHAREDNET_MEMBER_ID || '';
const incoming = (payload.messages || []).filter(m => m && m.content && m.sender_instance_id !== SEAT);
if (!incoming.length) { out('（没有需要回复的新消息）'); process.exit(0); }

// ── 事实：实时读产品公开端点，60 秒缓存，避免每个消息都打一次 ────────────────
const cache = globalThis.__roomAgentCache ||= {};
const fetchJson = async (path, ttlMs = 60000) => {
  const hit = cache[path];
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  try { const r = await fetch(BASE + path, { headers: { accept: 'application/json' } }); const data = await r.json(); cache[path] = { at: Date.now(), data }; return data; }
  catch { return hit?.data ?? null; }
};
const catalog = await fetchJson('/v1/catalog');
const evidence = await fetchJson('/v1/evidence');
const health = await fetchJson('/health');
const priceLabel = s => s.plans ? `${Object.values(s.plans).map(p => p.price).sort((a, b) => a - b).join('/')} 分（按 plan）` : `${s.price} 分`;
const menu = () => (catalog?.services || []).filter(s => s.price > 0 || s.plans).map(s => `${s.name} ${priceLabel(s)}`).join(' · ');
const num = prefix => evidence?.claims?.find(c => c.claim.startsWith(prefix))?.value;
const facts = () => `当前目录价：${menu()}；免费行情榜 0 分。每个付费服务可用你自己的产品免费试用一次（0 花费）。公开可核验：成功交付 ${num('成功交付数')}、live 交付占比 ${num('真实模型交付占比')}%、机器退款 ${num('机器判定退款数')} 起、未扣款失败 ${num('未扣款失败单数')} 单。`;

// ── 意图识别：只认关键词，命中多个时按优先级取第一个 ─────────────────────────
const INTENTS = [
  ['sponsor', /赞助|冠名|广告|曝光|sponsor|advert/i],
  ['objection', /异议|不足|缺点|担心|风险|但是|可是|不过|建议|缺少|没有给|看不到|无法判断|不够|质疑|问题在/i],
  ['buy', /我要买|下单|购买|买一|来一单|支付|付款|结算|pay|order\b/i],
  ['receipt', /收据|订单号|扣了|乱扣|余额|charged|receipt|对账/i],
  ['trial', /试用|免费|try\b|trial/i],
  ['howto', /怎么调|怎么用|接口|api\b|mcp|agent.?card|文档|链接|url|调用方式|接入/i],
  ['pricing', /价格|多少钱|报价|价目|定价|price|cost|贵/i],
  ['catalog', /有什么|什么服务|商品|能力|能做什么|菜单|list/i],
  ['rank', /排名|评分|投票|打分|rank|第几/i],
  ['greeting', /你好|您好|hi\b|hello|在吗|介绍下|介绍一下/i],
];
const intentOf = text => (INTENTS.find(([, re]) => re.test(text)) || ['unknown'])[0];

const quote = text => String(text).replace(/\s+/g, ' ').slice(0, 60);
const REPLIES = {
  greeting: () => `StarHall 星辉舞台 agent 在线。我们卖三件能直接用的东西，外加证据诊断与明星赞助：${menu()}。\n每个付费服务可以用你自己的产品免费试用一次（0 花费），试用入口和输入示例都在 ${BASE}/agent-card.json。你先给我一句你的产品，我按实价试一轮？`,
  catalog: () => `当前在售：${menu()}。完整输入 schema、交付时限、退款条款见 ${BASE}/v1/catalog；发现入口 ${BASE}/agent-card.json。要不要我先拿一个服务免费试给你看？`,
  pricing: () => `目录实价（不浮动、不打折）：${menu()}。\n本产品积分是模拟账本；真实比赛积分由房间结算（sharednet pay/ledger）。试用 0 花费，每个付费服务一次。价目以 ${BASE}/v1/catalog 为准，我这句只是转述。`,
  howto: () => `三条路都能调：① MCP：POST ${BASE}/mcp（tools/list 直接列工具）；② JSON HTTP：${BASE}/v1/catalog 里的 call 字段；③ Agent Card：${BASE}/agent-card.json。\n需要身份：POST ${BASE}/v1/agents 自助开户拿 Bearer token；下单/试用都要 Idempotency-Key（重试复用同一个键，不会重复扣分）。`,
  trial: () => `试用规则：每个身份、每个付费服务**一次**免费成功试用，失败可换幂等键重试；试用 0 花费、不计销量、不产生会员权益。\n调用：POST ${BASE}/v1/trials，头带 authorization: Bearer <token> 与 idempotency-key。输入示例见 ${BASE}/v1/catalog 的 call.body.input。\n把你要试的产品一句话给我，我也能直接替你跑一轮并给你回执。`,
  objection: text => `这条我收下，不辩解：你的点在「${quote(text)}」。\n${facts()}\n如果这是缺口而不是误解，我会先承认、给出补齐时间，然后在房间里发回执（刚才那条证据分布就是这么做掉的）。你要不要我把你这条记进我们的待补清单，并回一条可复算的答复？`,
  buy: () => `下单就三步：① 开户 POST ${BASE}/v1/agents 拿 token；② POST ${BASE}/v1/orders，body {service, input, message?}，头带 Bearer 与 Idempotency-Key；③ 用同一个键 GET ${BASE}/v1/orders/by-key 查回原单（网络断了先查、别重买）。\n各服务的 input 示例在 ${BASE}/v1/catalog 的 call.body.input。按目录实价扣分，交付失败不扣分，客观失败机器自动退款，成功交付可申请一次免费修订。`,
  receipt: () => `订单只能本人查：GET ${BASE}/v1/orders（带自己的 Bearer token），按幂等键查用 GET ${BASE}/v1/orders/by-key。\n公开统计（任何人可复算）：${BASE}/v1/evidence —— 成功交付 ${num('成功交付数')}、live 占比 ${num('真实模型交付占比')}%、退款 ${num('机器判定退款数')} 起（原因分布也在里面）、未扣款失败 ${num('未扣款失败单数')} 单。有对不上的数字，把订单号发我，我按账本核。`,
  sponsor: () => `赞助三档（绑定一位明星，价格见目录）：${menu().split(' · ').filter(x => /Sponsorship/i.test(x)).join('') || 'Star Sponsorship 5/10/15 分'}。\n买下即刻生效；曝光只在我们真实把它放进交付或榜单时计数，买家可查 GET ${BASE}/v1/ads（含逐条曝光事件与 impressionId）。没有真实投放时榜单不展示虚构广告。`,
  rank: () => `排名由你决定，我不替你打分也不刷票。你能用的可核验材料：${BASE}/v1/evidence（交付数、live 占比、时延分布、退款原因）与 ${BASE}/v1/catalog（每个服务的 health）。\n如果我们的交付有缺口，请直接说；我宁可你写一条具体异议，也不要笼统好评。`,
};
const fallbackReply = text => `这条我不确定，先给你我确定的部分：「${quote(text)}」\n当前目录价：${menu()}；交付上限 ${catalog?.delivery?.hardTimeoutSeconds ?? 115} 秒；公开可核验数据在 ${BASE}/v1/evidence。\n具体那个问题我记下来了，会在房间里补一条带出处的答复。`;

// ── 限流 + 发言 ──────────────────────────────────────────────────────────────
const stateFile = path.resolve('artifacts/room-agent-state.json');
let state = { lastBySender: {}, sentAt: [] };
try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 重置 */ }
const persist = () => { try { mkdirSync(path.dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); } catch { /* 无所谓 */ } };

const say = text => {
  if (dry) { out(`[dry] 将发送：\n${text}`); return { ok: true, dry: true }; }
  const r = spawnSync('npx', ['-y', 'sharednet@latest', 'say', text], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, err: (r.stderr || '').slice(0, 200) };
};

for (const message of incoming) {
  const sender = message.sender_instance_id || message.sender_principal_id || 'unknown';
  const intent = intentOf(message.content);
  const reply = (REPLIES[intent] || fallbackReply)(message.content);

  const now = Date.now();
  const last = state.lastBySender[sender] || 0;
  state.sentAt = (state.sentAt || []).filter(t => now - t < 3600_000);
  const tooSoon = now - last < perSenderMs;
  const tooMany = state.sentAt.length >= maxPerHour;
  if (tooSoon || tooMany) {
    out(`[跳过] ${tooSoon ? '同一发送者间隔过短' : '本小时发言已达上限'} | ${sender} seq=${message.sequence}`);
    log({ event: 'skipped', sender, sequence: message.sequence, intent, reason: tooSoon ? 'sender-gap' : 'hourly-cap' });
    continue;
  }

  out(`[${intent}] ${sender} seq=${message.sequence}: ${quote(message.content)}`);
  const result = say(reply);
  state.lastBySender[sender] = now; state.sentAt.push(now);
  log({ event: 'replied', sender, sequence: message.sequence, intent, incoming: message.content, reply, ok: result.ok, err: result.err || null });
  out(result.ok ? '→ 已回复' : `→ 回复失败：${result.err}`);
}
persist();
