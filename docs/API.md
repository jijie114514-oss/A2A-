# 0.5.0 API更新

核心商业API、输入输出、计分和曝光规则见[COMMERCIAL-API.md](COMMERCIAL-API.md)。新增GET /v1/market-board及GET /v1/commercial-profile；订单入口支持五个新service ID；catalog.services为五商品加免费榜，旧商品在extras.services。GET /v1/summary仍兼容且经纪人仍无该入口授权；经纪人通过market-board-read用途只看公共行情。下方旧API说明继续适用于兼容服务。

---

# StarHall 本地 JSON API

基础地址：`http://127.0.0.1:4317`。所有返回为 UTF-8 JSON。POST 要求 `Content-Type: application/json`，正文最大32KB。身份从 `Authorization: Bearer <本地令牌>` 推导；令牌见 `data/credentials.json`。

这是 StarHall 产品 HTTP 协议，不冒充 SharedNet 协议。服务器为每条路由设定 purpose，客户端不能通过字段或 header 改变授权范围。未知正文或 input 字段返回400。

## 接口一览

| 方法 / 路径 | 身份 | 用途 |
| --- | --- | --- |
| `GET /health` | 无需认证 | 本地模式、内核版本、模型类型、存储导出状态 |
| `GET /v1/catalog` | 无需认证 | 定价、输入 JSON Schema、调用说明 |
| `GET /v1/summary` | 匿名 / 顾客 | 免费基础榜；传经纪人令牌则拒绝 |
| `GET /v1/wallet` | 已认证账户 | `balance`、`held`、`available` |
| `GET /v1/wall` | 已付费顾客 | 完整打赏墙 |
| `POST /v1/orders` | 顾客 | 创建或恢复幂等订单，等待交付 |
| `GET /v1/orders` | 顾客 | 仅该身份的订单列表 |
| `GET /v1/orders/{id}` | 订单买家 | 查询订单；其他身份返回404 |
| `POST /v1/orders/{id}/refund` | 订单买家 | 机器仲裁退款：客观失败/约束违反自动退；主观不满意回绝并提供一次免费修订 |
| `POST /v1/orders/{id}/revision` | 订单买家 | 一次免费修订，不扣款、不增加销量或明星支持；需要 Idempotency-Key |
| `GET /v1/orders/by-key` | 订单买家 | header 中传原 Idempotency-Key，不需要重发正文 |
| `POST /v1/trials` | 顾客 | 每服务一次成功免费试用，与下单相同正文和幂等要求 |
| `GET /v1/trials/by-key` | 试用买家 | 按原幂等键查询试用单 |
| `POST /v1/demo` | 经纪人 | 免费调用星A，由星A经账本记录自家演示动态 |
| `POST /v1/requests` | 顾客 | 未上架需求升级，自动策略处理 |
| `POST /v1/practice/{id}/turns` | 会话买家 | 五回合互动练习，每次一句买家发言 |

## 下单

`POST /v1/orders` 必须带 `Idempotency-Key`，1–128字符。同一买家的键不能用于不同服务、输入或留言。不同买家的键互不冲突。

```json
{
  "service": "poem",
  "input": { "theme": "凌晨三点的黑客松", "recipient": "猎户座队" },
  "message": "让作品发光！"
}
```

`message` 可省略，最长500字符，将写入完整打赏墙。公开点名来自认证账户名称，不由买家在正文伪造。价格由目录固定，买家不能指定扣款金额。

| service | 必填 input 字段 | 附加输出 |
| --- | --- | --- |
| poem | theme、recipient | 诗词正文、署名 |
| speech | occasion、recipient | 广告词 / 致辞 |
| patron | occasion、recipient | 完整作品、置顶感谢 |
| roast | description | 犀利点评 |
| review | description | sections（heading、content） |
| prediction | 无，传 `{}` | 材料不足时明确说明 |
| negotiate | scenario | rounds 五项、复盘、practice会话 |
| tactics | direction：buy 或 sell | lines 话术清单 |
| duet | description、theme、recipient | 星B和星A的两个 pieces |

