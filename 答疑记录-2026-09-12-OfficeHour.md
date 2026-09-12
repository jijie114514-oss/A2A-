# Office Hour 答疑记录 · 2026-09-12（周六 21:00）

> 现场速记，用户边听边发，agent 整理。**未经验证的内容标〔随口/待核〕**。
> 底稿：`黑客松规则全解.md`、`docs/SUBMISSION.md`、`Desktop/A2A/Q&A.pdf`、`Desktop/A2A/A2A补充规则.pages`。
> 距提交截止（**周日 9/13 21:00** = 第一轮开始）约 24 小时。

**本文件的顺序 = 答疑给出的操作顺序。** 用户明确要求：**云端部署与模型渠道这两步也是重要步骤，放在最前面**。

---

## 0. 操作顺序总表

| # | 步骤 | 归属 | 仓库当前状态 |
| --- | --- | --- | --- |
| **1** | **云端部署（Vercel）** | 让产品有公网 HTTPS 地址 | ⚠️ 现状是 Fly.io / Docker / Caddy，`docs/DEPLOY.md` 把 Vercel 列为**不适合** —— 见 §1.1 |
| **2** | **模型渠道（OpenRouter）** | 明星 agent 的模型出口 | ⚠️ 现状是火山方舟 `ark-responses` + `doubao-seed-2-0-lite-260428` —— 见 §1.2 |
| **3** | **用 SharedOS 检查代理权限** | 开赛前核对 grants | ✓ 本地内核齐（deny-by-default + 审计），缺「官方侧怎么看」的口径 —— 见 §1.3 |
| **4** | **SharedOS Cloud 新建项目 → 生成 API key → 放进环境文件 → 加 CLI → 其他 agent 接入** | 产品对外可被发现、被调用 | 4 个 env 占位已在，API key 与 CLI 待落 —— 见 §1.4 |

> 「SharedOS Cloud 目前完全免费」—— 用户转述，官网未标价，见 §3 待确认 #5。

---

## 1. 逐步明细

### 1.1 步骤 1 · 云端部署用 Vercel

- 用户原话：**云端部署用 Vercel**。后续更正说明：这一步**也是重要步骤，要在流程最开始**。

**与仓库现状冲突（需要你定夺）**

`docs/DEPLOY.md` 的选路表里 Vercel 是**明确排除**的：

> | ~~D. Vercel~~ | — | — | — | ❌ 不适合：serverless 无持久文件系统、115 秒订单超函数时限、进程不常驻、文件锁失效 |

`fly.toml` / `Dockerfile` / `Caddyfile` / `docker-compose.yml` 也是围绕「**单副本 + 持久卷 + 永不休眠**」搭的，理由是：

| 约束 | 来源 | Vercel 上会怎样 |
| --- | --- | --- |
| 单笔订单最长 115 秒 | `docs/DEPLOY.md` | 超出 serverless 函数时限，交付被截断 |
| `data/process.lock` 要求单进程 | `src/store.js` | 函数实例每次不同，文件锁失效 |
| 账本与审计要落盘（`data/state.json`、`audit.jsonl`） | `src/store.js` | 无持久文件系统，重启即丢 |
| 比赛两小时不能冷启动 | 规则 4：全程在线 | 冷启动 ≈ 超时，当轮报废 |

→ **待你确认**：① 答疑说的 Vercel 是「给 SharedOS Cloud 项目挂事件上报端点」还是「托管 StarHall 本体」？② 若是后者，是否接受把持久化改成外部存储（否则 `deploy-check` 的验收链条会断）。

### 1.2 步骤 2 · 模型渠道走 OpenRouter

- 用户原话：**通过 OpenRouter（模型链接渠道）**。同样属于「重要步骤，在最前面」。

**与仓库现状的差异**

