import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { Brain } from '../src/brain.js';

// Synthetic retest material only. Save model content, never HTTP headers,
// credentials, environment, or request options.
const options = config().llm;
if (options.provider === 'mock') throw new Error('需要真实模型配置');
const cases = [
  { service: 'negotiate', star: 'star-c', input: { scenario: '我方买家预算15积分，对方卖家报价20积分，向别队采购四分钟内交付的代码审查服务；可减少一次修订换取折扣。' } },
];
const report = [];
await mkdir('artifacts', { recursive: true });
for (const item of cases) {
  const outputs = [];
  class DiagnosticBrain extends Brain {
    async request(...args) { const output = await super.request(...args); outputs.push(output); return output; }
  }
  const brain = new DiagnosticBrain({ ...options, fallback: true });
  const work = await brain.generate(item.star, item.service, item.input);
  report.push({ ...item, outputs, work });
  await writeFile('artifacts/context-diagnosis.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ service: item.service, generation: work.generation }));
}