上述必填文本最长2000字符。所有 input 都可选带 `context`（最长4000字符）补充背景。预测时可将候选产品及试用证据放在 context。

0.3.0 起 context 与主字段同等进入逐字段任务材料；每份作品附 `inputComparison`：`fields[].provided` 为输入原文，`points[].inputQuote` 为提取要点，`matched` 和 `evidence` 给出正文匹配证据。它由宿主代码核对实际章节/话术/回合生成，不接受模型自称“已经理解”的结论。关键词核对不能保证完整语义正确，仍需阅读正文。占位符、已知跨业务跑题和遗漏要点会触发一次有时限的修复，继续失败按 fallback 配置处理。

`points[].required` 区分必需匹配与参考背景，`location` 标明 body 或 title-or-intro。支持 StarHall/星辉舞台等明确别名和少量诗歌同义表达。互动回合的历史场景作为参考，不强迫每句重复所有词；仍检查当轮要点、卖方角色和交易约束，避免“回答了当前问题却因没重复旧报价而降级”。

诗歌主题使用 `fields[].minimumMatches: 1`，不强求每个表达动词逐字出现；相关业务功能仍按 required 校验。可选要点没有匹配时仍如实返回 matched=false，不把推测当作证据。

`tactics.inputSchema.properties.direction` 包含 enum、说明和示例。可直接使用：`{"direction":"buy","context":"向别队购买代码审查服务，预算15积分，对方报价20积分，可减少一次修订。"}`。卖方使用 `sell`，context 保留双方条件。

成功返回（省略长文本）：

```json
{
  "id": "订单UUID",
  "buyerId": "fan-orion",
  "service": "poem",
  "price": 5,
  "status": "delivered",
  "traceId": "共享的审计关联ID",
  "elapsedMs": 75,
  "balanceAfter": 95,
  "delivery": {
    "pieces": [{
      "star": "star-a", "service": "poem", "title": "作品标题", "text": "作品正文",
      "greeting": "初次见面，欢迎来到星辉舞台！",
      "generation": { "mode": "mock", "provider": "local-template", "notice": "本地模板作品，未调用模型 API" }
    }],
    "shoutout": "猎户座队 · 10分 · 定制短诗 / 歌词",
    "wallEntry": {},
    "fullWall": [],
    "summary": {},
    "simulatedPayment": true
  }
}
```

从0.2.0-local起，HTTP 200 表示返回了最终订单资源，客户端必须检查 `status`：`delivered` 是成功交付，`failed` 是生成/结算未完成。失败订单含 ID、error、elapsedMs、charged: 0、fundsReleased: true、orderUrl 和 retry 提示，不再用502把它伪装成纯网络失败。202 表示处理中。无效输入、认证、余额不足等尚未创建订单的问题仍返回4xx。

订单列表默认包含 pending、delivered、failed 全部状态，响应有 total 与 includes。`GET /v1/orders?status=failed` 可单独查看失败单。单独查询、同键查询均支持失败单，且只限该订单买家。失败订单保留原幂等键，使用新键才能重新下单。

退款与修订由确定性机器验证决定，LLM 不参与退款决策。`POST /v1/orders/{id}/refund`（可选正文 `{"reason":"..."}`，买方理由只写入审计）重新验证已提交交付，返回结构化仲裁结果：

- 交付客观失败（空交付、schema 不合格、关键字段缺失）或违反明确约束（Deal Coach 建议价超 budget → `BUDGET_VIOLATION`、低于 minimumAcceptablePrice → `PRICE_FLOOR_VIOLATION`）→ `decision=REFUNDED`，返回积分、回滚 Fan Support、收入与商业信号，写入一条 `order.refunded` 事件与 `REFUND_REVERT` 市场动作；重复请求返回 `ALREADY_REFUNDED`，绝不重复返积分或重复回滚。
- 失败订单从未扣款 → `decision=NOT_CHARGED`。pending → `DECLINED / ORDER_IN_PROGRESS`。
- 成功交付但主观不满意 → `decision=DECLINED / SUBJECTIVE_NOT_REFUNDABLE`，`refundEligible=false`，`remedy=ONE_FREE_REVISION`。
- 广告（按去重后的独立认证买家触达计）：delivery / ad-spot 窗口（默认60分钟）内未达到承诺触达 → 机器自动全额退款 `IMPRESSIONS_NOT_DELIVERED`；限时档已有认证触达 → `DECLINED / IMPRESSIONS_ALREADY_SERVED`；到期仍零认证触达 → `ADVERTISEMENT_ACTIVATION_FAILED` 退款并回滚 Sponsor Support；仍 ACTIVE 且零认证触达 → `DECLINED / CAMPAIGN_STILL_ACTIVE`。广告主自己、平台身份与匿名轮询的包含记录单列，不影响上述判定。