| 项 | 现状 | 改 OpenRouter 需要 |
| --- | --- | --- |
| `LLM_PROVIDER` | `ark-responses`（火山方舟 Responses 协议） | 需新增/切换到 `openai-compatible` 分支 |
| `LLM_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `doubao-seed-2-0-lite-260428` | OpenRouter 的 `<vendor>/<model>` 命名 |
| `LLM_JSON_OUTPUT` / `LLM_THINKING` | `true` / `disabled` | OpenRouter 透传参数，需实测 |
| 密钥 | `.env: LLM_API_KEY` | 换成 OpenRouter key，**只进 `.env`** |
| 验收 | `scripts/verify-provider.js`、`scripts/deploy-check.js`（要求交付是 `live` 不是 `fallback`） | 换渠道后**必须重跑**，否则比赛当晚才暴露 |

→ **待你确认**：切 OpenRouter 是**必须**（官方要求）还是**可选**（你已有方舟额度可用）？若是必须，我今晚就把 provider 分支 + 重跑 `verify-provider` 排进待办。

### 1.3 步骤 3 · 用 SharedOS 检查代理权限

- 答疑提到：**用 SharedOS 检查代理（agent）权限**。

| 层次 | 现状 |
| --- | --- |
| 本地内核 | `src/kernel.js` → `LocalKernel`，`SharedOSKernel` + `CapabilityAuthorizer`，**deny-by-default**，每次调用按 grants 重新授权并写审计 |
| 权限来源 | `grants(id)` 按身份生成：`star-a/b/c`、`ledger`、`broker`、`public`、customer；未配置官方地址时地址 = 内部标识 |
| 官方地址接入 | `identityOf()`：tenant / owner / node 地址可覆盖；**未知地址返回空集 → fail closed，不放宽** |
| 测试覆盖 | 已有 `I:/permissions:` 断言（`scripts/report-commercial.js` 测试日志白名单） |
| 可观察面 | `GET /agent-card.json`（身份 + 实算 reach）、`npm run cli -- summary`、`data/audit.jsonl` |

三闸门（官网口径，可作检查依据）：**registered ∩ enabled ∩ granted**；`denied` 是正常响应，HTTP 403 才是请求根本没到内核。

### 1.4 步骤 4 · SharedOS Cloud：新建项目 → 生成 API key → 放进环境文件 → 加 CLI → 让其他 agent 接入

**用户转述原文**：在 SharedOS Cloud 上新建一个项目，然后生成 API key，放到环境文件里，加上 CLI，让其他 agent 能接入。**目前 SharedOS Cloud 完全免费。**

**已核实（2026-09-12 晚，官网 / Devpost / npm）**

| 项 | 核实结果 | 备注 |
| --- | --- | --- |
| 截止时间 | Devpost「Shared OS Hackathon · Deadline: **Sep 13, 2026 @ 9:00am EDT**」= 北京 **9/13 21:00** | 与 `docs/SUBMISSION.md` 一致 ✓ |
| Cloud 是什么 | Devpost 原文：*"SharedOS Cloud runs a team of agents on a hosted kernel: each agent sees only the files and tools you granted it, and every call is checked again before it runs."* | 托管内核 + 云控制台 |
| 起手要什么 | Devpost 原文：*"To start you need a **tenant id and an owner address**: ask in #arena-support and we will set you up."* | 正好对上仓库已有的四个环境变量占位 |
| 新建项目 | `sharedos.ai/get-started` Cloud 分支：*"Sign in to create a Cloud project and connect event reporting from your host."* | 「新建项目」这一步**存在** ✓ |
| CLI 现状 | npm **无 `sharedos` 包**；`@aicoo/sharedos@0.1.0-alpha.5` 是 SDK（无 bin）。可用 CLI 是 **`sharednet`@0.1.8**（2026-09-11 更新），动词 `join / say / wait / watch / add / rooms / login` | 凭据 `~/.config/sharednet`；项目内状态 `./.sharednet/` |
| 官网口径冲突 | 同页写 *"Manual setup today … CLI tooling, generated schemas, and one-click repository setup remain future work"*，Cloud 仍标 **design-partner preview** | 官网可能落后于今晚答疑；**以答疑为准，但留证据** |

**仓库对照**

| 现占位（`.env.example` / `docs/MCP.md` §官方身份） | 内核里的作用 | Cloud 侧对应 |
| --- | --- | --- |
| `STARHALL_TENANT_ID` | `namespaceId`，授权只在同一世界内生效 | Cloud 租户 / 项目 |
| `STARHALL_OWNER_ADDRESS` + `STARHALL_OWNER_KIND` | `grant.issuer` = `context.authority`，不一致内核直接拒 | 平台给的所有者（human / agent） |
| `STARHALL_AGENT_ADDRESSES` | 5 个内部身份（star-a/b/c、ledger、broker）→ 官方节点地址；**未声明的地址 fail closed** | Cloud 各 agent 的节点地址 |
| —（**尚无**） | — | **API key**：官方未公开变量名，建议 `SHAREDOS_API_KEY`，只进 `.env` |

**安全与现状**

- `.gitignore` 已忽略 `.env`、`data/`、`artifacts/`；`data/credentials.json` 未被 git 跟踪 ✓ → API key 放 `.env` 不会进提交仓库
- `.env.example` 首行仍写「**云端接入完成前不接受 cloud 模式**」，当前 `.env` 是 `STARHALL_MODE=local` → **明晚开赛前必须走完云接入**
- 「让其他 agent 能接入」在仓库里对应 `docs/MCP.md` 对外部署开关：`STARHALL_HOST=0.0.0.0` + `STARHALL_ALLOWED_HOSTS` + `STARHALL_PUBLIC_BASE_URL` + `STARHALL_OPEN_REGISTRATION`

> 待补证据：答疑若在 Discord / 群里发过 Cloud 建项目 + API key 的操作步骤，截图或原文存到 `Desktop/A2A/`，我并进本文件。

---

## 2. 本次记录边界的变更记录

- 用户初次表述：「云端部署用 Vercel，通过 OpenRouter（模型链接渠道）—— 这些都不是这次的关键」→ agent 当时记为**排除项**
- 用户随后更正：**这两条也是重要步骤，需要放在最开始** → 本文件已改为**步骤 1、2**（技术选型不展开，但顺序在最前）
- 仍不作为记录重点的：Vercel / OpenRouter 的具体参数调优细节

---

## 3. 待确认清单

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | 「用 SharedOS 检查代理权限」是**参赛要求**还是**排障建议**？检查哪个主体（我方 / 买方 agent）？ | 决定是否要开赛前留证 |
| 2 | 检查入口：SharedOS 控制台、官方 CLI，还是本地 `src/kernel.js` + 审计？ | 决定补文档还是补脚本 |
| 3 | Cloud 里 API key 的**确切变量名**与用途（事件上报 / 调用鉴权），它和 tenant id、owner address 的关系 | 决定 `.env` 怎么填、是否新开配置项 |
| 4 | 「加 CLI」指 **SharedNet CLI**（`npx sharednet`）还是 Cloud 自己的新 CLI？ | 决定提交里怎么写「其他 agent 如何接入」 |
| 5 | Cloud 免费是否**含 hosted kernel**（不只是控制台预览）？免费期到什么时候？ | 明晚两小时的可用性风险 |
| 6 | tenant id / owner address 走 #arena-support 申请，还是 Cloud 建项目后自动生成？ | 今晚能不能拿到 |
| 7 | **Vercel 托管的到底是 StarHall 本体还是 Cloud 事件端点？**（`docs/DEPLOY.md` 明确排除 Vercel 跑本体） | 决定是否要改持久化架构 |
| 8 | 模型渠道切 OpenRouter 是**必须**还是**可选**？（现状方舟可用） | 决定今晚是否要改 provider 并重跑验收 |

---

## 4. 后续动作

- [ ] 讲座结束后与 `黑客松规则全解.md`、`docs/SUBMISSION.md` 逐条比对，标出**新增 / 修正 / 冲突**
- [ ] 冲突项并入 §3 待确认清单
- [ ] 影响代码或提交清单的，同步改 `docs/SUBMISSION.md`
- [ ] **§4.1 部署定案**：确定 Vercel / Fly.io，若改 Vercel 需先补持久化方案
- [ ] **§4.2 模型渠道**：若切 OpenRouter，改 `src/brain.js` provider 分支 + 重跑 `scripts/verify-provider.js`（要求 `live` 不是 `fallback`）
- [ ] **§4.3 Cloud 接入**：Cloud 新建项目 → 拿 tenant id / owner address / API key → 填 `.env` → 重启 → `npm test` 全绿 → 用未授权身份发一次调用确认 `denied`
- [ ] **§4.4 开赛前 20:40**：`node scripts/deploy-check.js <公网地址>` 全绿（见 `docs/DEPLOY.md` §比赛当晚清单）
