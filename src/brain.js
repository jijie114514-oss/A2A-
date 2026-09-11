import { AppError, ensure } from './errors.js';
import { systemPrompt, parseOutput } from './output.js';
import { inputBrief, compareInput, deliveryContract } from './grounding.js';
import { isSales, localSales } from './sales.js';
import { VERSION } from './catalog.js';

const short = (text, max = 100) => String(text || '').slice(0, max);
function templateWork(service, input) {
  const theme = short(input.theme || input.occasion || '星辉舞台', 60);
  const recipient = short(input.recipient || '每位认真创造的人', 60);
  const target = short(input.description, 160);
  if (service === 'poem' && input.stance === 'defend') return { title: `${recipient}的回应`, text: `你说我们的承诺还欠一场检验，\n我们把${theme}写进明天的清单。\n不拿愿景替代证据，不用口号遮住难关；\n把一个输入跑到底，让结果摆在桌前。\n该改的地方，我们承认，也动手改变；\n未被验证的价值，不该在起跑时被判完。\n等下一次交付，请带着问题再来——\n让作品回答，而非掌声替我们辩白。\n——星A · 词曲家` };
  if (service === 'poem') return { title: `把${theme}写成星光`, text: `致${recipient}：\n把${theme}折成一叶帆，\n让今夜的风替我们启航。\n屏幕微光照见未眠的眼睛，\n每一次尝试，都有回声落在远方。\n愿你的名字越过喧嚣，\n与一份真正完成的作品同亮。\n当掌声散去，仍有人记得——\n你曾把一个想法，交到世界手上。\n——星A · 词曲家` };
  if (service === 'speech' || service === 'patron') return { title: `${theme} · 致${recipient}`, text: `各位朋友，今天我们为${theme}相聚。送给${recipient}的这段掌声，不只为一个漂亮的想法，更为一次次把想法变成作品的行动。\n我们见过深夜仍亮着的屏幕，也见过问题解决时那一秒的笑容。每个看似平凡的小改动，都让下一位使用者少走一段弯路。\n${service === 'patron' ? '请把灯光留给每一位认真做事的人：为第一次失败后仍愿意重来的耐心，为一句真实反馈之后重新修改的勇气，也为那些没有被看见却始终可靠的细节。舞台的意义，是让这些付出被听见、被记住。\n' : ''}愿接下来的每一步都能回答一个具体的问题，兑现一个清楚的承诺。让作品走到人们面前，让价值留在使用之后。此刻，向${recipient}致意，也向下一次出发举杯！\n——星A · 词曲家` };
  if (service === 'roast') return { title: '概念可以起飞，交付还得落地', text: `你说「${target}」。这介绍像一辆贴满赛车贴纸的车：气势有了，刹车距离还没交代。把愿景讲大很容易，把第一次输入、失败时返回什么、用户多久能拿到结果讲清楚，才叫本事。\n我的具体异议是：仅凭这段材料，无法复现一条从输入到可用交付物的完整路径，也没有足够证据判断高峰期表现。这不等于产品做不到，而是宣传尚未证明它做到。\n建议把一个最小输入和真实输出并排摆出来，再公开响应时间、价格边界和失败补偿。若这些已经实现，就让演示说话；若还没有，先别给未来的功能提前颁奖。\n结论：创意值得继续打磨，但请让下一版说明少一点宇宙级形容词，多一个可复现例子。以上基于提供的描述，没有实际试用。\n——星B · 毒舌评审` };
  if (service === 'review') return { title: '产品评审报告', text: `评审对象：${target}\n证据范围：仅用户提供的描述，未实际试用。`, sections: [
    { heading: '价值', content: '描述提供了一个候选使用场景；是否满足需求需由真实输入和交付物验证。' },
    { heading: '具体异议', content: '当前材料不足以复现从输入到最终交付物的调用，也不足以确认异常情况下的处理方式。' },
    { heading: '风险', content: '首次使用成本、输出可用性和高峰延迟仍缺少证据。' },
    { heading: '建议', content: '给出最小调用示例、输出结构、价格及失败补偿；用三个不同输入展示边界。' },
    { heading: '验证', content: '记录真实端到端耗时、成功率和具体失败样例，再更新评分。' },
  ] };
  if (service === 'prediction') return { title: '冠军观察与选品锦囊', text: input.context ? `收到材料：${short(input.context, 300)}。以下提供可执行的比较框架，模板不对候选产品虚构实测排名。` : '当前没有候选产品证据，暂不点名冠军。先按以下步骤筛选值得试用和购买的产品。', confidence: 'insufficient-evidence', sections: [
    { heading: '评分尺（100分）', content: '交付可用性40分：能否直接用于任务；可靠性25分：重试及失败处理；性价比20分：同等预算的有效产出；调用清晰度15分：输入输出与价格是否明确。每项标明证据来源，未试用项先留空。' },
    { heading: '三问筛选', content: '给同一真实输入能交付什么？失败是否扣款且如何查回订单？另一输入或重复调用是否仍然有效？让每家给出可复现例子，再写具体异议。' },
    { heading: '候选比较表', content: '逐家记录 teamId、服务、价格、耗时、实际输出、具体缺项、修复路径和评分；比较至少三个不同队伍，不能把同队明星算作不同产品。' },
    { heading: '预算与止损', content: '可将100积分中的80积分分配为30/25/15/10四笔，但应按实际标价调整，覆盖至少三个队伍。遇到失败先查订单和余额，不盲目重复付款；用原幂等键查询，确认结果后再做新采购决定。' },
  ] };
  if (service === 'tactics') {
    const buy = input.direction === 'buy';
    return { title: `${buy ? '买方' : '卖方'}谈判话术锦囊`, text: '先明确交付标准，再交换条件；每次让步都绑定对方承诺。', lines: [
      buy ? '开场：请列出这个价格对应的交付物与完成时间。' : '开场：请先确认这个报价对应的交付范围、修订安排和时限。',
      '探底：您最在意的是价格、速度，还是可用性？我们先解决最重要的一项。',
      buy ? '交换：如果减少修订次数，价格能否相应调整？' : '交换：如果今天确认且缩小范围，我可以调整报价。',
      '收口：我们把范围、验收条件、价格、时限和失败处理写在同一条确认里。',
      '退出：这个条件超过我的边界；我们可以缩小交付范围，或这次先不成交。',
    ] };
  }
  if (service === 'negotiate') return { title: '五回合谈判演练', text: `模拟场景：${short(input.scenario, 300)}\n以下为模拟对话，不代表真实成交。`, rounds: [
    { round: 1, buyer: '请先说明交付范围，能否再优惠一点？', seller: '我们先对齐验收标准，再讨论价格，避免低价对应不同预期。' },
    { round: 2, buyer: '我的预算有限，哪一部分可以裁剪？', seller: '可以减少修订次数，保留核心交付，折扣与减少的工作量绑定。' },
    { round: 3, buyer: '如果我现在确认，能否缩短交付时间？', seller: '可以讨论，但加速需要您同步提供完整输入，并明确验收时限。' },
    { round: 4, buyer: '如果输出不符合标准，如何处理？', seller: '按预先确认的标准修订，未达标部分逐项重做；未完成的交付不收费。' },
    { round: 5, buyer: '确认缩小范围，保留核心功能，请复述最终条件。', seller: '范围、价格、时限和异常处理分别确认后再成交。这里是模拟，尚未发生交易。' },
  ], debrief: ['先定范围再谈价格', '让步需要条件交换', '给双方留下明确退出条件'] };
  if (service === 'practice') return { title: `第${input.round}回合 · 对手回应`, text: `你刚提出「${short(input.message, 200)}」。${['我理解你的要求。请先把预算和必需交付说清楚，我不会只因一句优惠请求就让价。', '可以讨论让步，但需要对应缩小范围或减少修订。你愿意交换哪项条件？', '时间也是成本。如果要求加急，请同步提供完整输入，并确认验收时限。', '我们来明确风险分担：交付标准、修订边界和失败处理各是什么？', '进入最后确认：请复述范围、价格、时限和退出条件。条件不明确，我暂不承诺成交。'][input.round - 1]}`, coaching: '尝试提出可验证的条件交换，而不是重复要求降价。' };
  throw new AppError('unknown_service', '没有对应的本地生成模板');
}
export function localWork(service, input) {
  if (isSales(service)) return localSales(service, input);
  const work = templateWork(service, input);
  // Templates are transparent checklists built from the current material,
  // never evidence of a successful model judgment or an actual negotiation.
  const scope = inputBrief(input, service).map(f => `${f.field}「${short(f.provided, 4000)}」`).join('；');
  if (scope) {
    if (service === 'review') work.sections[0].content = `材料明确的对象与范围：${scope}。优势假设：把这些需求放在同一调用路径中可降低切换成本；请用对应输入验证，不能从描述推断已经实现。`;
    else if (service === 'prediction') work.sections[0].content = `已知材料：${scope}。若所述差异成立，可以作为试用名单的差异化候选；能否进入前列仍取决于实际交付和对手表现。${work.sections[0].content}`;
    else if (service === 'tactics') {
      work.lines[0] = `开场：针对${scope}，我们先逐项核对服务范围、验收输出和交付时限，再确认预算与报价是否匹配。`;
      work.lines[1] = '探底：哪些交付项必须保留？修订安排是否已约定？先确认原条件再谈让步。';
      work.text = '以下为基于本次材料的本地话术清单；未确认条件通过询问补齐，不代表已成交。';
    } else if (service === 'negotiate') work.rounds[0].buyer = `本次采购条件是${scope}。请确认预算、报价、交付范围与修订安排；哪些可交换？`;
    else work.text += `\n本次材料对照：${scope}。${input.stance === 'defend' ? '这些服务都是我们的承诺范围；我们接受逐项验收，用下一次实际交付回应质疑。' : '上述为提供的材料，效果仍以实际交付验证。'}`;
  }
  work.inputComparison = compareInput(work, service, input);
  return work;
}
export class Brain {
  constructor(options, fetcher = fetch) { this.options = options; this.fetcher = fetcher; }
  async generate(star, service, input, memory = [], signal) {
    signal?.throwIfAborted();
    const o = this.options;
    if (service === 'deal-coach') return { ...localSales(service, input), generation: { mode: 'rules', provider: 'local-contract', notice: '根据当前报价、授权预算与底价生成下一步话术；未调用模型，不虚构成交。' } };
    if (o.provider === 'mock') return { ...localWork(service, input), generation: { mode: 'mock', provider: 'local-template', notice: '本地模板作品，未调用模型 API' } };
    const started = Date.now();
    let attempts = 0;
    let modelDurationMs = 0;
    const repairReasons = [];
    let failure;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = o.timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new AppError('model_timeout', '模型生成及修复超过总时限', 504);
        attempts++;
        try {
          const system = systemPrompt(star, service) + (attempt ? `\n上一次输出不符合本服务格式：${failure.message}。请根据相同输入重新生成完整作品，不要解释修复过程，不得省略必填数组。` : '');
          // The host renders purchase-history greetings. Past subjects must not contaminate new work.
          const user = JSON.stringify({ service, input, taskMaterial: inputBrief(input, service), returningFan: memory.length > 0,
            deliveryContract: deliveryContract(input, service), ...(attempt ? { correctionRequired: failure.message } : {}) });
          const callStarted = Date.now();
          const output = await this.request(system, user, Math.min(remaining, attempt ? 20000 : 25000), signal);
          modelDurationMs += Date.now() - callStarted;
          const parsed = parseOutput(output, service, input);
          return { ...parsed.work, generation: { mode: 'live', provider: o.provider, model: o.model, attempts,
            repaired: attempt > 0, repairReasons, normalizations: parsed.normalizations, elapsedMs: Date.now() - started, modelDurationMs, appVersion: VERSION } };
        } catch (e) {
          signal?.throwIfAborted();
          failure = e;
          if (e.code === 'invalid_model_output') repairReasons.push(e.message);
          // Only content errors get one bounded repair. No repeated authentication/network failures.
          if (e.code !== 'invalid_model_output' || attempt === 1) throw e;
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      const internalReason = classifyModelError(error);
      console.error(`[model] service=${service} star=${star} provider=${o.provider} model=${o.model} baseUrl=${o.baseUrl} attempts=${attempts} durationMs=${Date.now() - started} internalReason=${internalReason}`);
      if (!o.fallback) throw new AppError(error instanceof AppError ? error.code : 'model_failed', error instanceof AppError ? `${error.message}；备用交付已关闭，本单不扣分` : '模型连接失败；备用交付已关闭，本单不扣分', 502);
      return { ...localWork(service, input), generation: { mode: 'fallback', provider: 'local-template', reason: error instanceof AppError ? error.code : 'model_failed', internalReason, attempts, repairReasons,
        elapsedMs: Date.now() - started, modelDurationMs, appVersion: VERSION, notice: service === 'practice' ? '本回合已使用本地备用回应，互动不另收费。' : '模型未能完成合格输出，已交付本地备用作品（按目录价格收费）' } };
    }
  }
  async request(system, user, timeoutMs, signal) {
    const o = this.options;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, timeoutMs);
    const anthropic = o.provider === 'anthropic';
    const responses = o.provider === 'ark-responses';
    const endpoint = `${o.baseUrl}/${responses ? 'responses' : anthropic ? 'messages' : 'chat/completions'}`;
    const body = responses ? { model: o.model, max_output_tokens: 2200, store: false, stream: false,
      input: [{ role: 'system', content: [{ type: 'input_text', text: system }] }, { role: 'user', content: [{ type: 'input_text', text: user }] }] }
      : anthropic ? { model: o.model, max_tokens: 2200, system, messages: [{ role: 'user', content: user }] }
      : { model: o.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], [o.tokenLimitField || 'max_completion_tokens']: 2200 };
    if (!anthropic) {
      if (o.thinking && o.thinking !== 'default') body.thinking = { type: o.thinking };
      if (o.jsonOutput) {
        if (responses) body.text = { format: { type: 'json_object' } };
        else body.response_format = { type: 'json_object' };
      }
    }
    try {
      signal?.throwIfAborted();
      const timeout = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new AppError('model_timeout', '模型响应超时或取消', 504)), { once: true }));
      const execute = async () => {
        const startedAt = Date.now();
        console.error(`[model] call_started provider=${o.provider} model=${o.model} url=${endpoint}`);
        let response;
        try { response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error',
          headers: anthropic ? { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
          body: JSON.stringify(body), signal: controller.signal }); }
        catch (networkError) {
          console.error(`[model] call_error provider=${o.provider} model=${o.model} durationMs=${Date.now() - startedAt} errorClass=${networkError.constructor?.name} causeCode=${networkError.cause?.code || networkError.cause?.message || 'none'} message=${String(networkError.message).slice(0, 200)}`);
          throw networkError;
        }
        console.error(`[model] call_finished provider=${o.provider} model=${o.model} status=${response.status} durationMs=${Date.now() - startedAt}`);
        ensure(response.ok, 'model_http_error', `模型服务返回 HTTP ${response.status}`, 502);
        const raw = await response.text();
        ensure(raw.length <= 100000, 'invalid_model_output', '模型响应过长', 502);
        let data;
        try { data = JSON.parse(raw); } catch { throw new AppError('invalid_model_output', '模型服务返回了非 JSON 响应', 502); }
        ensure(data && typeof data === 'object' && !Array.isArray(data), 'invalid_model_output', '模型服务返回了无效响应对象', 502);
        const finish = anthropic ? data.stop_reason : data.choices?.[0]?.finish_reason;
        ensure(!['length', 'max_tokens'].includes(finish), 'invalid_model_output', '输出被 token 上限截断', 502);
        if (responses) {
          ensure(data.status === 'completed' && !data.error && !data.incomplete_details, 'invalid_model_output', '方舟 Responses 未完整完成，不能作为成功作品交付', 502);
          ensure(Array.isArray(data.output), 'invalid_model_output', '方舟 Responses 缺少 output 数组', 502);
          const messages = data.output.filter(item => item?.type === 'message' && item.role === 'assistant');
          ensure(messages.length > 0 && messages.every(item => (!item.status || item.status === 'completed') && Array.isArray(item.content) && !item.content.some(c => c?.type === 'refusal')), 'invalid_model_output', '方舟 Responses 没有完整的助手文本', 502);
          const parts = messages.flatMap(item => item.content).filter(c => c?.type === 'output_text');
          ensure(parts.length > 0 && parts.every(p => typeof p.text === 'string'), 'invalid_model_output', '方舟 Responses 未返回有效 output_text', 502);
          const text = parts.map(p => p.text).join('\n');
          ensure(text.trim(), 'invalid_model_output', '方舟 Responses 返回空文本', 502);
          return text;
        }
        const text = anthropic ? data.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') : data.choices?.[0]?.message?.content;
        ensure(typeof text === 'string', 'invalid_model_output', '模型未返回作品文本', 502);
        return text;
      };
      return await Promise.race([execute(), timeout]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
}

/**
 * 内部错误分类（对外 reason 保持不变，internalReason 供诊断）。
 * 分类依据：AppError code 优先；网络层错误看 cause code；其余归为未知。
 */
export function classifyModelError(error) {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'model_config_missing': return 'MODEL_CONFIG_MISSING';
      case 'model_timeout': return 'MODEL_TIMEOUT';
      case 'model_http_error': {
        const status = String(error.message).match(/HTTP (\d+)/)?.[1];
        if (status === '401' || status === '403') return 'MODEL_AUTH_FAILED';
        if (status === '429') return 'MODEL_RATE_LIMITED';
        return 'MODEL_HTTP_ERROR';
      }
      case 'invalid_model_output': return 'MODEL_VALIDATION_FAILED';
      default: return 'MODEL_UNKNOWN_ERROR';
    }
  }
  const cause = error?.cause?.code || error?.cause?.message || '';
  const message = String(error?.message || '');
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/.test(cause) || /fetch failed|network/i.test(message)) return 'MODEL_PROVIDER_UNAVAILABLE';
  return 'MODEL_UNKNOWN_ERROR';
}
