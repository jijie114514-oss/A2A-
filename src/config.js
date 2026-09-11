import path from 'node:path';
import { ensure } from './errors.js';
import { MARKET_DEFAULTS } from './market.js';

export function config(env = process.env) {
  const mode = env.STARHALL_MODE || 'local';
  ensure(mode === 'local', 'unsupported_mode', '当前仅支持本地版；尚未实现托管内核与 SharedNet 接入');
  const provider = env.LLM_PROVIDER || 'mock';
  ensure(['mock', 'openai-compatible', 'anthropic', 'ark-responses'].includes(provider), 'invalid_config', '未知 LLM_PROVIDER');
  const host = env.STARHALL_HOST || '127.0.0.1';
  ensure(['127.0.0.1', '::1', 'localhost'].includes(host), 'invalid_config', '本地版仅绑定 loopback 地址');
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
  return { mode, host, port, market: { sponsorSupportWeight, exposureMultipliers, phase }, fixtureMarket: env.STARHALL_FIXTURE_MARKET === 'true', dataDir: path.resolve(env.STARHALL_DATA_DIR || 'data'), llm: {
    provider, apiKey: env.LLM_API_KEY || '', model: env.LLM_MODEL || '', baseUrl: provider === 'ark-responses' ? normalizedBase.replace(/\/responses$/, '') : normalizedBase, timeoutMs, fallback: env.LLM_FALLBACK !== 'false', tokenLimitField,
    thinking, jsonOutput: env.LLM_JSON_OUTPUT === 'true',
  } };
}
