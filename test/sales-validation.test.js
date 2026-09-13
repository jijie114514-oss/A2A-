import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSales, localSales } from '../src/sales.js';

/** 输入用真实验收时那一单：产品名带空格、价格是数字。 */
const input = { productName: 'MCP 自检', productDescription: '通过官方 MCP SDK 从公网串流 HTTP 调用', price: 9, targetBuyer: 'agents' };

/** 真实模型（doubao-seed-2-0-lite）当时逐字返回的内容。它其实完全可用，
 *  却被旧校验器两次判死、降级成交付模板。这些用例锁住「别再犯同样的错」。 */
const MODEL_OUTPUT = {
  oneLinePitch: '专为agents打造的MCP自检服务，仅需9本地积分，通过官方MCP SDK从公网串流HTTP调用即可完成自检',
  shortPitch: '面向agents推出的MCP自检服务，定价为9本地积分，全程通过官方MCP SDK从公网串流HTTP调用完成自检操作，适配agents的MCP相关运行校验需求',
  keyValuePoints: ['专为agents提供的MCP自检服务，定价仅9本地积分，使用成本低', '依托官方MCP SDK实现从公网串流HTTP调用的自检流程，调用逻辑符合官方标准'],
  callToAction: '有相关自检需求的agents可先核对实际使用政策，通过样例验证服务适配性后再完成采购操作',
};

const pitch = overrides => ({ ...MODEL_OUTPUT, ...overrides });
/** 四个字段全部替换：避免「只想测缺价格」时别的字段里还留着合法价格。 */
const pitchWithoutPrice = overrides => ({ oneLinePitch: '面向agents的MCP自检服务',
  shortPitch: '面向agents的MCP自检服务，交付范围清晰。', keyValuePoints: ['自检服务，范围明确', '面向agents的调用校验'],
  callToAction: '请发来一个真实场景，我们先确认范围与验收标准。', ...overrides });
const accepts = (work, extra = {}) => normalizeSales(work, 'sales-pitch', { ...input, ...extra });
const rejects = (work, matcher, extra = {}) => {
  try { normalizeSales(work, 'sales-pitch', { ...input, ...extra }); } catch (error) { assert.match(error.message, matcher, `期望拒绝理由匹配 ${matcher}，实际：${error.message}`); return; }
  assert.fail(`本应被拒绝却通过了：${JSON.stringify(work).slice(0, 120)}`);
};

test('真实模型输出必须通过：产品名少一个空格、价格写成「9本地积分」都不算错', () => {
  const { work } = accepts(MODEL_OUTPUT);
  assert.equal(work.oneLinePitch, MODEL_OUTPUT.oneLinePitch);
  const nameField = work.inputComparison.fields.find(f => f.field === 'productName');
  assert.ok(nameField, 'productName 必须出现在 inputComparison 里');
  assert.equal(nameField.points.every(p => !p.required || p.matched), true, '必填锚点都要命中');
});

test('价格的可接受写法：积分 / 本地积分 / 个积分 / 分 / credits', () => {
  for (const phrase of ['报价 9 积分', '只需9本地积分', '定价 9 个积分', '仅 9 分', 'price: 9 credits', '9 点积分']) {
    accepts(pitch({ shortPitch: `面向agents的MCP自检服务。${phrase}。` }));
  }
});

test('价格写错不算用到：缺价格、数字不符、自行加价都要拒绝', () => {
  rejects(pitchWithoutPrice({}), /需要在实际正文使用输入的价格及积分单位/);
  rejects(pitch({ shortPitch: '面向agents的MCP自检服务，报价 19 积分。' }), /不得自行添加未提供的积分报价或折扣/);
  rejects(pitch({ shortPitch: '面向agents的MCP自检服务，报价 9 积分，另加 3 积分可加急。' }), /不得自行添加未提供的积分报价或折扣/);
});

test('时间与折扣不是报价：5 分钟、9 折不能当价格证据', () => {
  const { work } = accepts(pitch({ shortPitch: '面向agents的MCP自检服务，报价 9 分，5 分钟内交付。' }));
  assert.equal(work.shortPitch.includes('5 分钟'), true);
  // 整篇只有时间与折扣时，不能算作「用到了输入价格」
  rejects({ oneLinePitch: '面向agents的MCP自检服务', shortPitch: '面向agents的MCP自检服务，5 分钟内交付，限时 9 折。',
    keyValuePoints: ['自检服务，5 分钟交付', '限时 9 折，先到先得'], callToAction: '请发来一个真实场景再确认。' },
  /需要在实际正文使用输入的价格及积分单位/);
});

test('产品名同义/去空格可以，完全没用则拒绝', () => {
  accepts(pitch({ shortPitch: '面向agents的MCP自检服务，报价 9 分。' }));
  accepts(pitch({ shortPitch: '面向agents的MCP 自检服务，报价 9 分。' }));
  rejects(pitch({ oneLinePitch: '面向agents的通用服务', shortPitch: '面向agents的通用服务，报价 9 分。', keyValuePoints: ['通用服务，报价 9 分', '适合各类场景，报价 9 分'] }), /未使用输入产品名或价格/);
});

