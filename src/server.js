import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StarHall } from './app.js';
import { config } from './config.js';
import { AppError, ensure, object, string } from './errors.js';
import { fixtureMarket } from './arena.js';
import { VERSION } from './catalog.js';

async function bodyOf(req) {
  ensure(req.headers['content-type']?.split(';')[0] === 'application/json', 'unsupported_media_type', '请求需要 Content-Type: application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= 32768, 'body_too_large', '请求不得超过32KB', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('invalid_json', '无效的 JSON', 400); }
}
export async function startServer(options = config(), app) {
  app ||= await StarHall.open(options);
  const testMarkets = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); } };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      ensure(!req.headers.origin, 'browser_origin_denied', '此服务面向 agent/CLI，不接收浏览器跨源调用', 403);
      const host = req.headers.host || '';
      ensure(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host), 'invalid_host', '只接受本机 Host', 403);
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: app.bridge.auditFailed || app.projectionFailed ? 'degraded' : 'ok', product: 'StarHall', version: VERSION, mode: 'local', dataSet: path.basename(options.dataDir), kernel: '@aicoo/sharedos@0.1.0-alpha.5', provider: options.llm.provider, fallbackEnabled: options.llm.fallback, cloudConnected: false, projectionsReady: !app.projectionFailed });
      if (req.method === 'GET' && url.pathname === '/v1/catalog') {
        const listing = app.catalog();
        if (options.fixtureMarket) listing.market.rehearsal = { catalogUrl: '/v1/test-market/catalog', simulated: true, persistence: 'process-lifetime', currency: 'fixture-credit' };
        return send(200, listing);
      }
      if (options.fixtureMarket && req.method === 'GET' && url.pathname === '/v1/test-market/catalog') return send(200, { simulated: true, teams: await fixtureMarket().list(),
        endpoints: { trial: '/v1/test-market/try', buy: '/v1/test-market/orders', ranking: '/v1/test-market/rankings', wallet: '/v1/test-market/wallet' },
        note: '本地虚构竞品，非真实参赛队伍；每个身份另有100模拟市场积分，与StarHall消费独立。进程重启后清零重建。' });
      const auth = req.headers.authorization;
      const actor = auth ? app.authenticate(auth.startsWith('Bearer ') ? auth.slice(7) : '') : null;
      if (req.method === 'GET' && url.pathname === '/v1/summary') return send(200, await app.summary(actor || undefined));
      if (req.method === 'GET' && url.pathname === '/v1/market-board') return send(200, await app.marketBoard(actor || undefined, req.headers['idempotency-key']));
      ensure(actor, 'unauthorized', '需要 Authorization: Bearer <token>', 401);
      const route = `${req.method} ${url.pathname}`;
      const brokerRoute = { 'GET /broker/status': 'status', 'GET /broker/next': 'next', 'POST /broker/session': 'session',
        'POST /broker/receipt': 'receipt', 'POST /broker/checklist': 'checklist' }[route];
      if (brokerRoute) {
        ensure([...url.searchParams.keys()].every(k => req.method === 'GET' && k === 'runId') && url.searchParams.getAll('runId').length <= 1, 'invalid_input', '仅GET支持单个runId查询参数');
        const input = req.method === 'GET' ? { runId: url.searchParams.get('runId') } : await bodyOf(req);
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
      if (req.method === 'GET' && /^\/v1\/ads\/[^/]+$/.test(url.pathname)) return send(200, app.adById(actor, url.pathname.split('/').at(-1)));
      if (req.method === 'GET' && url.pathname === '/v1/health/sales-pitch') {
        return send(200, app.salesPitchHealth({ window: url.searchParams.get('window'), testRunId: url.searchParams.get('testRunId') }));
      }
      if (route === 'GET /v1/orders') {
        const orders = app.orders(actor, url.searchParams.get('status'));
        return send(200, { orders, total: orders.length, includes: url.searchParams.get('status') || 'all-statuses' });
      }
      if (route === 'GET /v1/orders/by-key') return send(200, app.orderByKey(actor, req.headers['idempotency-key']));
      if (route === 'GET /v1/trials/by-key') return send(200, app.orderByKey(actor, req.headers['idempotency-key'], true));
      if (req.method === 'GET' && /^\/v1\/orders\/[^/]+$/.test(url.pathname)) return send(200, app.getOrder(actor, url.pathname.split('/').at(-1)));
      const refund = url.pathname.match(/^\/v1\/orders\/([^/]+)\/refund$/);
      if (req.method === 'POST' && refund) return send(200, await app.refund(actor, refund[1], await bodyOf(req)));
      const revision = url.pathname.match(/^\/v1\/orders\/([^/]+)\/revision$/);
      if (req.method === 'POST' && revision) return send(200, await app.revisionRequest(actor, revision[1], await bodyOf(req), req.headers['idempotency-key']));
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
      if (req.method === 'POST' && practice) return send(200, await app.practice(actor, practice[1], await bodyOf(req), req.headers['idempotency-key']));
      throw new AppError('not_found', '接口不存在；服务清单见 GET /v1/catalog', 404);
    } catch (error) { send(error instanceof AppError ? error.status : 500, { error: { code: error instanceof AppError ? error.code : 'internal_error', message: error instanceof AppError ? error.message : '服务器内部错误', ...(error instanceof AppError && error.details ? { details: error.details } : {}) } }); }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.timeout = 130000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); }); }
  catch (e) { await app.close(); throw e; }
  let closing;
  return { server, app, url: `http://${options.host === '::1' ? '[::1]' : options.host}:${server.address().port}`,
    close: () => closing ||= new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }).then(() => app.close()) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const host = await startServer();
    console.log(`StarHall 本地服务已启动：${host.url}\n模型：${host.app.brain.options.provider}；云端：未接入\n服务目录：${host.url}/v1/catalog\n运行 npm run demo 可执行独立演练；Ctrl+C 停止。`);
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { host.close().catch(e => { console.error(e.message); process.exitCode = 1; }); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
