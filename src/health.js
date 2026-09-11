import { VERSION } from './catalog.js';

/**
 * Sales Pitch 可观测性：从订单记录聚合 generation 健康统计。
 * 数据源 = 已交付订单的 delivery.pieces[].generation（持久化于 state.json），
 * 不另设存储、不猜测旧记录版本、不泄露任何凭据（只输出聚合计数与原因分类）。
 */

/** 把订单映射为一次 generation 样本（requestId/timestamp/version/mode/耗时/原因）。 */
export function generationSamples(orders, serviceId) {
  return orders
    .filter(o => o.service === serviceId && o.status === 'delivered' && Array.isArray(o.delivery?.pieces) && o.delivery.pieces.some(p => p.service === serviceId || (p.kind === 'ad' && p.service === serviceId)))
    .map(o => {
      const piece = o.delivery.pieces.find(p => p.service === serviceId) || o.delivery.pieces[0];
      const g = piece?.generation || {};
      return { requestId: o.id, testRunId: o.testRunId || null, timestamp: o.completedAt || o.createdAt || null,
        appVersion: g.appVersion || null, mode: g.mode || 'unknown', durationMs: o.elapsedMs ?? g.elapsedMs ?? null,
        modelDurationMs: g.modelDurationMs ?? null, fallbackReason: g.reason || null, internalReason: g.internalReason || null };
    })
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function bucket(samples) {
  const total = samples.length;
  const live = samples.filter(s => s.mode === 'live').length;
  const fallback = samples.filter(s => s.mode === 'fallback').length;
  const mock = samples.filter(s => s.mode === 'mock').length;
  const fallbackReasons = {};
  for (const s of samples) if (s.mode === 'fallback') {
    const key = s.internalReason || 'UNKNOWN';
    fallbackReasons[key] = (fallbackReasons[key] || 0) + 1;
  }
  return { total, live, fallback, mock, liveRate: total ? Number((live / total).toFixed(3)) : null, fallbackReasons };
}

export function serviceGenerationHealth(orders, serviceId, { window = 10, testRunId = null } = {}) {
  const all = generationSamples(orders, serviceId);
  const lifetime = bucket(all);
  const currentVersion = { version: VERSION, ...bucket(all.filter(s => s.appVersion === VERSION)) };
  const recent = { window, ...bucket(all.slice(-window)) };
  const basis = recent.total ? `recent-${window}` : currentVersion.total ? 'current-version' : 'no-samples';
  const rate = recent.total ? recent.liveRate : currentVersion.liveRate;
  const status = recent.total || currentVersion.total ? (rate >= 0.5 ? 'healthy' : 'degraded') : 'unverified';
  return { status, basis, version: VERSION, window, lifetime, currentVersion, recent,
    ...(testRunId ? { testRun: { testRunId, ...bucket(all.filter(s => s.testRunId === testRunId)) } } : {}),
    note: '主状态依据 recent/currentVersion，不受历史旧失败永久拖累；lifetime 完整保留。testRunId 通过下单时的 X-Test-Run-Id 头写入订单。' };
}
