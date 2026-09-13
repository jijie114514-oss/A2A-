/**
 * 部署台账：每次上线后追加一条**可核验**记录（借鉴 ZAAT 的 deployed-artifacts.md 纪律）。
 *
 *   node scripts/record-deploy.js https://starhall-a2a.vercel.app --note "开户原子化"
 *
 * 记录内容：git sha/分支/提交标题、目标地址、/health 与 /readiness 快照、
 * 公开交付统计摘要、回滚命令。只读线上端点，不写任何数据。
 * 台账文件：docs/DEPLOY-LEDGER.md（单一权威来源，别在别处复制部署状态）。
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('http')) || process.env.STARHALL_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!base) { console.error('用法: node scripts/record-deploy.js <publicUrl> [--note "..."] [--rollback "..."]'); process.exit(2); }
const noteOf = name => { const hit = args.find(a => a.startsWith(`--${name}=`)); const idx = args.indexOf(`--${name}`); return hit ? hit.split('=').slice(1).join('=') : (idx >= 0 ? args[idx + 1] : ''); };
const note = noteOf('note');
const ledger = 'docs/DEPLOY-LEDGER.md';

const git = cmd => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const get = async path => { try { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { code: r.status, body: await r.json() }; } catch (e) { return { code: 0, body: null, error: e.message }; } };

const health = await get('/health');
const readiness = await get('/readiness');
const evidence = await get('/v1/evidence');
const claim = n => evidence.body?.claims?.find(c => c.claim.startsWith(n))?.value;
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

const row = [
  `## ${stamp} · ${note || '（未写说明）'}`,
  '',
  `| 项 | 值 |`,
  `| --- | --- |`,
  `| git | \`${git('git rev-parse --short HEAD')}\` (${git('git rev-parse --abbrev-ref HEAD')}) — ${git('git log -1 --pretty=%s').slice(0, 70)} |`,
  `| 地址 | ${base} |`,
  `| health | http=${health.code} status=${health.body?.status} store=${health.body?.store} dbReady=${health.body?.dbReady} writeConflicts=${health.body?.writeConflicts ?? '-'} round=${health.body?.round} |`,
  `| readiness | http=${readiness.code} ready=${readiness.body?.ready} state=${readiness.body?.state} |`,
  `| 公开交付统计 | 成功交付 ${claim('成功交付数')} · live 占比 ${claim('真实模型交付占比')}% · 退款 ${claim('机器判定退款数')}（${JSON.stringify(claim('退款原因分布'))}）· 时延 p50/p95=${claim('交付时延 p50 / p95 / max（毫秒）')?.p50}/${claim('交付时延 p50 / p95 / max（毫秒）')?.p95}ms |`,
  `| 回滚 | \`npx vercel rollback\`${noteOf('rollback') ? ` · 备选：${noteOf('rollback')}` : ''} |`,
  '',
].join('\n');

if (!existsSync(ledger)) {
  writeFileSync(ledger, `# 部署台账（单一权威来源）\n\n> 每次上线后由 \`node scripts/record-deploy.js <url> --note "..."\` 追加。\n> 部署状态只看这里与实时 \`/health\`、\`/readiness\`；不要在 README 或聊天里复制版本号（会漂移）。\n\n`);
}
appendFileSync(ledger, row + '\n');
console.log(`已写入 ${ledger}：`);
console.log(row);
if (health.code !== 200 || readiness.body?.ready !== true) { console.error('⚠️ 健康或就绪未通过，这条记录应视为失败部署'); process.exitCode = 1; }
