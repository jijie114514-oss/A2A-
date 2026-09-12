import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';

const [command = 'help', target, connectionFile] = process.argv.slice(2);
try {
  if (command === 'help') {
    console.log(`作战室 CLI（先启动 npm start 或 npm run sandbox）
  npm run broker -- init-rehearsal <runId> [connection.json]  创建10分钟试用+60分钟市场的演练
  npm run broker -- init <session.json> [connection.json]    按自定义赛程创建会话
  npm run broker -- status <runId> [connection.json]
  npm run broker -- next <runId> [connection.json]
  npm run broker -- watch <runId> [connection.json]          每15秒核对；Ctrl+C关闭
  npm run broker -- receipt <receipt.json> [connection.json]
  npm run broker -- checklist <event.json> [connection.json]
读取凭据只用于本机认证，不显示token。工具不会购买、试用、发言或提交排名。
详细启动、关闭与请求格式：docs/BROKER-RUNBOOK.md`);
  } else {
    if (!['init-rehearsal', 'init', 'status', 'next', 'watch', 'receipt', 'checklist'].includes(command) || !target) throw new Error('命令或参数缺失，请执行 npm run broker -- help');
    const settings = config();
    const connection = connectionFile ? JSON.parse(await readFile(path.resolve(connectionFile), 'utf8')) : {
      baseUrl: `http://${settings.host === '::1' ? '[::1]' : settings.host}:${settings.port}`, credentialsFile: settings.dataDir ? path.join(settings.dataDir, 'credentials.json') : null };
    const base = new URL(connection.baseUrl);
    // 连接文件带 token 时允许直连云端 HTTPS（本机 agent 在比赛房间里的用法）；
    // 否则只接受本机 HTTP + credentials.json，防止误把内部令牌发到外部地址。
    if (connection.token) {
      if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('云端连接需要干净的 https:// 地址');
    } else if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('作战室CLI仅连接本机HTTP入口，或使用带 token 的云端连接文件');
    let token = connection.token || '';
    if (!token) {
      if (!connection.credentialsFile) throw new Error('连接文件缺少 token，且本部署没有本地凭据文件');
      const credentials = JSON.parse(await readFile(connection.credentialsFile, 'utf8'));
      const broker = credentials.accounts.find(a => a.id === 'broker' && a.role === 'broker');
      if (!broker) throw new Error('凭据文件没有经纪人身份');
      token = broker.token;
    }
    const stop = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());
    const request = async (route, body) => {
      const response = await fetch(new URL(route, base), { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) });
      const output = await response.json();
      if (!response.ok) { console.error(JSON.stringify(output, null, 2)); throw new Error(`作战室请求失败：HTTP ${response.status}`); }
      return output;
    };
    if (command === 'watch') {
      console.log('仅监看并在此终端提醒，每15秒查询一次；不会唤醒已关闭的agent。Ctrl+C停止监看。');
      try {
        while (!stop.signal.aborted) {
          const s = await request(`/broker/status?runId=${encodeURIComponent(target)}`);
          console.log(JSON.stringify({ checkedAt: s.checkedAt, phase: s.phase, spent: s.spent, remaining: s.remaining,
            missingTeams: s.missing, productCount: s.productCount, productsMissing: s.productsMissing, sellerSpend: s.sellerSpend,
            spendMissing: s.spendMissing, minutesLeft: s.minutesLeft, checklist: s.checklist, alerts: s.alerts }));
          await delay(15000, undefined, { signal: stop.signal });
        }
      } catch (e) { if (!stop.signal.aborted) throw e; }
    } else {
      let route, body;
      if (command === 'init-rehearsal') {
        const start = Date.now(), iso = minutes => new Date(start + minutes * 60000).toISOString();
        route = '/broker/session'; body = { runId: target, source: 'fixture', ownTeamId: 'starhall',
          schedule: { trialStart: iso(0), trialEnd: iso(10), marketStart: iso(10), marketEnd: iso(70) } };
      } else if (['init', 'receipt', 'checklist'].includes(command)) {
        route = `/broker/${command === 'init' ? 'session' : command}`;
        body = JSON.parse((await readFile(path.resolve(target), 'utf8')).replace(/^\uFEFF/, ''));
      } else route = `/broker/${command}?runId=${encodeURIComponent(target)}`;
      console.log(JSON.stringify(await request(route, body), null, 2));
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