test('sales-stress-test 用同一套价格与产品名规则', () => {
  const stressInput = { ...input };
  const stress = {
    evidenceType: 'SIMULATED',
    topObjections: ['MCP自检服务凭什么值得9本地积分，而不是自己写脚本？', '面向agents的交付能否复现？'],
    whyBuyerMayObject: ['描述不等于可用性证明', '需要把交付范围与采购成本对齐'],
    severity: ['HIGH', 'MEDIUM'],
    recommendedResponses: ['请用您的真实调用串流走一遍，报价 9 积分不变', '先对齐验收条件再确认'],
    whatToFixBeforeSelling: ['给出一次真实输入与输出', '写明标价与时限'],
  };
  assert.equal(normalizeSales(stress, 'sales-stress-test', stressInput).work.evidenceType, 'SIMULATED');
  try { normalizeSales({ ...stress, recommendedResponses: ['报价 12 积分即可', '先对齐验收条件再确认'] }, 'sales-stress-test', stressInput); assert.fail('应当拒绝'); }
  catch (error) { assert.match(error.message, /不得自行添加未提供的积分报价或折扣/); }
});

// ── 以下两个用例来自 2026-09-13 真实买方 Pi agent 的失败回执（逐字输入） ──────────
test('输入里给过的金额（预算/对方报价）可以在正文引用，不算「自行添加报价」', () => {
  const buyerInput = { productName: 'CodeLens', targetBuyer: '参加竞赛的 coding agent 团队',
    productDescription: '代码审查服务：输入代码或仓库片段，输出带文件位置与行号的审查报告（风险清单 + 修复建议）。单次 20 积分，交付 <2 分钟。',
    price: 20, context: '付费复现：我是买方 agent，正在为本队采购代码审查服务；预算 15 积分，卖方报价 20 积分，可减少一次修订次数。' };
  const body = { oneLinePitch: 'CodeLens：代码审查服务，20 积分/次。',
    shortPitch: '面向 coding agent 团队的 CodeLens，20 积分/次，交付 <2 分钟。我们的预算是 15 积分，你方报价 20 积分——能否在原约定基础上减少一次修订来接近预算？',
    keyValuePoints: ['单次 20 积分，输出带位置与修复建议', '可在 15 积分预算内讨论缩小范围'],
    callToAction: '请确认能否在 15 积分预算内缩范围，或保留 20 积分并减少一次修订。' };
  const { work } = normalizeSales(body, 'sales-pitch', buyerInput);
  assert.equal(work.shortPitch, body.shortPitch, '引用输入里的预算/对方报价不该被判失败');
  // 凭空冒出来的金额仍然拒绝
  rejects(pitch({ keyValuePoints: ['单次 20 积分', '加 3 积分可加急'], shortPitch: 'CodeLens 20 积分一次。' }),
    /不得自行添加未提供的积分报价或折扣/, { ...buyerInput, price: 20 });
});

test('context 是背景与约束，不是产品描述：销售类服务不再强制把 context 词写进正文', () => {
  const buyerInput = { productName: 'CodeLens', productDescription: '代码审查服务', price: 20,
    context: '预算 15 积分，对方报价 20 积分，修订次数待确认' };
  const body = { oneLinePitch: 'CodeLens：代码审查服务，20 积分一次。',
    shortPitch: '面向团队的 CodeLens，20 积分一次，先给一个真实片段验证再采购。',
    keyValuePoints: ['20 积分一次，输出问题位置与修复建议', '交付 <2 分钟'],
    callToAction: '发一个真实片段，我按 20 积分交付并把验收标准写清楚。' };
  const { work } = normalizeSales(body, 'sales-pitch', buyerInput);
  const field = work.inputComparison.fields.find(f => f.field === 'context');
  if (field) assert.equal(field.points.every(p => !p.required), true, 'context 锚点必须是非必填（否则模型只能把背景抄进正文）');
});

test('deal-coach 退出条件分方向：预算=底价时只说「只有一个可行点」', () => {
  const both = localSales('deal-coach', { budget: 15, minimumAcceptablePrice: 15, currentOffer: 20, counterpartyMessage: '不降价' });
  assert.match(both.walkAwayCondition, /可行区间只有 15 积分这一点/);
  assert.ok(!/高于预算15积分则退出/.test(both.walkAwayCondition), '预算=底价时不能同时给出两个相反边界');
  assert.match(localSales('deal-coach', { budget: 15 }).walkAwayCondition, /买方视角/);
  assert.match(localSales('deal-coach', { minimumAcceptablePrice: 12 }).walkAwayCondition, /卖方视角/);
  assert.match(localSales('deal-coach', { budget: 10, minimumAcceptablePrice: 15 }).walkAwayCondition, /可行区间不存在/);
});
