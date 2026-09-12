import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { createHandler } from '../src/server.js';

/**
 * Vercel 入口：一个函数承载全部路由（vercel.json 把所有路径 rewrite 到这里）。
 *
 * - 冷启动内复用 app 与 handler；跨实例一致性由 Neon 账本（读-改-写 + 版本号）保证。
 * - 初始化失败不缓存，下一个请求会重试（例如 seed-cloud 还没跑的时候）。
 */
let cached = null;
let opening = null;

export default async function starhall(req, res) {
  try {
    if (!cached) {
      opening ||= (async () => {
        const options = config(process.env);
        const app = await StarHall.open(options);
        return { app, handler: createHandler(app, options) };
      })();
      try { cached = await opening; } finally { opening = null; }
    }
    return await cached.handler(req, res);
  } catch (error) {
    console.error(`[starhall] 初始化失败：${error?.code || ''} ${error?.message || error}`);
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: error?.code || 'store_unavailable', message: error?.message || '账本初始化失败' } }));
    }
  }
}
