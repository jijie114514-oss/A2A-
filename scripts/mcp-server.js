/**
 * StarHall MCP（stdio）入口：给本机的编码 agent（Claude Code / Codex / Cursor / Pi）用。
 *
 * 注意 stdout 只用于 MCP 协议报文，日志一律走 stderr。
 * 同一个 STARHALL_DATA_DIR 同时只能有一个进程（与 HTTP 服务共用同一把目录锁）：
 * 若 HTTP 服务已在运行，请让 agent 直接连 `http://<host>:<port>/mcp`，不要再起 stdio。
 */
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { createMcpServer } from '../src/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const options = config();
const app = await StarHall.open(options);
const server = createMcpServer(app, { openRegistration: options.openRegistration, token: options.mcpToken, registrationCredits: options.registrationCredits });
await server.connect(new StdioServerTransport());
console.error(`StarHall MCP（stdio）已就绪：数据目录 ${options.dataDir}；自助开户 ${options.openRegistration ? '已开启' : '未开启'}`);

let closing;
const shutdown = async () => {
  closing ||= (async () => {
    await server.close().catch(() => {});
    await app.close().catch(() => {});
  })();
  await closing;
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
