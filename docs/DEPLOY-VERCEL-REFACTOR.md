# StarHall → Vercel 改造大纲（0.6.0-cloud）

> 目标：把 StarHall 部署到 **Vercel Hobby（免费）**，公网 HTTPS 可达、账本与审计不丢、比赛两小时可用。
> 本文是给执行 agent 的施工图，**决策已定，不要重新论证**；有疑问按本文档为准，改代码前先读 §2。
> 起草时间：2026-09-12 晚（距开赛约 24 小时）。

---

## 1. 先看这个：真正要改的只有三件事

| # | 问题 | 现状 | 改法 |
| --- | --- | --- | --- |
| **1** | 没有持久文件系统 | `storage` 全落在 `data/` 目录（`state.json` / `audit.jsonl` / `credentials.json` / `ledger/*` / `stars/*`） | 换成 Postgres（Neon 免费版），**单文档 JSONB + 乐观并发**，领域逻辑不动 |
| **2** | 「单进程」假设失效 | `process.lock` 互斥（`src/store.js:36`）、启动时把 pending 订单全部判失败（`src/store.js:58`）、内存限流 Map（`src/server.js:14`） | 删锁、改租约超时、限流落库 |
| **3** | 模式开关写死 | `config.js:7` 硬校验 `mode === 'local'`；`/health` 报 `mode: 'local'`、`dataSet`、`cloudConnected: false` | 新增 `cloud` 模式与 `STARHALL_STORE` 驱动选择 |

**明确不用改的：**

- ❌ **订单不用异步化**。Hobby 的函数上限是 **300 秒**（默认值=上限，见 §2），而单笔订单 115 秒，装得下。原 `docs/DEPLOY.md` 里「115 秒超函数时限」这条判断**是错的，可以划掉**。
- ❌ **MCP 不用改**。`/mcp`、`/api/mcp` 本来就是「每次请求一个 server、不留会话」（`src/server.js:74`），无状态，天然适配 serverless。
- ❌ **授权内核不用改**。`src/kernel.js` / `@aicoo/sharedos` 是进程内库，跑在函数里没问题。
- ❌ **不要引 ORM**。项目至今只有 2 个直接依赖，保持零依赖风格，直接写 SQL。

---

## 2. 已核实的前置事实（别再查一遍，也别凭记忆改）

| 事实 | 值 | 对改造的影响 |
| --- | --- | --- |
| Vercel Hobby 函数时长 | **默认 300s，上限也是 300s**（Node runtime） | 115s 订单直接跑，见 §1 |
| Vercel Hobby Cron | **每天只能跑 1 次** | ❌ 不能靠 cron 推进异步任务；将来要异步只能靠调用方轮询 |
| Vercel Hobby 区域 | 默认 `iad1`（美东）；`vercel.json` 的 `regions` 语法支持单区域，**Hobby 能否用 `hkg1`（香港）未确认** | 部署后用 `x-vercel-id` 响应头验证；拿不到 hkg1 就意味着函数在美东，到 `ark.cn-beijing` 的 RTT 会 +200ms 左右 |
| Vercel Hobby 请求体上限 | 4.5 MB | 我们在 `bodyOf()` 自己拦 32KB，不受影响 |
| Vercel Hobby 内存上限 | 2 GB | `vercel.json` 里设 1024MB 足够 |
| Vercel Hobby 用途限制 | **仅限个人/非商业** | 模拟积分、黑客松 demo 属于可接受范围，但别把「收钱」写进产品说明 |
| Vercel Hobby 每月额度 | 100 万次函数调用、**4 CPU-小时**、360 GB-小时（预置内存） | 4 CPU-小时是最紧的一项。我们的订单几乎全程在等模型 I/O，**等待期间不计 CPU**，按两小时赛程估算用量在 1 CPU-小时以内 → 额度充足（已决策，见 §8 末） |
| Neon 免费版 | 0.5 GB 存储、100 CU-小时/月、**5 分钟无活动缩容到 0**、免费永久、单区域 | 赛前要预热，别让它冷着；比赛期间有流量不会缩 |
| Neon 区域 | AWS 新加坡（`aws-ap-southeast-1`）/ 悉尼可用 | 配 hkg1 或直接新加坡都行，**选新加坡**，离北京近 |
| Vercel Postgres | 已下线，2024-12 全量迁到 Neon | 从 Vercel Marketplace 装 Neon 集成；SDK 用 `@neondatabase/serverless`，**不要用 `@vercel/postgres`** |

