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

## 三、SharedNet 接入流程（录屏里的官方步骤）

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

## 四、时间线（北京时间）

| 时刻 | 事件 |
| --- | --- |
| 周五 | 开赛/build |
| 周六 21:00 | Office Hour 集中答疑 |
| **周日 21:00** | **提交截止 = 第一轮开始（同一刻）** |
| 周日 21:00–22:00 | 第一轮 Critique：present / try / argue / rank |
| 周日 22:00–23:00 | 第二轮 Market：100 credits 买卖交付 |
| 周日 23:00 | 结束，结果在 Discord 公布 |

硬性要求：这两小时**机器不休眠、进程自启、产品公网可达**。

## 五、本仓库负责的部分（与规则对应）

| 规则 | 仓库里对应的实现 |
| --- | --- |
| 规则 3：可被 agent 直接调用 | MCP（`/mcp`、`/api/mcp`、stdio）+ agent card + 自助开户，见 `docs/MCP.md` |
| 规则 4 第一轮 | `broker-agent.md`：试用≥3 家、每家≥1 条具体异议、实际提交排名 |
| 规则 4 第二轮 | `broker-agent.md` 购买策略：≥3 件、≥3 家外队、尽量恰好 80 分、单卖方≤30 分偏好 |
| 规则 5：无人干预 | 作战室只记账与提醒，不替 agent 决策；`broker.js` 无自动购买与自动提交 |
| 卖方行为 | `docs/SELLER-PLAYBOOK.md`：按实价报价、不虚构人气、只在允许时段推销 |

## 六、待办

- [x] ~~建公开 GitHub 仓库~~（https://github.com/jijie114514-oss/A2A-，`.gitignore` 已挡 `.env` 与 `data/`）
- [x] ~~部署到公网~~（https://starhall-a2a.vercel.app，Vercel + Neon，见上表与 `docs/DEPLOY-VERCEL-REFACTOR.md`）
- [ ] 登录 `sharednet.ai` 后台看自己账号有无确认横幅（有就去自己邮箱点确认，重点查垃圾箱）
- [ ] 用 `--claim` 命令把参赛 agent 接入 SharedNet（seat 归属本人账号）
- [ ] 加入 Discord，用户名 `wayward_` 写进提交
- [ ] 拿到 tenant ID + owner address，填 `STARHALL_TENANT_ID` / `STARHALL_OWNER_ADDRESS`（加在 Vercel 环境变量里，再 `npx vercel --prod`）
- [ ] 周日进竞技场房间后记录 seat ID，补齐提交
- [ ] 周日 20:40 预热：连打两次 `curl https://starhall-a2a.vercel.app/health`（Neon 空闲 5 分钟会缩容，首次查询会多花约 1 秒），再跑 `node scripts/deploy-check.js https://starhall-a2a.vercel.app`
- [ ] Arena 两小时内保持本机 agent 在线（`caffeinate -i`），产品侧不需要本机做任何事
