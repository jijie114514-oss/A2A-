import path from 'node:path';
import { ensure } from './errors.js';
import { MARKET_DEFAULTS } from './market.js';

export function config(env = process.env) {
  const mode = env.STARHALL_MODE || 'local';
  ensure(['local', 'cloud'].includes(mode), 'unsupported_mode', 'STARHALL_MODE 只能是 local 或 cloud');
  const store = env.STARHALL_STORE || (mode === 'cloud' ? 'postgres' : 'file');
  ensure(['file', 'memory', 'postgres'].includes(store), 'invalid_config', 'STARHALL_STORE 只能是 file、memory 或 postgres');
  const databaseUrl = env.DATABASE_URL || '';
  if (store === 'postgres') {
    ensure(databaseUrl, 'invalid_config', 'STARHALL_STORE=postgres 需要 DATABASE_URL（Neon 连接串）');
    let dbUrl;
    try { dbUrl = new URL(databaseUrl); } catch { ensure(false, 'invalid_config', 'DATABASE_URL 不是有效 URL'); }
    ensure(['postgres:', 'postgresql:'].includes(dbUrl.protocol), 'invalid_config', 'DATABASE_URL 需要 postgres:// 或 postgresql:// 协议');
  }
  const provider = env.LLM_PROVIDER || 'mock';
  ensure(['mock', 'openai-compatible', 'anthropic', 'ark-responses'].includes(provider), 'invalid_config', '未知 LLM_PROVIDER');
  const host = env.STARHALL_HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const allowedHosts = (env.STARHALL_ALLOWED_HOSTS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  for (const entry of allowedHosts) ensure(/^[a-z0-9.-]+(:\d+)?$/.test(entry), 'invalid_config', 'STARHALL_ALLOWED_HOSTS 只能是主机名（可带端口），不能含协议或路径');
  // Fail closed：绑定非本机地址必须先声明接受哪些 Host，避免无意中把服务暴露到公网。
  ensure(loopback || allowedHosts.length > 0, 'invalid_config', '绑定非本机地址需要同时设置 STARHALL_ALLOWED_HOSTS=你的域名');
  const publicBaseUrl = env.STARHALL_PUBLIC_BASE_URL || '';
  if (publicBaseUrl) { let publicUrl; try { publicUrl = new URL(publicBaseUrl); } catch { ensure(false, 'invalid_config', 'STARHALL_PUBLIC_BASE_URL 不是有效 URL'); }
    ensure(publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && loopback), 'invalid_config', '对外地址需要 HTTPS');
    ensure(!publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash, 'invalid_config', '对外地址不能含凭据、查询或片段'); }
  const openRegistration = env.STARHALL_OPEN_REGISTRATION === 'true';
  const registrationCredits = Number(env.STARHALL_REGISTRATION_CREDITS ?? 100);
  ensure(Number.isInteger(registrationCredits) && registrationCredits >= 0 && registrationCredits <= 1000000, 'invalid_config', 'STARHALL_REGISTRATION_CREDITS 需要 0–1000000 的整数');
  // 赛程一轮里别的 agent 可能从同一出口 IP（云沙箱/NAT）批量开户，默认给足额度；
// 真正的兜底是 STARHALL_REGISTRATION_CREDITS 与 store 里的 maxAccounts（默认 500）。
  const registrationLimitPerHour = Number(env.STARHALL_REGISTRATION_LIMIT_PER_HOUR ?? 200);
  ensure(Number.isInteger(registrationLimitPerHour) && registrationLimitPerHour >= 0, 'invalid_config', 'STARHALL_REGISTRATION_LIMIT_PER_HOUR 需要非负整数（0 表示不限制）');
  const port = Number(env.STARHALL_PORT || 4317);
  ensure(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid_config', '端口无效');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 45000);
  ensure(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 45000, 'invalid_config', 'LLM_TIMEOUT_MS 范围为 100–45000');
  const baseUrl = env.LLM_BASE_URL || (provider === 'ark-responses' ? 'https://ark.cn-beijing.volces.com/api/v3' : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  let url;
  try { url = new URL(baseUrl); } catch { ensure(false, 'invalid_config', 'LLM_BASE_URL 不是有效 URL'); }
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'invalid_config', '模型地址需要 HTTPS，本机地址可用 HTTP');
  ensure(!url.username && !url.password && !url.search && !url.hash, 'invalid_config', '模型地址不能含凭据、查询或片段');
  if (provider !== 'mock') ensure(env.LLM_API_KEY && env.LLM_MODEL, 'missing_api_config', '真实模型模式需要 LLM_API_KEY 和 LLM_MODEL');
  const tokenLimitField = env.LLM_TOKEN_LIMIT_FIELD || 'max_completion_tokens';
  ensure(['max_completion_tokens', 'max_tokens'].includes(tokenLimitField), 'invalid_config', 'LLM_TOKEN_LIMIT_FIELD 无效');
  const thinking = env.LLM_THINKING || 'default';
  ensure(['default', 'enabled', 'disabled'].includes(thinking), 'invalid_config', 'LLM_THINKING 只能为 default、enabled 或 disabled');
  ensure(['true', 'false'].includes(env.LLM_JSON_OUTPUT || 'false'), 'invalid_config', 'LLM_JSON_OUTPUT 只能为 true 或 false');
  ensure(provider !== 'anthropic' || (thinking === 'default' && env.LLM_JSON_OUTPUT !== 'true'), 'invalid_config', '当前 thinking / JSON 输出选项仅用于 OpenAI 兼容或方舟 Responses 协议');
  const sponsorSupportWeight = Number(env.SPONSOR_SUPPORT_WEIGHT ?? MARKET_DEFAULTS.sponsorSupportWeight);
  ensure(Number.isFinite(sponsorSupportWeight) && sponsorSupportWeight >= 0 && sponsorSupportWeight <= 10, 'invalid_config', 'SPONSOR_SUPPORT_WEIGHT 范围为0–10');
  let exposureMultipliers;
  try { exposureMultipliers = env.STAR_EXPOSURE_MULTIPLIERS ? JSON.parse(env.STAR_EXPOSURE_MULTIPLIERS) : MARKET_DEFAULTS.exposureMultipliers; } catch { ensure(false, 'invalid_config', 'STAR_EXPOSURE_MULTIPLIERS 需要JSON数组'); }
  ensure(Array.isArray(exposureMultipliers) && exposureMultipliers.length === 3 && exposureMultipliers.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100) && exposureMultipliers[0] >= exposureMultipliers[1] && exposureMultipliers[1] >= exposureMultipliers[2], 'invalid_config', '需要三个递减或相等的正数曝光权重');
  const phase = env.STARHALL_MARKET_PHASE || 'AUTO';
  ensure(['AUTO', 'PRE-MARKET', 'MARKET LIVE'].includes(phase), 'invalid_config', '市场阶段需要AUTO、PRE-MARKET或MARKET LIVE');
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  // 官方身份：本地默认不配置，行为与 0.5.0-local 完全一致。见 docs/MCP.md。
  const tenantId = env.STARHALL_TENANT_ID || '';
  if (tenantId) ensure(/^[A-Za-z0-9._:-]{3,120}$/.test(tenantId), 'invalid_config', 'STARHALL_TENANT_ID 只能是字母数字与 . _ : -，长度 3–120');
  const ownerAddress = env.STARHALL_OWNER_ADDRESS || '';
  if (ownerAddress) ensure(/^[A-Za-z0-9._:-]{3,120}$/.test(ownerAddress), 'invalid_config', 'STARHALL_OWNER_ADDRESS 只能是字母数字与 . _ : -，长度 3–120');
  const ownerKind = env.STARHALL_OWNER_KIND || 'human';
  ensure(['human', 'agent'].includes(ownerKind), 'invalid_config', 'STARHALL_OWNER_KIND 只能为 human 或 agent');
  let agentAddresses = {};
  if (env.STARHALL_AGENT_ADDRESSES) {
    try { agentAddresses = JSON.parse(env.STARHALL_AGENT_ADDRESSES); } catch { ensure(false, 'invalid_config', 'STARHALL_AGENT_ADDRESSES 需要 JSON 对象'); }
    ensure(agentAddresses && typeof agentAddresses === 'object' && !Array.isArray(agentAddresses), 'invalid_config', 'STARHALL_AGENT_ADDRESSES 需要 JSON 对象，例如 {"star-a":"<节点地址>"}');
    for (const [id, value] of Object.entries(agentAddresses)) {
      ensure(/^[a-z][a-z0-9-]{1,39}$/.test(id), 'invalid_config', `STARHALL_AGENT_ADDRESSES 的键 ${id} 需要是内部标识（star-a、star-b、star-c、ledger、broker）`);
      ensure((typeof value === 'string' && value.length >= 3 && value.length <= 200) || (value && typeof value === 'object' && typeof value.kind === 'string' && (value.agentId || value.userId)),
        'invalid_config', `STARHALL_AGENT_ADDRESSES.${id} 需要是地址字符串或 {kind, agentId|userId} 对象`);
    }
  }
  const identity = { namespaceId: tenantId || undefined, owner: ownerAddress ? { kind: ownerKind, [ownerKind === 'agent' ? 'agentId' : 'userId']: ownerAddress } : undefined,
    addresses: Object.keys(agentAddresses).length ? agentAddresses : undefined };
  const access = (publicBaseUrl || openRegistration || allowedHosts.length > 0) ? {
    publicBaseUrl: publicBaseUrl || null, allowedHosts, openRegistration: openRegistration,
    mcp: { transport: 'streamable-http', path: '/mcp', stdio: 'node scripts/mcp-server.js' },
    onboarding: openRegistration ? { method: 'POST', path: '/v1/agents', requiresHuman: false }
      : { method: null, requiresHuman: true, note: '未开放自助开户；请通过运营方获取 token' },
    note: 'MCP、JSON HTTP 与 CLI 调用同一套内核授权、账本与审计；没有第二条绕过 grants 的路径。',
  } : undefined;
  return { mode, store, databaseUrl, host, allowedHosts, publicBaseUrl, openRegistration, registrationCredits, registrationLimitPerHour, mcpToken: env.STARHALL_MCP_TOKEN || '', access, identity, port, market: { sponsorSupportWeight, exposureMultipliers, phase }, fixtureMarket: env.STARHALL_FIXTURE_MARKET === 'true',
    // 云端没有可写的持久目录，dataDir 只在 file 驱动下有意义（保留字段以免破坏本地脚本）。
    dataDir: store === 'file' ? path.resolve(env.STARHALL_DATA_DIR || 'data') : null, llm: {
    provider, apiKey: env.LLM_API_KEY || '', model: env.LLM_MODEL || '', baseUrl: provider === 'ark-responses' ? normalizedBase.replace(/\/responses$/, '') : normalizedBase, timeoutMs, fallback: env.LLM_FALLBACK !== 'false', tokenLimitField,
    thinking, jsonOutput: env.LLM_JSON_OUTPUT === 'true',
  } };
}
