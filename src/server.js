import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { StarHall } from './app.js';
import { config } from './config.js';
import { AppError, ensure, object, string } from './errors.js';
import { fixtureMarket } from './arena.js';
import { VERSION } from './catalog.js';
import { createMcpServer, toolDefinitions } from './mcp.js';
import { buildAgentCard } from './agent-card.js';
import { indexHtml, indexJson, explainHtml, HTML_HEADERS } from './landing.js';
import { evidenceOf } from './evidence.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** 开户限流：按来源地址做小时窗口。计数落在账本状态里，多实例（Vercel）下同样生效。 */
export async function enforceRegistrationLimit(app, req, perHour) {
  if (!perHour) return;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || req.socket?.remoteAddress || 'unknown';
  await app.store.rateLimit({ bucket: 'register', key, perHour });
}

export async function bodyOf(req) {
  ensure(req.headers['content-type']?.split(';')[0] === 'application/json', 'unsupported_media_type', '请求需要 Content-Type: application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= 32768, 'body_too_large', '请求不得超过32KB', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('invalid_json', '无效的 JSON', 400); }
}

/** 只写入口被浏览器点到（Accept: text/html）时返回解释页，而不是让人以为是鉴权问题。 */
function explainWriteOnly(req, res, { path, allow, example, returns, note, base }) {
  if (!String(req.headers.accept || '').includes('text/html')) return false;
  const html = explainHtml({ path, allow, example, returns, note, base });
  res.writeHead(405, { allow, 'content-type': 'text/html; charset=utf-8', ...HTML_HEADERS });
  res.end(html);
  return true;
}

/** 把路由体抽成纯 handler：本地 http.createServer 与 Vercel (`api/index.js`) 共用同一份逻辑。 */
export function createHandler(app, options) {
  const testMarkets = new Map();
  const allowedHosts = options.allowedHosts || [];
  const mcpTools = toolDefinitions({ openRegistration: options.openRegistration }).map(tool => tool.name);
  const cardPaths = ['/agent-card.json', '/.well-known/agent-card.json', '/.well-known/agent.json'];
  return async function handleRequest(req, res) {
    // HEAD 按 GET 路由：探活工具常用 HEAD，Node 不会为 HEAD 发送 body。
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const send = (status, data) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); } };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      ensure(!req.headers.origin, 'browser_origin_denied', '此服务面向 agent/CLI，不接收浏览器跨源调用', 403);
      const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(v => String(v).toLowerCase());
      const hostOk = hosts.some(host => {
        const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        return /^(127\.0\.0\.1|localhost|::1)$/.test(hostname) || allowedHosts.includes(hostname) || allowedHosts.includes(host);
      });
      ensure(hostOk, 'invalid_host', '只接受本机或已声明的 Host（对外部署需设置 STARHALL_ALLOWED_HOSTS）', 403);
      // 云端每请求刷新快照（多实例下别的实例刚写入的账号/订单必须可见）；file/memory 是空操作。
      await app.store.refresh();
      // 门厅：机器拿 JSON（默认），浏览器拿节目单。这里不是 API，业务接口在 /v1/* 与 /mcp。
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/landing')) {
        if (String(req.headers.accept || '').includes('text/html')) {
          // 先渲染再写头：渲染失败时还能由外层返回结构化 500，而不是留下半截响应。
          const html = indexHtml(app, options);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HTML_HEADERS });
          return res.end(html);
        }
        return send(200, indexJson(app, options));
      }
      if (method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end(); }
      // 发现入口：卡片每次请求都从实时目录重算，不落地也不缓存（同 ADR 0021 的 read time 原则）。
      if (method === 'GET' && cardPaths.includes(url.pathname)) {
        return send(200, buildAgentCard(app, { publicBaseUrl: options.publicBaseUrl, openRegistration: options.openRegistration,
          registrationCredits: options.registrationCredits, mcpTools, allowedHosts }));
      }
      // MCP streamable HTTP：无状态，每次请求一个 server，不保留会话。/api/mcp 是业界常用别名。
      if (url.pathname === '/mcp' || url.pathname === '/api/mcp') {
        if (method !== 'POST') {
          if (explainWriteOnly(req, res, { path: '/mcp', allow: 'POST', base: options.publicBaseUrl || '',
            note: 'MCP streamable HTTP 只接受 POST；本部署无状态，不提供 GET SSE 与 DELETE 会话。',
            example: `curl -X POST {base}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
            returns: 'JSON-RPC；tools/list 返回 19 个工具，tools/call 直接调用（免费工具不需要 token）。' })) return;
          res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: 'MCP streamable HTTP 只接受 POST；本部署无状态，不提供 GET SSE 与 DELETE 会话' } }));
        }
        const body = await bodyOf(req);
        const mcp = createMcpServer(app, { openRegistration: options.openRegistration, token: options.mcpToken, registrationCredits: options.registrationCredits });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // 就绪端点：只回答「现在能不能接单」，不回答「交付质量」。
      // 借鉴 ZAAT 的做法：端口在听/健康通过 ≠ 客户端或体验已经验收，所以把这句话写进响应。
      if (method === 'GET' && (url.pathname === '/readiness' || url.pathname === '/ready')) {
        const dbReady = await app.store.probe();
        const checks = {
          store: { ok: Boolean(dbReady) && !app.store.stale, driver: app.store.store, writeConflicts: app.store.writeConflicts ?? 0,
            stale: Boolean(app.store.stale), staleSince: app.store.staleSince ? new Date(app.store.staleSince).toISOString() : null,
            lastLoadedAt: app.store.lastLoadedAt ?? null, lastError: app.store.lastError ?? null },
          model: { ok: options.llm.provider !== 'mock', provider: options.llm.provider, model: options.llm.model || null, fallbackEnabled: Boolean(options.llm.fallback) },
          registration: { ok: Boolean(options.openRegistration), path: '/v1/agents' },
          bookkeeping: { ok: !app.bridge.auditFailed && !app.projectionFailed, auditFailed: Boolean(app.bridge.auditFailed), projectionFailed: Boolean(app.projectionFailed) },
        };
        const ready = Object.values(checks).every(check => check.ok);
        return send(ready ? 200 : 503, { ready, state: ready ? 'ready' : 'degraded', mode: options.mode, round: app.catalog().round.id,
          checks, asOf: new Date().toISOString(),
          scope: '就绪只表示可以接单。交付质量请看 GET /v1/evidence（成功率、时延分位、退款与失败原因），不要把「服务在听」当成「交付合格」。' });
      }
      if (method === 'GET' && url.pathname === '/health') {
        const dbReady = await app.store.probe();
        const storeStale = Boolean(app.store.stale);
        return send(200, { status: app.bridge.auditFailed || app.projectionFailed || !dbReady || storeStale ? 'degraded' : 'ok', product: 'StarHall', version: VERSION,
          storeStale, storeLastLoadedAt: app.store.lastLoadedAt ?? null,
          mode: options.mode || 'local', store: app.store.store, dataSet: app.store.dataSet ?? null, dbReady, round: app.catalog().round.id,
          writeConflicts: app.store.writeConflicts ?? 0,
          kernel: '@aicoo/sharedos@0.1.0-alpha.5', provider: options.llm.provider, fallbackEnabled: options.llm.fallback,
          projectionsReady: !app.projectionFailed,
          mcp: { transport: 'streamable-http', path: '/mcp' }, registration: { open: Boolean(options.openRegistration), path: '/v1/agents', credits: options.registrationCredits }, publicBaseUrl: options.publicBaseUrl || null });
      }
      if (method === 'GET' && url.pathname === '/v1/catalog') {
        const listing = app.catalog();
        if (options.fixtureMarket) listing.market.rehearsal = { catalogUrl: '/v1/test-market/catalog', simulated: true, persistence: 'process-lifetime', currency: 'fixture-credit' };
        return send(200, listing);
      }
      if (options.fixtureMarket && method === 'GET' && url.pathname === '/v1/test-market/catalog') return send(200, { simulated: true, teams: await fixtureMarket().list(),
        endpoints: { trial: '/v1/test-market/try', buy: '/v1/test-market/orders', ranking: '/v1/test-market/rankings', wallet: '/v1/test-market/wallet' },
        note: '本地虚构竞品，非真实参赛队伍；每个身份另有100模拟市场积分，与StarHall消费独立。进程重启后清零重建。' });
      const auth = req.headers.authorization;
      let actor = null;
      if (auth) {
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        try { actor = app.authenticate(token); }
        catch (error) {
          // 快照可能落后（别的实例刚写入身份）：强制回源一次再判，否则新开户的 agent 会白等 2 秒 TTL。
          await app.store.refresh({ force: true });
          actor = app.authenticate(token);
        }
      }
      if (url.pathname === '/v1/agents' && method !== 'POST') {
        // 浏览器点开这个链接的人（评委/队友）应该看到「怎么调」，而不是一句 401。
        const base = options.publicBaseUrl || '';
        const example = `curl -X POST {base}/v1/agents -H 'content-type: application/json' \\\n  -d '{"handle":"your-agent","name":"Your Agent","secret":"<16 字符以上，自行保管>"}'`;
        const returns = '201 { buyerId, token, balance }；token 只返回一次，之后用它调 /v1/orders 与 /v1/trials。';
        const note = '自助开户只接受 POST；浏览器直接打开是 GET，所以不会替你开户。';
        if (explainWriteOnly(req, res, { path: '/v1/agents', allow: 'POST', example, returns, note, base })) return;
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: note },
          howTo: example.replace('{base}', base), returns, documentation: `${base}/agent-card.json` }));
      }
      if (method === 'POST' && url.pathname === '/v1/agents') {
        ensure(options.openRegistration, 'registration_closed', '本部署未开放自助开户，请通过运营方获取 token', 403);
        await enforceRegistrationLimit(app, req, options.registrationLimitPerHour);
        const body = object(await bodyOf(req), ['handle', 'name', 'secret']);
        const registered = await app.registerAgent({ handle: body.handle, name: body.name, secret: body.secret, credits: options.registrationCredits });
        return send(201, { buyerId: registered.account.id, name: registered.account.name, token: registered.token, balance: registered.account.balance,
          currency: 'local-credit', simulated: true, created: registered.created,
          note: registered.created ? '请保管 token：服务端只保存摘要，无法再次取回。' : '同一 handle 与 secret 再次注册会轮换 token，旧 token 立即失效。' });
      }
      // 免费公开证据：第一轮点评的 agent 用可核验事实提异议，第二轮买家用来比较可靠性。
      if (method === 'GET' && url.pathname === '/v1/evidence') return send(200, evidenceOf(app.store.read(), { services: app.catalog().services }));
      // 监视器可声明 X-StarHall-Impressions: none：响应照常返回广告，但不创建任何曝光事件。
      const countImpressions = !/^(none|skip|off|0|false)$/i.test(String(req.headers['x-starhall-impressions'] || ''));
      if (method === 'GET' && url.pathname === '/v1/summary') return send(200, await app.summary(actor || undefined, { countImpressions }));
      if (method === 'GET' && url.pathname === '/v1/market-board') return send(200, await app.marketBoard(actor || undefined, req.headers['idempotency-key'], { countImpressions }));
      // 未知路径先 404：打错 URL 的 agent 不该以为「只是缺 token」。
      // 路由存在但缺 token 的情况仍然 401（不泄露任何额外信息，路由本来就在目录里公开）。
      const knownPath = [
        /^\/v1\/(wallet|wall|ads|commercial-profile|orders|trials|demo|requests|agents)$/,
        /^\/v1\/ads\/[^/]+$/, /^\/v1\/orders\/(by-key|[^/]+)$/, /^\/v1\/orders\/[^/]+\/(refund|revision)$/,
        /^\/v1\/trials\/by-key$/, /^\/v1\/health\/sales-pitch$/, /^\/v1\/practice\/[^/]+\/turns$/,
        /^\/broker\/(status|next|session|receipt|checklist)$/,
        ...(options.fixtureMarket ? [/^\/v1\/test-market\/(wallet|try|orders|rankings)$/] : []),
      ].some(pattern => pattern.test(url.pathname));
      ensure(knownPath, 'not_found', '接口不存在；可用接口见 GET /v1/catalog 与 GET /agent-card.json', 404);
      ensure(actor, 'unauthorized', '需要 Authorization: Bearer <token>（自助开户：POST /v1/agents）', 401);
      const route = `${method} ${url.pathname}`;
      const brokerRoute = { 'GET /broker/status': 'status', 'GET /broker/next': 'next', 'POST /broker/session': 'session',
        'POST /broker/receipt': 'receipt', 'POST /broker/checklist': 'checklist' }[route];
      if (brokerRoute) {
        ensure([...url.searchParams.keys()].every(k => method === 'GET' && k === 'runId') && url.searchParams.getAll('runId').length <= 1, 'invalid_input', '仅GET支持单个runId查询参数');
        const input = method === 'GET' ? { runId: url.searchParams.get('runId') } : await bodyOf(req);
        return send(200, await app.bridge.call(actor.id, 'broker-tracking', `broker_${brokerRoute}`, input));
      }
      if (route === 'GET /v1/commercial-profile') {
        ensure(!url.search, 'invalid_input', '商业档案仅限当前身份，不接受买方选择参数');
        return send(200, await app.commercialProfile(actor));
      }
      if (options.fixtureMarket && url.pathname.startsWith('/v1/test-market/')) {
        if (!testMarkets.has(actor.id)) testMarkets.set(actor.id, fixtureMarket());
        const market = testMarkets.get(actor.id);
        if (route === 'GET /v1/test-market/wallet') return send(200, await market.wallet());
        if (route === 'POST /v1/test-market/try') {
          const body = object(await bodyOf(req), ['productId']); return send(200, await market.try(string(body.productId, 'productId', 80)));
        }
        if (route === 'POST /v1/test-market/orders') {
          const body = object(await bodyOf(req), ['productId']); return send(200, await market.buy(string(body.productId, 'productId', 80), string(req.headers['idempotency-key'], 'Idempotency-Key', 128)));
        }
        if (route === 'POST /v1/test-market/rankings') {
          const body = object(await bodyOf(req), ['ranking', 'reviews']);
          ensure(Array.isArray(body.ranking) && body.ranking.length >= 3 && body.ranking.length <= 16 && body.ranking.every(x => typeof x === 'string'), 'invalid_input', 'ranking 需要至少3个队伍ID');
          ensure(Array.isArray(body.reviews), 'invalid_input', 'reviews 需要试用异议列表');
          return send(200, await market.submitRanking(body.ranking, body.reviews));
        }
      }
      if (route === 'GET /v1/wallet') return send(200, app.wallet(actor));
      if (route === 'GET /v1/wall') return send(200, await app.wall(actor));
      if (route === 'GET /v1/ads') return send(200, app.ads(actor));
      if (method === 'GET' && /^\/v1\/ads\/[^/]+$/.test(url.pathname)) return send(200, app.adById(actor, url.pathname.split('/').at(-1)));
      if (method === 'GET' && url.pathname === '/v1/health/sales-pitch') {
        return send(200, app.salesPitchHealth({ window: url.searchParams.get('window'), testRunId: url.searchParams.get('testRunId') }));
      }
      if (route === 'GET /v1/orders') {
        const orders = app.orders(actor, url.searchParams.get('status'));
        return send(200, { orders, total: orders.length, includes: url.searchParams.get('status') || 'all-statuses' });
      }
      if (route === 'GET /v1/orders/by-key') return send(200, app.orderByKey(actor, req.headers['idempotency-key']));
      if (route === 'GET /v1/trials/by-key') return send(200, app.orderByKey(actor, req.headers['idempotency-key'], true));
      if (method === 'GET' && /^\/v1\/orders\/[^/]+$/.test(url.pathname)) return send(200, app.getOrder(actor, url.pathname.split('/').at(-1)));
      const refund = url.pathname.match(/^\/v1\/orders\/([^/]+)\/refund$/);
      if (method === 'POST' && refund) return send(200, await app.refund(actor, refund[1], await bodyOf(req)));
      const revision = url.pathname.match(/^\/v1\/orders\/([^/]+)\/revision$/);
      if (method === 'POST' && revision) return send(200, await app.revisionRequest(actor, revision[1], await bodyOf(req), req.headers['idempotency-key']));
      if (route === 'POST /v1/orders') {
        const order = await app.order(actor, await bodyOf(req), req.headers['idempotency-key'], { testRunId: req.headers['x-test-run-id'] || null });
        return send(order.status === 'pending' ? 202 : 200, order);
      }
      if (route === 'POST /v1/trials') {
        const order = await app.order(actor, await bodyOf(req), req.headers['idempotency-key'], { trial: true, testRunId: req.headers['x-test-run-id'] || null });
        return send(order.status === 'pending' ? 202 : 200, order);
      }
      if (route === 'POST /v1/demo') return send(200, await app.demo(actor, await bodyOf(req)));
      if (route === 'POST /v1/requests') return send(200, await app.request(actor, await bodyOf(req)));
      const practice = url.pathname.match(/^\/v1\/practice\/([^/]+)\/turns$/);
      if (method === 'POST' && practice) return send(200, await app.practice(actor, practice[1], await bodyOf(req), req.headers['idempotency-key']));
      throw new AppError('not_found', '接口不存在；服务清单见 GET /v1/catalog', 404);
    } catch (error) { send(error instanceof AppError ? error.status : 500, { error: { code: error instanceof AppError ? error.code : 'internal_error', message: error instanceof AppError ? error.message : '服务器内部错误', ...(error instanceof AppError && error.details ? { details: error.details } : {}) } }); }
  };
}

export async function startServer(options = config(), app) {
  app ||= await StarHall.open(options);
  const server = http.createServer(createHandler(app, options));
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.timeout = 130000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); }); }
  catch (e) { await app.close(); throw e; }
  let closing;
  return { server, app, url: `http://${options.host === '::1' ? '[::1]' : options.host}:${server.address().port}`,
    publicUrl: options.publicBaseUrl || null,
    close: () => closing ||= new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }).then(() => app.close()) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const host = await startServer();
    console.log(`StarHall 服务已启动：${host.publicUrl || host.url}\n监听：${host.url}${host.publicUrl ? '（对外地址来自 STARHALL_PUBLIC_BASE_URL）' : ''}\n模型：${host.app.brain.options.provider}；存储：${host.app.store.store}\n服务目录：${host.publicUrl || host.url}/v1/catalog\nMCP（streamable HTTP）：${host.publicUrl || host.url}/mcp；本机 agent 也可用 stdio：npm run mcp\n自助开户：${host.app.access?.openRegistration ? '已开放' : '未开放（需设 STARHALL_OPEN_REGISTRATION=true）'}；运行 npm run demo 可执行独立演练；Ctrl+C 停止。`);
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { host.close().catch(e => { console.error(e.message); process.exitCode = 1; }); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
