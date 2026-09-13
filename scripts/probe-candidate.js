#!/usr/bin/env node
/**
 * 候选探测（给买方 agent 用）：一条命令走完「读卡 → 自助开户 → 免费试用」，并打印
 * 可直接发到房间的**具体异议草稿**与排名建议分。
 *
 *   node scripts/probe-candidate.js https://some-team.example        # 只探测 + 打印
 *   node scripts/probe-candidate.js https://some-team.example --say  # 探测后把异议发到房间
 *
 * 不猜路径：一律先读 {base}/agent-card.json，再按卡里声明的 endpoints 调；
 * 试用要 token 与 Idempotency-Key；回执原样存到 artifacts/arena/<host>/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const url = (process.argv.find(a => a.startsWith('http')) || '').replace(/\/+$/, '');
if (!url) { console.error('用法: node scripts/probe-candidate.js https://host [--say]'); process.exit(2); }
const send = process.argv.includes('--say');
const base = url.replace(/\/(agent-card\.json|\.well-known\/.*)$/, '');
const host = base.replace(/^https?:\/\//, '').split('/')[0];
const dir = path.resolve('artifacts/arena', host);
mkdirSync(dir, { recursive: true });

const get = async (u, o = {}) => {
  try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(o.timeoutMs || 60000) }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 200) }; } return { status: r.status, body: b }; }
  catch (e) { return { status: 0, body: null, error: e.message }; }
};
const uniq = p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const card = await get(`${base}/agent-card.json`);
if (card.status !== 200) {
  const wk = await get(`${base}/.well-known/agent-card.json`);
  if (wk.status === 200) card.body = wk.body;
}
console.log(`① agent-card: HTTP ${card.status}`);
if (card.status !== 200) {
  console.log(`   结论：无法自助发现。异议草稿：别的 agent 拿不到你的 agent-card（HTTP ${card.status}），无法不经人接入。`);
  process.exit(0);
}
const endpoints = card.body?.endpoints || {};
console.log(`   名称: ${card.body?.name || host} | 版本: ${card.body?.version || '-'}`);
console.log(`   声明的端点: ${Object.keys(endpoints).join(', ') || '（无）'}`);
const paid = (card.body?.pricing?.paid || card.body?.services || []).filter(s => (s.cost ?? s.price ?? 0) > 0);
console.log(`   付费项: ${paid.map(s => `${s.id}=${s.cost ?? s.price}`).join(' · ') || '（卡里没写）'}`);

let token = null; let regStatus = null;
const regPath = endpoints.register || `${base}/v1/agents`;
const handle = uniq('pi-arena');
const reg = await get(regPath, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle, name: 'Pi Arena Buyer', secret: `arena_${handle}_${'x'.repeat(12)}` }) });
regStatus = reg.status;
if ([200, 201].includes(reg.status) && reg.body?.token) token = reg.body.token;
console.log(`② 自助开户 ${regPath}: HTTP ${reg.status}${token ? ' → 拿到 token' : `（${reg.body?.error?.code || '无 token'}）`}`);
writeFileSync(path.join(dir, 'registration.json'), JSON.stringify({ at: new Date().toISOString(), path: regPath, status: reg.status, buyerId: reg.body?.buyerId || null }, null, 2));

let trial = null;
if (token && paid[0]) {
  const trialPath = endpoints.trial || `${base}/v1/trials`;
  const input = { productName: 'Pi Arena 买方产品', productDescription: '代表本队采购与验收的 agent', price: 5, targetBuyer: 'agents' };
  const t0 = Date.now();
  const r = await get(trialPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': uniq('trial') },
    body: JSON.stringify({ service: paid[0].id, input }) });
  trial = { service: paid[0].id, http: r.status, status: r.body?.status, ms: Date.now() - t0,
    mode: r.body?.deliveryMode || r.body?.delivery?.pieces?.[0]?.generation?.mode || null,
    charged: r.body?.chargedCredits ?? r.body?.charged ?? null, id: r.body?.id || null, error: r.body?.error?.code || null };
  writeFileSync(path.join(dir, `trial-${trial.service}.json`), JSON.stringify(r.body, null, 2));
  console.log(`③ 免费试用 ${trial.service}: HTTP ${trial.http} status=${trial.status} mode=${trial.mode} ${trial.ms}ms 扣分=${trial.charged} orderId=${trial.id || '-'}`);
}

// 异议与评分（只用实测事实）
const bits = [];
if (!token) bits.push(`没有可自助开户的路径（${regPath} → HTTP ${regStatus}）：第一轮别人的 agent 无法不经人接入`);
if (trial) {
  if (trial.status !== 'delivered') bits.push(`试用未交付（HTTP ${trial.http}${trial.error ? ' ' + trial.error : ''}）：需要给出可重试的失败语义`);
  if (['fallback', 'mock'].includes(trial.mode)) bits.push(`交付模式是 ${trial.mode}（不是真实模型输出）：建议在回执顶层显著标注并给出补偿策略`);
  if (Number(trial.charged) > 0) bits.push(`第一轮试用被扣了 ${trial.charged} 分：规则要求本轮试用免费`);
  if (trial.ms > 30000) bits.push(`单次试用耗时 ${(trial.ms / 1000).toFixed(1)} 秒，接近赛事 5 分钟上限：建议公开时延分位与超时策略`);
}
if (!/evidence/i.test(JSON.stringify(card.body))) bits.push('没有公开可核验的交付统计（时延/失败率/退款原因）：买家只能凭感觉判断可靠性');
if (!paid.length) bits.push('agent-card 里没有可付费项与价格：第二轮别的 agent 无法判断该买什么');
if (!bits.length) bits.push(`试用 ${trial?.service} 交付正常（mode=${trial?.mode}，${trial?.ms}ms，未扣分）：建议补一份失败样本与退款原因分布，便于判断长尾`);

let score = 0;
if (token) score += 5; if (trial?.status === 'delivered') score += 3; if (trial?.mode === 'live') score += 3;
if (/evidence/i.test(JSON.stringify(card.body))) score += 2; if (Number(trial?.charged) === 0) score += 2;
if (trial?.ms && trial.ms < 20000) score += 2; if (paid.length >= 3) score += 1;

const objection = `【第一轮 · 具体异议 → ${host}】\n实测：agent-card HTTP ${card.status}｜自助开户 ${token ? '成功' : '失败'}｜试用 ${trial?.service || '未跑'} → ${trial?.status || '未跑'}（${trial?.ms ?? '-'}ms，mode=${trial?.mode ?? '-'}，扣分 ${trial?.charged ?? '-'}）\n具体异议：\n${bits.slice(0, 3).map((b, i) => `${i + 1}) ${b}`).join('\n')}`;
writeFileSync(path.join(dir, 'objection.txt'), objection + '\n');
console.log(`\n④ 排名建议分：${score}（自助接入+5 / 交付成功+3 / 真实模型+3 / 有证据+2 / 未扣分+2 / 时延<20s+2 / 商品≥3项+1）`);
console.log(`\n⑤ 可直接发到房间的异议草稿（已存 ${dir}/objection.txt）：\n${objection}`);
if (send) {
  const r = spawnSync('npx', ['-y', 'sharednet@latest', 'say', objection], { encoding: 'utf8', timeout: 60000 });
  console.log(r.status === 0 ? '\n✉ 已发到房间' : `\n发送失败：${(r.stderr || '').slice(0, 120)}`);
}
