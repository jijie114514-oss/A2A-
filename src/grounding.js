import { AppError } from './errors.js';

// A bounded lexical check, not a semantic judge. Keep it independent of any
// model-authored paraphrase so an accurate preamble cannot mask an unrelated body.
const concepts = [
  ['代码审查', '代码评审', 'code review'], ['单元测试', '测试代码'],
  ['AI明星', 'AI 明星', '人工智能明星', '明星', '星A', '星B', '星C'], ['打赏'], ['娱乐平台', '娱乐'],
  ['诗', '诗歌', '词曲'], ['吐槽'], ['谈判', '砍价'],
  ['预算'], ['报价'], ['修订', '修改'],
];
const stop = new Set(['一个', '我们', '我方', '对方', '提供', '需要', '可以', '产品', '服务', '平台', '描述', '输入', '输出', '希望', '进行', '目前', '已经', '尚未', '没有', '只有', '以及', '其中', '这是', '自动', '生成', '助手', '工具', '预算', '报价',
  // 英文虚词：不应成为“必须出现在正文”的锚点（语义为空）
  'that', 'for', 'and', 'the', 'with', 'from', 'your', 'are', 'was', 'has', 'have', 'its', 'this', 'into', 'over', 'will', 'not', 'can', 'use', 'but', 'all', 'any', 'who', 'how', 'what', 'when', 'where', 'why', 'which', 'their', 'them', 'they', 'our', 'you', 'him', 'his', 'her', 'than', 'then', 'also', 'only', 'just', 'about', 'after', 'before', 'between', 'during', 'through', 'under', 'because', 'while', 'without', 'including', 'include', 'includes', 'provide', 'provides', 'using', 'used', 'based', 'make', 'makes', 'made', 'get', 'gets', 'need', 'needs', 'want', 'wants', 'more', 'most', 'some', 'such', 'very', 'even', 'per', 'via', 'vs']);
