import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { Brain } from '../src/brain.js';

const settings = config();
const observations = [];
const brain = new Brain({ ...settings.llm, fallback: false }, async (url, init) => {
  const response = await fetch(url, init);
  let data;
  try { data = await response.clone().json(); } catch { data = {}; }
  // Save only model output/usage, never request headers or credentials.
  const content = settings.llm.provider === 'ark-responses'
    ? data.output?.filter(item => item?.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).filter(c => c?.type === 'output_text').map(c => c.text).join('\n')
    : settings.llm.provider === 'anthropic' ? data.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') : data.choices?.[0]?.message?.content;
  observations.push({ status: response.status, content, finishReason: data.status || data.stop_reason || data.choices?.[0]?.finish_reason, usage: data.usage });
  return response;
});
try {
  const work = await brain.generate('star-b', 'review', { description: '一个自动写软件单元测试的AI助手，输入JavaScript函数，输出测试代码。' });
  console.log(JSON.stringify({ status: 'delivered', fields: Object.keys(work) }));
} catch (e) { console.log(JSON.stringify({ status: 'failed', code: e.code, message: e.message })); }
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/model-diagnosis.json', JSON.stringify(observations, null, 2));
console.log('Model response saved to artifacts/model-diagnosis.json');
