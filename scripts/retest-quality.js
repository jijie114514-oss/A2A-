import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { Brain } from '../src/brain.js';
const settings = config();
const input = { direction: 'sell', context: '我方买家预算15积分，对方卖家报价20积分，采购四分钟内交付的产品评审；可减少一次修订换取折扣。' };
const work = await new Brain(settings.llm).generate('star-c', 'tactics', input);
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/tactics-quality-retest.json', JSON.stringify({ input, work }, null, 2));
console.log(JSON.stringify({ mode: work.generation.mode, attempts: work.generation.attempts, lines: work.lines, report: 'artifacts/tactics-quality-retest.json' }, null, 2));