---

## 3. 阶段一：抽 Store 接口（不改领域逻辑，先跑通测试）

现状：`src/store.js` 一个 `Store` 类，构造函数 `(dir, market)`，方法 `open / read / transaction / audit / projections / seed / authenticate / registerAgent / close`。

**动作：拆成驱动 + 工厂。**

```
src/store/index.js      # createStore(config) → 按 STARHALL_STORE 选驱动
src/store/file.js       # 现有实现原样搬过来（本地开发继续用，含 process.lock 语义）
src/store/memory.js     # 测试用，替代 mkdtemp
src/store/postgres.js   # 云端用
```

- 三个驱动必须实现同一套方法签名，`transaction(fn)` 的语义必须完全一致：**`fn(draft)` 收到深拷贝，返回深拷贝，失败则不落盘**（`src/store.js:67-77`）。
- `atomicJson`、`summaryOf`、`hash`、`now` 这些纯函数留在共用模块（建议 `src/store/shared.js`），别复制三份。
- 工厂按 `STARHALL_STORE=file|memory|postgres` 选择，默认 `file`（保持本地行为不变）。

**验收：** `npm test` 全绿（默认切到 memory 驱动后仍然全绿，见 §7.1）。

---

## 4. 阶段二：PostgresStore（关键决策，照做）

### 4.1 表结构

```sql
CREATE TABLE IF NOT EXISTS starhall_state (
  id         smallint PRIMARY KEY DEFAULT 1,
  doc        jsonb    NOT NULL,
  version    bigint   NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS starhall_audit (
  seq     bigserial PRIMARY KEY,
  id      text NOT NULL,
  type    text NOT NULL,
  outcome text NOT NULL,
  actor   jsonb,
  purpose text,
  at      timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS starhall_ratelimit (
  bucket text NOT NULL,
  key    text NOT NULL,
  at     timestamptz NOT NULL,
  PRIMARY KEY (bucket, key, at)
);
```

- **状态是单文档 JSONB，不拆表**。理由：现有全部领域代码都是「读整份 state → 改 → 写回」的形状，拆表等于重写 `src/app.js` 的 563 行，风险远大于收益。
- 审计单独一张 append-only 表（对应现在的 `audit.jsonl`）。
- `credentials` 建议**并入 `state.doc`**（它既然是「凭据先写、再铸余额」的不变量，放同一份文档里反而更容易保证原子性）；若要独立表，必须保留 `src/store.js:117` 的注释所述不变量。

### 4.2 读-改-写：乐观并发，不交互式事务

```sql
UPDATE starhall_state
   SET doc = $1::jsonb, version = version + 1, updated_at = now()
 WHERE id = 1 AND version = $2
RETURNING version;
```

- 影响行数为 0 表示被别的实例抢先 → 重读、重跑 `fn`、重试，**最多 5 次**，指数退避（10/20/40/80ms）。
- 这样一条 SQL 就能提交，**可以用 `@neondatabase/serverless` 的 HTTP 驱动（`neon()`）**，不需要 WebSocket Pool，也不需要长连接——serverless 下最省心。
- 首次读取用 `SELECT doc, version FROM starhall_state WHERE id = 1`；空表则 `INSERT ... ON CONFLICT DO NOTHING` 后重读。
- **重试必须在 `fn` 之外**：`fn` 可能不幂等（生成 ID、扣分），所以每次重试都用**重新读到的 doc 重跑一遍 fn**，不能复用上次的 draft。