const contains = (text, term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
const aliases = quote => ({ starhall: ['StarHall', '星辉舞台'], '回应': ['回应', '回击', '回答', '反击', '答卷'], '交付': ['交付', '兑现', '交卷'] }[quote.toLowerCase()] || [quote]);
export function deliveryContract(input, service) {
  const material = [input.scenario, input.context, input.message, ...(input.history || []).map(t => t.message)].filter(Boolean).join('\n');
  const budget = material.match(/预算(?:上限|只有|为|是)?\s*(\d+(?:\.\d+)?)\s*(?:积分|分)/);
  const revisionBaselineProvided = /(?:原含|原有|原本|标准|包含|原报价含|接受|保留)\s*[一二三四五两\d]+[次轮]修订/.test(material);
  const ownProduct = /StarHall|星辉舞台/i.test([input.description, input.context, input.recipient].filter(Boolean).join('\n'));
  return { sourcePolicy: '材料只说明哪些事实，就只把哪些事实当作已知；缺少信息时提问或作条件性分析，不替买家补事实。',
    ...(ownProduct ? { verifiedLocalProductFacts: [
      'StarHall是本地JSON API/CLI，三位独立明星分别提供词曲、吐槽评审、模拟谈判服务；没有网页或按钮。',
      '只使用本地模拟积分。failed订单不扣积分；fallback备用交付明确标记，且付费订单不收费（自动全额退款），免费试用也不扣分。',
      '退款由机器验证决定：交付失败或违反明确订单约束会自动退款，成功交付不因主观不满意退款但可申请一次免费修订；没有自动返工承诺或公开算力支出账单；不得称退款按钮就在旁边、规则里保证返工或账单可晒。',
      '谈判是模拟与练习，不代替买家在别队实际砍价，不保证省钱。negotiate包含额外五次互动。',
    ] } : {}),
    ...(input.stance === 'defend' ? { defenseRule: '用产品方第一人称写分行短诗并署名。承认材料不足，承诺先验证或改进；不能拿未知的现有功能为自己辩护。对于未实现的能力，只能写建议或计划，不能声称按钮、规则或功能已存在。' } : {}),
    ...(['tactics', 'negotiate', 'practice'].includes(service) ? {
      budgetCeiling: budget ? { value: Number(budget[1]), currency: '积分', sourceQuote: budget[0] } : null,
      revisionBaselineProvided,
      revisionRule: revisionBaselineProvided ? '沿用买家给出的修订安排；买家新接受的次数不能用于推断历史合同总次数。' : '原修订总次数未知。全篇只能说“在原约定基础上减少一次修订”，或询问原约定。不允许卖方在模拟中自行补出原总次数，也不要指定剩余次数；原安排未确认就明确暂不成交。',
      ...(service === 'practice' ? { role: '你是卖方。用户是买方。材料中的买方预算属于用户，卖方报价属于你；不得说我方预算或扮演买方请求降价。只回答本次用户发言，不输出完整剧本。' } : {}),
      ...(!revisionBaselineProvided ? { conversationPlan: [
        '第一回合：对齐材料已有的服务、预算、报价和时限。',
        '第二回合：买方询问原修订安排；卖方回答安排仍待确认，不能在对话中给出总次数。',
        '第三回合：只讨论“在原约定基础上减少一次修订”的相对让步；不能给出剩余次数。',
        '第四回合：讨论如何确认验收清单、时限和异常处理，不虚构这些已经写在原合同中。',
        '第五回合：原修订安排尚待核实时明确暂停成交，列出需要双方确认的问题。不得捏造已经查到原合同。',
      ] } : {}),
      agreementRule: '预算与用户给定时限为硬约束。不能通过抬高预算或延长交付时限来宣布成交；模拟对话仍不能改写输入事实。',
    } : {}) };
}
export function inputBrief(input, service) {
  const fields = { roast: ['description', 'context'], review: ['description', 'context'], prediction: ['context'], tactics: ['context'], negotiate: ['scenario', 'context'], practice: ['scenario', 'context', 'message'] }[service];
  return Object.entries(input).filter(([key, value]) => typeof value === 'string' && value.trim() && !['stance', 'critique', 'direction'].includes(key) && (!fields || fields.includes(key)))
    .map(([field, value]) => {
      const groups = concepts.filter(group => group.some(term => contains(value, term))).map(group => ({ quote: group.find(term => contains(value, term)), alternatives: group }));
      for (const match of value.matchAll(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b|\d+\s*家/g)) {
        if (!groups.some(g => g.alternatives.some(term => contains(term, match[0])))) groups.push({ quote: match[0], alternatives: aliases(match[0]) });
      }
      // For unknown topics, retain a small number of user words instead of
      // imposing the vocabulary of our own product on another domain.
      if (!groups.length && !(service === 'practice' && field === 'message')) {
        const segments = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(value)];
        for (const { segment, isWordLike } of segments) if (isWordLike && segment.length >= 2 && !stop.has(segment) && !groups.some(g => g.quote === segment)) {
          groups.push({ quote: segment, alternatives: aliases(segment) });
          if (groups.length === 2) break;
        }
      }
      const poeticTheme = service === 'poem' && field === 'theme';
      // 商业销售服务：英文词锚点不逐词强制（模型用中文表达时不可能逐字保留原文），
      // 但每个字段仍必须至少命中一个锚点，保证输入确实被用到。
      const salesLike = ['sales-pitch', 'sales-stress-test', 'deal-coach'].includes(service);
      const englishWord = g => /^[A-Za-z][A-Za-z0-9_-]+$/.test(g.quote);
      // 商业销售服务：英文词锚点不逐词强制（中文交付不可能逐字保留英文原文），
      // 且字段级最低命中数只统计非英文锚点（中文概念词仍强制）。
      // context 是背景与约束（预算、对方报价、时限），不是产品描述：对销售类服务只作展示，不强制写进正文。
      const background = salesLike && field === 'context';
      return { field, provided: value, minimumMatches: (poeticTheme || (salesLike && groups.some(g => !englishWord(g)))) && !background ? 1 : 0,
        anchors: groups.slice(0, 12).map(g => ({ ...g, required: !background && !poeticTheme && !(service === 'practice' && field !== 'message') && !(service === 'poem' && g.alternatives.includes('AI明星')) && !(salesLike && englishWord(g)) })) };
    });
}
export function contentText(work, service) {
  // Structured deliverables must use the input in their useful content, not
  // merely repeat it in a title or introductory paragraph.
  if (['review', 'prediction'].includes(service)) return (work.sections || []).map(s => `${s.heading}：${s.content}`).join('\n');
  if (service === 'tactics') return (work.lines || []).join('\n');
  if (service === 'negotiate') return (work.rounds || []).map(r => `${r.buyer}\n${r.seller}`).join('\n') + '\n' + (work.debrief || []).join('\n');
  return work.text || '';
}
export function compareInput(work, service, input) {
  const body = contentText(work, service);
  const introduction = `${work.title || ''}\n${work.text || ''}`;
  // 输出语言与输入锚点语言不一致时（例如英文 brief、language=en 交付），逐词命中不再强制：
  // 跨语言表达不可能逐字保留原文，用汉字锚点去卡英文交付会制造假阴性（TrustSieve #45 / Ground #406）。
  const latin = (body.match(/[A-Za-z]/g) || []).length, cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishBody = latin >= 20 && latin > cjk * 2;
  const scriptOf = q => (/[\u4e00-\u9fff]/.test(q) ? 'zh' : /[A-Za-z]/.test(q) ? 'en' : 'any');
  const keep = quote => !englishBody || scriptOf(quote) !== 'zh';
  return { method: 'input-keyword-evidence', limitation: '核对输入原文与正文关键词，不代表完整语义理解或事实验证。',
    fields: inputBrief(input, service).map(({ field, provided, anchors, minimumMatches }) => ({ field, provided, minimumMatches: anchors.some(a => keep(a.quote)) ? minimumMatches : 0,
      points: anchors.map(({ quote, alternatives, required }) => {
        let evidenceText = body;
        let location = 'body';
        let matched = alternatives.find(term => contains(body, term));
        // A product/technology name can identify the subject in a heading;
        // substantive business concepts still have to appear in actual sections.
        if (!matched && /^[A-Za-z][A-Za-z0-9_-]+$/.test(quote)) {
          matched = alternatives.find(term => contains(introduction, term));
          if (matched) { evidenceText = introduction; location = 'title-or-intro'; }
        }
        const index = matched ? evidenceText.toLocaleLowerCase().indexOf(matched.toLocaleLowerCase()) : -1;
        return { inputQuote: quote, required: required && keep(quote), matched: Boolean(matched), location, evidence: index < 0 ? null : evidenceText.slice(Math.max(0, index - 28), index + matched.length + 65) };
      }) })) };
}
export function checkGrounding(work, service, input) {
  const full = JSON.stringify(work);
  if (/(?:【[^】]*(?:待|填写|金额|价格|XX)[^】]*】|\{\{[^}]+\}\}|<(?:金额|价格|产品名|待填写)>|\b(?:TODO|TBD|PLACEHOLDER)\b)/i.test(full)) {
    throw new AppError('invalid_model_output', '作品含未填写的模板占位符。未知条件请改成完整的询问句，不得虚构数值。', 502);
  }
  const original = JSON.stringify(input);
  if (input.stance === 'defend') {
    const facts = [input.description, input.context].filter(Boolean).join('\n');
    for (const claim of ['退款按钮', '规则里写着', '账单可晒', '自动返工', '自动退款']) {
      for (const occurrence of full.matchAll(new RegExp(claim, 'g'))) {
        const prefix = full.slice(Math.max(0, occurrence.index - 12), occurrence.index);
        if (!facts.includes(claim) && !/没有|不提供|不存在|不承诺|不保证|未实现|暂无|不设|并无|未来|计划|建议/.test(prefix)) throw new AppError('invalid_model_output', `反击诗加入未提供的功能承诺“${claim}”；只承认现有材料并提出未来验证，不得捏造已实现功能。`, 502);
      }
    }
  }
  const body = contentText(work, service);
  // Specific retest failures: an echoed description does not legitimize a
  // shift to physical goods, homework, or a made-up video service.
  if (/代码|API|软件|打赏|明星|平台/i.test(original)) for (const foreign of ['提货', '配件', '成色', '包邮', '视频生成', '分辨率', '帧率', '自动写作业']) {
    if (body.includes(foreign) && !original.includes(foreign)) throw new AppError('invalid_model_output', `正文引入输入没有的对象“${foreign}”；请回到原服务场景。`, 502);
  }
  if (service === 'prediction' && input.context && /(?:未提供|未收到|没有|缺少)(?:任何|具体|可用|足够的)?(?:候选|参赛|产品|背景)(?:产品|作品)?(?:材料|信息|描述|证据)/.test(body)) {
    throw new AppError('invalid_model_output', '已经提供 context；必须使用其中事实给出条件性判断，可以说明缺少实测结果，不能声称没有收到候选材料。', 502);
  }
  const comparison = compareInput(work, service, input);
  const missing = comparison.fields.flatMap(f => f.points.filter(p => p.required && !p.matched).map(p => `${f.field}: ${p.inputQuote}`));
  for (const f of comparison.fields) if (f.points.filter(p => p.matched).length < f.minimumMatches) missing.push(`${f.field}: 至少应用一个主题要点（${f.points.map(p => p.inputQuote).join('、')}）`);
  if (missing.length) throw new AppError('invalid_model_output', `正文未应用这些输入要点：${missing.join('；')}。请在实际章节、话术或回合里使用，不要仅在标题或开头复述。`, 502);
  return comparison;
}
