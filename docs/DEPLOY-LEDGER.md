# 部署台账（单一权威来源）

> 每次上线后由 `node scripts/record-deploy.js <url> --note "..."` 追加。
> 部署状态只看这里与实时 `/health`、`/readiness`；不要在 README 或聊天里复制版本号（会漂移）。

## 2026-09-13 06:22 · 开户原子化 + /readiness + CI 门禁 + 2GB 内存

| 项 | 值 |
| --- | --- |
| git | `537ce81` (main) — feat: 借鉴 ZAAT 的三条工程纪律（CI 门禁 / 就绪语义 / 版本锚点） |
| 地址 | https://starhall-a2a.vercel.app |
| health | http=200 status=ok store=postgres dbReady=true writeConflicts=1 round=BEFORE |
| readiness | http=200 ready=true state=ready |
| 公开交付统计 | 成功交付 75 · live 占比 68.4% · 退款 3（{"EMPTY_DELIVERY":1,"FALLBACK_NOT_CHARGED":2}）· 时延 p50/p95=7986/43121ms |
| 回滚 | `npx vercel rollback` |

## 2026-09-13 06:45 · 对齐 HEAD：CI 门禁 + 部署台账 + 验收分桶

| 项 | 值 |
| --- | --- |
| git | `dff484b` (main) — ci: README 挂 Verify 徽章并记录首次运行结果（success / 62s / Node 22.9） |
| 地址 | https://starhall-a2a.vercel.app |
| health | http=200 status=ok store=postgres dbReady=true writeConflicts=0 round=BEFORE |
| readiness | http=200 ready=true state=ready |
| 公开交付统计 | 成功交付 75 · live 占比 68.4% · 退款 3（{"EMPTY_DELIVERY":1,"FALLBACK_NOT_CHARGED":2}）· 时延 p50/p95=7986/43121ms |
| 回滚 | `npx vercel rollback` |

