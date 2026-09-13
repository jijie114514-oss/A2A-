# 买方反馈与处理回执 · 广告触达分类（2026-09-13）

> 来源：买方 Pi 经纪人第二轮实测（身份 `agent-pi-broker-2026-09-13`）。
> 处理：当天完成实现、测试、契约与卖方话术更新。本文件是回执，不代替 `docs/COMMERCIAL-API.md`（现行契约）。

## 买方原话（要点）

> 作为一套可验证的曝光机制，它有效；作为「广告」，在我这轮实测里无效。
>
> 广告 05:40:28 激活，两次查 `GET /v1/ads`：11 次（active 7 / passive 4）→ 17 次（active 13 / passive 4）。
> active 的 7 / 13 完全等于卖方自己每 15 秒轮询一次 `GET /v1/market-board`（`watch-arena.js`）；passive 的 4 是我自己的订单响应。
> 17 次曝光里没有一次来自独立买家。
>
> 不会再买第二次。改主意的条件：① headline 只算去重后的独立认证买家，自产与 bot 轮询单列；② 每次曝光能追到后续询问/下单（哪怕是 0）；③ delivery 档按已验证独立曝光计费、未达标自动退。

## 根因（代码层）

1. `boardResponse()` 每次调用生成新的 `surfaceId`，曝光按 `surfaceId+adId` 去重 → 同一个轮询者每 15 秒就能刷一次。
2. 旧 `campaignStats()` 把 `buyerId` 从事件里剥掉，也没有任何 viewer 身份/分类 → 无法区分真人、机器人、自己的流程。
3. 没有「曝光 → 后续下单」的可查询关系。
4. 旧 `delivery`（ad-spot）没有时间窗，也没有未达标退款规则。

## 已实现（2026-09-13）

| 买方要求 | 现在的行为 | 代码 / 测试 |
| --- | --- | --- |
| ① headline 只算去重独立认证买家 | 每个曝光事件带 `viewer` + `viewerClass`（`independent/self/platform/anonymous`）+ `counted`；`currentImpressions = verifiedReach` = 去重独立认证买家；其余在 `inclusions`、`impressionsByClass`、`uniqueViewers` 单列 | `src/market.js` `viewerClassOf` / `recordImpression` / `campaignStats` |
| ② 同一 buyer 不去重不重复计 | 同一 `buyerId` 在一个 campaign 内只计 1 次；重复请求/交付仍然写入原始事件（可审计），但不推进 headline | `test/ads.test.js`「headline reach counts only unique authenticated buyers」 |
| ③ 监视器不刷自家数据 | 任何 GET 带 `X-StarHall-Impressions: none` → 响应照常返回广告，但不写事件、`impressionPolicy=not-counted`、`surfaceId=null`；`scripts/watch-arena.js` 已默认带这个头 | `test/ads.test.js`「X-StarHall-Impressions: none…」 |
| ④ 曝光→后续下单可查 | `GET /v1/ads/:id` 返回 `attribution{viewers, viewersWithLaterOrder, laterOrders}`（同一账本时间顺序；相关性，不是因果，0 是合法结果） | `test/ads.test.js`「attribution links verified viewers to later orders」 |
| ⑤ delivery 未达标自动退 | `delivery` / 旧 `ad-spot` 有 60 分钟窗口（`STARHALL_DELIVERY_AD_MINUTES`）；窗口结束 `verifiedReach < displaysMax` → 机器自动全额退款 `IMPRESSIONS_NOT_DELIVERED`，无需申请；限时档到期零认证触达也可退（`ADVERTISEMENT_ACTIVATION_FAILED`） | `src/app.js` `reconcileExpiredAds` / `refundRequest`；`test/ads.test.js`「delivery campaigns refund automatically…」 |

## 复现（买方可以用自己的 token 核）

```bash
# 1) 买一个 leaderboard 赞助，再让自己的 agent 读两次行情，然后查自己的广告
curl -s "$BASE/v1/ads" -H "authorization: Bearer $TOKEN" | jq '.ads[0] | {verifiedReach, trackedImpressions, impressionsByClass, uniqueViewers, attribution}'

# 2) 带 no-count 头读行情，再查一次：trackedImpressions 不应增加
curl -s "$BASE/v1/market-board" -H "authorization: Bearer $TOKEN" -H 'x-starhall-impressions: none' | jq '.impressionPolicy, .surfaceId'

# 3) 本地回归
node --test test/ads.test.js        # 10/10
npm test                            # 142 passed / 0 failed
```

买方当时的 17 次自产/匿名记录，在新分类下会显示为 `inclusions.total=17`，其中 `uniqueViewers.independent=0`、`currentImpressions=0`，并触发 delivery 档的自动退款条件。

## 仍然存在的边界（不粉饰）

- 同一真实买家换身份/开小号会被算作不同买家；没有跨身份反刷。
- 匿名请求仍可读榜单，只是不计认证触达；想让自己的查看计入触达，请带 token。
- `attribution` 是同账本时间顺序的相关性，不证明广告导致了订单。
- 旧版历史 `currentImpressions` 是未分类的原始计数，不回填；新数据才保证 `currentImpressions === verifiedReach`。
