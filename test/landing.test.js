import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

/** 根路径是给人看的门厅：默认 JSON，浏览器拿 HTML。业务接口仍然只认 Bearer token。 */
test('root 门厅：JSON / HTML 双形态、转义、favicon，且不影响鉴权边界', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'starhall-landing-'));
  const host = await startServer(config({ STARHALL_DATA_DIR: dataDir, STARHALL_PORT: '0', STARHALL_OPEN_REGISTRATION: 'true' })); t.after(() => host.close());

  // 机器：不带 Accept 或 */* 拿到结构化索引
  const json = await fetch(host.url + '/');
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type'), /application\/json/);
  const index = await json.json();
  assert.equal(index.product, 'STARHALL — 星辉舞台');
  assert.ok(index.endpoints.some(e => e.path === '/agent-card.json'));
  assert.match(index.thisPath, /不是接口/);

  // 人：浏览器 Accept 拿到 HTML 门厅
  const html = await fetch(host.url + '/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  const page = await html.text();
  assert.match(page, /STARHALL/);
  assert.match(page, /Running Order/);
  assert.match(page, /Authorization: Bearer/); // 401 的自解释：门厅要说清根路径不是接口

  // 账本里的买家名是用户输入，必须转义
  const registered = await (await fetch(host.url + '/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `xss-${Date.now().toString(36)}`, name: '<img src=x onerror=alert(1)>', secret: 's'.repeat(24) }) })).json();
  await fetch(host.url + '/v1/trials', { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json', 'idempotency-key': 'xss-trial' },
    body: JSON.stringify({ service: 'poem', input: { theme: '转义', recipient: '所有人' } }) });
  const after = await (await fetch(host.url + '/', { headers: { accept: 'text/html' } })).text();
  assert.ok(!after.includes('<img src=x'), '买家名里的 HTML 必须被转义');
  assert.match(after, /&lt;img src=x/);

  // 其余契约不变
  assert.equal((await fetch(host.url + '/favicon.ico')).status, 204);
  assert.equal((await fetch(host.url + '/v1/wallet')).status, 401);
  assert.equal((await fetch(host.url + '/v1/catalog')).status, 200);
  assert.equal((await fetch(host.url + '/', { headers: { origin: 'https://example.invalid' } })).status, 403);
});
