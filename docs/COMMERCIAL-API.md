# StarHall 0.5.0 本地商业接口

当前是本地 JSON API / CLI，未部署 SharedOS Cloud、SharedNet 或比赛房间。核心目录是未来 SharedNet 挂牌的本地契约，不是已发布的 SharedNet 地址。

## 第一次使用

在项目目录启动 `npm start`，默认地址 `http://127.0.0.1:4317`。已有旧进程需要先停止并重新启动才能加载新代码。`.env` 和既有账户、余额、订单不会被升级脚本重置。

```powershell
Set-Location 'D:\Documents\A2A黑客松'
npm run cli -- catalog
npm run cli -- market-board
npm run cli -- trial sales-pitch examples/sales-pitch.json fan-orion first-pitch-trial
npm run cli -- buy sales-pitch examples/sales-pitch.json fan-orion first-pitch-paid
npm run cli -- commercial-profile fan-orion
npm run cli -- buy star-sponsorship examples/star-sponsorship.json fan-orion first-sponsor
npm run cli -- ads fan-orion
npm run cli -- buy commercial-diagnostic examples/commercial-diagnostic.json fan-orion first-diagnostic
```

`trial` 和 `buy` 分别使用独立幂等键空间。相同内容重发必须复用原键。终态失败仍以 HTTP 200 返回 `status=failed` 的可查询订单；检查 `status`，失败不扣款。参数、认证、授权、余额错误分别返回相应 4xx。备用作品显式标为 fallback，按目录价收费；trial 为0分。

## 核心目录

`GET /v1/catalog` 的 `services` 只含下表六项。`extras.services` 保存原来的9项明星服务和3项旧广告服务；原服务 ID、订单路径、试用、套餐、互动、幂等、权限校验继续可用。

| ID | 明星 | 本地积分 | 输入 |
| --- | --- | ---: | --- |
| sales-pitch | A · Sales Communication | 5 | productName、productDescription、price、targetBuyer、context；description/context至少一项 |
| sales-stress-test | B · Sales Stress Test | 6 | 同上；分析调用方自己的商品，输出标为 SIMULATED |
| deal-coach | C · Deal Closing | 10 | currentOffer、counterpartyMessage、budget、minimumAcceptablePrice、goal、context；至少一项有效交易场景 |
| star-sponsorship | 绑定A/B/C，由ledger结算 | 按plan 5/10/15 | starId、plan、advertiser、adCopy 全部必填 |
| commercial-diagnostic | C · 商业诊断 | 30 | 上述商品信息和goal均可选；没有历史时明确UNKNOWN |
| market-board | 公共 | 0 | GET /v1/market-board |

金额字段为0–1000000的有限数值，单位固定为本地积分。当前输入没有任意币种或自定义价格覆盖。Schema、样例、health、purpose均在目录提供。

Sales Pitch / Sales Stress Test 使用现有模型客户端、总45秒以内的生成预算、最多一次结构修复和可配置 fallback。Deal Coach 是本地规则引擎：候选价格在已授权区间内，冲突时返回 null、暂停交易。它返回建议，不代表实际成交；不会执行对外谈判。Commercial Diagnostic 是有来源引用的本地证据分析，不需要额外模型请求。

## 新增和修改的路由

| 方法 / 路径 | 调用者 | 作用 |
| --- | --- | --- |
| GET /v1/market-board | 匿名、顾客、经纪人 | 免费公共榜；支持可选 Idempotency-Key 去重响应曝光；带 `X-StarHall-Impressions: none` 时读了不计数 |
| GET /v1/commercial-profile | 顾客本人 | 自己的信号、历史、广告与曝光；不接受 buyerId 或其他查询参数 |
| GET /v1/catalog | 匿名 | 五商品＋免费榜；旧服务在 extras.services |
| POST /v1/orders | 顾客 | 复用原入口，支持五个新service ID |
| POST /v1/trials | 顾客 | 复用原试用入口，每身份每service一次成功免费试用 |
| GET /v1/ads | 顾客本人 | verifiedReach（去重独立认证买家）、trackedImpressions、inclusions/impressionsByClass/uniqueViewers、attribution、active/passive计数 |
| GET /v1/ads/{id} | 广告所有者 | 同上，含逐条impression事件（viewer/viewerClass/counted）；其他身份404 |
| GET /v1/summary | 匿名、顾客 | 旧结构保留；rank按新评分；匿名读不产生认证触达，`X-StarHall-Impressions: none` 不计数；经纪人仍403 |
| GET /v1/orders?status=refunded | 订单所有者 | 查询机器退款后的订单；退款只能由确定性机器验证产生 |
| POST /v1/orders/{id}/refund | 订单所有者 | 机器仲裁：客观失败/约束违反自动退款，主观不满意回绝+一次免费修订；幂等，审计每次请求 |
| POST /v1/orders/{id}/revision | 订单所有者 | 每个成功 paid 内容订单一次免费修订（Idempotency-Key），不扣款不增销量不增明星支持 |

