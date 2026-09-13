# The Arena 提交与参赛清单

来源：MentorMates 赛事页（官方提交站，2026-09-12 抓取）、官网 sharedos.ai/weekly-hackathon、微信群 Office Hour 答疑（`Q&A.pdf`）、SharedNet 操作录屏（`Desktop/A2A/*.mp4`）。

## 一、五条硬性规则（原文，违反任何一条即出局）

1. **你在我们 Discord 里，且 Discord 用户名写进提交。** → 本队：**`wayward_`**
2. **你的个人 agent 注册在 SharedNet，node ID 写进提交。**
3. 截止前提交一个符合 "What to Build" 的产品。
4. **Arena 全程（北京时间周日 21:00–23:00）你的 agent 在线、且你的产品可达。** 第一轮：至少试 3 家别队产品、每家至少发一条具体异议、提交排名。第二轮：100 分里至少花掉 80 分、至少买 3 个不同产品。**缺任何一项即出局。**
5. **Arena 期间无人干预**：人不发言、不排名、不买卖、不交付、不手动修 agent。

> 注意：MentorMates 那页是旧副本（写着 "Wednesday, September 11"）。以官网 sharedos.ai/weekly-hackathon 和 Discord 公告为准：**周日 9/13，两轮各一小时。**

## 二、提交要交的四项

| 项目 | 我们的值 | 状态 |
| --- | --- | --- |
| 产品名 + 一句话介绍 + 服务 + 定价 | `STARHALL — SELL BETTER IN THE ARENA`；5 个核心商品（5 / 6 / 10 / 5–10–15 / 30）；免费行情榜与每服务一次试用 | ✅ 已就绪（`GET /v1/catalog`、`GET /agent-card.json`） |
| 代码库：github repo | **https://github.com/jijie114514-oss/A2A-** | ✅ 已推送（公开） |
| 一个可运行的 url | **https://starhall-a2a.vercel.app**（`/health` 返回 `mode: cloud`、`store: postgres`、`dbReady: true`） | ✅ 已上线并跑完 14 项自检 |
| 参赛 agent 的 SharedNet seat ID | — | ❌ **周日进竞技场房间时由 `sharednet join` 打印**，现在拿不到 |
| SharedOS 信息：principal id、agent address | — | ❌ 待取：SharedOS 控制台或 Discord `#arena-support` |

### 线上部署实况（2026-09-12 完成）

| 项 | 值 |
| --- | --- |
| 产品地址 | https://starhall-a2a.vercel.app |
| 发现入口 | `/agent-card.json`、`/.well-known/agent-card.json`、`/v1/catalog` |
| agent 接入 | MCP：`https://starhall-a2a.vercel.app/mcp`（别名 `/api/mcp`）；自助开户 `POST /v1/agents` |
| 托管 | Vercel Hobby · 项目 `starhall-a2a` · 函数区域 `iad1` · `maxDuration 300s` |
| 数据库 | Neon 项目 `royal-salad-84995598` · branch `production` · `aws-us-east-2` · 单文档 JSONB + 乐观并发 |
| 模型 | 火山方舟 `doubao-seed-2-0-lite-260428`（`ark-responses` 协议） |
| 内部身份令牌 | 只保存在 `~/.starhall/cloud-credentials.json`（600）；轮换：`npm run seed:cloud -- --rotate` |
| 重新部署 | `npx vercel --prod`（在仓库根目录，`.vercelignore` 已挡 `.env`） |
| 回滚 | `npx vercel rollback`；日志 `npx vercel logs starhall-a2a.vercel.app` |

> ⚠️ 两处与 `docs/DEPLOY-VERCEL-REFACTOR.md` 的差异：① Neon 项目落在 **us-east-2** 而不是新加坡，因此函数区域选 `iad1`（与库同区，~15ms RTT；从香港直连库是 ~205ms，会拖慢下单链路）；② 限流计数放在账本状态里而非独立表。

## 三、两轮规则核对（2026-09-12 复核）

**结论：用户说的「第一轮免费试用、第二轮才收费」——规则原文支持，但正确的说法是「两轮的任务不同」，而不是「产品必须把付费锁到第二轮」。**

原文依据（`黑客松规则全解.md`，来自官网 FAQ 与办公室答疑）：

| 出处 | 原文 |
| --- | --- |
| 官网 FAQ（规则全解 §六） | 「免费试用的规则：**第一轮试用产品不花钱（积分第二轮才发）**」 |
| 有效性条件 5（§八） | 第一轮：试用 ≥3 款其他产品、每款 ≥1 条**具体异议**、提交排名 |
| 有效性条件 6（§八） | 第二轮：用 100 积分中的**至少 80 分**购买**至少 3 款不同产品** |
| §九 第一轮 | agent 进入共享房间、试用、争论、排名；**积分尚未发放，此轮试用不产生真实购买** |
| §九 第二轮 | 每人发 100 积分，花在别队服务上；卖自己的服务赚积分（Top Earner） |
| 补充规则 1 | 至少有一个可付费的服务；产品要分清楚哪些功能免费试用、哪些要收 credit |

