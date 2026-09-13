/**
 * 外部 agent 验收：从公网地址出发，模拟**别的队伍的 agent** 完成真实调用链。
 *
 *   node scripts/agent-acceptance.js https://starhall-a2a.vercel.app
 *
 * 与 deploy-check 的分工：
 *   - deploy-check：只做只读 + 一次免费试用，用来判断「部署是否健康」。
 *   - 本脚本：真的注册两个身份、真的下单、真的走退款与修订、真的买赞助，
 *     并验证幂等、越权隔离、余额边界与错误语义 —— 也就是「别人的 agent 能不能用起来」。
 *
 * 全部走对外协议：先读 Agent Card 自己发现地址，再用 MCP 与 JSON HTTP 两条路调用。
 * 会产生真实订单与（模拟）积分消耗；不产生任何真实付款。
 */
const base = (process.argv[2] || process.env.STARHALL_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!base) { console.error('用法: node scripts/agent-acceptance.js https://your-domain.example'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); return ok; };
const warn = (name, detail) => results.push({ name, ok: true, warning: true, detail });
const step = name => console.log(`\n▸ ${name}`);

const request = async (method, path, { token, key, body, accept } = {}) => {
  const headers = { ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: response.status, headers: response.headers, body: parsed };
};

const rpc = async (method, params, id = 1) => {
  const r = await request('POST', '/mcp', { accept: 'application/json, text/event-stream', body: { jsonrpc: '2.0', id, method, params } });
  return { status: r.status, body: r.body };
};
const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args }, 2);
  const text = r.body?.result?.content?.[0]?.text;
  return { status: r.status, isError: Boolean(r.body?.result?.isError), body: text ? JSON.parse(text) : r.body };
};
const unique = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const PITCH = { service: 'sales-pitch', input: { productName: '外部验收产品', productDescription: '一个把代码审查结果转成结构化风险清单的服务，供别的 agent 调用', price: 12, targetBuyer: 'coding agents' } };

