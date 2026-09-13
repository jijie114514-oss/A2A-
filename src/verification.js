// Machine-verifiable delivery verification. Deterministic code only:
// refunds, refund reasons and constraint checks are never decided by an LLM.
export const REFUND_REASONS = Object.freeze([
  'DELIVERY_TIMEOUT',
  'SERVER_ERROR',
  'EMPTY_DELIVERY',
  'SCHEMA_VALIDATION_FAILED',
  'REQUIRED_COMPONENT_MISSING',
  'BUDGET_VIOLATION',
  'PRICE_FLOOR_VIOLATION',
  'ADVERTISEMENT_ACTIVATION_FAILED',
  'FALLBACK_NOT_CHARGED',
  'OTHER_MACHINE_VERIFIED_FAILURE',
]);

const filled = value => typeof value === 'string' && value.trim().length > 0;
const nonEmptyStrings = (value, min = 1) => Array.isArray(value) && value.length >= min && value.every(item => filled(item));
const PLACEHOLDER = /(?:【[^】]*(?:待|填写|金额|价格|XX)[^】]*】|\{\{[^}]+\}\}|<(?:金额|价格|产品名|待填写)>|\b(?:TODO|TBD|PLACEHOLDER)\b)/i;

const check = (name, ok, detail = '') => ({ name, ok, detail });
const fail = (refundReason, checks) => ({ ok: false, refundReason, checks, machineDecided: true });
const pass = checks => ({ ok: true, refundReason: null, checks, machineDecided: true });

/**
 * Deterministic verification of a committed delivery against the order contract.
 * Mirrors the generation-time validation as a second line of defense; it must
 * agree with delivered content and only fails on objectively broken deliveries.
 */