### 4.3 两个必须保持的语义

1. **`open()` 里的 pending 清理必须去掉**（`src/store.js:58-60`）。serverless 每次冷启动都会走 `open()`，那会把在飞的订单全部误杀。改成**租约**：
   - 下单时写 `order.expiresAt = 下单时间 + 300_000ms`；
   - 判定中断的条件从「进程重启」改成「`status === 'pending' && expiresAt < now`」；
   - 惰性清理：`read()` / `summary()` 时顺带扫一遍，不引入定时任务（Hobby cron 一天只能 1 次，靠不住）。
2. **`projections()` 不要写文件**。现在它把 `ledger/summary.json`、`wall.json`、`stars/*/memory.json`、`stars/*/works/*.json` 落盘（`src/store.js:86-101`），云端没有可写的持久目录。二选一：
   - **方案 A（推荐）**：改成按需计算的只读端点（这些内容本来就是 `state` 的投影），`app.projectionFailed` 保留为「DB 探活失败」的语义；
   - 方案 B：写 Vercel Blob —— 只在「必须有人类能点开的文件 URL」时才需要，比赛不需要。

---

## 5. 阶段三：逐条拆掉「进程假设」

| 现状 | 位置 | 云端会怎样 | 改法 |
| --- | --- | --- | --- |
| `process.lock` 文件互斥 | `src/store.js:36-48` | 无共享文件系统，锁形同虚设 | cloud 驱动里删掉；`data_locked` 错误码只在 file 驱动保留（`test/app.test.js:123-135` 也只在 file 下跑） |
| 启动时 pending → failed | `src/store.js:58-60` | **每个冷启动误杀在飞订单** | 改租约超时，见 §4.3 |
| `#queue` / `#auditQueue` / `#projectionQueue` 内存串行 | `src/store.js:30,67-77,78-85` | 每实例一份，跨实例不串行 | 正确性交给 DB 乐观并发；内存队列保留作单实例优化即可 |
| 开户限流内存 Map | `src/server.js:13-21` | 每实例独立，多实例下限流失效 | 迁到 `starhall_ratelimit` 表（或 state 里按来源计数）。注意 `req.socket.remoteAddress` 在 Vercel 上要改成 `x-forwarded-for` 的第一段 |
| fixture market 内存 Map | `src/server.js:52` | 实例间不共享、重启清零 | 云端保持 `STARHALL_FIXTURE_MARKET=false`（默认就是）；要留就落 state |
| `credentials.json` | `src/store.js:102-121` | 无文件可写 | 首次部署跑一次 `node scripts/seed-cloud.js` 把凭据写进 DB；**保留「凭据先写、余额后铸」的顺序** |
| 读本地凭据的 CLI | `src/cli.js:34` | 云端没有 `data/credentials.json` | 增加 remote 模式：`--base <公网URL> --token <token>`，不走本地文件。`scripts/broker-cli.js` 同理 |
| `server.requestTimeout/timeout` | `src/server.js` 末尾 | Vercel 自己管超时 | 只在「独立运行时」分支里设置 |
| stdio MCP | `scripts/mcp-server.js` | 无法部署 | 保留为**本机** agent 用；公网走 `/mcp` |

---

## 6. 阶段四：入口与 Vercel 配置

### 6.1 抽出 handler

`src/server.js` 现在是 `http.createServer(async (req, res) => { ... })`（第 48–160 行整块路由）。

- 抽成 `export function createHandler(app, options)` → 返回 `(req, res) => Promise<void>`，路由体原样搬进去。
- `startServer()` 保留（本地 `npm start` 用），内部改为 `http.createServer(createHandler(app, options))`。
- **注意**：`new URL(req.url, 'http://127.0.0.1')` 这行在 Vercel 上仍然可用（`req.url` 是相对路径），但拼「对外地址」要用 `STARHALL_PUBLIC_BASE_URL` 或 `x-forwarded-host`，不要用 `req.headers.host` 直接信任。
- Host 白名单（fail-closed，`src/server.js:57-60`）**必须保留**。云端把 `<app>.vercel.app`（含 preview 域，如果要用）和自定义域都写进 `STARHALL_ALLOWED_HOSTS`；Vercel 会带 `x-forwarded-host`，白名单校验要对它也生效。