const run = async () => {
  // ── 1. 发现：只读 Agent Card，像第一次见到这个产品一样 ─────────────────────────
  step('发现（Agent Card → 接口地址）');
  const card = await request('GET', '/agent-card.json');
  const links = card.body?.endpoints || {};
  check('GET /agent-card.json 可读', card.status === 200 && card.body?.schemaVersion === 'v1', `schemaVersion=${card.body?.schemaVersion}`);
  check('对外地址与请求地址一致', String(links.mcp || '').startsWith(base), `mcp=${links.mcp}`);
  const wellKnown = await request('GET', '/.well-known/agent-card.json');
  check('well-known 别名可读', wellKnown.status === 200, `url=${wellKnown.body?.url}`);
  check('无需人工开户（自助开户已开放）', links.register === `${base}/v1/agents` && card.body?.onboarding?.requiresHuman === false, `register=${links.register}`);
  check('Agent Card 说明两轮该做什么', Boolean(card.body?.howToParticipate?.roundOne && card.body?.howToParticipate?.roundTwo), `round=${card.body?.round?.id}`);

  const catalog = (await request('GET', '/v1/catalog')).body;
  // 可付费 = 直接标价，或按 plan 标价（priceFrom）；两种都要能被一眼看懂
  const payable = (catalog.services || []).filter(s => s.price > 0 || s.priceFrom > 0);
  const priced = payable.map(s => s.price > 0 ? `${s.id}=${s.price}` : `${s.id}=plan ${s.plans ? Object.values(s.plans).map(p => p.price).join('/') : s.priceFrom}`);
  check('目录列出可付费服务与价格', payable.length >= 5 && payable.every(s => s.price > 0 || Number.isInteger(s.priceFrom)), priced.join(' '));
  check('按 plan 计价的服务标明是付费', (catalog.services || []).filter(s => s.plans).every(s => s.pricing === 'by-plan' && s.priceFrom > 0), 'star-sponsorship pricing=by-plan priceFrom=' + (catalog.services.find(s => s.id === 'star-sponsorship')?.priceFrom ?? 'n/a'));
  check('目录给出试用政策与交付预算', catalog.round?.trialPolicy?.price === 0 && catalog.delivery?.hardTimeoutSeconds > 0, `trial=0 分, 交付上限=${catalog.delivery?.hardTimeoutSeconds}s`);

  // ── 2. MCP：另一条协议也要能用 ────────────────────────────────────────────────
  step('MCP（streamable HTTP，无 token 的免费工具）');
  const tools = (await rpc('tools/list', {})).body?.result?.tools || [];
  check('tools/list 返回工具清单', tools.length >= 15, `${tools.length} 个工具`);
  check('含付费下单与试用工具', tools.some(t => t.name.startsWith('starhall_buy_')) && tools.some(t => t.name === 'starhall_trial'), tools.filter(t => /buy_|trial/.test(t.name)).map(t => t.name).join(' '));
  const mcpCatalog = await callTool('starhall_catalog', {});
  check('MCP 免费工具可直调（不需 token）', !mcpCatalog.isError && (mcpCatalog.body?.services || []).length > 0, `services=${mcpCatalog.body?.services?.length}`);
  const mcpEvidence = await callTool('starhall_evidence', {});
  check('MCP 可读公开证据', !mcpEvidence.isError && Array.isArray(mcpEvidence.body?.claims) && mcpEvidence.body.whatWeDoNotClaim?.length > 0, `claims=${mcpEvidence.body?.claims?.length}, 不主张=${mcpEvidence.body?.whatWeDoNotClaim?.length} 条`);

  // ── 3. 开户：两个独立身份 ────────────────────────────────────────────────────
  step('自助开户（两个身份，验证隔离）');
  const register = async label => {
    const handle = unique(`acc-${label}`);
    const r = await request('POST', '/v1/agents', { body: { handle, name: `验收-${label}`, secret: `secret_${handle}_0123456789` } });
    return { handle, ...r };
  };
  const agentA = await register('a'); const agentB = await register('b');
  check('POST /v1/agents 开户成功', agentA.status === 201 && agentB.status === 201, `A=${agentA.body?.buyerId} B=${agentB.body?.buyerId}`);
  check('开户即得可用身份与余额', agentA.body?.token?.length >= 32 && agentA.body?.balance === 100, `balance=${agentA.body?.balance}`);
  const A = { token: agentA.body.token, id: agentA.body.buyerId }; const B = { token: agentB.body.token, id: agentB.body.buyerId };
  const wallet = async who => (await request('GET', '/v1/wallet', { token: who.token })).body;
  check('钱包只读自己的身份', (await wallet(A)).buyerId === A.id && (await wallet(B)).buyerId === B.id, `${(await wallet(A)).balance} / ${(await wallet(B)).balance}`);

  // ── 4. 第一轮任务：免费试用（不花钱） ────────────────────────────────────────
  step('第一轮能力：免费试用（MCP 调用，0 花费）');
  const trial = await callTool('starhall_trial', { service: PITCH.service, input: PITCH.input, idempotencyKey: unique('trial-a'), token: A.token });
  const trialBody = trial.body || {};
  check('MCP 试用交付成功', !trial.isError && trialBody.status === 'delivered', `status=${trialBody.status} charged=${trialBody.chargedCredits}`);
  check('试用不扣分', trialBody.chargedCredits === 0 && (await wallet(A)).balance === 100, `balance=${(await wallet(A)).balance}`);
  const mode = trialBody.delivery?.pieces?.[0]?.generation?.mode;
  if (mode === 'live') check('交付来自真实模型', true, `generation=${mode}`);
  else warn('交付来自真实模型', `generation=${mode}（备用交付：模型调用失败，产品仍按约定标记并交付）`);
  const pieces = trialBody.delivery?.pieces || [];
  const usable = pieces.length > 0 && pieces.every(p => typeof p.text === 'string' && p.text.trim().length > 0);
  check('交付内容非空、可直接引用', usable, `pieces=${pieces.length}, text=${(pieces[0]?.text || '').length} 字符`);
  const second = await callTool('starhall_trial', { service: PITCH.service, input: PITCH.input, idempotencyKey: unique('trial-a2'), token: A.token });
  check('同一服务不能重复白嫖', second.isError && /trial_used/.test(JSON.stringify(second.body)), second.body?.error?.code);

  const trialB = await request('POST', '/v1/trials', { token: B.token, key: unique('trial-b'), body: PITCH });
  check('另一个身份可以独立试用同一服务', trialB.status === 200 && trialB.body?.status === 'delivered', `B status=${trialB.body?.status}`);

  // ── 5. 第二轮任务：付费下单 + 幂等 + 隔离 ────────────────────────────────────
  step('第二轮能力：付费下单、幂等、越权隔离');
  const orderKey = unique('paid-a');
  const paid = await request('POST', '/v1/orders', { token: A.token, key: orderKey, body: PITCH });
  check('HTTP 付费下单交付', paid.status === 200 && paid.body?.status === 'delivered', `status=${paid.body?.status} charged=${paid.body?.chargedCredits}`);
  check('按目录价扣分', paid.body?.chargedCredits === 5 && (await wallet(A)).balance === 95, `charged=${paid.body?.chargedCredits} balance=${(await wallet(A)).balance}`);
  const replay = await request('POST', '/v1/orders', { token: A.token, key: orderKey, body: PITCH });
  check('同一幂等键重试不重复扣款', replay.body?.id === paid.body?.id && (await wallet(A)).balance === 95, `id 相同=${replay.body?.id === paid.body?.id} balance=${(await wallet(A)).balance}`);
  const byKey = await request('GET', '/v1/orders/by-key', { token: A.token, key: orderKey });
  check('可按幂等键查回原单', byKey.status === 200 && byKey.body?.id === paid.body?.id, `id=${byKey.body?.id}`);
  const cross = await request('GET', `/v1/orders/${paid.body.id}`, { token: B.token });
  check('别的身份读不到我的订单（越权隔离）', cross.status === 404, `B 读 A 的单 → HTTP ${cross.status}`);
  const conflict = await request('POST', '/v1/orders', { token: A.token, key: orderKey, body: { ...PITCH, message: '改了内容' } });
  check('幂等键内容冲突被拒绝', conflict.status === 409 && conflict.body?.error?.code === 'idempotency_conflict', `HTTP ${conflict.status} ${conflict.body?.error?.code}`);

  // ── 6. 退款与修订：机器的判定要可解释 ────────────────────────────────────────
  step('售后：机器仲裁退款与一次免费修订');
  const refund1 = await request('POST', `/v1/orders/${paid.body.id}/refund`, { token: A.token, body: { reason: '我就是不想要了' } });
  check('主观不满被机器拒绝并给出补救', refund1.body?.decision === 'DECLINED' && refund1.body?.remedy === 'ONE_FREE_REVISION', `${refund1.body?.decision}/${refund1.body?.remedy}`);
  const revision = await request('POST', `/v1/orders/${paid.body.id}/revision`, { token: A.token, key: unique('rev'), body: { notes: '把第一段改短，并补一个可核验的例子' } });
  check('免费修订可执行且不扣款', revision.status === 200 && revision.body?.revisionUsed === true && revision.body?.chargedCredits === 0, `used=${revision.body?.revisionUsed} charged=${revision.body?.chargedCredits}`);
  const refund2 = await request('POST', `/v1/orders/${paid.body.id}/refund`, { token: A.token, body: { reason: '再试一次' } });
  check('修订用完后不再给补救', refund2.body?.decision === 'DECLINED' && refund2.body?.remedy === null, `${refund2.body?.decision}/${refund2.body?.remedy}`);

  // ── 7. 赞助（卖家侧的另一种收入）与余额边界 ──────────────────────────────────
  step('赞助购买与余额边界');
  const sponsor = await request('POST', '/v1/orders', { token: A.token, key: unique('sponsor'), body: { service: 'star-sponsorship', input: { starId: 'star-b', plan: 'delivery', advertiser: '外部验收队', adCopy: '验收专用：外部 agent 真实投放的展示位。' } } });
  check('赞助按 plan 计价并即时生效', sponsor.body?.status === 'delivered' && (await wallet(A)).balance === 90, `charged=${sponsor.body?.chargedCredits} balance=${(await wallet(A)).balance}`);
  const ads = await request('GET', '/v1/ads', { token: A.token });
  check('买家能查到自己的投放与曝光计数', (ads.body?.ads || []).length === 1 && ads.body.ads[0].advertiser === '外部验收队', `ads=${ads.body?.ads?.length} currentImpressions=${ads.body?.ads?.[0]?.currentImpressions}`);

  const spender = await register('c');
  const C = { token: spender.body.token, id: spender.body.buyerId };
  for (let i = 0; i < 3; i++) await request('POST', '/v1/orders', { token: C.token, key: unique(`diag-${i}`), body: { service: 'commercial-diagnostic', input: { goal: '找出下一步该验证什么' } } });
  const broke = await request('POST', '/v1/orders', { token: C.token, key: unique('diag-over'), body: { service: 'commercial-diagnostic', input: { goal: '再买一次' } } });
  check('余额不足时正确拒绝（不产生欠款）', broke.status === 402 && broke.body?.error?.code === 'insufficient_balance', `HTTP ${broke.status} ${broke.body?.error?.code} balance=${(await wallet(C)).balance}`);

  // ── 8. 错误语义：让对方的 agent 知道下一步怎么做 ─────────────────────────────
  step('错误语义（对接方最容易踩的四种）');
  const noToken = await request('GET', '/v1/wallet');
  check('缺 token → 401 且说清怎么开户', noToken.status === 401 && /POST \/v1\/agents/.test(noToken.body?.error?.message || ''), noToken.body?.error?.message);
  const badToken = await request('GET', '/v1/wallet', { token: 'not-a-real-token' });
  check('错 token → 401', badToken.status === 401, badToken.body?.error?.code);
  const typo = await request('GET', '/v1/walelt');
  check('路径打错 → 404（不是 401）', typo.status === 404, `HTTP ${typo.status}`);
  const wrongMethod = await request('GET', '/v1/agents', { accept: 'application/json' });
  check('只写入口用 GET → 405 + howTo', wrongMethod.status === 405 && wrongMethod.headers.get('allow') === 'POST' && Boolean(wrongMethod.body?.howTo), `allow=${wrongMethod.headers.get('allow')}`);

  // ── 9. 公开事实要跟着真实行为更新 ───────────────────────────────────────────
  step('账本与公开事实一致');
  const board = (await request('GET', '/v1/market-board')).body;
  check('行情榜计入本次真实消费', board.ranking?.reduce((n, r) => n + r.fanSupport + r.sponsorSupport, 0) > 0 && board.round?.id, `支持分合计=${board.ranking?.reduce((n, r) => n + r.fanSupport + r.sponsorSupport, 0)} 轮次=${board.round?.id}`);
  const summary = (await request('GET', '/v1/summary')).body;
  check('墙上出现本次交付', (summary.latest || []).some(w => w.buyerName === `验收-a` || w.buyerName === `验收-b` || w.buyerName === `验收-c`), `最近 ${summary.latest?.length} 条`);
  const evidence = (await request('GET', '/v1/evidence')).body;
  const delivered = evidence.claims.find(c => c.claim.startsWith('成功交付数'))?.value ?? 0;
  check('公开证据的交付计数 ≥ 本次动作', delivered >= 6, `成功交付=${delivered}`);
  check('公开证据显式标注不主张什么', (evidence.whatWeDoNotClaim || []).length >= 4, `${evidence.whatWeDoNotClaim?.length} 条`);

  const failed = results.filter(r => !r.ok);
  const warned = results.filter(r => r.warning);
  console.log(`\n外部 agent 验收 → ${base}\n${'-'.repeat(86)}`);
  for (const r of results) console.log(`${r.ok ? (r.warning ? '!' : '✓') : '✗'} ${r.name.padEnd(38)} ${r.detail ?? ''}`);
  console.log('-'.repeat(86));
  console.log(failed.length ? `${failed.length} 项未通过。` : `${results.length} 项通过${warned.length ? `（${warned.length} 项为提示）` : ''}：别的 agent 可以自行发现、开户、试用、下单、售后。`);
  process.exit(failed.length ? 1 : 0);
};

run().catch(error => { console.error('验收脚本自身失败：', error.stack || error.message); process.exit(1); });
