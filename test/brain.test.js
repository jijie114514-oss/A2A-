import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { config } from '../src/config.js';

const options = { provider: 'openai-compatible', apiKey: 'test-secret', model: 'test-model', baseUrl: 'https://example.invalid/v1', timeoutMs: 100, fallback: true };
const input = { theme: '测试', recipient: '队伍' };
test('compatible API sends shared model configuration and parses structured content', async () => {
  let request;
  const brain = new Brain(options, async (url, init) => { request = { url, ...init }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"诗","text":"测试照亮队伍前路"}' } }] })); });
  const work = await brain.generate('star-a', 'poem', input);
  assert.equal(work.generation.mode, 'live'); assert.equal(request.url, 'https://example.invalid/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(request.body).model, 'test-model');
  assert.ok(!JSON.parse(request.body).messages.some(m => m.content.includes('test-secret')));
});
test('Anthropic uses messages endpoint, correct headers, and text blocks', async () => {
  const brain = new Brain({ ...options, provider: 'anthropic' }, async (url, init) => {
    assert.match(url, /\/messages$/); assert.equal(init.headers['x-api-key'], 'test-secret'); assert.ok(init.headers['anthropic-version']);
    assert.equal(JSON.parse(init.body).max_tokens, 2200);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n{"title":"演出","text":"测试照亮队伍前路"}\n```' }] }));
  });
  assert.equal((await brain.generate('star-a', 'poem', input)).generation.mode, 'live');
});
test('DeepSeek V4 Pro configuration sends max_tokens, JSON output and explicit non-thinking mode', async () => {
  const settings = config({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'test-secret',
    LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-v4-pro', LLM_TOKEN_LIMIT_FIELD: 'max_tokens',
    LLM_JSON_OUTPUT: 'true', LLM_THINKING: 'disabled', LLM_FALLBACK: 'false' });
  const brain = new Brain(settings.llm, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(body.model, 'deepseek-v4-pro'); assert.equal(body.max_tokens, 2200);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /JSON 格式示例/);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"星辉","text":"测试照亮队伍前路"}' } }] }));
  });
  const work = await brain.generate('star-a', 'poem', input);
  assert.equal(work.generation.mode, 'live'); assert.equal(work.generation.model, 'deepseek-v4-pro');
});
test('HTTP, malformed JSON and incomplete five-round output fall back explicitly', async () => {
  const replies = [new Response('DO NOT EXPOSE test-secret', { status: 401 }), new Response('broken JSON'),
    new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"模拟","text":"只有一回合","rounds":[]}' } }] }))];
  for (const response of replies) {
    const brain = new Brain(options, async () => response);
    const result = await brain.generate('star-c', 'negotiate', { scenario: '测试' });
    assert.equal(result.generation.mode, 'fallback'); assert.equal(result.rounds.length, 5);
    assert.ok(!JSON.stringify(result).includes('test-secret'));
  }
});
test('timeout enforces deadline even when transport ignores cancellation', async () => {
  const brain = new Brain(options, async () => new Promise(() => {}));
  const start = performance.now(); const result = await brain.generate('star-a', 'poem', input);
  assert.equal(result.generation.mode, 'fallback'); assert.equal(result.generation.reason, 'model_timeout'); assert.ok(performance.now() - start < 1000);
});
test('disabled fallback fails; caller cancellation never triggers delivery fallback', async () => {
  const brain = new Brain({ ...options, fallback: false }, async () => new Response('', { status: 500 }));
  await assert.rejects(brain.generate('star-a', 'poem', input), e => e.code === 'model_http_error');
  const controller = new AbortController();
  const hanging = new Brain(options, async () => new Promise(() => {}));
  const promise = hanging.generate('star-a', 'poem', input, [], controller.signal); controller.abort();
  await assert.rejects(promise, e => e.name === 'AbortError');
});
test('config refuses silent live fallback and unsupported cloud mode', () => {
  assert.throws(() => config({ LLM_PROVIDER: 'openai-compatible' }), e => e.code === 'missing_api_config');
  assert.throws(() => config({ STARHALL_MODE: 'cloud' }), e => e.code === 'unsupported_mode');
  assert.throws(() => config({ STARHALL_HOST: '0.0.0.0' }), e => e.code === 'invalid_config');
  assert.throws(() => config({ LLM_TIMEOUT_MS: '999999' }), e => e.code === 'invalid_config');
  assert.throws(() => config({ LLM_THINKING: 'typo' }), e => e.code === 'invalid_config');
  assert.throws(() => config({ LLM_JSON_OUTPUT: 'yes' }), e => e.code === 'invalid_config');
});

const arkSettings = () => config({ LLM_PROVIDER: 'ark-responses', LLM_API_KEY: 'test-secret', LLM_MODEL: 'doubao-seed-2-0-lite-260428', LLM_JSON_OUTPUT: 'true', LLM_THINKING: 'disabled', LLM_FALLBACK: 'false' }).llm;
const arkReply = (text = '{"title":"测试","text":"测试照亮队伍前路"}') => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Do not deliver this reasoning' }] },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
] });
test('Ark Responses sends input_text, bearer auth, max_output_tokens and JSON format; extracts only assistant output', async () => {
  const brain = new Brain(arkSettings(), async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
    assert.equal(init.headers.authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'error');
    assert.equal(body.model, 'doubao-seed-2-0-lite-260428');
    assert.equal(body.max_output_tokens, 2200); assert.equal(body.max_tokens, undefined); assert.equal(body.messages, undefined);
    assert.equal(body.input[0].role, 'system'); assert.equal(body.input[0].content[0].type, 'input_text');
    assert.match(body.input[0].content[0].text, /JSON/);
    assert.equal(JSON.parse(body.input[1].content[0].text).input.theme, '测试');
    assert.equal(body.store, false); assert.equal(body.stream, false);
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.response_format, undefined);
    assert.ok(!init.body.includes('test-secret'));
    return new Response(JSON.stringify(arkReply()));
  });
  const work = await brain.generate('star-a', 'poem', input);
  assert.equal(work.generation.mode, 'live'); assert.equal(work.generation.provider, 'ark-responses');
  assert.equal(work.text, '测试照亮队伍前路');
});
test('Ark accepts base API URL or complete responses endpoint without doubling the suffix', () => {
  for (const url of ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/responses/']) {
    const llm = config({ LLM_PROVIDER: 'ark-responses', LLM_BASE_URL: url, LLM_MODEL: 'fixture', LLM_API_KEY: 'test-secret' }).llm;
    assert.equal(llm.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  }
  assert.throws(() => config({ LLM_PROVIDER: 'ark-responses' }), e => e.code === 'missing_api_config');
});
test('Ark rejects failed, incomplete, empty and refusal responses even if a valid-looking partial JSON exists', async () => {
  const payloads = [
    { ...arkReply(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { ...arkReply(), status: 'failed', error: { message: 'test-secret must not escape' } },
    { ...arkReply(), status: 'in_progress' }, { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'function_call', arguments: '{}' }] },
    arkReply(''),
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] },
  ];
  for (const payload of payloads) {
    const brain = new Brain(arkSettings(), async () => new Response(JSON.stringify(payload)));
    await assert.rejects(brain.request('JSON', '{}', 100), e => e.code === 'invalid_model_output' && !e.message.includes('test-secret'));
  }
});
test('Ark invalid output preserves bounded repair/fallback, while HTTP auth failure never retries or exposes response body', async () => {
  let calls = 0;
  const brain = new Brain({ ...arkSettings(), fallback: true }, async () => { calls++; return new Response(JSON.stringify(arkReply('{}'))); });
  const work = await brain.generate('star-a', 'poem', input);
  assert.equal(calls, 2); assert.equal(work.generation.mode, 'fallback');
  calls = 0;
  const denied = new Brain(arkSettings(), async () => { calls++; return new Response('test-secret', { status: 401 }); });
  await assert.rejects(denied.generate('star-a', 'poem', input), e => e.code === 'model_http_error' && !e.message.includes('test-secret'));
  assert.equal(calls, 1);
});