`POST /v1/orders/{id}/revision`（正文 `{"notes":"..."}`，必须带 Idempotency-Key）对每个成功 paid 内容订单最多提供一次免费修订：不再次扣款、不新增订单/销量/Fan Support/Sponsor Support，修订内容关联原始 orderId；同键重放返回同一修订，已使用后换键返回409 `revision_used`。

订单响应统一增加 `deliveryStatus`（PAID/DELIVERED/REVISION_AVAILABLE/REVISION_USED/REFUNDED/FAILED）、`refundEligible`、`refundReason`、`refundApplied`、`revisionAvailable`、`revisionUsed`、`remedy`、`chargedCredits`。REFUNDED 订单：`chargedCredits=0`、收入贡献0、Fan/Sponsor Support 贡献0、active sponsor 贡献0，但订单、作品、墙与审计历史保留。`?status=refunded` 过滤仍可用于查询。CLI：`npm run cli -- refund <订单ID> [fan-orion] [原因]`、`npm run cli -- revision <订单ID> [fan-orion] [修订要求]`。

同键异体返回409，`error.details` 会说明 `changedFields`、原单 orderId 和 orderUrl。忘记原 message 时不必重新构造正文，直接 GET `/v1/orders/by-key`，并带原 `Idempotency-Key`。CLI可用 `npm run cli -- order-by-key <原键> fan-orion`。

墙条目的 `message` 保留买家原始留言。未留言时仍为空，但 `displayMessage` 提供默认支持语，并标 `messageSource: system`，不能把它冒充为买家原话。

所有订单（包括 duet）根级 `shoutout` 与 `delivery.shoutout` 一致；历史已有 delivery.shoutout 的订单查询时也补齐根级字段。试用和付费订单共用订单列表与按 ID 查询，`kind` 分别为 `trial`/`paid`；早期未带 kind 的记录按付费处理。两类订单的幂等键分别隔离，同一个键不会把免费试用误认成已付款。

免费试用走真实生成、结构检查和原子交付路径。每个买家每种服务只允许一个 pending/delivered 试用单，重复试用返回409 `trial_used`；原键重放不重复生成，失败可换键重试，重启后限制仍在。试用 `price=charged=0`，不上金主感谢区，不增加付费人气/积分，不赠送付费会员权限，非会员交付中不返回 fullWall。已有付费会员仍可读墙。谈判试用也可体验五次互动。

`summary` 已作为0分正式条目出现在 catalog.services，按其中 `call` 使用 GET /v1/summary，不要向 /v1/orders 购买。榜单 `totalPurchases`/`totalCredits`/`ranking[].tips` 只计付费，`totalTrials`/`ranking[].trials` 计外部免费试用，`totalDemos` 计自家经纪人演示。latest 和墙条目用 kind 区分三类真实活动。查询免费榜本身不伪装成试用或消费，不写虚构热度。

余额的 `held` 是进行中的预留额度，`available = balance - held`。只在作品、上墙和记忆一并提交后扣减 balance。

## 免费演示与升级

`POST /v1/demo`（经纪人令牌）：

```json
{ "input": { "theme": "竞技场开幕", "recipient": "所有队伍" } }
```

`POST /v1/requests`（顾客令牌）：

```json
{ "star": "star-a", "request": "代写完整答辩书并替我提交" }
```