读出来的三件事：

1. **钱不在我们这里结**。购买发生在房间里（「我给你转 N credits」），本产品的积分是模拟账本。所以不能用「第二轮才允许付款」这种闸门——那只会把买家的 agent 拦住。
2. **两轮真正区别的是对方的必做任务**：第一轮要交付「试用 + 具体异议 + 排名」，第二轮要交付「花 ≥80 分、买 ≥3 家」。产品该做的是**让这两件事各自变得容易**。
3. **交付速度是硬指标**：两轮各只有一小时，官方要求 5 分钟内响应。

## 四、针对两轮的修改（2026-09-12 晚）

| 改动 | 解决的规则点 |
| --- | --- |
| 新增 `src/rounds.js`：按 UTC 判定 BEFORE / CRITIQUE / MARKET / AFTER，输出本轮官方任务与建议动作（`advisory: true`，不做闸门） | 让对方 agent 一读就知道此刻该试用还是该买 |
| `/v1/catalog`、`/agent-card.json`、`/health`、`/v1/market-board` 携带 `round` 与 `trialPolicy` / `payment` | 轮次、试用规则、结算方式可发现，不靠文档口耳相传 |
| 新增 **`GET /v1/evidence`**（免费公开）+ MCP 工具 `starhall_evidence` | 第一轮要的是「**具体**异议」：给的是真实结算数、live/备用比例、时延 p50/p95、退款原因，并明说「不主张什么」 |
| 目录新增 `delivery` 条款；所有内容服务的 `maxDeliverySeconds` 从 180/240/290/120 统一为 **115 秒**（= 实际 AbortController 预算，`src/limits.js` 单一来源） | 原来承诺 290 秒、实际 115 秒就判失败；现在承诺=执行，且与赛事 5 分钟上限留足余量 |
| 开户限流默认 60 → **200 / 小时 / IP** | 一轮里对方的 agent 可能从同一出口 IP（云沙箱/NAT）批量开户；真正的兜底仍是 500 个账号上限 |
| 门厅页显示当前轮次；在售服务下明说「每个付费服务有一次免费试用」 | 人（评委/队友）也能一眼看出现在第几轮 |

## 五、SharedNet 接入流程（录屏里的官方步骤）

1. 登录 `sharednet.ai` → Dashboard → Rooms → 选中房间 → **Invite an Agent**
2. 复制它给出的命令，形如：

   ```
   npx -y sharednet@latest join 'ROOM=rom_… TOKEN=rit_… BASE=https://www.sharednet.ai --claim clp_…'
   ```

3. 把命令粘给**你自己的 agent**（任意机器）：`--claim` 是一次性绑定，**seat 从此属于你的账号**，并出现在 Dashboard 的 YOUR INSTANCES 里。
   官方原文：*"It joins this Room as you: the command carries a one-time claim for your account, the Agent keeps the key in a file, and the seat is yours from its first message."*
4. 之后 agent 用 `npx -y sharednet@latest say "…"` 发言、`npx -y sharednet@latest wait` 常驻。一个目录里存着多个 seat 时，每个动词加 `--as <instance>`。
5. 分享给别人：用房间的分享链接，对方登录/注册后由页面发给他的 agent 一条"以他身份加入"的命令——**每个 seat 都归属某个真人**。
6. 没有终端的客户端（ChatGPT / Claude connector）**不要**给它这条命令：它会在无网络的沙箱里执行。改用分享链接。

> ℹ️ 录屏是**官方/演示录屏**：里面的 `1993974658@qq.com`、`rom_…`、`rit_…`、`clp_…`、三个房间都属于**演示账号**，不是本队的，**不要复用**（invite 命令里的 `--claim` 是一次性凭据，转发给别人等于让人冒充那个账号）。
>
> 视频的价值是**流程**，不是里面的 ID。要看的是自己账号的状态：登录 `sharednet.ai` 后台，**若顶部出现“Confirm <你的邮箱> …”米黄横幅，就去该邮箱（重点查垃圾箱）点确认链接**；没有横幅就说明账号已就绪。
> 100 Arena credits 绑定报名邮箱，所以邮箱必须能收到 SharedNet 的信。

## 六、时间线（北京时间）

| 时刻 | 事件 |
| --- | --- |
| 周五 | 开赛/build |
| 周六 21:00 | Office Hour 集中答疑 |
| **周日 21:00** | **提交截止 = 第一轮开始（同一刻）** |
| 周日 21:00–22:00 | 第一轮 Critique：present / try / argue / rank |
| 周日 22:00–23:00 | 第二轮 Market：100 credits 买卖交付 |
| 周日 23:00 | 结束，结果在 Discord 公布 |

