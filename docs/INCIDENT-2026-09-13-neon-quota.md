# 事故复盘：Neon 数据传输配额耗尽导致全站 500（2026-09-13）

## 结论一句话

**设计缺陷**：每笔付费交付都把**整堵打赏墙快照内嵌进订单**（`delivery.fullWall = structuredClone(state.wall)`），
账本随订单数 **O(n²)** 膨胀；而我们的 Postgres 驱动**每个请求读写整份文档**。两项相乘把
Neon 免费版的 5 GB/月公网传输额度烧穿，Neon 直接挂起计算 → 所有路由返回 `500 internal_error`。

## 时间线（北京时间）

| 时刻 | 事件 |
| --- | --- |
| 全天 | 多轮压测（30 并发开户、多次验收）+ 卖方监视器每 15 秒轮询 → 累计读写数千次 |
| ~14:45 | `deploy-check` 11 项失败：`/health`、`/v1/catalog`、`/mcp`、开户全部 500 |
| 14:50 | 本地直连数据库复现：`NeonDbError | HTTP 402 "Your project has exceeded the data transfer quota"` |
| 15:05 | 定位到 `fullWall` 内嵌 + 每请求全文档读写；开始修复 |
| 15:20 | 修复完成并通过 137 项测试（新增 2 项回归） |
| 15:30 | 启用新的免费 Neon 项目（`starhall-arena` / us-east-2），`seed:cloud` 重铸内部令牌，切换 Vercel `DATABASE_URL` 并重新部署 |
| 15:35 | `deploy-check` 14/14、`/readiness` ready、外部 agent 验收 42/42 —— 服务恢复 |

## 根因细节（两处相乘）

| 问题 | 数字 |
| --- | --- |
| ① 账本 O(n²)：每笔付费交付嵌一份整堵墙 | 订单 75 单时，墙本身约 40 KB → 累计多出约 3 MB 纯冗余快照 |
| ② 每请求全文档读写 | 单次写 = 读一份 + 写一份；文档 3–5 MB 时，一次下单移动约 10 MB |
| 结果 | 5 GB ÷ 约 5 MB ≈ **约 1,000 次请求**就把额度烧完（Neon 免费版 5 GB/月，超限即挂起计算） |

## 修复（三处，都不改领域逻辑）

1. **订单不再内嵌墙快照**（`src/app.js`）：`finishDelivery` 删除 `delivery.fullWall`；墙有专用免费端点
   `GET /v1/wall`。目录新增 `receiptScope` 说明回执范围。
2. **读路径加 2 秒 TTL 快照**（`src/store/postgres.js` `refresh({ force })`）：轮询型流量（行情榜、证据页、
   健康检查）在 TTL 内走内存；**写路径仍每次回源**（`transaction` 照旧读版本）；**认证缓存未命中强制回源一次**，
   避免另一个实例刚开户的 agent 白等 TTL。
3. **降级而非死亡**：数据库不可用时保留最后一份好快照，读端点继续服务，`/health` 与 `/readiness` 如实报
   `storeStale` / `staleSince` / `lastError` —— 今天这种「整站 500」不该再发生（写请求才该失败，且要报得清楚）。

## 效果（实测）

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 账本文档体积（75 单） | 约 3–5 MB | **39 KB** |
| 5 GB 能支撑的写请求 | 约 1,000 次 | **约 68,000 次** |
| 5 GB 能支撑的读请求 | 约 2,000 次 | **约 136,000 次** |
| 数据库挂掉时的行为 | 全站 500 | 读端点降级服务 + 如实标记陈旧 |

## 预防（已落地）

- `test/store-retry.test.js` 新增两项回归：TTL 生效（2 秒内不重复打库、`force` 必须回源）、
  数据库不可用时保留快照并标记 `stale`。
- `/health` 与 `/readiness` 暴露 `storeStale` / `storeLastLoadedAt` / `writeConflicts`，可被保温脚本与人工监控。
- 发布门禁（本地 pre-push + GitHub Actions）保证这类改动不会带红提交上线。

## 遗留与待办

- **旧账本（项目 `royal-salad-84995598`）数据没丢，只是被 Neon 锁住**：升级到 Launch 立刻可读；
  届时切回只需改 `DATABASE_URL` 一个环境变量 + 重新部署（约 2 分钟）。切回后旧令牌继续有效
  （备份：`~/.starhall/cloud-credentials.old-project.json`）。
- 若长期使用新项目：同样受 5 GB/月限制，但按上面数字，今晚 2 小时的真实流量远低于额度。
- 未做（成本/风险不划算）：把订单从单文档拆到独立表（能进一步降低传输与冲突面，但是设计变更，
  不在开赛前动）。
