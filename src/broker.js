import { ensure, object, string } from './errors.js';

export const BROKER_TOOLS = ['session', 'status', 'receipt', 'checklist', 'next'];
export const PURCHASE_POLICY = Object.freeze({
  minimumProducts: 3, minimumTeams: 3, preferredTeams: 4, preferredTotal: 80,
  preferredMaxProductPrice: 30, preferredMaxSellerSpend: 30,
  preferLowerPrices: true, preferBalancedSpend: true,
  popularity: 'Prefer less-purchased sellers using current comparable public evidence; unknown is not zero.',
  exceptions: 'Agent decides and records the reason; preferences never invalidate a delivered receipt.',
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = values => [...new Set(values)];
const id = (value, name) => string(value, name, 120);
function timestamp(value, name) {
  ensure(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'invalid_input', `${name} 需要带时区的 ISO 时间`);
  return new Date(value).toISOString();
}
function sessionInput(input) {
  object(input, ['runId', 'source', 'ownTeamId', 'schedule']);
  ensure(['fixture', 'arena'].includes(input.source), 'invalid_input', 'source 必须是 fixture 或 arena');
  let schedule = null;
  if (input.schedule != null) {
    object(input.schedule, ['trialStart', 'trialEnd', 'marketStart', 'marketEnd']);
    schedule = Object.fromEntries(['trialStart', 'trialEnd', 'marketStart', 'marketEnd'].map(k => [k, timestamp(input.schedule[k], k)]));
    const t = Object.values(schedule).map(Date.parse);
    ensure(t[0] < t[1] && t[1] <= t[2] && t[2] < t[3], 'invalid_input', '两轮时间必须依次为试用开始、试用结束、市场开始、市场结束');
  }
  ensure(input.source !== 'arena' || schedule, 'missing_schedule', '正式记录必须先配置真实赛程；目前仍未连接正式赛事接口');
  return { runId: id(input.runId, 'runId'), source: input.source, ownTeamId: id(input.ownTeamId, 'ownTeamId'), schedule };
}
export function createBrokerSession(state, input) {
  const settings = sessionInput(input);
  state.brokerRooms ||= [];
  const existing = state.brokerRooms.find(r => r.settings.runId === settings.runId);
  if (existing) {
    ensure(same(existing.settings, settings), 'session_conflict', 'runId 已存在且配置不同；不能覆盖历史记录，请使用新 runId', 409);
    return { ...existing.settings, replayed: true };
  }
  state.brokerRooms.push({ settings, receipts: [], checklist: [], createdAt: new Date().toISOString() });
  return { ...settings, replayed: false };
}
function roomOf(state, runId) {
  const room = state.brokerRooms?.find(r => r.settings.runId === id(runId, 'runId'));
  ensure(room, 'broker_session_not_found', '作战室会话不存在，请先初始化指定 runId', 404);
  return room;
}
function common(room, input, clock) {
  ensure(input.source === room.settings.source, 'source_mismatch', '模拟回执与正式记录不能混用');
  const occurredAt = timestamp(input.occurredAt, 'occurredAt');
  ensure(Date.parse(occurredAt) <= clock, 'future_evidence', '不能记录尚未发生的事件');
  return { source: input.source, occurredAt, evidenceRef: string(input.evidenceRef, 'evidenceRef', 1000) };
}
function otherTeam(room, teamId) {
  const team = id(teamId, 'teamId');
  ensure(team !== room.settings.ownTeamId, 'own_team', '本队明星不算其他队伍，请使用赛事目录的真实 teamId');
  return team;
}
export function recordBrokerReceipt(state, input, clock = Date.now()) {
  object(input, ['runId', 'receiptId', 'teamId', 'amount', 'service', 'status', 'source', 'occurredAt', 'evidenceRef', 'note']);
  const room = roomOf(state, input.runId);
  ensure(Number.isSafeInteger(input.amount) && input.amount >= 0 && input.amount <= 100000, 'invalid_input', 'amount 必须为非负整数积分');
  ensure(['delivered', 'failed', 'refunded'].includes(input.status), 'invalid_input', '仅接受 delivered、failed、refunded 回执');
  const receipt = { receiptId: id(input.receiptId, 'receiptId'), teamId: otherTeam(room, input.teamId), amount: input.amount,
    service: id(input.service, 'service'), status: input.status, ...common(room, input, clock), note: string(input.note, 'note', 2000, false) };
  const previous = room.receipts.find(r => r.receiptId === receipt.receiptId && r.teamId === receipt.teamId);
  if (previous) {
    if (same(previous.current, receipt)) return { recorded: true, replayed: true };
    ensure(previous.current.status === 'delivered' && receipt.status === 'refunded' && previous.current.amount === receipt.amount
      && previous.current.service === receipt.service && receipt.occurredAt >= previous.current.occurredAt,
    'receipt_conflict', '同队同回执不可改写；只允许已交付订单按原金额记录后续全额退款', 409);
    previous.history.push(previous.current); previous.current = receipt;
  } else {
    ensure(receipt.status !== 'refunded', 'missing_original_receipt', '请先记录原交付回执，再记录退款');
    room.receipts.push({ receiptId: receipt.receiptId, teamId: receipt.teamId, current: receipt, history: [] });
  }
  return { recorded: true, replayed: false };
}
export function recordBrokerChecklist(state, input, clock = Date.now()) {
  object(input, ['runId', 'eventId', 'kind', 'teamId', 'service', 'text', 'teams', 'accepted', 'source', 'occurredAt', 'evidenceRef']);
  const room = roomOf(state, input.runId);
  ensure(['trial', 'objection', 'ranking'].includes(input.kind), 'invalid_input', 'kind 必须为 trial、objection 或 ranking');
  const event = { eventId: id(input.eventId, 'eventId'), kind: input.kind, ...common(room, input, clock) };
  if (event.kind === 'ranking') {
    ensure(input.accepted === true, 'ranking_unconfirmed', '排名必须已提交并获得接收确认');
    ensure(Array.isArray(input.teams) && input.teams.length >= 3 && input.teams.length <= 100, 'invalid_input', 'teams 需要排名中的队伍ID列表');
    event.teams = input.teams.map(t => id(t, 'teamId'));
    ensure(unique(event.teams).length === event.teams.length && event.teams.filter(t => t !== room.settings.ownTeamId).length >= 3, 'invalid_ranking', '排名需包含至少3个不同的其他队伍');
    event.accepted = true;
  } else {
    event.teamId = otherTeam(room, input.teamId);
    if (event.kind === 'trial') event.service = id(input.service, 'service');
    else {
      event.text = string(input.text, 'text', 3000);
      ensure(event.text.length >= 6, 'invalid_input', '异议需要具体描述观察或证据缺口');
      ensure(room.checklist.some(e => e.kind === 'trial' && e.teamId === event.teamId && e.occurredAt <= event.occurredAt), 'missing_trial', '请先记录该队伍的实际试用');
    }
  }
  const previous = room.checklist.find(e => e.eventId === event.eventId);
  if (previous) { ensure(same(previous, event), 'checklist_conflict', 'eventId 已用于不同打卡，请查询原记录', 409); return { recorded: true, replayed: true }; }
  room.checklist.push(event);
  return { recorded: true, replayed: false };
}
function inRound(room, event, round) {
  const s = room.settings.schedule;
  return !s || (event.occurredAt >= s[`${round}Start`] && event.occurredAt <= s[`${round}End`]);
}
export function brokerStatus(state, runId, clock = Date.now()) {
  const room = roomOf(state, runId), s = room.settings.schedule;
  const receipts = room.receipts.map(r => ({ ...r.current, history: r.history }));
  const counted = receipts.filter(r => r.status === 'delivered' && r.amount > 0 && inRound(room, r, 'market'));
  const spent = counted.reduce((sum, r) => sum + r.amount, 0), teamsBought = unique(counted.map(r => r.teamId));
  const productsBought = [...new Map(counted.map(r => [JSON.stringify([r.teamId, r.service]), { teamId: r.teamId, service: r.service }])).values()];
  const productsMissing = Math.max(0, PURCHASE_POLICY.minimumProducts - productsBought.length);
  const sellerSpend = teamsBought.map(teamId => {
    const purchases = counted.filter(r => r.teamId === teamId);
    const amount = purchases.reduce((sum, r) => sum + r.amount, 0);
    return { teamId, spent: amount, purchaseCount: purchases.length, preferredRemaining: Math.max(0, PURCHASE_POLICY.preferredMaxSellerSpend - amount) };
  });
  const tried = unique(room.checklist.filter(e => e.kind === 'trial' && inRound(room, e, 'trial')).map(e => e.teamId));
  const objections = unique(room.checklist.filter(e => e.kind === 'objection' && inRound(room, e, 'trial') && tried.includes(e.teamId)).map(e => e.teamId));
  const missingObjections = tried.filter(t => !objections.includes(t));
  const rankings = room.checklist.filter(e => e.kind === 'ranking' && inRound(room, e, 'trial'));
  const lastRanking = rankings.toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1);
  const requiredEvents = room.checklist.filter(e => e.kind !== 'ranking' && inRound(room, e, 'trial'));
  const ranked = !!lastRanking && tried.every(t => lastRanking.teams.includes(t)) && requiredEvents.every(e => e.occurredAt <= lastRanking.occurredAt);
  const checklist = { tried3: tried.length >= 3, objections3: objections.length >= 3 && missingObjections.length === 0, ranked };
  let phase = 'UNSCHEDULED', deadline = null;
  if (s) {
    const t = new Date(clock).toISOString();
    phase = t < s.trialStart ? 'BEFORE' : t < s.trialEnd ? 'TRIAL' : t < s.marketStart ? 'BETWEEN' : t < s.marketEnd ? 'MARKET' : 'ENDED';
    deadline = phase === 'BEFORE' ? s.trialStart : phase === 'TRIAL' ? s.trialEnd : phase === 'BETWEEN' ? s.marketStart : s.marketEnd;
  }
  const minutesLeft = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - clock) / 60000)) : null;
  const recordedObjectivesMet = spent >= 80 && spent <= 100 && teamsBought.length >= 3 && productsMissing === 0 && Object.values(checklist).every(Boolean);
  const alerts = [];
  if (!s) alerts.push({ level: 'warning', code: 'NO_SCHEDULE', message: '未配置赛程，不能检查倒计时和发生时段' });
  if (spent > 100) alerts.push({ level: 'critical', code: 'OVER_BUDGET', message: '记录的支出超过100分，请核对真实钱包与回执' });
  if (spent > PURCHASE_POLICY.preferredTotal && spent <= 100) alerts.push({ level: 'info', code: 'ABOVE_PREFERRED_TOTAL', message: `支出已超过80分目标${spent - PURCHASE_POLICY.preferredTotal}分；核对剩余硬指标，避免继续非必要消费` });
  const expensive = counted.filter(r => r.amount > PURCHASE_POLICY.preferredMaxProductPrice);
  if (expensive.length) alerts.push({ level: 'warning', code: 'HIGH_PRICE_PURCHASE',
    message: '存在单笔超过30分的产品；请在原回执note中保留无其他可行选择的依据',
    receipts: expensive.map(r => ({ teamId: r.teamId, receiptId: r.receiptId, amount: r.amount })) });
  const concentrated = sellerSpend.filter(r => r.spent > PURCHASE_POLICY.preferredMaxSellerSpend);
  if (concentrated.length) alerts.push({ level: 'warning', code: 'SELLER_SPEND_CONCENTRATED',
    message: '部分卖方累计支出超过30分偏好；后续选品优先考虑其他队伍，勿为均摊追加无必要消费', sellers: concentrated });
  const trialDone = Object.values(checklist).every(Boolean), marketDone = spent >= 80 && spent <= 100 && teamsBought.length >= 3 && productsMissing === 0;
  if (phase === 'TRIAL' && minutesLeft <= 15 && !trialDone) alerts.push({ level: 'critical', code: 'TRIAL_DEADLINE', message: '试用轮剩余不足15分钟，优先补齐试用、异议和排名' });
  if (phase === 'MARKET' && minutesLeft <= 15 && !marketDone) alerts.push({ level: 'critical', code: 'MARKET_DEADLINE', message: '市场轮剩余不足15分钟，立即自主评估预算和不同队伍缺额' });
  if (phase === 'MARKET' && clock >= (Date.parse(s.marketStart) + Date.parse(s.marketEnd)) / 2 && spent < 40) alerts.push({ level: 'warning', code: 'BEHIND_HALF', message: '市场轮已过半，记录的消费仍不足40分' });
  if (['BETWEEN', 'MARKET', 'ENDED'].includes(phase) && !trialDone) alerts.push({ level: 'critical', code: 'TRIAL_INCOMPLETE', message: '试用轮已结束，第一轮记录不完整，不能用后续动作冒充按时完成' });
  if (phase === 'ENDED' && !recordedObjectivesMet) alerts.push({ level: 'critical', code: 'ROUND_ENDED_INCOMPLETE', message: '比赛时段已结束，尚有未完成项，请如实报告' });
  return { ...room.settings, phase, spent, budget: 100, required: 80, remaining: 100 - spent, spendMissing: Math.max(0, 80 - spent),
    teamsBought, teamsRequired: 3, missing: Math.max(0, 3 - teamsBought.length), minutesLeft, deadline, checklist,
    purchaseCount: counted.length, productsBought, productCount: productsBought.length, productsRequired: PURCHASE_POLICY.minimumProducts, productsMissing,
    sellerSpend, purchasePolicy: { ...PURCHASE_POLICY },
    teamsTried: tried, teamsWithObjections: objections, missingObjections, recordedObjectivesMet, scheduleConfigured: !!s,
    qualificationConfirmed: false, evidenceMode: 'agent-reported', arenaConnected: false, automaticPurchases: false,
    alerts, receipts, events: room.checklist, checkedAt: new Date(clock).toISOString() };
}
export function brokerNext(status) {
  let advice;
  if (status.alerts.some(a => a.code === 'OVER_BUDGET')) advice = '先核对真实钱包及退款记录，停止新增消费。';
  else if (status.phase === 'ENDED') advice = '本轮已结束；核对原始回执并如实报告完成情况，不补造赛内记录。';
  else if (status.phase === 'BEFORE') advice = '等待试用轮开始；检查市场入口、队伍ID和经纪人身份。';
  else if (status.phase === 'BETWEEN') advice = '等待市场轮开始，核对第一轮回执并自主拟定预算。';
  else if (status.phase === 'MARKET' && (status.spendMissing || status.missing || status.productsMissing)) advice = `还差${status.spendMissing}分、${status.productsMissing}件产品、${status.missing}家外队；剩余预算${status.remaining}分。自主比较接近80分的组合，优先单价≤30分、卖方累计≤30分及有证据表明较少被购买的外队；下单前核对真实钱包。`;
  else if (!status.checklist.tried3 && status.phase !== 'MARKET') advice = `自主选择并试用另外${Math.max(0, 3 - status.teamsTried.length)}家不同队伍，保存回执。`;
  else if (!status.checklist.objections3 && status.phase !== 'MARKET') advice = `根据实测给${status.missingObjections.join('、') || '试用队伍'}提交具体异议并记录发送凭据。`;
  else if (!status.checklist.ranked && status.phase !== 'MARKET') advice = '自主决定排名并实际提交；收到确认后记录排名回执。';
  else if (status.spendMissing || status.missing || status.productsMissing) advice = '第一轮清单已齐；市场轮开始后自主比较组合：至少3件产品、3家外队，尽量恰好80分，同等总额优先分散到4家及以上并均摊。';
  else advice = status.recordedObjectivesMet ? '记录中的硬指标已齐；核对平台回执后停止为凑数新增购买，不为凑第4家超过80分，可开展获准的推销与服务跟进。' : '市场消费记录已齐，停止为凑数新增购买；第一轮仍有缺项，如实核对并报告。';
  return { runId: status.runId, phase: status.phase, advice, alerts: status.alerts, automaticPurchases: false };
}
export function registerBrokerTools(app) {
  for (const name of BROKER_TOOLS) app.bridge.register(`broker_${name}`, `broker/tracking/${name}`, 'invoke', async (_ctx, args) => {
    if (name === 'session') return app.store.transaction(state => createBrokerSession(state, args));
    if (name === 'receipt') return app.store.transaction(state => recordBrokerReceipt(state, args));
    if (name === 'checklist') return app.store.transaction(state => recordBrokerChecklist(state, args));
    object(args, ['runId']);
    const status = brokerStatus(app.store.read(), args.runId);
    return name === 'next' ? brokerNext(status) : status;
  });
}