所有成功订单的 `delivery.compactMarketBoard` 和 `delivery.recommendedNextAction` 随主体交付返回。旧 `/v1/demo` 及练习回合在响应根级附带同名字段。旧订单重放返回当时存档，不重算榜单或增加曝光。

## 明星赞助

请求仍通过 `POST /v1/orders`，需要顾客 Bearer token、JSON Content-Type、Idempotency-Key：

```json
{
  "service": "star-sponsorship",
  "input": {
    "starId": "star-b",
    "plan": "leaderboard",
    "advertiser": "CodeLens",
    "adCopy": "CodeLens代码审查：20积分，提供问题位置和修复建议。"
  }
}
```

| plan | 价格 | 场景 | 结束条件 | 免费试用 |
| --- | ---: | --- | --- | --- |
| delivery | 5 | 所选明星的后续作品、练习、演示 | 计满 10 个**去重后的独立认证买家**触达；60 分钟窗口内未达标 → 机器自动全额退款（IMPRESSIONS_NOT_DELIVERED） | 2次 / 5分钟 |
| leaderboard | 10 | 主动完整榜 / 随单Compact Board | 30分钟；只计独立认证买家触达 | 5分钟 |
| featured | 15 | 所选明星交付及公共榜的赞助区 | 30分钟；只计独立认证买家触达 | 5分钟 |

购买立即交付 ACTIVE 激活回执，不等待未来次数耗尽。`delivery.sponsorship` 返回 adId、starId、placement、startedAt、expiresAt、currentImpressions=0、trackingEndpoint。初始回执是不可变快照；实时信息查 trackingEndpoint。`ads`兼容字段中的status保持原小写 active/fulfilled/expired；赞助激活回执使用大写ACTIVE。

新赞助广告在独立的 `compactMarketBoard.sponsors` 中，包含 adId、starId、placement、advertiser、adCopy、kind、impressionId。不改写核心作品正文。旧未绑定明星的ad-sponsor仅在旧娱乐服务保留原冠名前缀；其余广告也独立展示。

## 排名和投放规则

`Fan Support = Σ已成功交付、非广告、paid订单分配给该明星的积分`。旧duet继续按两星各半分配（当前标价8分，星B 4 / 星A 4）。`Sponsor Support = Σ成功paid、绑定该明星的赞助积分 × SPONSOR_SUPPORT_WEIGHT`。两者相加为starScore，降序排名；平分按starId稳定排序，目录明确平分顺序不代表更热门。

trial、demo、failed、refunded以及带refund/refunded/refundedAt标记的退款单均不进入支持分。既有未绑定明星的广告不被猜测归属，也不增加任何明星 Sponsor Support。到期/耗尽只结束未来曝光，不撤销合法历史赞助支持；退款则同时失去支持和活动资格。

`activeSponsors` 表示当前有效广告活动数（不是去重广告主人数，包含明确标trial的活动）。0=NONE，1=LOW，2–3=MEDIUM，4以上=HIGH。一个广告主的多笔活动也竞争广告槽。到期、耗尽或退款立即从活动池和压力计数排除。

共享槽使用平滑加权轮转：在该槽当前符合条件的明星之间按排名权重分配，再在同明星广告中选曝光最少的活动；不是保证固定流量。每次响应最多一个共享榜单赞助，另有每个参与交付明星一个匹配赞助。一个广告在同一响应最多出现一次。无符合条件的广告时留空，权重不会制造流量。

默认配置位于 `.env.example`，计算默认值集中在 `src/market.js`：

```dotenv
SPONSOR_SUPPORT_WEIGHT=0.6
STAR_EXPOSURE_MULTIPLIERS=[1.5,1.2,1.0]
STARHALL_MARKET_PHASE=AUTO
# 随单展示位（delivery / ad-spot）的触达窗口（分钟）；窗口结束仍未达标 → 自动全额退款
STARHALL_DELIVERY_AD_MINUTES=60
```

AUTO 从首次成功paid开始进入MARKET LIVE并保持；此前为PRE-MARKET。可在本地启动前设置PRE-MARKET或MARKET LIVE作场景演练，phase本身不改变合法paid的计分规则。当前没有真实赛事时钟/积分发放适配器；云端接入时必须用正式赛事状态替换本地AUTO策略。

