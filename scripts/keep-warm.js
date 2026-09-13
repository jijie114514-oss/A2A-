/**
 * 赛前与赛期保温：把函数实例与 Neon 都压在热态，避免第一波 agent 撞上冷启动。
 *
 *   node scripts/keep-warm.js [baseUrl] [--every=240] [--minutes=150]
 *
 * 只打公开只读端点（/health、/v1/catalog、/v1/evidence），不做任何写操作。
 * Neon 免费版 5 分钟无活动就缩容；每 4 分钟一次即可保持热态（约 0.25 CU-小时/2 小时）。
 * Ctrl+C 停止；结束时打印延迟分位与失败次数，作为当晚的实测记录。
 */
const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('http')) || process.env.STARHALL_PUBLIC_BASE_URL || 'https://starhall-a2a.vercel.app').replace(/\/+$/, '');
const everySec = Number((args.find(a => a.startsWith('--every=')) || '').split('=')[1] || 240);
const minutes = Number((args.find(a => a.startsWith('--minutes=')) || '').split('=')[1] || 150);
const paths = ['/health', '/v1/catalog', '/v1/evidence'];
const samples = []; let failures = 0;
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

async function beat() {
  for (const p of paths) {
    const t = Date.now();
    try { const r = await fetch(base + p, { headers: { 'accept': 'application/json' } }); if (!r.ok) failures++; await r.arrayBuffer(); samples.push(Date.now() - t); }
    catch { failures++; }
  }
  const xs = [...samples].sort((a, b) => a - b);
  const p = q => xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))] : 0;
  process.stdout.write(`\r[${stamp()}] 保温中 · 样本 ${samples.length} · p50 ${p(.5)}ms · p95 ${p(.95)}ms · 失败 ${failures}   `);
}

const deadline = Date.now() + minutes * 60_000;
console.log(`保温 → ${base}（每 ${everySec}s 一次，共 ${minutes} 分钟；Ctrl+C 停止）`);
await beat();
while (Date.now() < deadline) { await new Promise(r => setTimeout(r, everySec * 1000)); await beat(); }
console.log('\n保温结束。');