### 6.2 `api/index.js`

```js
import { createHandler } from '../src/server.js';
import { config } from '../src/config.js';
import { StarHall } from '../src/app.js';
import { createStore } from '../src/store/index.js';

let cached;                                   // 冷启动内复用，别每次请求都开连接
export default async function handler(req, res) {
  const options = config(process.env);
  cached ||= await StarHall.open(options);    // 注意：单实例内共享，跨实例靠 DB
  return createHandler(cached, options)(req, res);
}
```

### 6.3 `vercel.json`

```json
{
  "framework": null,
  "regions": ["hkg1"],
  "functions": { "api/index.js": { "maxDuration": 300, "memory": 1024 } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
}
```

- `regions` 是单区域，Hobby 是否允许 `hkg1` 未确认 → 部署后按 §7.7 验证；不允许就退回默认 `iad1`，或者先试 `sin1`。
- **显式写 `maxDuration`**：即使默认已是 300，也不要依赖默认值。

### 6.4 健康检查要跟着驱动走

`src/server.js` 的 `/health` 目前硬编码 `mode: 'local'`、`dataSet: path.basename(options.dataDir)`、`cloudConnected: false`。改成按驱动动态输出：`{ mode, store: 'file'|'memory'|'postgres', dataSet: null|'…', dbReady: <探活结果> }`。`scripts/deploy-check.js` 里对应的断言要同步。

---

## 7. 阶段五：验证清单（每条都要能跑，不许口头确认）

1. `npm test` 全绿（memory 驱动）—— 领域逻辑零退化。
2. **驱动一致性**：同一串操作（开户 → 免费试用 → 付费单 → 退款 → 修订）分别跑 file / memory / pg，断言最终 `summary()` 一致。
3. **并发正确性**：并行发 50 个下单请求，断言余额不为负、无重复扣分、订单数正确（这条是乐观并发的核心回归）。
4. `npx vercel dev` 本地起服务 → `node scripts/deploy-check.js http://127.0.0.1:3000`。
5. 线上部署后 → `node scripts/deploy-check.js https://<app>.vercel.app` 全绿，**交付必须是 `live` 不是 `fallback`**。
6. **持久化**：注册一个账号 → 打一个能触发新实例的请求（如再问一次 `/v1/wallet`）→ 余额与订单仍在。
7. **区域**：`curl -sI https://<app>.vercel.app/health | grep -i x-vercel-id`，确认区域是不是 `hkg1`。
8. **并发**：同时发 5 个付费订单，全部 `delivered`、扣分总额正确。
9. **冷启动**：静置 10 分钟后再打 `/health`，记录耗时（这就是赛前必须预热的原因）。

---

## 8. 风险与取舍（写清楚了再动手）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| Neon 免费版 0.5 GB | `state.doc` 是单文档，`events` / `impressions` / `wall` 会持续增长 | 加保留策略：`events` 只留最近 N 条、`impressions` 按天聚合、`wall` 只留最近 M 条；上线前先估一遍两小时能涨多少 |
| Neon 5 分钟缩容到 0 | 缩容后首次查询多几百 ms | 赛前（20:40）预热一次 `/health` + 一次 `/v1/catalog`；比赛期间有流量不会缩 |
| 115s 占 300s 上限的 ~40% | 最坏情况（模型重试 2 次 + 多段串行生成）可能顶到上限 | **顺手把多段生成并行化**：`src/app.js:317-324` 现在是顺序 `yield`，改成并发后 115s → 约 40s（这条建议做，收益大风险小） |
| Hobby 仅限非商业 | 产品说明里别写「收费」 | 保持模拟积分口径 |
| 多实例下内存 Map 失效 | 限流、fixture market | 见 §5 |

