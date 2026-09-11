import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { Brain } from '../src/brain.js';
import { StarHall } from '../src/app.js';

// Real model smoke test: isolated accounts, no fallback counted as API success.
const settings = config();
if (settings.llm.provider === 'mock') throw new Error('请先配置真实模型');
await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(path.resolve('artifacts', 'provider-check-'));
const observations = [];
const brain = new Brain({ ...settings.llm, fallback: false }, async (url, init) => {
  const response = await fetch(url, init);
  const row = { status: response.status };
  if (!response.ok) {
    const data = await response.clone().json().catch(() => ({}));
    row.errorCode = data.error?.code || data.code || 'unknown';
    row.message = String(data.error?.message || 'Provider rejected request').replaceAll(settings.llm.apiKey, '<redacted>').replace(/(?:ark|sk)-[A-Za-z0-9-]+/g, '<redacted>').slice(0, 600);
  }
  observations.push(row);
  return response;
});
const app = await StarHall.open({ ...settings, dataDir: dir }, brain);
const results = [];
try {
  for (const [service, input] of [
    ['sales-pitch', { productName: 'CodeLens', productDescription: '代码审查：输入代码，输出问题位置和修复建议', price: 20, targetBuyer: '开发者' }],
    ['sales-stress-test', { productName: 'CodeLens', productDescription: '代码审查：输入代码，输出问题位置和修复建议', price: 20, targetBuyer: '开发者' }],
    ['tactics', { direction: 'buy', context: '采购代码审查服务，预算15积分，对方报价20积分，原修订安排尚未确认。' }],
  ]) {
    const order = await app.order({ id: 'fan-orion' }, { service, input }, service);
    const result = { service, status: order.status, elapsedMs: order.elapsedMs, generation: order.delivery?.pieces[0]?.generation, error: order.error };
    results.push(result); console.log(JSON.stringify(result));
    if (order.status !== 'delivered') process.exitCode = 1;
    if (observations.some(o => o.status >= 400)) break;
  }
  const report = { provider: settings.llm.provider, model: settings.llm.model, baseUrl: settings.llm.baseUrl, at: new Date().toISOString(), fallbackEnabledForCheck: false, results, observations };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${path.join(dir, 'report.json')}`);
  for (const row of observations.filter(o => o.status >= 400)) console.log(JSON.stringify(row));
} finally { await app.close(); }