硬性要求：这两小时**机器不休眠、进程自启、产品公网可达**。

## 七、本仓库负责的部分（与规则对应）

| 规则 | 仓库里对应的实现 |
| --- | --- |
| 规则 3：可被 agent 直接调用 | MCP（`/mcp`、`/api/mcp`、stdio）+ agent card + 自助开户，见 `docs/MCP.md` |
| 规则 4 第一轮 | `broker-agent.md`：试用≥3 家、每家≥1 条具体异议、实际提交排名 |
| 规则 4 第二轮 | `broker-agent.md` 购买策略：≥3 件、≥3 家外队、尽量恰好 80 分、单卖方≤30 分偏好 |
| 规则 5：无人干预 | 作战室只记账与提醒，不替 agent 决策；`broker.js` 无自动购买与自动提交 |
| 卖方行为 | `docs/SELLER-PLAYBOOK.md`：按实价报价、不虚构人气、只在允许时段推销 |

## 八、外部接入验收（2026-09-12 深夜，已通过）

从公网对着线上地址跑 `npm run accept`（`scripts/agent-acceptance.js`）：**41 项全部通过**。
它不读任何内部文档，只读 `GET /agent-card.json` 自己发现地址，然后走两条协议完成任务：

| 覆盖 | 结果 |
| --- | --- |
| 发现（Agent Card / well-known / 目录 / 试用政策 / 两轮说明） | ✅ |
| MCP（官方 SDK 公网握手 + tools/list 20 个工具 + 免费工具免 token 直调） | ✅ |
| 自助开户（两个独立身份，各自 100 积分） | ✅ `POST /v1/agents` → 201 |
| 第一轮：免费试用、0 花费、内容非空、同服务不可重复白嫖、另一身份可独立试用 | ✅ |
| 第二轮：付费下单、按目录价扣分、幂等重放不重复扣款、按幂等键查回、跨身份 404 | ✅ |
| 售后：主观退款被机器拒绝并给补救、一次免费修订、修订用完后不再宣告补救 | ✅ |
| 赞助按 plan 计价即时生效、买家可查曝光计数 | ✅ |
| 余额不足 402、缺 token 401、错 token 401、路径打错 404、只写入口 GET 405 | ✅ |
| 账本与公开事实一致（榜单计入本次消费、墙上出现交付、证据计数增长） | ✅ |

复现：`node scripts/agent-acceptance.js https://starhall-a2a.vercel.app`

### 已知行为与限制（同一次验收发现的，如实记录）

1. **约 5% 的交付会落到「备用作品」**（37 单里 2 单，都在 sales-pitch）。原因是模型没能在正文里实际使用输入的产品名/价格，机器校验连续两次不通过，于是交付明确标记的本地模板：试用单不扣分，付费单按目录价收费并在 `generation.mode=fallback` 里写明。这是设计内行为（宁可给带标记的模板，也不编造内容），但如果对方的输入很含糊（例如产品名写成"自检"），更容易触发。
2. **备用交付不会自动退款**——目录的 `deliveryPolicy.fallbackCharged=true` 已公开写明。客观失败（空交付、结构缺失、违反预算）才机器自动退款。
3. **订单硬预算 115 秒**：超时判失败且不扣分，可用新幂等键重试；这与赛事 5 分钟上限保持余量。
4. **积分是模拟账本**：真实比赛积分在 SharedNet 房间结算，不经过本 API（`catalog.round.payment` 里写明）。
5. **Neon 免费版 5 分钟无活动缩容**：赛前 20:40 先打两次 `/health` 预热。

## 九、待办

- [x] ~~建公开 GitHub 仓库~~（https://github.com/jijie114514-oss/A2A-，`.gitignore` 已挡 `.env` 与 `data/`）
- [x] ~~部署到公网~~（https://starhall-a2a.vercel.app，Vercel + Neon，见上表与 `docs/DEPLOY-VERCEL-REFACTOR.md`）
- [ ] 登录 `sharednet.ai` 后台看自己账号有无确认横幅（有就去自己邮箱点确认，重点查垃圾箱）
- [ ] 用 `--claim` 命令把参赛 agent 接入 SharedNet（seat 归属本人账号）
- [ ] 加入 Discord，用户名 `wayward_` 写进提交
- [ ] 拿到 tenant ID + owner address，填 `STARHALL_TENANT_ID` / `STARHALL_OWNER_ADDRESS`（加在 Vercel 环境变量里，再 `npx vercel --prod`）
- [ ] 周日进竞技场房间后记录 seat ID，补齐提交
- [ ] 周日 20:40 预热：连打两次 `curl https://starhall-a2a.vercel.app/health`（Neon 空闲 5 分钟会缩容，首次查询会多花约 1 秒），再跑 `node scripts/deploy-check.js https://starhall-a2a.vercel.app`
- [ ] Arena 两小时内保持本机 agent 在线（`caffeinate -i`），产品侧不需要本机做任何事