**已决策：走 Vercel（2026-09-12 晚确认）。** 免费额度经核实足够覆盖本次比赛：Hobby 每月 100 万次调用 / 4 CPU-小时 / 360 GB-小时内存，而订单是 I/O 密集（等模型生成时不消耗 CPU），两小时赛程的实际用量远低于额度。**不要**再去评估或切换到别的主机方案，按本大纲执行即可。

> 应急备选（仅在 Vercel 端出现平台级故障时才考虑，不作为路径选项）：`docs/DEPLOY.md` 方案 B 的 VPS 路线，或 Oracle Cloud Always Free / GCP e2-micro 这类免费常驻 VM，它们**零代码改动**即可上线——正因为改造成本为零，才值得留作当晚的兜底，而不是现在去做。

---

## 9. 交付物清单（执行 agent 的 checklist）

**实现状态（2026-09-12 深夜，全部落地）：**

- [x] `src/store/index.js`、`src/store/file.js`、`src/store/memory.js`、`src/store/postgres.js`、`src/store/shared.js`（`src/store.js` 已删除）
- [x] `api/index.js`、`vercel.json`（`regions: ["hkg1"]`、`maxDuration: 300`、`memory: 1024`）
- [x] `src/server.js`：抽出 `createHandler`，`startServer` 复用之；每请求 `store.refresh()`；`/health` 按驱动输出 `mode / store / dataSet / dbReady`
- [x] `src/config.js`：允许 `cloud` 模式，新增 `STARHALL_STORE`、`DATABASE_URL`；非 local 驱动下 `dataDir` 为 null
- [x] `src/cli.js`：`--base / --token / --actor`；`scripts/broker-cli.js`：连接文件支持 `{baseUrl, token}`
- [x] `scripts/seed-cloud.js`：建表 + 凭据写入 + `--rotate` / `--reset`
- [x] `scripts/deploy-check.js`：断言 cloud/postgres（本机演练自动跳过）
- [x] `test/store-conformance.test.js`（file/memory/（pg）一致性 + 限流）、`test/concurrency.test.js`（50 并发）；`test/app.test.js` 重启用例标注 file-only
- [x] `.env.example`：删掉「云端接入完成前不接受 cloud 模式」，补 `STARHALL_STORE` / `DATABASE_URL`
- [x] `docs/DEPLOY.md`：旧「Vercel ❌」改为指向本文档
- [x] 新依赖：`@neondatabase/serverless@^1.1.0`

**实现时对本文档的两处偏离（都按 §5 允许的口径）：**

1. **限流不建 `starhall_ratelimit` 表**：改为状态文档内按小时窗口计数（`state.rateLimits`），三个驱动语义完全一致，也免掉一次跨表事务。原文 §5 明确允许「或 state 里按来源计数」。
2. **`projections()` 在云端不落盘**：file 驱动行为不变（本地开发仍生成 `data/ledger`、`data/stars`），memory/postgres 驱动只做探活。对应 §4.3.2 的方案 A，投影内容本来就由 `/v1/summary`、`/v1/wall`、`/v1/ads` 现算。
3. **多段生成没有并行化**：`duet` 的第二段是「星A回应星B的批评」，有真实依赖，改并发等于改产品语义。115 秒订单预算内两次生成（各 45 秒上限）仍装得下。

## 10. 执行顺序（每步都要能独立验证）

1. §3 抽接口 + memory 驱动 → `npm test` 全绿（**先把测试体系稳住，再碰云端**）
2. §5 拆进程假设（租约、限流落库、projections 改端点）
3. §4 PostgresStore + §6 入口适配
4. 本地 `vercel dev` 跑通 `deploy-check`
5. 建 Neon 项目（新加坡）→ `seed-cloud` → `vercel deploy` → §7 全绿
6. 赛前 20:40：预热 + 复跑 `deploy-check`
