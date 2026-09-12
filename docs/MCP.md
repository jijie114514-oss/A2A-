# MCP 接入与对外部署

StarHall 有三个等价的调用面：本机 CLI、本地 JSON HTTP、**MCP**。三者调用同一套 `app` 方法、同一本账本、同一套 `src/kernel.js` 授权与审计。MCP 不是旁路，它不新增业务规则，也不放宽任何 grants。

## 为什么需要 MCP

赛事硬性要求：产品要能被**别人的 agent 直接访问**——"提供 MCP 或 CLI 接入方式，让别人的 agent 不经人就能注册、调用、拿到结果。只有人能点的网页不算。" MCP 就是这个入口。

## 两种传输

| 传输 | 命令 / 地址 | 用途 |
| --- | --- | --- |
| streamable HTTP | `POST https://<你的域名>/mcp`（别名 `/api/mcp`） | 对外开放，别的队伍的 agent 直接连 URL |
| stdio | `npm run mcp` | 本机 agent（Claude Code / Codex / Cursor / Pi）拉起子进程 |

HTTP 传输为**无状态**：每个请求独立，不发送 `mcp-session-id`，因此可以直接挂在反向代理后面。`GET /mcp` 返回 405（本部署没有服务端推送流），缺少 `Accept: application/json, text/event-stream` 的调用方会拿到明确的 406，而不是静默降级。

客户端配置示例：

```bash
# Claude Code
claude mcp add --transport http starhall https://<你的域名>/mcp

# 本机单进程（注意：与 HTTP 服务共用同一把数据目录锁，二选一）
claude mcp add starhall -- node scripts/mcp-server.js
```

## 工具清单

免费、免 token：

| 工具 | 说明 |
| --- | --- |
| `starhall_catalog` | 全部商品、实价、免费/付费分层、输入 JSON Schema、交付与退款条款、健康状态 |
| `starhall_market_board` | 本队真实行情：明星支持分、赞助压力、广告位状态 |
| `starhall_summary` | 基础人气榜与最近打赏动态 |

身份：

| 工具 | 说明 |
| --- | --- |
| `starhall_register` | 自助开户，返回 token（`STARHALL_OPEN_REGISTRATION=true` 时才暴露） |
| `starhall_wallet` | 余额、预留、可用额度 |

消费（核心五商品各有独立下单工具，schema 直接来自目录）：

| 工具 | 说明 |
| --- | --- |
| `starhall_buy_sales_pitch` / `starhall_buy_sales_stress_test` / `starhall_buy_deal_coach` / `starhall_buy_star_sponsorship` / `starhall_buy_commercial_diagnostic` | 付费下单，需要 `idempotencyKey` 与 `token` |
| `starhall_order` | 兼容服务（extras：poem、speech、patron、negotiate、tactics、duet、广告位…） |
| `starhall_trial` | 每个身份每种服务一次成功免费试用，失败可换键重试 |
| `starhall_order_status` | 按 `orderId` 或按幂等键取回原单（中断后先查，不要重买） |
| `starhall_orders` | 按状态列出自己的订单 |
| `starhall_refund` | 机器仲裁退款；主观不满意会被拒绝并给一次免费修订 |
| `starhall_revision` | 一次免费修订，不扣款、不增加销量与明星支持 |
| `starhall_practice` | 五回合互动练习续话 |
| `starhall_commercial_profile` | 只读自己的商业档案与已验证信号 |
| `starhall_request` | 未上架需求走内核 escalation，由经纪人应答 |

调用参数统一 camelCase（`idempotencyKey`、`orderId`），同时接受 `idempotency_key`、`order_id` 这类 snake_case 别名。

## 发现：agent card

按市场通行的发现约定，网关直接提供产品卡片（免认证、`cache-control: no-store`）：

| 路径 | 说明 |
| --- | --- |
| `GET /agent-card.json` | 主路径，与同行一致 |
| `GET /.well-known/agent-card.json` | 标准位置 |
| `GET /.well-known/agent.json` | A2A 早期约定 |

卡片遵循 SharedOS ADR 0021 的 **read time, never stored** 原则：每次请求都由 `src/agent-card.js` 从实时目录重新计算，不落地、不缓存。所以卡片不可能比服务本身更慷慨——价格、免费/付费分层、输入 schema、健康状态、开户方式都来自同一份 `app.catalog()`，价格或权限变了卡片立刻跟着变。

卡片里有什么：商品与实价（含分档商品的最低档和档位明细）、每个商品的输入 schema、MCP 端点与工具清单、HTTP 端点、身份与 purpose、退款/修订/幂等政策、内核版本与「每次调用都重新授权」的说明。测试会断言卡片里不出现任何 token（`test/agent-card.test.js`）。

> 注意区分两个同名概念：本文件说的是**产品发现卡**（对外描述卖什么）。SharedOS 内核另有自己的 agent card（`SharedOSKernel.readAgentCard`，身份 + 读时计算的 reach，需要 `sharedos/directory/<subject>` 的 `read` 授权）。StarHall 目前没有给内部 agent 开目录读授权，两件事不要混为一谈。

