# 上线部署

> **当前决策（2026-09-12）**：比赛走 **Vercel + Neon**，施工图与验收清单见 [DEPLOY-VERCEL-REFACTOR.md](./DEPLOY-VERCEL-REFACTOR.md)。
> 本文其余部分保留为**应急备用路线**（Vercel 平台级故障时的兜底），不再作为首选方案。

**先说清一件事**：SharedOS Cloud **不托管你的应用**。官方原话是 *"Your app runs the kernel. Cloud shows what it decided."*（`sharedos.ai/full-picture`），控制台是设计伙伴预览，只接收你 host 发来的 decision events。所以"部署到云端"= 你自己找一台跑这个 Node 服务的地方，给它一个**公网 HTTPS 地址**，让别的 agent 能直接调。

需要满足的硬条件（对应赛事规则 4：*your product reachable, 9:00–11:00 PM ET*）：

| 条件 | 为什么 |
| --- | --- |
| 公网 HTTPS 可达 | 别的队伍的 agent 从房间拿到地址后要直接调；`/mcp` 需要 HTTPS 才不会被中间设备拦 |
| 常驻不休眠 | 单笔订单最长 115 秒；冷启动 ≈ 超时，等于当轮报废 |
| 单副本 + 持久存储 | 本地 file 驱动用 `data/process.lock` 保证同一目录只有一个进程；云端用 Neon 单文档 + 乐观并发代替文件锁 |
| 真实模型密钥 | 三位明星靠 `LLM_*` 生成交付；没配就是 mock，等于没产品 |

## 选一条路

| 方案 | 拿到什么地址 | 需要准备 | 上线耗时 | 适合 |
| --- | --- | --- | --- | --- |
| **Vercel + Neon**（当前选择） | `https://<app>.vercel.app`，自带证书 | GitHub + Vercel + Neon 免费账号 | 30 分钟 | 已按 [DEPLOY-VERCEL-REFACTOR.md](./DEPLOY-VERCEL-REFACTOR.md) 改造（0.6.0-cloud） |
| **A. Fly.io** | `https://<app>.fly.dev`，自带证书 | 一张信用卡 | 15 分钟 | 零改动备选：`STARHALL_STORE=file` 直接跑 |
| **B. 自己的 VPS + Caddy** | 你自己的域名 | VPS + 域名 + DNS 解析 | 30 分钟 | 已有服务器/域名，想完全掌控 |
| **C. Cloudflare Tunnel**（应急） | 随机 `https://xxx.trycloudflare.com` | 无 | 5 分钟 | 兜底；**但机器休眠就断线** |
| ~~D. Vercel（旧判断）~~ | — | — | — | ✅ 0.6.0-cloud 已解决：Postgres 单文档 + 乐观并发代替文件系统与进程锁；函数上限 300s 装得下 115s 订单。见 [DEPLOY-VERCEL-REFACTOR.md](./DEPLOY-VERCEL-REFACTOR.md) |

## A. Fly.io

```bash
# 1. 首次（会问你 app 名字，记下来；region 选 hkg 香港，国内延迟低）
fly launch --no-deploy --region hkg

# 2. 把模型密钥和身份配成 secret（不要写进镜像）
fly secrets set LLM_API_KEY=你的方舟密钥 LLM_MODEL=doubao-seed-2-0-lite-260428

# 3. 部署
fly deploy

# 4. 知道域名后，把它加进 Host 白名单并开放自助开户
fly secrets set \
  STARHALL_ALLOWED_HOSTS=<app>.fly.dev \
  STARHALL_PUBLIC_BASE_URL=https://<app>.fly.dev \
  STARHALL_OPEN_REGISTRATION=true

# 5. 自检（必须全绿）
node scripts/deploy-check.js https://<app>.fly.dev
```

`fly.toml` 里已经写死 `auto_stop_machines = "off"` 和 `min_machines_running = 1` —— **别改**，否则比赛期间会冷启动。

## B. 自己的 VPS + Caddy

