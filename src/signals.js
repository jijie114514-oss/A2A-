import { campaignStats, eligiblePaid } from './market.js';

export const SALES_IDS = ['sales-pitch', 'sales-stress-test', 'deal-coach'];
const concern = { 'sales-pitch': 'sales communication', 'sales-stress-test': 'offer validation', 'deal-coach': 'pricing and negotiation' };
export function recordSignals(state, order) {
  if (!SALES_IDS.includes(order.service) || order.status !== 'delivered') return;
  state.commercialSignals ||= [];
  if (state.commercialSignals.some(s => s.orderId === order.id)) return;
  const base = { buyerId: order.buyerId, orderId: order.id, service: order.service, kind: order.kind, at: order.completedAt };
  for (const [field, value] of Object.entries(order.input)) state.commercialSignals.push({ ...base, id: `${order.id}:explicit:${field}`,
    evidenceClass: 'EXPLICIT', confidence: 'HIGH', status: 'KNOWN', field, value, source: `order:${order.id}/input/${field}`, qualification: 'Self-reported input; not independently verified' });
  state.commercialSignals.push({ ...base, id: `${order.id}:behavior`, evidenceClass: 'BEHAVIORAL', confidence: 'LOW', status: 'INFERRED',
    field: 'possibleCommercialConcern', value: `${concern[order.service]} may currently matter`, source: `order:${order.id}`, qualification: 'Service usage alone does not establish buyer objections or sales outcomes' });
  state.commercialSignals.push({ ...base, id: `${order.id}:usage`, evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN',
    field: 'serviceDelivered', value: { service: order.service, kind: order.kind, paidCredits: order.price, generationModes: order.delivery.pieces.map(p => p.generation.mode) }, source: `order:${order.id}` });
}
export function commercialProfile(state, buyerId, currentInput = {}) {
  const orders = state.orders.filter(o => o.buyerId === buyerId && o.status !== 'pending');
  const campaigns = state.ads.filter(a => a.buyerId === buyerId).map(a => campaignStats(state, a));
  const signals = (state.commercialSignals || []).filter(s => s.buyerId === buyerId).map(s => ({ ...s,
    sourceOrderStatus: orders.find(o => o.id === s.orderId)?.status || 'unknown' }));
  const evidence = [...signals];
  for (const [field, value] of Object.entries(currentInput)) evidence.push({ id: `current:${field}`, evidenceClass: 'EXPLICIT', confidence: 'HIGH', status: 'KNOWN', field, value, source: `currentInput/${field}`, qualification: 'Current self-reported input; not independently verified' });
  for (const order of orders) evidence.push({ id: `order:${order.id}`, evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN', field: 'transaction',
    value: { service: order.service, kind: order.kind || 'paid', status: order.status, paidCredits: eligiblePaid(order) ? order.price : 0 }, source: `order:${order.id}` });
  for (const campaign of campaigns) {
    evidence.push({ id: `campaign:${campaign.id}`, evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN', field: 'campaign',
      value: { starId: campaign.starId || null, status: campaign.status, kind: campaign.kind, currentImpressions: campaign.currentImpressions,
        trackedImpressions: campaign.trackedImpressions, traffic: campaign.traffic }, source: `campaign:${campaign.id}` });
    for (const impression of campaign.impressions) evidence.push({ id: `impression:${impression.id}`, evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN', field: 'adImpression', value: impression, source: `campaign:${campaign.id}` });
  }
  evidence.push({ id: 'profile:snapshot', evidenceClass: 'OBSERVED', confidence: 'HIGH', status: 'KNOWN', field: 'authorizedSnapshot',
    value: { completedOrders: orders.length, campaignCount: campaigns.length, hasRealBuyerOutcomeTracking: false }, source: 'own-ledger-snapshot' });
  return { buyerId, scope: 'Only this buyer’s authorized StarHall history; no Arena-wide or psychological profile', currentInput, signals, evidence,
    history: orders.map(o => ({ orderId: o.id, service: o.service, status: o.status, kind: o.kind || 'paid', credits: eligiblePaid(o) ? o.price : 0, completedAt: o.completedAt })),
    campaigns, totals: { successfulPaidOrders: orders.filter(eligiblePaid).length, paidCredits: orders.filter(eligiblePaid).reduce((n, o) => n + o.price, 0),
      trackedImpressions: campaigns.reduce((n, c) => n + c.trackedImpressions, 0) } };
}
export function recommendedNextAction(state, buyerId) {
  const orders = state.orders.filter(o => o.buyerId === buyerId && o.status === 'delivered' && !o.refundedAt && !o.refund && !o.refunded);
  const used = id => orders.some(o => o.service === id);
  if (used('commercial-diagnostic')) return { action: 'validate-with-a-real-buyer', price: 0, reason: 'Apply the diagnostic’s first action and collect real acceptance or rejection evidence before buying more analysis.' };
  if (used('star-sponsorship') && (used('sales-pitch') || used('deal-coach'))) return { service: 'commercial-diagnostic', price: 30, reason: 'You have service and campaign history that can now be compared; impressions are not conversions.' };
  if (used('deal-coach') && used('sales-stress-test')) return { service: 'star-sponsorship', reason: 'Compare real audience, pressure and exposure weight on the free board before choosing a star.', firstStep: '/v1/market-board' };
  if (used('sales-stress-test')) return { service: 'deal-coach', price: 15, reason: 'Bring an actual offer, budget or counterparty message to decide the next negotiation move.' };
  if (used('sales-pitch')) return { service: 'sales-stress-test', price: 10, reason: 'Stress-test the offer you just expressed before using it with real buyers.' };
  if (used('deal-coach')) return { service: 'sales-pitch', price: 8, reason: 'Clarify the product value supporting your price and negotiation position.' };
  return { service: 'sales-pitch', price: 8, reason: 'Start with your product description or context to obtain immediately usable sales wording.' };
}
export function diagnostic(profile) {
  const evidence = profile.evidence;
  const refs = predicate => evidence.filter(predicate).map(e => e.id);
  const explicit = field => evidence.filter(e => e.evidenceClass === 'EXPLICIT' && e.field === field).at(-1);
  const finding = (text, ids = [], status = 'KNOWN', confidence = 'HIGH') => {
    if (!ids.length && status !== 'UNKNOWN') ids = ['profile:snapshot'];
    return { finding: text, evidenceRefs: ids, evidenceClass: [...new Set(evidence.filter(e => ids.includes(e.id)).map(e => e.evidenceClass))], status, confidence };
  };
  const unknown = text => finding(text, [], 'UNKNOWN', 'INSUFFICIENT');
  const transactions = refs(e => e.field === 'transaction');
  const uses = service => profile.history.filter(o => o.service === service && o.status === 'delivered');
  const useRefs = service => refs(e => e.field === 'transaction' && e.value.service === service && e.value.status === 'delivered');
  const product = explicit('productDescription') || explicit('context');
  const price = explicit('price');
  const buyer = explicit('targetBuyer');
  const campaigns = refs(e => e.field === 'campaign');
  const usageFinding = (service, label) => uses(service).length ? finding(`${uses(service).length} completed ${service} use(s) suggest ${label} may be a current concern; they do not demonstrate a customer problem.`, [...useRefs(service), ...refs(e => e.service === service && e.evidenceClass === 'BEHAVIORAL')], 'INFERRED', 'MODERATE') : unknown(`No completed ${service} history; ${label} cannot be assessed from usage.`);
  const sections = {
    currentCommercialProfile: [finding(`${profile.totals.successfulPaidOrders} successful paid StarHall orders; ${profile.totals.paidCredits} local credits.`, transactions), product ? finding(`Self-reported offering: ${product.value}`, [product.id]) : unknown('Product offering not provided.')],
    positioningDiagnosis: [buyer ? finding(`Self-reported target buyer: ${buyer.value}. Validate this audience against a real buyer’s task.`, [buyer.id]) : unknown('Target buyer is missing; ask one real buyer to state the task your product should complete.'), unknown('Positioning effectiveness in the Arena has not been observed.')],
    salesCommunicationDiagnosis: [usageFinding('sales-pitch', 'sales communication'), unknown('No verified comparison of buyer understanding before and after using the pitch.')],
    pricingDiagnosis: [price ? finding(`Latest self-reported price: ${price.value} credits; willingness to pay remains unverified.`, [price.id]) : unknown('No explicit product price supplied.'), usageFinding('deal-coach', 'pricing and negotiation')],
    negotiationDiagnosis: [usageFinding('deal-coach', 'negotiation'), unknown('Real counterparty acceptance, rejection and completed deals have not been independently observed.')],
    distributionDiagnosis: [finding(`${profile.campaigns.length} campaigns; ${profile.totals.trackedImpressions} event-backed payload impressions.`, campaigns), unknown('Impressions measure inclusion in responses, not attention, clicks, revenue or conversions. Historic untracked legacy counters cannot establish individual exposure events.')],
    evidenceSummary: { findings: [finding(`Evidence comes exclusively from your current input and your own StarHall records.`, transactions)], counts: Object.fromEntries(['EXPLICIT', 'BEHAVIORAL', 'OBSERVED'].map(c => [c, evidence.filter(e => e.evidenceClass === c).length])), evidence },
    mainBottleneck: [finding(profile.totals.trackedImpressions ? 'Distribution activity is recorded, but its commercial effect cannot yet be established. Collect a real buyer outcome and link it to the specific offer.' : 'The current records do not establish real buyer acceptance. Run one concrete buyer validation before increasing distribution spend.', campaigns.length ? campaigns : transactions, 'INFERRED', 'MODERATE')],
    recommendedNext3Actions: [
      { ...finding(product ? 'Use the stated offering to run one end-to-end demo for a real target buyer; record their exact task and response.' : 'Write one concrete product input and deliverable, then test that example with a real buyer.', product ? [product.id] : [], 'INFERRED', 'MODERATE'), action: 'validate-offer' },
      { ...finding(price ? `Ask the buyer whether the stated ${price.value}-credit scope is acceptable; record exact objections without converting simulation into fact.` : 'Choose an explicit price and delivery scope, then collect a real counteroffer.', price ? [price.id] : [], 'INFERRED', 'MODERATE'), action: 'validate-price' },
      { ...finding(campaigns.length ? 'Compare your recorded active/passive impressions and star audience; repeat a small campaign only after checking a real buyer outcome.' : 'Use the free Market Board to select an audience; set a small campaign budget only after validating the offer.', campaigns, 'INFERRED', 'MODERATE'), action: 'measure-distribution' },
    ],
  };
  return { title: 'Commercial Diagnostic', text: sections.mainBottleneck[0].finding, ...sections,
    generation: { mode: 'evidence-engine', provider: 'local-ledger', notice: 'Deterministic analysis of authorized evidence; no claim of Arena-wide observation.' } };
}