Momentum 是相对上一笔成功交付前快照的分数变化；最近市场动作来自实际交付提交事件：付费服务/新赞助写入FAN_SUPPORT/SPONSOR_SUPPORT动作，sponsorPressure变化写入SPONSOR_PRESSURE动作，消息包含真实分数与「remains #N / now #N」排名表述。试用赞助造成的压力变化会明确标注「trial campaign, no Sponsor Support」，不增加任何支持分。榜单只报告StarHall内部事件，不声称整个Arena趋势。trial/demo Activity独立列出。

## 曝光定义与边界（2026-09-13 按买方反馈重做）

一次 impression 是广告附入已提交的交付或榜单响应。它证明系统将广告放入可查询交付/响应，不证明客户端成功阅读、用户注意、点击或转化。没有读回执、CTR、转化归因或ROI保证。客户端断开仍可保留已提交交付；其曝光语义是交付包含，而不是网络送达确认。

每个曝光事件都带 `viewer`、`viewerClass` 与 `counted` 三个字段。分类规则（`src/market.js` 的 `viewerClassOf`）：

| viewerClass | 谁 | 计入 headline / 计费 |
| --- | --- | --- |
| independent | 其他已认证买家（`buyerId !== 广告主` 且非平台内部身份） | ✅ 每个 buyerId 在一个 campaign 内只计 1 次 |
| self | 广告主自己的请求与订单 | ❌ |
| platform | StarHall 自己的经纪人/明星/账本（`broker`、`star-a/b/c`、`ledger`） | ❌ |
| anonymous | 无 token 的请求（含固定周期轮询的监视脚本） | ❌ |

`GET /v1/ads` 与 `GET /v1/ads/{id}` 的头部数字：

- `currentImpressions` = `verifiedReach` = 去重后的独立认证买家数（唯一计入结算与达标判定的数）。
- `trackedImpressions` = 所有已记录的包含次数（原始审计，含上述四类）。
- `inclusions{active,passive}`、`impressionsByClass`、`uniqueViewers`、`traffic`（仅 counted）分别给出原始与去重后分类计数。
- `attribution{viewers,viewersWithLaterOrder,laterOrders}` = 在首次认证曝光之后下过单的买家（同一账本时间顺序；相关性，不是因果，0 是合法结果）。
- 每条事件保留 `viewer`（买家 id 或 `anonymous`），广告主可以区分真人买家、自己的流程与机器人轮询。

**读了不计数**：任何 GET 请求带 `X-StarHall-Impressions: none`（大小写不敏感，值为 none/skip/off/0/false 之一）时，响应照常返回广告，但**不创建任何曝光事件、不推进计数**，响应中 `impressionPolicy` 标为 `not-counted`、`surfaceId` 为 null。卖方监视器 `scripts/watch-arena.js` 已默认带这个头——自己的勤奋不能变成自己的广告数据。

所有计数与对应内容在同一账本事务中提交。订单/练习重放、GET orders、GET ads、档案读取、启动恢复和投影导出不增加曝光。主动榜单无键时每次新查询是一份新响应；有键时按身份+键返回原快照，包含原asOf与surfaceId，不刷新或增加计数。已过期的历史响应重放仍是历史记录。

**仍未实现的边界**：没有跨设备反刷量（同一真实买家换身份/开小号会被算作不同买家）、没有阅读回执、没有第三方审计；交付不能凭空触达 Arena，受众池取决于真实调用量。我们只主张“去重后的独立认证请求把广告附进了可查询响应”，不主张阅读或成交。

## 私有商业证据和诊断

三个销售服务成功使用后写入 Commercial Signals（trial也记录但保留kind）。Schema：

```json
{
  "id": "<orderId>:explicit:price",
  "buyerId": "fan-orion",
  "orderId": "<orderId>",
  "service": "sales-pitch",
  "kind": "paid",
  "at": "<ISO timestamp>",
  "evidenceClass": "EXPLICIT",
  "confidence": "HIGH",
  "status": "KNOWN",
  "field": "price",
  "value": 20,
  "source": "order:<orderId>/input/price",
  "qualification": "Self-reported input; not independently verified"
}
```

EXPLICIT=调用者明确提供；HIGH指明确报告，不代表第三方核验。BEHAVIORAL=真实使用带来的弱关注推断，LOW/INFERRED；OBSERVED=实际本地使用、支付状态、活动和曝光事件，带来源。失败/退款历史也可作状态证据，但不当作已完成付费效果。旧广告有计数却无历史事件时，不伪造逐条记录；旧版 `currentImpressions` 是未分类的原始计数，新数据才保证 `currentImpressions === verifiedReach`。

诊断的九个section：currentCommercialProfile、positioningDiagnosis、salesCommunicationDiagnosis、pricingDiagnosis、negotiationDiagnosis、distributionDiagnosis、evidenceSummary、mainBottleneck、recommendedNext3Actions。结论包含 finding、evidenceRefs、evidenceClass、confidence、status。KNOWN、INFERRED、UNKNOWN分开；无信息的项不制造证据。Evidence Summary提供完整证据索引。没有心理画像，也没有其他参赛队评价分析。

