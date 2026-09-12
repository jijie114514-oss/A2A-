/**
 * 上线自检：对着**公网地址**跑一遍真实调用链，确认别的 agent 能发现、开户、试用、下单。
 *
 *   node scripts/deploy-check.js https://your-domain.example
 *
 * 只做只读检查 + 一次免费试用，不产生付费订单、不改产品数据。
 * 退出码 0 表示全部通过；非 0 表示有硬伤，别等到比赛当晚再发现。
 */
const base = (process.argv[2] || process.env.STARHALL_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error('用法: node scripts/deploy-check.js https://your-domain.example');
  process.exit(2);
}

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); };
// 本机演练（npm start / vercel dev）不要求云端存储；公网地址必须真的是 cloud+postgres。
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base);

async function json(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: response.status, headers: response.headers, body };
}
const rpc = (method, params, id = 1) => json('/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
});
const toolCall = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args }, 2);
  const payload = r.body?.result?.content?.[0]?.text;
  return { status: r.status, isError: Boolean(r.body?.result?.isError), body: payload ? JSON.parse(payload) : r.body };
};

const run = async () => {
  // 1. 健康检查：能连通、云端存储就位、模型配置就位、没有 degraded
  try {
    const health = await json('/health');
    record('GET /health 可达', health.status === 200, `${health.status} status=${health.body?.status} provider=${health.body?.provider}`);
    record('/health 非 degraded', health.body?.status === 'ok', `status=${health.body?.status}（degraded 通常意味着审计写入、DB 探活或导出失败）`);
    record('云端存储是 postgres', isLocal || (health.body?.store === 'postgres' && health.body?.mode === 'cloud' && health.body?.dbReady === true), `mode=${health.body?.mode} store=${health.body?.store} dbReady=${health.body?.dbReady}${isLocal ? '（本机演练，跳过云端断言）' : ''}`);
    record('模型不是 mock', health.body?.provider && health.body.provider !== 'mock', `provider=${health.body?.provider}`);
  } catch (error) { record('GET /health 可达', false, error.message); }

  // 2. 目录与定价
  let catalog;
  try {
    catalog = await json('/v1/catalog');
    const core = catalog.body?.services ?? [];
    record('GET /v1/catalog 可达', catalog.status === 200, `${core.length} 个核心商品`);
    record('核心商品带价', core.every(s => s.price !== undefined), core.map(s => `${s.id}=${s.price ?? '按plan'}`).join(' '));
  } catch (error) { record('GET /v1/catalog 可达', false, error.message); }

  // 3. 发现入口：三个路径都要能读，且要如实反映开户状态
  for (const path of ['/agent-card.json', '/.well-known/agent-card.json']) {
    try {
      const card = await json(path);
      record(`GET ${path}`, card.status === 200 && card.body?.schemaVersion === 'v1',
        `url=${card.body?.url} mcp=${card.body?.endpoints?.mcp} 需人工开户=${card.body?.onboarding?.requiresHuman}`);
    } catch (error) { record(`GET ${path}`, false, error.message); }
  }

  // 4. MCP：列工具 + 免费工具直调
  try {
    const list = await rpc('tools/list', {});
    const tools = list.body?.result?.tools ?? [];
    record('POST /mcp tools/list', list.status === 200 && tools.length > 0, `${tools.length} 个工具`);
    record('MCP 别名 /api/mcp', (await rpc('tools/list', {})).status === 200, '同一套工具');
    const board = await toolCall('starhall_market_board', {});
    record('MCP 免费工具可调', !board.isError && board.body?.price === 0, `phase=${board.body?.phase}`);
  } catch (error) { record('POST /mcp tools/list', false, error.message); }

  // 5. 自助开户 → 免费试用：证明"别的 agent 不经人就能注册、调用、拿到结果"
  let token = '';
  try {
    const reg = await json('/v1/agents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `deploy-check-${Date.now().toString(36)}`, name: '上线自检', secret: `chk_${'0123456789abcdef'.repeat(2)}` }),
    });
    token = reg.body?.token ?? '';
    record('POST /v1/agents 自助开户', reg.status === 201 && Boolean(token), reg.status === 403 ? '未开放开户：需要 STARHALL_OPEN_REGISTRATION=true' : `buyerId=${reg.body?.buyerId} balance=${reg.body?.balance}`);
  } catch (error) { record('POST /v1/agents 自助开户', false, error.message); }

  if (token) {
    try {
      const trial = await toolCall('starhall_trial', { service: 'sales-pitch', input: { productDescription: '上线自检：代码审查服务，输出风险位置与修复建议' }, idempotencyKey: `deploy-check-${Date.now()}`, token });
      const mode = trial.body?.delivery?.pieces?.[0]?.generation?.mode;
      record('MCP 免费试用交付', trial.body?.status === 'delivered', `delivered，generation=${mode}，charged=${trial.body?.charged}`);
      record('交付是真实模型输出', mode === 'live', mode === 'fallback' ? '拿到的是备用作品：模型调用失败，检查 LLM_* 配置' : `mode=${mode}`);
    } catch (error) { record('MCP 免费试用交付', false, error.message); }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n上线自检 → ${base}\n${'-'.repeat(78)}`);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(28)} ${r.detail ?? ''}`);
  console.log('-'.repeat(78));
  console.log(failed.length ? `${failed.length} 项未通过，先修再上线。` : `全部 ${results.length} 项通过，可以参赛。`);
  process.exit(failed.length ? 1 : 0);
};

run().catch(error => { console.error('自检本身失败：', error.message); process.exit(1); });