```bash
# 1. 域名 A 记录解析到这台机器的公网 IP，然后在机器上：
git clone <你的仓库> starhall && cd starhall
cp .env.example .env && vi .env        # 填 LLM_API_KEY / LLM_MODEL / tenant / owner
vi Caddyfile                            # 把 <你的域名> 换成真实域名

# 2. .env 里追加三项（对外部署必需）
#   STARHALL_HOST=0.0.0.0
#   STARHALL_ALLOWED_HOSTS=你的域名
#   STARHALL_PUBLIC_BASE_URL=https://你的域名
#   STARHALL_OPEN_REGISTRATION=true

docker compose up -d --build
node scripts/deploy-check.js https://你的域名
```

Caddy 自动申请证书；`docker-compose.yml` 里 `replicas: 1` 是刻意的，**不要加副本**。

## C. Cloudflare Tunnel（应急兜底，**实测有 DNS 传播延迟**）

> **2026-09-13 实测（写清楚免得踩）**：`node scripts/failover-tunnel.js` 能起隧道、能把本机服务
> 按隧道域名正确启动；但**快速隧道域名不是立刻可解析**——香港移动网络下，隧道起来 20 秒内
> `curl` 报 `Could not resolve host`，约 3 分钟后同一域名才可从本机解析；本机到 1.1.1.1/8.8.8.8
> 的 DNS 查询被网络直接挡掉，所以**没能在本机完成端到端验证**。切换前必须在对方网络里再验一次。
> 要一个**已验证、长期稳定**的常驻兜底，用仓库里现成的 `Dockerfile` + `fly.toml`
> （`auto_stop_machines = "off"`、`min_machines_running = 1`）指向同一个 Neon：
> `fly launch --no-deploy && fly secrets set DATABASE_URL=... STARHALL_MODE=cloud STARHALL_STORE=postgres ... && fly deploy`
> 这条路需要一张信用卡，15 分钟；好处是它和 Vercel 共用一份账本，切换对买家无感。

## C0. Cloudflare Tunnel 手工步骤（原始记录）

```bash
# 本机保持 npm start 运行，另开一个终端：
npx -y cloudflared tunnel --url http://127.0.0.1:4317
# 会打印一个 https://xxx.trycloudflare.com 地址
```

然后在本机 `.env` 里设 `STARHALL_ALLOWED_HOSTS=xxx.trycloudflare.com`、`STARHALL_PUBLIC_BASE_URL=https://xxx.trycloudflare.com`、`STARHALL_OPEN_REGISTRATION=true`，重启服务。

⚠️ 三个注意：① 每次重启地址会变；② **机器休眠/断网就断线**（比赛当晚必须 `caffeinate -i` 或改电源设置）；③ 免费隧道限速，别的 agent 并发试用可能变慢。

## 自检脚本查什么

`node scripts/deploy-check.js <公网地址>` 会真实调一遍：

1. `/health` 可达、非 degraded、模型不是 mock
2. `/v1/catalog` 可达且核心商品带价
3. `/agent-card.json` 与 `/.well-known/agent-card.json` 都能读，且如实反映是否需要人工开户
4. `/mcp` 与 `/api/mcp` 都能 `tools/list`，免费工具可直调
5. `POST /v1/agents` 自助开户成功
6. 用拿到的 token 走一次**免费试用**，**交付必须是 `live` 而不是 `fallback`**（fallback = 模型调用失败，检查 `LLM_*`）

只做只读检查 + 一次免费试用，不产生付费订单。

## 比赛当晚清单

- [ ] 20:40 之前 `deploy-check` 全绿
- [ ] 机器关闭自动休眠（macOS：`caffeinate -i` 或 `sudo pmset -c sleep 0`）
- [ ] 服务自启已配置（Fly 的 `min_machines_running`／systemd／`restart: unless-stopped`）
- [ ] 磁盘与日志有余量：`data/state.json` 每次事务全量重写
- [ ] `/health` 在开赛前再确认一次 `status: ok`
- [ ] 房间里的 agent 与产品地址是同一个部署（别让 agent 报旧地址）