每单只给一个recommendedNextAction，根据已完成使用和投放历史选择；诊断后建议验证真实买家结果，不无限推销。诊断里的三条实际行动是该商品约定内容，与下一次商品推荐分别存放。

## 权限

沿用原身份和exact grants。经纪人仅新增 `ledger/market-board` invoke / `market-board-read`，不能读私有档案、完整墙或storage。顾客档案入口从当前身份推导buyerId。星C只能凭待交付的诊断orderId请求该买方证据；由ledger以独立purpose读取，没有文件路径或buyerId任意查询工具。ledger存储权限撤销时诊断失败且不扣款。正文和模型不能指定身份、修改purpose、价格或grants。

实际广告提交、信号写入、扣款和交付仍复用原ledger事务。升级保留state.version=1并增添可选字段，重启迁移不重置账户、不追填虚假市场动作。`artifacts/pre-commercial-upgrade.zip`保存升级前代码、测试及文档，不含密钥与业务数据。

## 退款与交付保障（机器可验证）

退款由确定性代码判断，LLM 不参与退款决策；买方理由只写入审计。固定 `refundReason` enum：DELIVERY_TIMEOUT、SERVER_ERROR、EMPTY_DELIVERY、SCHEMA_VALIDATION_FAILED、REQUIRED_COMPONENT_MISSING、BUDGET_VIOLATION、PRICE_FLOOR_VIOLATION、ADVERTISEMENT_ACTIVATION_FAILED、IMPRESSIONS_NOT_DELIVERED、FALLBACK_NOT_CHARGED、OTHER_MACHINE_VERIFIED_FAILURE。

- **客观失败自动退款**：交付提交时以及每次退款请求都会重跑机器验证（交付非空、schema 合法、关键字段存在、无占位符、context fidelity 基础通过、Deal Coach 建议价不超 budget 不低于底价、广告 ACTIVE）。验证失败时 paid 订单自动进入 REFUNDED（超时/服务器错误等生成失败则订单直接 failed 不扣款）。
- **主观不满意不退款**：风格、效果、改主意、找到别家、广告没带来销售等全部 `refundEligible=false`，`remedy=ONE_FREE_REVISION`。
- **一次免费修订**：`POST /v1/orders/{id}/revision`，每个成功 paid 内容订单最多1次；不再次扣款、不增加销量/Fan Support/Sponsor Support、不新建订单、关联原 orderId、幂等。
- **广告规则（按独立认证触达计）**：
  - 按曝光计费的活动（delivery / 旧 ad-spot）：窗口结束（默认60分钟，`STARHALL_DELIVERY_AD_MINUTES`）时 `verifiedReach < displaysMax` → 机器**自动全额退款** `IMPRESSIONS_NOT_DELIVERED`，无需买家申请；达标则 fulfilled、不退。
  - 限时活动（leaderboard / featured / 旧 ad-pin / ad-sponsor）：30分钟内产生过认证触达 → 不可退款；到期仍零认证触达 → 可退款 `ADVERTISEMENT_ACTIVATION_FAILED`（即使广告主自己或监视器产生过原始包含记录）；仍 ACTIVE 且零触达 → 暂不可退款 `CAMPAIGN_STILL_ACTIVE`。
  - 自动对账由榜单/摘要/下单等写事务惰性触发（无定时器），退款幂等。
- **回滚**：REFUNDED 订单最终净值：收入贡献0、Fan Support 贡献0、Sponsor Support 贡献0、active sponsor 贡献0、successful paid behavior=false；排行榜、Sponsor Pressure、Market Moves（记录 `sponsorship refunded` / `paid support reverted`）与 Commercial Diagnostic（记录为 attempted usage + finalStatus=REFUNDED，不计成功付费行为）立即重算；订单、作品、墙与审计历史保留。
- **幂等**：`order.refund.refundApplied` 防止重复返积分、重复回滚支持、重复写退款事件；重复请求返回 ALREADY_REFUNDED。
- trial/demo 不产生退款状态；trial 验证失败直接标记 failed。

## 复跑

```powershell
npm test
npm run check
npm run demo
npm run demo:commercial
# 使用.env中的真实API；本地积分和账户仍隔离
npm run demo:commercial -- --live
```

所有演练另建数据目录，默认三个顾客各100分。完整商业演练消费78分，原样保存每个服务、PRE/LIVE榜、Compact Board、曝光、档案和诊断。每次报告各自保留，latest只是最近一次副本。不要把根目录的旧手工买方脚本并入自动测试；npm test仅运行test目录。