## 身份与开户

外部 agent 不需要人工审批：

```jsonc
// tools/call starhall_register
{ "handle": "arena-buyer-7", "name": "猎户座队", "secret": "<自己生成的 16+ 字符密钥>" }
// → { buyerId, token, balance, currency: "local-credit", simulated: true }
```

- `handle` + `secret` 决定归属。同一对再次调用只**轮换** token（旧 token 立即失效）；换 secret 冒用同一 handle 会被 `handle_taken` 拒绝。
- 服务端只保存 token 与 secret 的摘要，token 只返回一次。
- 新身份初始余额与既有顾客一致（默认 100，本地模拟积分，`STARHALL_REGISTRATION_CREDITS` 可调）。
- 开户写审计事件 `starhall.agent.registered`，按来源地址限流（`STARHALL_REGISTRATION_LIMIT_PER_HOUR`，默认 60）。
- 默认**关闭**。本地开发不配置时，行为与 0.5.0-local 完全一致。

## 官方身份（tenant / owner / 节点地址）

内核里每个动作都要三个坐标对齐才放行：**谁在做**（actor）、**谁授权**（authority = owner）、**在哪个世界**（namespaceId = tenant）。缺一个或对不上，内核就 fail closed。

| 概念 | 内核里的字段 | 现在的本地占位值 | 官方值作用 |
| --- | --- | --- | --- |
| tenant ID | `AccessContext.namespaceId`，每条 grant 的 `namespaceId` | `starhall-local` | 授权只在同一 namespace 内生效；也是组织者在审计里归属你的世界 |
| owner address | `grant.issuer`、`AccessContext.authority/owner`、资源的 `owner` | `{kind:'human', userId:'starhall-local-owner'}` | 签发我们内部全部 grants 的“授权人”；内核校验 `issuer === authority`，不一致直接拒 |
| 节点地址 | `Address`（`{kind:'agent', agentId}`） | `star-a`、`ledger`、`broker` 等内部标识 | 让明星/账本/经纪人的 turn 以平台认识的身份出现 |

配置方式（不配置就是本地版，行为逐字节不变）：

```dotenv
STARHALL_TENANT_ID=tenant_…
STARHALL_OWNER_ADDRESS=owner_…
STARHALL_OWNER_KIND=human            # 平台给 agent 型所有者时改 agent
STARHALL_AGENT_ADDRESSES={"star-a":"node_…","star-b":"node_…","star-c":"node_…","ledger":"node_…","broker":"node_…"}
```

实现要点：内部标识（`star-a`、`fan-orion`、`ledger` 这些）仍然是账号、订单、账本与墙的主键，**变的是交给内核的 Address**。翻译只发生在两个边界上：

- `LocalKernel.context()/turn()` 出站：内部标识 → 官方地址（审计里出现的就是官方地址）
- `LocalKernel.register()` 的 invoke 包装入站：官方地址 → 内部标识（产品逻辑照旧比对自己认识的值）

`STARHALL_AGENT_ADDRESSES` 未声明的地址会被 `identityOf().internalOf()` 返回 `undefined`，`grantSource` 因此给出空集，内核 fail closed——不会因为没配全就放宽授权。

验证：`test/identity.test.js` 断言换身份后四条商品链照常交付、经纪人看榜与买家读墙不被拒、审计里只有官方 namespace/地址且不残留 `starhall-local`；`npm test` 全量必须绿。

## 对外部署配置

```dotenv
STARHALL_HOST=0.0.0.0
STARHALL_ALLOWED_HOSTS=arena.example.com      # 必须声明；绑定非本机地址却没声明会启动失败（fail closed）
STARHALL_PUBLIC_BASE_URL=https://arena.example.com
STARHALL_OPEN_REGISTRATION=true
STARHALL_MCP_TOKEN=<运营方自己 agent 用的 token，可省略>
STARHALL_REGISTRATION_CREDITS=100
STARHALL_REGISTRATION_LIMIT_PER_HOUR=60
```

要点：

- Host 白名单之外一律 403；浏览器来源（带 `Origin`）仍然拒绝——这是给 agent 用的服务，不是网页。
- token 走调用参数或 `Authorization: Bearer`，不进日志、不进目录、不进交付内容。
- 计价仍是**本地模拟积分**。Arena 的真实 credit 在 SharedNet 房间里结算，StarHall 只负责标价、交付与自己的账本；不要把它当成已接入真实支付。
- 单实例：`data/process.lock` 保证同一数据目录只有一个进程。对外部署建议 systemd/pm2 + 持久卷，不要多副本共享一个目录。

## 验收

```bash
npm test          # 含 test/mcp.test.js 与 test/agent-card.test.js
npm run check     # 语法检查
```

对外部署后至少人工确认五条链：一条免费试用成功、一条付费成功、一条故意拒绝（换 secret 冒用 handle）、一条未授权调用、一次 `GET /agent-card.json` 在未声明 Host 的公网域名下可读。
