import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';

await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', 'sandbox-'));
const settings = config({ ...process.env, STARHALL_DATA_DIR: dir, STARHALL_PORT: process.env.STARHALL_SANDBOX_PORT || '4318', STARHALL_FIXTURE_MARKET: 'true' });
const host = await startServer(settings);
await writeFile(path.join(dir, 'connection.json'), JSON.stringify({ baseUrl: host.url, dataDir: dir, credentialsFile: path.join(dir, 'credentials.json'), market: '/v1/test-market/catalog', simulatedExternalTeams: true }, null, 2));
console.log(`全新测试环境：${host.url}\n模型：${settings.llm.provider} / ${settings.llm.model}\n数据目录：${dir}\n凭据：${path.join(dir, 'credentials.json')}\n三位买家各100分；原 data 目录不变。\n模拟竞品：${host.url}/v1/test-market/catalog\nCtrl+C 关闭；下次运行会创建新的独立环境。`);
console.log(`作战室初始化（另开终端）：\nnpm run broker -- init-rehearsal rehearsal-001 "${path.join(dir, 'connection.json')}"\n监看命令：\nnpm run broker -- watch rehearsal-001 "${path.join(dir, 'connection.json')}"\n经纪人需要在Codex中另行启动：读取 broker-agent.md，仅演练本地市场，runId=rehearsal-001，连接文件=${path.join(dir, 'connection.json')}。`);
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => host.close().catch(e => { console.error(e.message); process.exitCode = 1; }));