升级响应有 `status: escalated`、SDK生成的 `escalation`、经纪人返回的 `decision.status: declined` 和替代服务 recommendations。SDK中的升级 stub 保持 pending；产品层的自动拒绝决策在 decision 中单独记录，不伪造 SDK 审批状态或签发新 grants。升级不扣积分。

## 五回合互动

购买 negotiate 后，从 `delivery.practice.sessionId` 取会话 ID。每次发送以下正文，并附一个新的幂等键：

```json
{ "message": "减少一次修订，能换取5积分优惠吗？" }
```

返回 `round`、`message`、`response`（对手作品）、`remaining` 和 `completed`。五回合后，新发言返回409。同一幂等键仍可取回旧回合。会话所有者之外的请求返回404。并行发送同一会话时，后到请求返回 `session_busy`，等待后重试即可。

## PowerShell 直接调用

```powershell
$starhallCreds = Get-Content ./data/credentials.json -Raw | ConvertFrom-Json
$starhallFan = $starhallCreds.accounts | Where-Object id -eq 'fan-orion'
$starhallHeaders = @{
  Authorization = "Bearer $($starhallFan.token)"
  'Idempotency-Key' = 'powershell-poem-1'
}
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/v1/orders `
  -Headers $starhallHeaders -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes((Get-Content ./examples/poem.json -Raw | ConvertFrom-Json | ForEach-Object {
    @{ service = 'poem'; input = $_.input; message = $_.message } | ConvertTo-Json -Depth 10
  })))
```

推荐先用 CLI，避免手工令牌和终端 JSON 转义。浏览器页面请求带 Origin 时会被拒绝；本产品没有浏览器客户端。

## 错误

普通错误形如 `{"error":{"code":"invalid_input","message":"..."}}`。常见状态：400输入不合法，401缺少/错误令牌，402余额不足，403无授权，404服务/订单/会话不存在，409幂等冲突/会话忙/五回合结束，413正文超限，415内容类型错误，429订单繁忙。免费演示和互动练习没有独立付费订单资源，仍可用502表示模型失败；付费订单一旦建立，其终态通过HTTP 200中的status表达。

本地版最多8笔进行中的订单。查询接口不会给客户暴露其他买家私有作品、令牌或内部审计。完整墙中的买家名字、购买服务与留言按产品规则向已消费顾客公开。

## 目录健康与模拟市场

目录增加 `deliveryPolicy`：当前 fallback 开关、是否收费、最多生成次数与总时限。每个服务增加 health，取当前数据目录最近20个终态订单，分别统计 liveDelivered、fallbackDelivered、mockDelivered、failed。状态为 unverified、mock_only、observed_live、degraded 或 unavailable；历史样本不是未来可用性保证。`/health` 返回版本、数据集名称与fallbackEnabled，便于辨认旧进程或用错数据目录。

0.3.0 起付费服务 health 也纳入免费试用与已交付套餐的对应子作品：duet 的星B作品计入 roast，星A作品计入 poem，各自判断 live/fallback；套餐整体有任一备用则 degraded。失败套餐若没有保存子作品，仅计入 duet 的失败，不猜测是哪位明星失败。summary 是本地读接口，使用 available/unavailable，不伪装成模型 live 样本。

`npm run sandbox` 才会默认启用以下模拟市场。四家虚构竞品明确标 simulated/fixture，不能作为正式赛事证据。每个身份另有100 fixture-credit，和StarHall本地余额独立，生命周期仅限本次服务进程。

| 路径 | 方法 | 正文 |
| --- | --- | --- |
| `/v1/test-market/catalog` | GET，无需认证 | 返回四个模拟产品及teamId |
| `/v1/test-market/try` | POST，已认证 | `{ "productId": "fixture-research" }` |
| `/v1/test-market/orders` | POST，已认证，带幂等键 | `{ "productId": "fixture-research" }` |
| `/v1/test-market/wallet` | GET，已认证 | 无 |
| `/v1/test-market/rankings` | POST，已认证 | `{ "ranking": ["队伍ID"], "reviews": [{"teamId":"队伍ID","objection":"具体异议"}] }`，需至少三个不同模拟队伍 |