export function verifyDelivery(order, service) {
  const checks = [];
  const pieces = order?.delivery?.pieces || [];
  checks.push(check('pieces.nonEmpty', pieces.length > 0, `pieces=${pieces.length}`));
  if (!pieces.length) return fail('EMPTY_DELIVERY', checks);
  for (const piece of pieces) {
    const shapeOk = Boolean(piece && typeof piece === 'object');
    const textOk = shapeOk && filled(piece.text);
    checks.push(check('piece.text.nonEmpty', textOk, `star=${piece?.star}`));
    if (!shapeOk) return fail('SCHEMA_VALIDATION_FAILED', checks);
    if (!textOk) return fail('EMPTY_DELIVERY', checks);
  }
  if (service.ad) {
    const ad = order.delivery?.ad;
    const sponsorship = order.delivery?.sponsorship;
    const activated = Boolean(ad && ad.status === 'active'
      && (order.service !== 'star-sponsorship' || (sponsorship?.status === 'ACTIVE' && sponsorship.starId === ad.starId)));
    checks.push(check('ad.activation', activated, `ad=${ad?.status || 'missing'}, sponsorship=${sponsorship?.status || 'missing'}`));
    return activated ? pass(checks) : fail('ADVERTISEMENT_ACTIVATION_FAILED', checks);
  }
  const piece = pieces[0];
  const all = fields => fields.every(field => filled(piece[field]));
  const input = order.input || {};
  if (service.id === 'sales-pitch') {
    const schema = all(['oneLinePitch', 'shortPitch', 'callToAction']) && nonEmptyStrings(piece.keyValuePoints, 2);
    checks.push(check('schema.requiredFields', all(['oneLinePitch', 'shortPitch', 'callToAction'])));
    checks.push(check('schema.keyValuePoints', nonEmptyStrings(piece.keyValuePoints, 2)));
    checks.push(check('schema.noPlaceholders', !PLACEHOLDER.test(JSON.stringify(piece))));
    const cmp = piece.inputComparison;
    const fidelity = Boolean(cmp && Array.isArray(cmp.fields) && cmp.fields.length > 0
      && cmp.fields.every(f => Array.isArray(f.points) && f.points.every(p => !p.required || p.matched)));
    checks.push(check('contextFidelity.basic', fidelity, 'inputComparison present and required anchors matched'));
    if (!schema) return fail('REQUIRED_COMPONENT_MISSING', checks);
    if (PLACEHOLDER.test(JSON.stringify(piece))) return fail('SCHEMA_VALIDATION_FAILED', checks);
    if (!fidelity) return fail('REQUIRED_COMPONENT_MISSING', checks);
    return pass(checks);
  }
  if (service.id === 'sales-stress-test') {
    const arrays = ['topObjections', 'whyBuyerMayObject', 'severity', 'recommendedResponses', 'whatToFixBeforeSelling'];
    const aligned = nonEmptyStrings(piece.topObjections, 2) && arrays.every(field => nonEmptyStrings(piece[field], 2))
      && arrays.every(field => piece[field].length === piece.topObjections.length);
    const severityOk = Array.isArray(piece.severity) && piece.severity.every(s => ['HIGH', 'MEDIUM', 'LOW'].includes(s));
    const simulated = piece.evidenceType === 'SIMULATED';
    checks.push(check('schema.topObjections', nonEmptyStrings(piece.topObjections, 2)));
    checks.push(check('schema.recommendedResponses', nonEmptyStrings(piece.recommendedResponses, 2)));
    checks.push(check('schema.alignedLengths', arrays.every(field => nonEmptyStrings(piece[field], 2) && piece[field].length === (piece.topObjections || []).length)));
    checks.push(check('schema.severityEnum', severityOk));
    checks.push(check('schema.evidenceType.simulated', simulated, `evidenceType=${piece.evidenceType}`));
    if (!aligned || !severityOk) return fail('REQUIRED_COMPONENT_MISSING', checks);
    if (!simulated) return fail('SCHEMA_VALIDATION_FAILED', checks);
    return pass(checks);
  }
  if (service.id === 'deal-coach') {
    const offer = piece.recommendedCounteroffer;
    const offerTypeOk = offer === null || (typeof offer === 'number' && Number.isFinite(offer));
    checks.push(check('counteroffer.type', offerTypeOk, `value=${JSON.stringify(offer)}`));
    if (typeof offer === 'number' && input.budget !== undefined && offer > input.budget) {
      checks.push(check('constraint.budget', false, `recommended ${offer} > budget ${input.budget}`));
      return fail('BUDGET_VIOLATION', checks);
    }
    if (typeof offer === 'number' && input.minimumAcceptablePrice !== undefined && offer < input.minimumAcceptablePrice) {
      checks.push(check('constraint.priceFloor', false, `recommended ${offer} < minimumAcceptablePrice ${input.minimumAcceptablePrice}`));
      return fail('PRICE_FLOOR_VIOLATION', checks);
    }
    if (typeof offer === 'number') {
      checks.push(check('constraint.budget', input.budget === undefined || offer <= input.budget, `offer=${offer}, budget=${input.budget}`));
      checks.push(check('constraint.priceFloor', input.minimumAcceptablePrice === undefined || offer >= input.minimumAcceptablePrice, `offer=${offer}, floor=${input.minimumAcceptablePrice}`));
    }
    const fieldsOk = all(['nextMessage', 'strategy', 'concessionLevel', 'walkAwayCondition', 'risk']);
    checks.push(check('schema.requiredFields', fieldsOk));
    if (!offerTypeOk) return fail('SCHEMA_VALIDATION_FAILED', checks);
    if (!fieldsOk) return fail('REQUIRED_COMPONENT_MISSING', checks);
    return pass(checks);
  }
  if (service.id === 'commercial-diagnostic') {
    const sections = ['currentCommercialProfile', 'positioningDiagnosis', 'salesCommunicationDiagnosis', 'pricingDiagnosis',
      'negotiationDiagnosis', 'distributionDiagnosis', 'evidenceSummary', 'mainBottleneck', 'recommendedNext3Actions'];
    const missing = sections.filter(key => piece[key] === undefined);
    checks.push(check('sections.complete', missing.length === 0, missing.join(',') || 'all present'));
    const evidenceOk = Boolean(piece.evidenceSummary && Array.isArray(piece.evidenceSummary.evidence) && piece.evidenceSummary.evidence.length > 0
      && Array.isArray(piece.evidenceSummary.findings) && piece.evidenceSummary.findings.length > 0);
    const findingsOk = ['currentCommercialProfile', 'positioningDiagnosis', 'salesCommunicationDiagnosis', 'pricingDiagnosis',
      'negotiationDiagnosis', 'distributionDiagnosis', 'mainBottleneck']
      .every(key => Array.isArray(piece[key]) && piece[key].every(f => f && ['KNOWN', 'INFERRED', 'UNKNOWN'].includes(f.status)));
    const actionsOk = Array.isArray(piece.recommendedNext3Actions) && piece.recommendedNext3Actions.length === 3;
    checks.push(check('schema.evidenceSummary', evidenceOk));
    checks.push(check('schema.knownInferredUnknown', findingsOk));
    checks.push(check('schema.threeActions', actionsOk));
    if (missing.length) return fail('REQUIRED_COMPONENT_MISSING', checks);
    if (!evidenceOk || !findingsOk || !actionsOk) return fail('SCHEMA_VALIDATION_FAILED', checks);
    return pass(checks);
  }
  // Legacy entertainment services are fully validated during generation (schema,
  // grounding, placeholders); machine checks here only confirm non-empty committed text.
  checks.push(check('service.verifiedAtGeneration', true, 'legacy services validated during generation'));
  return pass(checks);
}
