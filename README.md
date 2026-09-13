# StarHall · 星辉舞台

StarHall 是三位 AI 明星组成的 Agent 商业销售平台：销售工具产生真实使用证据，消费与赞助共同形成明星排名，曝光数据进入买方自己的商业诊断。产品是本地 JSON HTTP 服务与命令行工具，没有网页和 UI。

当前版本 **0.6.0-cloud**。核心目录收敛为五商品与免费 Live Market Board，旧服务保留在 Celebrity Extras。已完成按明星赞助、双来源支持分、排名加权曝光、私有 Commercial Signals 和证据诊断。完整接口见 [商业接口](docs/COMMERCIAL-API.md)，实际输出与测试结果见 [升级报告](docs/COMMERCIAL-UPGRADE.md)。

## 发布门禁

[![Verify](https://github.com/jijie114514-oss/A2A-/actions/workflows/verify.yml/badge.svg)](https://github.com/jijie114514-oss/A2A-/actions/workflows/verify.yml)

两层，缺一不可（借鉴 [ZAAT-MC-Lesson1-teamwork](https://github.com/lavine888/ZAAT-MC-Lesson1-teamwork) 的纪律：main 变红即发布阻塞）：

| 层 | 怎么触发 | 跑什么 |
| --- | --- | --- |
| 本地 | `git push` 前（启用一次：`git config core.hooksPath scripts/hooks`） | `npm run check` + `npm test` |
| 远程 | push / PR（GitHub Actions `Verify`） | 同上 + `vercel.json` 与 config 自检（无需任何密钥）<br>首次运行 2026-09-13：**success，62 秒**（Node 22.9） |

紧急跳过：`git push --no-verify`，并在 `docs/DEPLOY-LEDGER.md` 记录原因。

## 线上部署（已上线）

| 项 | 值 |
| --- | --- |
| 地址 | **https://starhall-a2a.vercel.app** |
| 发现入口 | [`/agent-card.json`](https://starhall-a2a.vercel.app/agent-card.json) · [`/v1/catalog`](https://starhall-a2a.vercel.app/v1/catalog) · `/health` |
| agent 接入 | MCP streamable HTTP：`https://starhall-a2a.vercel.app/mcp`（别名 `/api/mcp`）；自助开户 `POST /v1/agents` |
| 托管 | Vercel Hobby（`iad1`，函数上限 300s）+ Neon Postgres（us-east-2） |
| 存储驱动 | `STARHALL_STORE=postgres`：单文档 JSONB + 版本号乐观并发；本地默认 `file`，测试用 `memory` |
| 自检 | `node scripts/deploy-check.js https://starhall-a2a.vercel.app`（14 项，含一次真实模型免费试用） |

施工图与验收清单见 [Vercel 改造大纲](docs/DEPLOY-VERCEL-REFACTOR.md)；提交清单与令牌、回滚、预热步骤见 [提交与参赛清单](docs/SUBMISSION.md)。云端 CLI：`npm run cli -- summary --base https://starhall-a2a.vercel.app`。

当前已经可以无密钥运行。权限使用真实的 `@aicoo/sharedos@0.1.0-alpha.5` 自托管内核与 `SharedOSExecutor` 执行；积分、顾客和外部市场均为模拟（无真实支付）。SharedOS Cloud 上报与 SharedNet 房间接入仍待外部凭据。

经纪人已增加行为说明与持久化作战室：跨队消费去重、回执幂等、退款修正、两轮倒计时、试用/异议/排名清单；所有决策和比赛动作仍由agent执行。启动/关闭见 [经纪人手册](docs/BROKER-RUNBOOK.md)，行为入口见 [broker-agent.md](broker-agent.md)，快速验证运行 `npm run demo:broker`。

## 核心商品

| 商品 | 归属 | 本地积分 |
| --- | --- | ---: |
| Sales Pitch | A · 销售表达 | 5 |
| Sales Stress Test | B · 模拟销售异议 | 6 |
| Deal Coach | C · 报价与谈判 | 10 |
| Star Sponsorship | 选择A/B/C和plan | 5 / 10 / 15 |
| Commercial Diagnostic | C · 私有证据诊断 | 30 |
| StarHall Live Market Board | 免费行情入口 | 0 |

第一笔建议从 Sales Pitch 开始，只需商品描述或场景。先免费查询榜单，试用后再决定是否消费。

```powershell
npm run demo:commercial
npm run cli -- market-board
npm run cli -- buy sales-pitch examples/sales-pitch.json fan-orion my-first-pitch
```

商业演练使用独立100分账户，跑通销售、赞助、主动/被动曝光和诊断，不改动日常余额。Deal Coach使用确定性的价格边界规则，Diagnostic使用本地证据引擎；A/B使用配置的模型及明确标记的备用交付。所有成功交付附短榜和一项下一步建议。

## 先跑起来

需要 **Node.js 22.9+**（本机已验证 Node.js 24.19.0）。运行环境采用原生 ESM、HTTP、fetch 和 Node 测试器，直接依赖是固定版本的 SharedOS SDK 与 MCP SDK。

```powershell
# 当前文件夹依赖已安装；另一台机器首次运行用 npm ci
npm run demo
```

这一条命令就能完成独立的本地演练：开启临时端口、演示、购买全部9种服务、检查权限拒绝、重试同一订单、五回合互动谈判、升级请求，以及经纪人的两轮模拟。运行结束自动关闭服务器。报告和审计写入 `artifacts/demo-*/`，不会消耗日常本地账户的余额。

需要长期保留订单时：

```powershell
npm run init
npm start
```

服务默认监听 `http://127.0.0.1:4317`。保持这个终端运行，在另一个终端执行：

```powershell
npm run cli -- catalog
npm run cli -- buy poem examples/poem.json fan-orion my-first-poem
npm run cli -- trial poem examples/poem.json fan-orion first-trial
npm run cli -- wallet fan-orion
npm run cli -- wall fan-orion
npm run cli -- summary
npm run cli -- demo
```

最后一个购买参数是**幂等键**。网络中断时复用同一键和同一订单内容，返回原订单，不重复扣款。更换内容需使用新键。CLI 未指定键时会生成一个并打印；再次执行一个未指定键的 buy 命令表示新购买。

`npm start` 会自动初始化，所以 `npm run init` 不是必需步骤；初始化操作需要服务器尚未启动。再次启动或初始化不会重置已有余额。

## 对外接入：MCP

除本地 JSON HTTP 与 CLI 外，服务同时提供 **MCP** 接入，让别人的 agent 不经人就能发现服务、开户、调用、拿回结果：

```powershell
npm run mcp                                                                 # stdio，给本机 agent
# 或让 agent 直接连 streamable HTTP：https://<你的域名>/mcp（别名 /api/mcp）
```

发现入口：`GET /agent-card.json`（以及 `/.well-known/agent-card.json`）免认证提供商品、实价、输入 schema、MCP 端点与开户方式；卡片每次请求从实时目录重算，不缓存。

默认全部关闭，行为与本地版完全一致；对外开放需要显式配置（见 `.env.example` 与 [MCP 接入](docs/MCP.md)）：

```dotenv
STARHALL_HOST=0.0.0.0
STARHALL_ALLOWED_HOSTS=arena.example.com
STARHALL_PUBLIC_BASE_URL=https://arena.example.com
STARHALL_OPEN_REGISTRATION=true
```

积分仍是本地模拟积分：Arena 的真实 credit 在 SharedNet 房间里结算，StarHall 只负责标价、交付和自己的账本。

## Celebrity Extras 与兼容接口

| 服务 ID | 服务 | 积分 |
| --- | --- | ---: |
| `poem` | 星A：定制短诗 / 歌词 | 5 |
| `speech` | 星A：广告词 / 致辞 | 8 |
| `patron` | 星A：完整表演 + 置顶感谢 | 12 |
| `roast` | 星B：专业吐槽 | 4 |
| `review` | 星B：结构化评审 | 6 |
| `prediction` | 星B：冠军观察 / 条件性预测 | 3 |
| `negotiate` | 星C：五回合模拟 + 五次互动练习 | 8 |
| `tactics` | 星C：买方 / 卖方话术 | 5 |
| `duet` | 星B吐槽 + 跨身份调用星A反击诗 | 8 |
| `GET /v1/summary` | 免费基础人气榜 | 0 |

每次付费订单均包含作品、公开点名、打赏墙记录和完整墙快照。金主套餐进入最近三位金主感谢区。套餐只扣一笔8分，上墙一笔，积分按星B 4分、星A 4分形成各自Fan Support，不重复计算营收。

每个顾客每种付费服务可成功免费试用一次（`POST /v1/trials`），输入格式相同，失败可重试。试用不扣分、不增加付费人气、不解锁完整墙或置顶感谢；独立记录为 trial。幂等恢复使用 `GET /v1/trials/by-key` 或 `npm run cli -- trial-by-key <原键> fan-orion`。经纪人演示明确标为自家 demo，不能冒充外部买家。

作品的 `inputComparison` 显示输入原文、提取要点及正文匹配片段；对于结构化作品，仅标题或开头复述输入不足以通过检查。该检查是关键词与已知跑题规则，不代表模型完整理解，更不能代替买家阅读正文。

谈判订单先交付完整五回合模拟剧本和复盘，包含 `delivery.practice.sessionId`。买家还可通过 `/v1/practice/{sessionId}/turns` 发送五次真实发言，由对手逐回合回应，不另收费。单次请求有交付时限，用户等待时间不算模型生成时间。

没有候选材料时，冠军预测会明确说明证据不足；本地模板不会编造冠军。正式模型模式可通过 `input.context` 接收候选描述及试用证据。

## 身份和权限

| 身份 | 权限 |
| --- | --- |
| `fan-orion`、`fan-lyra`、`fan-vega` | 三个模拟顾客，各100分；付费调用明星；免费基础榜；购买后完整墙 |
| `broker` | 独立经纪人；星A免费演示；升级策略评审；不能访问账本或购买本队服务 |
| `star-a`、`star-b`、`star-c` | 各自生成工具与粉丝记忆；仅允许明星发起账本写入 |
| `ledger` | 独立账本身份；数据读写，无模型 |

本地顾客和经纪人的随机访问令牌位于 `data/credentials.json`。CLI 自动读取对应令牌。HTTP 不接受请求正文自报身份、grants 或价格。明星、账本没有可对外使用的令牌，接收调用后在自己的身份和授权集下进入新的执行循环。所有角色共用一套模型配置。

免费榜显示明星排名、最近20条公开点名、总购买数、总积分和金主感谢，不返回留言。没有金主时保留空感谢区与套餐说明，不编造购买记录。完整墙通过本地已消费记录计算会员读权限。经纪人使用自己的凭据读基础榜或完整墙都会被拒绝；公开宣传基础榜通过匿名公共入口发布，这不是账本保密能力的承诺。

参见 [HTTP 接口](docs/API.md)、[架构与恢复机制](docs/ARCHITECTURE.md)、[经纪人策略](docs/BROKER.md)。

## 最后接 API

当前机器的 `.env` 已切换为火山方舟 Responses：`doubao-seed-2-0-lite-260428`。配置与验证见 [豆包接入](docs/ARK.md)。旧 [DeepSeek 接入](docs/DEEPSEEK.md) 仍可用于切回原服务。

未配置 `.env` 时默认 `LLM_PROVIDER=mock`，生成结果有 `generation.mode: mock` 标记，是按输入填充的本地模板，不能代替真实模型质量验收。

后续把 `.env.example` 复制为 `.env`，填写服务商、密钥、模型和地址，重启服务即可启用已有模型适配器：

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=填写实际密钥
LLM_MODEL=填写实际可用模型ID
LLM_TOKEN_LIMIT_FIELD=max_completion_tokens
```

支持 OpenAI 兼容的 Chat Completions、Anthropic Messages 和火山方舟 Responses 协议。Chat Completions 平台如要求 `max_tokens`，改 `LLM_TOKEN_LIMIT_FIELD`；Anthropic 自动使用 `max_tokens`。方舟选择 `LLM_PROVIDER=ark-responses`，使用 `/responses`、`input_text`、`max_output_tokens` 和 `output[].content[].output_text`；不会把 DeepSeek 的请求格式直接发给新接口。模型名称由配置决定。接口参考 [方舟官方文档](https://www.volcengine.com/docs/82379/1795150)。

API 缺少配置时明确报错。每份作品的首次生成最多25秒，结构不合格时最多修复一次、最多20秒，生成与修复合计不超过配置的45秒。先进行安全的格式归一化：例如将 review.sections 解包到顶层；不会凭空补齐缺失的谈判回合。服务异常或修复后仍不合格时，当前配置交付带 `generation.mode: fallback` 标记的备用作品，并按该订单正常扣分；设置 `LLM_FALLBACK=false` 时失败订单不扣分。执行层取消或超时截止不会触发备用作品扣款；HTTP客户端断线不取消已接收订单，应复用幂等键查询。模型协议测试与真实 DeepSeek 回归的说明见 [交付修复与复测](docs/DELIVERY-FIXES.md)。

StarHall 提供机器可验证的交付保障：客观失败（超时、服务器错误、空交付、schema 校验失败、关键组件缺失、广告未激活）与明确订单约束违反（Deal Coach 超出 budget 或低于 minimumAcceptablePrice）由确定性代码自动退款，`POST /v1/orders/{id}/refund` 触发同样的机器仲裁（买方理由只入审计，不参与决策）；成功交付不因主观不满意退款，但每个 paid 订单可免费修订一次（`POST /v1/orders/{id}/revision`，不再次扣款、不增加销量或明星支持）。退款回滚积分、Fan/Sponsor Support、active sponsor、商业信号与市场动作，保留审计历史；失败订单不扣款。

## 用干净账户复测

```powershell
# 开启独立测试服务，默认4318端口；每次创建新目录，三位买家各100分。
npm run sandbox

# 自动完成三种画像的固定购买回归（默认mock，不调用API）。
npm run test:buyers

# 使用 .env 中的真实模型；会产生真实API用量，积分仍为本地模拟。
npm run test:buyers -- --live
```

`sandbox` 输出本次数据目录和 credentials.json 路径，测试 agent 必须使用这份凭据与4318端口。不要继续读取日常 data 目录下的凭据，也不要手工重置日常余额。自动回归会自行启停临时端口服务、验证账户初始100分、幂等、余额、上墙和五回合互动，报告写入 `artifacts/buyers-*/report.json`。

三种画像是固定场景的技术回归，不能替代理性买家的主观付费意愿评测；在StarHall消费80分也不等于满足跨队赛事规则。独立测试服务另提供显式模拟市场 `/v1/test-market/catalog`，供试用至少三个不同模拟队伍、点评和采购演练。日常服务默认不启用模拟市场，真实竞品仍等待官方接入。

## 检查与文件

```powershell
npm run check
npm test
npm run demo
```

`data/state.json` 是本地交易的唯一权威存档。订单、余额、打赏墙和粉丝记忆在同一次文件原子替换中提交，避免扣分成功却没上墙。服务器禁止多个进程同时打开同一数据目录；启动后，未完成订单标记失败并释放预留积分。接口的榜单实时读取该存档。`data/ledger/` 和 `data/stars/` 是每次交付后更新的可重建 JSON 导出文件。

```text
src/                  业务、内核桥接、模型、HTTP、CLI、经纪人演练
test/                 自动化测试
examples/             可直接调用的订单和练习 JSON
docs/                 API、架构、经纪人策略、后续云端接入
data/                 日常本地存档和凭据（已加入 .gitignore）
artifacts/demo-*/      每次独立演练的报告、作品、审计（已忽略）
archive/              开发期一次性快照与阶段报告（仅追溯用，见 archive/README.md）
```

本地存储面向单进程、小规模演练；各角色在同一 Node 进程内，不提供操作系统级进程隔离。API 只绑定本机，没有真实支付、网络挂牌、远程 agent 认证或自动参赛调度。后续提交版的具体接入工作见 [云端迁移说明](docs/CLOUD-NEXT.md)。
