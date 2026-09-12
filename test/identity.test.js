import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StarHall } from '../src/app.js';
import { config } from '../src/config.js';
import { identityOf, OWNER, NAMESPACE_ID, resource } from '../src/kernel.js';
import { buildAgentCard } from '../src/agent-card.js';

const TENANT = 'tenant_acme_42';
const OWNER_ID = 'owner_9f3';
const NODES = { 'star-a': 'node_star_a_777', 'star-b': 'node_star_b_777', 'star-c': 'node_star_c_777', ledger: 'node_ledger_777', broker: 'node_broker_777' };
const official = { STARHALL_TENANT_ID: TENANT, STARHALL_OWNER_ADDRESS: OWNER_ID, STARHALL_AGENT_ADDRESSES: JSON.stringify(NODES) };
async function setup(t, env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'starhall-identity-'));
  const app = await StarHall.open(config({ STARHALL_DATA_DIR: dir, STARHALL_PORT: '0', ...env }));
  t.after(() => app.close());
  return { app, dir };
}

test('身份默认值：未配置官方 tenant/owner 时与本地版完全一致', async t => {
  const { app } = await setup(t);
  assert.equal(app.bridge.namespaceId, NAMESPACE_ID);
  assert.deepEqual(app.bridge.owner, OWNER);
  assert.deepEqual(app.bridge.identity.addr('star-a'), { kind: 'agent', agentId: 'star-a' });
  const card = buildAgentCard(app, {});
  assert.equal(card.identity.namespaceId, NAMESPACE_ID);
  assert.deepEqual(card.identity.owner, OWNER);
});

test('换官方身份后：授权链、商品交付、账本结算全部照常工作', async t => {
  const { app } = await setup(t, official);
  const buyer = { id: 'fan-orion' };
  const poem = await app.order(buyer, { service: 'poem', input: { theme: '身份', recipient: '测试' } }, 'p1');
  assert.equal(poem.status, 'delivered'); assert.equal(poem.charged, 5);
  const duet = await app.order(buyer, { service: 'duet', input: { description: '平台', theme: 't', recipient: 'r' } }, 'p2');
  assert.equal(duet.status, 'delivered');
  assert.deepEqual(duet.delivery.wallEntry.allocations, { 'star-b': 4, 'star-a': 4 }, '换地址后 starId 分账仍按内部标识算');
  const deal = await app.order(buyer, { service: 'deal-coach', input: { currentOffer: 20, budget: 15, minimumAcceptablePrice: 10, goal: '采购' } }, 'p3');
  assert.equal(deal.status, 'delivered'); assert.equal(deal.charged, 10);
  const diagnostic = await app.order(buyer, { service: 'commercial-diagnostic', input: { goal: '复盘' } }, 'p4');
  assert.equal(diagnostic.status, 'delivered'); assert.equal(diagnostic.charged, 30);
  const board = await app.marketBoard({ id: 'broker' });
  assert.equal(board.price, 0, '经纪人看公共行情不因换地址而被拒');
  assert.ok(Array.isArray((await app.wall(buyer)).wall), '付费买家读完整墙不因换地址而被拒');
});

test('换官方身份后：审计里只有官方 namespace 与节点地址，没有本地默认值', async t => {
  const { app, dir } = await setup(t, official);
  await app.order({ id: 'fan-orion' }, { service: 'sales-pitch', input: { productDescription: '代码审查服务' } }, 'a1');
  await app.marketBoard({ id: 'broker' });
  const events = (await readFile(path.join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.length > 10);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes('starhall-local'), '审计里不能残留本地默认 namespace/owner');
  assert.ok(!blob.includes('starhall-local-owner'), '审计里不能残留本地默认 owner');
  assert.equal(events.filter(e => e.namespaceId === TENANT).length, events.length, '每条内核事件都带官方 tenant');
  assert.ok(events.some(e => e.actor?.agentId === NODES['star-a']), '明星 turn 必须以官方节点地址出现');
  assert.ok(events.some(e => JSON.stringify(e.authority) === JSON.stringify({ kind: 'human', userId: OWNER_ID })), '授权人必须是官方 owner 地址');
  assert.ok(events.every(e => JSON.stringify(e.resource?.owner ?? { kind: 'human', userId: OWNER_ID }) !== JSON.stringify(OWNER)), '资源所有者不能是本地默认 owner');
});

test('官方身份也要如实出现在 agent card 与目录里', async t => {
  const { app } = await setup(t, official);
  const card = buildAgentCard(app, { openRegistration: true, publicBaseUrl: 'https://arena.example.com' });
  assert.equal(card.identity.namespaceId, TENANT);
  assert.deepEqual(card.identity.owner, { kind: 'human', userId: OWNER_ID });
});

test('ownerKind 为 agent 时按 agentId 组装；未知地址不给任何 grant', () => {
  const identity = identityOf({ owner: { kind: 'agent', agentId: 'owner_agent_1' }, addresses: { 'star-a': 'node_a' } });
  assert.deepEqual(identity.owner, { kind: 'agent', agentId: 'owner_agent_1' });
  assert.deepEqual(identity.addr('star-a'), { kind: 'agent', agentId: 'node_a' });
  assert.equal(identity.internalOf({ kind: 'agent', agentId: 'node_a' }), 'star-a');
  assert.equal(identity.internalOf({ kind: 'agent', agentId: 'someone_else' }), undefined, '未知地址必须返回 undefined，让 grantSource fail closed');
  assert.equal(identityOf({}).internalOf({ kind: 'agent', agentId: 'star-a' }), undefined, '未 materialize 的地址不解映射');
  assert.deepEqual(resource('services/poem', identity.owner).owner, identity.owner);
});

test('身份配置非法时启动即报错，而不是悄悄回退到本地值', () => {
  for (const env of [{ STARHALL_TENANT_ID: '坏 tenant' }, { STARHALL_OWNER_ADDRESS: 'x' }, { STARHALL_OWNER_KIND: 'robot' },
    { STARHALL_AGENT_ADDRESSES: 'not json' }, { STARHALL_AGENT_ADDRESSES: '["star-a"]' }, { STARHALL_AGENT_ADDRESSES: '{"STAR A":"node"}' },
    { STARHALL_AGENT_ADDRESSES: '{"star-a":{}}' }]) {
    assert.throws(() => config({ STARHALL_DATA_DIR: '/tmp/x', ...env }), e => e.code === 'invalid_config', JSON.stringify(env));
  }
  const ok = config({ STARHALL_DATA_DIR: '/tmp/x', ...official });
  assert.deepEqual(ok.identity, { namespaceId: TENANT, owner: { kind: 'human', userId: OWNER_ID }, addresses: NODES });
});
