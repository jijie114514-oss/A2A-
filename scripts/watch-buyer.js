#!/usr/bin/env node
/**
 * 第二轮（Arena 2）买方合规监视器：只读 sharednet 账本，核对硬指标。
 *   node scripts/watch-buyer.js --interval=30 [--principal=p_...]
 *
 * 硬指标（黑客松规则 / broker-agent.md）：
 *   · 真实成功消费 80–100 分（失败、免费试用、全额退款不计）
 *   · ≥3 件产品、≥3 家不同外队
 *   · 偏好（非门槛）：单价 ≤30、单卖方累计 ≤30、同等支出尽量 4 家以上
 * 输出：artifacts/arena/buyer-compliance.log（每次一行 JSON）+ buyer-compliance.json（最新快照）
 * 口径：按本方 principal 的出账 txn 统计；退款按入账 txn 扣回；交付成功与否以买方收到的回执为准（本脚本只看账本）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (n, d) => { const hit = args.find(a => a.startsWith(`--${n}=`)); return hit ? hit.split('=').slice(1).join('=') : d; };
const intervalMs = Math.max(15, Number(value('interval', 30))) * 1000;
const own = value('principal', 'p_YZ05HyQL9b');
const logFile = value('log', path.resolve('artifacts/arena/buyer-compliance.log'));
const snapFile = value('snapshot', path.resolve('artifacts/arena/buyer-compliance.json'));
const TEAMS = { p_1gi1M2QuZF: 'TrustSieve', p_t7gkFlUzPN: 'Arbiter', p_Dgu0cZzArK: 'Yuzu', p_A2Pz2QW4iZ: 'Witness', p_lm7RjG7ets: 'Warden', p_zn1vNpB1lD: 'Counterparty', p_WZvBhL1FII: 'Ground' };

const sh = (...a) => spawnSync('npx', ['-y', 'sharednet@latest', ...a], { encoding: 'utf8', timeout: 60000 });
const json = out => { try { const i = String(out || '').indexOf('{'); return i < 0 ? null : JSON.parse(String(out).slice(i)); } catch { return null; } };

function check() {
  const balance = json(sh('balance').stdout) || {};
  const ledger = json(sh('ledger', '--last', '100').stdout) || { items: [] };
  const items = ledger.items || [];
  const outbound = items.filter(t => t.from_principal_id === own);
  const inbound = items.filter(t => t.to_principal_id === own);
  const grants = inbound.filter(t => !t.from_principal_id).reduce((s, t) => s + t.amount, 0);
  const spent = outbound.reduce((s, t) => s + t.amount, 0);
  const bySeller = {};
  for (const t of outbound) bySeller[t.to_principal_id] = (bySeller[t.to_principal_id] || 0) + t.amount;
  // 退款只认 memo 里写明 refund/退款 的入账；否则（含卖方买我们服务）都算营收。
  // 不能按“来自付过款的卖方”判断：卖方也可能同时是我们的客户（2026-09-13 实测误报 30 分）。
  const isRefund = t => /refund|退款|reversal|chargeback/i.test(t.memo || '');
  const refunded = inbound.filter(t => t.from_principal_id && isRefund(t)).reduce((s, t) => s + t.amount, 0);
  const revenue = inbound.filter(t => t.from_principal_id && !isRefund(t)).reduce((s, t) => s + t.amount, 0);
  const products = [...new Set(outbound.map(t => /StarHall r2 ([^\s(]+)/.exec(t.memo || '')?.[1]?.replace(/-\d+$/, '')).filter(Boolean))];
  const sellers = Object.keys(bySeller);
  const net = spent - refunded;
  const met = net >= 80 && sellers.length >= 3 && products.length >= 3;
  const overCap = Object.entries(bySeller).filter(([, a]) => a > 30).map(([p, a]) => `${TEAMS[p] || p}:${a}`);
  const row = { at: new Date().toISOString(), balance: balance.balance ?? null, granted: balance.granted ?? grants, spent, refunded, revenue, net, sellers: sellers.length, products: products.length, bySeller, productList: products, met, overCap };
  mkdirSync(path.dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify(row) + '\n');
  writeFileSync(snapFile, JSON.stringify(row, null, 1));
  const names = Object.entries(bySeller).map(([p, a]) => `${TEAMS[p] || p.slice(0, 10)}:${a}`).join(' ');
  const flag = overCap.length ? ` ⚠️单卖方超30偏好: ${overCap.join(' ')}` : '';
  return { row, line: `[${row.at.slice(11, 19)}] 消费 ${spent}（净 ${net}）· 外队 ${sellers.length} · 产品 ${products.length} · 余 ${balance.balance ?? '?'}${refunded ? ` · 退款 ${refunded}` : ''}${revenue ? ` · 营收 ${revenue}` : ''} ${met ? '✅达标' : '⏳未达'} | ${names}${flag}` };
}

let last = '';
for (;;) {
  try {
    const { row, line } = check();
    const key = JSON.stringify([row.spent, row.refunded, row.revenue, row.balance, row.sellers, row.products]);
    if (key !== last) {
      console.log(line);
      last = key;
      if (row.revenue > 0) console.log(`💰 卖出 ${row.revenue} 分（真实营收到账）`);
      if (row.refunded > 0) console.log(`⚠️ 出现退款 ${row.refunded} 分（退款不计成功消费，需要补买）`);
      if (row.met && row.balance === 0) console.log('🏁 已达标且余额清零');
      else if (row.met && row.balance > 0) console.log(`ℹ️ 已达 80 分门槛，仍有余额 ${row.balance}（Arena 2 裁判要求花完则继续）`);
      else if (!row.met && row.balance === 0) console.log('⚠️ 余额为 0 但未达 80 分门槛');
    }
  } catch (e) {
    console.error(`[${new Date().toISOString().slice(11, 19)}] 监视失败：${e.message}`);
  }
  await new Promise(r => setTimeout(r, intervalMs));
}
