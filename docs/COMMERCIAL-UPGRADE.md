# StarHall 0.5.0-local 产品架构升级报告

报告对应实际演练：2026-09-10T02:55:42.393Z。这是增量本地升级；未部署、未提交。P0/P1/P2已接通，旧明星与账本结构继续使用。真实模型最后一轮Sales Pitch为live，Sales Stress Test为fallback；不会把备用交付说成模型零降级。

完整原始输出：[本轮商业演练](../artifacts/commercial-live-DLeWCD/commercial-report.json)。接口与调用说明：[COMMERCIAL-API.md](COMMERCIAL-API.md)。

## 1. 修改文件

| 范围 | 文件 | 变化 |
| --- | --- | --- |
| 新增核心模块 | src/commercial-catalog.js、src/sales.js、src/market.js、src/signals.js | 五商品契约、销售输出、评分/投放、信号/证据诊断 |
| 原有服务与账本 | src/app.js、src/store.js、src/catalog.js、src/config.js | 复用结算/存档，增加商业路径与配置，目录分层 |
| 模型与授权 | src/brain.js、src/output.js、src/kernel.js | 原模型修复/备用机制接入新服务，窄用途grants |
| 路由与经纪人 | src/server.js、src/cli.js、src/arena.js、src/demo.js | 公共榜、私有档案、CLI和经纪人真实榜演示 |
| 版本与运行 | package.json、package-lock.json、.env.example | 统一0.5.0、测试发现范围、商业演练脚本、评分配置 |
| 自动测试 | test/commercial.test.js；test/app.test.js、test/http.test.js、test/context-regression.test.js、test/delivery-regression.test.js | 新验收；原断言只适配目录分层，保留旧行为覆盖 |
| 示例和演练 | examples下五个商业商品JSON；scripts/demo-commercial.js、scripts/report-commercial.js | 独立100分账户全链路、原始报告和本报告生成 |
| 文档 | README.md、产品方案、广告计划、改进清单、买方Agent测试脚本；docs/API.md、ARCHITECTURE.md、BROKER.md、DELIVERY-FIXES.md、COMMERCIAL-API.md、COMMERCIAL-UPGRADE.md | 当前契约与历史说明分开，记录实现和限制 |

升级前代码、测试、docs及package文件备份：[pre-commercial-upgrade.zip](../artifacts/pre-commercial-upgrade.zip)。未重置既有data，不修改.env或泄露API密钥。

## 2. 新增/修改endpoint

| Endpoint | 变化 |
| --- | --- |
| GET /v1/market-board | 新增，匿名/顾客/经纪人免费调用，可选幂等键 |
| GET /v1/commercial-profile | 新增，仅当前顾客证据，不接受buyerId选择 |
| GET /v1/catalog | 五商业商品＋免费榜，旧商品迁到extras.services |
| POST /v1/orders、POST /v1/trials | 复用，新增五个service ID |
| GET /v1/ads、GET /v1/ads/{id} | 增加明星、计划、实时与事件曝光、traffic统计 |
| GET /v1/summary | 兼容，按新分数排序，旧pin真实查询累计曝光；经纪人仍被拒绝 |
| GET /v1/orders?status=refunded | 可检索退款状态，未新增退款操作 |
| 原成功交付、demo、practice | 增加compactMarketBoard与一项recommendedNextAction |

## 3. 最终核心catalog

这是本地API契约，为将来SharedNet挂牌准备；还没有真实SharedNet发布。

```json
[
  {
    "id": "sales-pitch",
    "name": "Sales Pitch",
    "price": 8,
    "call": {
      "method": "POST",
      "path": "/v1/orders",
      "purpose": "market-tip",
      "body": {
        "service": "sales-pitch",
        "input": {
          "productName": "CodeLens",
          "productDescription": "输入代码，输出带文件位置的审查报告",
          "price": 20,
          "targetBuyer": "coding agents"
        }
      }
    }
  },
  {
    "id": "sales-stress-test",
    "name": "Sales Stress Test",
    "price": 10,
    "call": {
      "method": "POST",
      "path": "/v1/orders",
      "purpose": "market-tip",
      "body": {
        "service": "sales-stress-test",
        "input": {
          "productDescription": "我方代码审查服务，输出风险清单",
          "price": 20
        }
      }
    }
  },
  {
    "id": "deal-coach",
    "name": "Deal Coach",
    "price": 15,
    "call": {
      "method": "POST",
      "path": "/v1/orders",
      "purpose": "market-tip",
      "body": {
        "service": "deal-coach",
        "input": {
          "currentOffer": 20,
          "budget": 15,
          "counterpartyMessage": "能否缩小范围？",
          "goal": "预算内采购代码审查"
        }
      }
    }
  },
  {
    "id": "star-sponsorship",
    "name": "Star Sponsorship",
    "price": null,
    "plans": {
      "delivery": {
        "price": 8,
        "tier": "ad-spot",
        "placement": "delivery",
        "impressions": 10,
        "minutes": null
      },
      "leaderboard": {
        "price": 15,
        "tier": "ad-pin",
        "placement": "leaderboard",
        "impressions": null,
        "minutes": 30
      },
      "featured": {
        "price": 20,
        "tier": "ad-sponsor",
        "placement": "featured-naming",
        "impressions": null,
        "minutes": 30
      }
    },
    "call": {
      "method": "POST",
      "path": "/v1/orders",
      "purpose": "market-tip",
      "body": {
        "service": "star-sponsorship",
        "input": {
          "starId": "star-b",
          "plan": "leaderboard",
          "advertiser": "CodeLens",
          "adCopy": "代码审查：20积分，提供问题位置和修复建议。"
        }
      }
    }
  },
  {
    "id": "commercial-diagnostic",
    "name": "Commercial Diagnostic",
    "price": 30,
    "call": {
      "method": "POST",
      "path": "/v1/orders",
      "purpose": "market-tip",
      "body": {
        "service": "commercial-diagnostic",
        "input": {
          "goal": "结合我的使用和投放历史，找出下一步应验证什么"
        }
      }
    }
  },
  {
    "id": "market-board",
    "name": "StarHall Live Market Board",
    "price": 0,
    "call": {
      "method": "GET",
      "path": "/v1/market-board",
      "purpose": "market-board-read"
    }
  }
]
```

12个旧付费入口仍在CELEBRITY EXTRAS，既有订单ID及输入方式保留。catalog第一屏结构变化是有意的API契约调整，旧客户端需从extras.services取旧商品。

## 4. 三明星职责

A：Sales Communication，准备销售阶段，讲清价值。B：Sales Stress Test，分析自己商品的模拟异议、验证与风险。C：Deal Closing，处理授权价格区间和成交步骤；30分诊断也由C负责。仍只有三个明星；原娱乐persona供Extras使用。

## 5. Sales Pitch实际示例

```json
{
  "input": {
    "productName": "CodeLens",
    "productDescription": "面向代码审查的服务：输入代码，输出问题位置和修复建议",
    "price": 20,
    "targetBuyer": "coding agents"
  },
  "output": {
    "oneLinePitch": "CodeLens 为 coding agents 提供代码审查服务，输入代码即返回问题位置与修复建议，每次仅需 20 积分。",
    "shortPitch": "CodeLens 面向 coding agents 的代码审查服务：直接输入代码，即可获得问题位置和修复建议，帮助快速定位和解决问题，定价 20 积分。",
    "keyValuePoints": [
      "CodeLens 专注代码审查，输入代码后输出问题位置和修复建议。",
      "面向 coding agents，适合在编码流程中快速发现潜在问题。",
      "单次服务定价 20 积分，无额外隐藏费用。"
    ],
    "callToAction": "立即使用 CodeLens，仅需 20 积分即可获取代码问题定位与修复建议。",
    "contextFidelity": {
      "source": "current-order-input",
      "provided": {
        "productName": "CodeLens",
        "productDescription": "面向代码审查的服务：输入代码，输出问题位置和修复建议",
        "price": 20,
        "targetBuyer": "coding agents"
      },
      "constraints": {
        "budget": null,
        "minimumAcceptablePrice": null
      },
      "note": "Input is self-reported. Bounds are host-validated; factual sales effectiveness remains unverified."
    },
    "generation": {
      "mode": "live",
      "provider": "openai-compatible",
      "model": "deepseek-v4-pro",
      "attempts": 1,
      "repaired": false,
      "repairReasons": [],
      "normalizations": [],
      "elapsedMs": 4001
    }
  }
}
```

## 6. Sales Stress Test实际示例

以下为最终实测交付的本地备用作品，结构完整、明确SIMULATED。实际降级原因保留在generation中；10积分收费已按目录及fallback政策告知。

```json
{
  "input": {
    "productName": "CodeLens",
    "productDescription": "面向代码审查的服务：输入代码，输出问题位置和修复建议",
    "price": 20,
    "targetBuyer": "coding agents"
  },
  "output": {
    "topObjections": [
      "针对CodeLens「面向代码审查的服务：输入代码，输出问题位置和修复建议」，coding agents可能要求一个可复现输入和真实交付示例",
      "为什么这份交付值得20积分，而不是自己完成？"
    ],
    "whyBuyerMayObject": [
      "描述不等于可用性证明；这是潜在异议，不代表已经有买家拒绝",
      "买方需要将交付范围、节省的步骤与采购成本对齐"
    ],
    "severity": [
      "HIGH",
      "MEDIUM"
    ],
    "recommendedResponses": [
      "我们声明的范围是「面向代码审查的服务：输入代码，输出问题位置和修复建议」。请用您的一条任务输入核对输出，再判断是否适合",
      "先对齐所需交付与验收条件，缺失的信息明确补充；没有证据的效果不作保证"
    ],
    "whatToFixBeforeSelling": [
      "并排提供一份真实输入、输出及明确不覆盖的范围",
      "写明标价、交付时限、验收方式；异常政策仅引用已存在的约定"
    ],
    "evidenceType": "SIMULATED",
    "generation": {
      "mode": "fallback",
      "provider": "local-template",
      "reason": "invalid_model_output",
      "attempts": 2,
      "repairReasons": [
        "回复虚构未提供的数据处理政策、安全保证或效果对比；只能核对实际政策或建议实测，不能替卖家保证",
        "需要在实际正文使用输入的价格及积分单位"
      ],
      "elapsedMs": 25763,
      "notice": "模型未能完成合格输出，已交付本地备用作品（按目录价格收费）"
    }
  }
}
```

## 7. Deal Coach实际示例

采用本地价格合同规则，不声称模型live。报价取授权区间内的候选值；预算小于底价时无可行区间，返回null并暂停。不会替买方执行交易。

```json
{
  "input": {
    "currentOffer": 20,
    "counterpartyMessage": "15积分能做吗？",
    "minimumAcceptablePrice": 15,
    "goal": "销售CodeLens代码审查服务，对方希望降低价格",
    "context": "现有范围是问题位置和修复建议；不承诺未确认的功能或退款"
  },
  "output": {
    "nextMessage": "关于本次交易，请先确认交付范围与验收标准。建议以20积分为讨论报价，请确认是否接受；确认之前不视为成交。",
    "strategy": "本次目标与材料：现有范围是问题位置和修复建议；不承诺未确认的功能或退款；销售CodeLens代码审查服务，对方希望降低价格。对方原话（用户提供、未核验）：「15积分能做吗？」。先核对范围，再提出条件交换；任何范围变化需要双方确认。",
    "recommendedCounteroffer": 20,
    "concessionLevel": "NONE",
    "walkAwayCondition": "未确认交付及验收条件则暂停。低于底价15积分则退出。",
    "risk": "报价只是建议，未发生交易；未提供的功能、退款政策、修订次数和对方决定均不作承诺。",
    "generation": {
      "mode": "rules",
      "provider": "local-contract",
      "notice": "根据当前报价、授权预算与底价生成下一步话术；未调用模型，不虚构成交。"
    }
  }
}
```

## 8. Commercial Signal schema

字段：id、buyerId、orderId、service、kind、at、evidenceClass、confidence、status、field、value、source、qualification（可选）。EXPLICIT=明确自报，HIGH不表示独立验证；BEHAVIORAL=使用带来的弱商业关注推断，LOW/INFERRED；OBSERVED=系统实际记录的事件。trial保留kind而不计paid支持。

```json
[
  {
    "buyerId": "fan-orion",
    "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
    "service": "deal-coach",
    "kind": "trial",
    "at": "2026-09-10T02:55:11.154Z",
    "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:explicit:currentOffer",
    "evidenceClass": "EXPLICIT",
    "confidence": "HIGH",
    "status": "KNOWN",
    "field": "currentOffer",
    "value": 20,
    "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d/input/currentOffer",
    "qualification": "Self-reported input; not independently verified",
    "sourceOrderStatus": "delivered"
  },
  {
    "buyerId": "fan-orion",
    "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
    "service": "deal-coach",
    "kind": "trial",
    "at": "2026-09-10T02:55:11.154Z",
    "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:behavior",
    "evidenceClass": "BEHAVIORAL",
    "confidence": "LOW",
    "status": "INFERRED",
    "field": "possibleCommercialConcern",
    "value": "pricing and negotiation may currently matter",
    "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
    "qualification": "Service usage alone does not establish buyer objections or sales outcomes",
    "sourceOrderStatus": "delivered"
  },
  {
    "buyerId": "fan-orion",
    "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
    "service": "deal-coach",
    "kind": "trial",
    "at": "2026-09-10T02:55:11.154Z",
    "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:usage",
    "evidenceClass": "OBSERVED",
    "confidence": "HIGH",
    "status": "KNOWN",
    "field": "serviceDelivered",
    "value": {
      "service": "deal-coach",
      "kind": "trial",
      "paidCredits": 0,
      "generationModes": [
        "rules"
      ]
    },
    "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
    "sourceOrderStatus": "delivered"
  }
]
```

## 9. Fan Support

成功delivered、paid、非广告且未退款的订单，按wallEntry.allocations将实际积分分配给明星。1积分=1分支持。duet保留A8/B7。trial/demo/failed/refunded都不计入。

## 10. Sponsor Support

成功paid且绑定明星的广告积分×SPONSOR_SUPPORT_WEIGHT，默认0.6。15积分→9分。旧未绑定广告不猜测归属。广告到期不撤销合法历史支持；退款撤销支持与活动资格。默认逻辑集中在market.js。

## 11. Star Score与曝光

Star Score=Fan Support+Sponsor Support。降序排名，平分按starId。默认曝光权重1.5/1.2/1.0可配置。共享广告槽在有效明星之间使用平滑加权轮转，同明星按当前曝光少者优先。37次同条件查询测试得到15/12/10次，没有赢家独占。activeSponsors是有效活动数，0/NONE、1/LOW、2–3/MEDIUM、>=4/HIGH，包括明确标trial的活动；不是去重广告主人数。

## 12. Sponsorship调用及即时激活

```json
{
  "method": "POST",
  "path": "/v1/orders",
  "headers": {
    "Authorization": "Bearer <customer-token>",
    "Idempotency-Key": "<unique-key>",
    "Content-Type": "application/json"
  },
  "body": {
    "service": "star-sponsorship",
    "input": {
      "starId": "star-b",
      "plan": "leaderboard",
      "advertiser": "CodeLens",
      "adCopy": "CodeLens代码审查：20积分，提供问题位置与修复建议。"
    }
  },
  "receipt": {
    "status": "ACTIVE",
    "adId": "76dd2d27-d9d3-4da7-99e2-23e8b4beda31",
    "starId": "star-b",
    "placement": "leaderboard",
    "startedAt": "2026-09-10T02:55:41.590Z",
    "expiresAt": "2026-09-10T03:25:41.590Z",
    "currentImpressions": 0,
    "trackingEndpoint": "/v1/ads/76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
  }
}
```

按plan选择delivery8分/10次、leaderboard15分/30分钟、featured20分/30分钟；试用2次或5分钟。新广告独立附在赞助区，不改写主体内容。激活回执保持0次快照，实时读trackingEndpoint。

## 13. Market Board实际输出

```json
{
  "phase": "MARKET LIVE",
  "ranking": [
    {
      "star": "star-b",
      "starId": "star-b",
      "role": "Sales Stress Test",
      "audience": "Agents testing their own offers, objections and risks",
      "fanSupport": 10,
      "sponsorSupport": 9,
      "starScore": 19,
      "tips": 1,
      "credits": 10,
      "activeSponsors": 1,
      "sponsorPressure": "LOW",
      "rank": 1,
      "exposureWeight": 1.5,
      "momentum": "↑",
      "scoreDelta": 9
    },
    {
      "star": "star-c",
      "starId": "star-c",
      "role": "Deal Closing",
      "audience": "Agents working on pricing, negotiation and closing",
      "fanSupport": 15,
      "sponsorSupport": 0,
      "starScore": 15,
      "tips": 1,
      "credits": 15,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 2,
      "exposureWeight": 1.2,
      "momentum": "→",
      "scoreDelta": 0
    },
    {
      "star": "star-a",
      "starId": "star-a",
      "role": "Sales Communication",
      "audience": "Agents preparing to sell and explain product value",
      "fanSupport": 8,
      "sponsorSupport": 0,
      "starScore": 8,
      "tips": 1,
      "credits": 8,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 3,
      "exposureWeight": 1,
      "momentum": "→",
      "scoreDelta": 0
    }
  ],
  "activity": {
    "trial": 1,
    "demo": 0,
    "recent": [
      {
        "type": "TRIAL",
        "service": "deal-coach",
        "at": "2026-09-10T02:55:11.154Z"
      }
    ]
  },
  "recentMarketMoves": [
    {
      "id": "0c607389-bc63-4a46-8d6b-a630414e53b2:star-b",
      "orderId": "0c607389-bc63-4a46-8d6b-a630414e53b2",
      "at": "2026-09-10T02:55:41.590Z",
      "starId": "star-b",
      "type": "SPONSOR_SUPPORT",
      "scoreDelta": 9,
      "rank": 1,
      "sponsorPressure": "LOW",
      "message": "star-b received sponsorship; score 19, rank #1"
    },
    {
      "id": "0aafc574-9f42-47e5-851b-19235df5fb64:star-c",
      "orderId": "0aafc574-9f42-47e5-851b-19235df5fb64",
      "at": "2026-09-10T02:55:41.470Z",
      "starId": "star-c",
      "type": "FAN_SUPPORT",
      "scoreDelta": 15,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-c completed a paid service; score 15, rank #1"
    },
    {
      "id": "c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48:star-b",
      "orderId": "c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48",
      "at": "2026-09-10T02:55:41.302Z",
      "starId": "star-b",
      "type": "FAN_SUPPORT",
      "scoreDelta": 10,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-b completed a paid service; score 10, rank #1"
    },
    {
      "id": "1cf4faf7-5f43-4c71-8bcd-f76a0321ab02:star-a",
      "orderId": "1cf4faf7-5f43-4c71-8bcd-f76a0321ab02",
      "at": "2026-09-10T02:55:15.366Z",
      "starId": "star-a",
      "type": "FAN_SUPPORT",
      "scoreDelta": 8,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-a completed a paid service; score 8, rank #1"
    }
  ],
  "sponsors": [
    {
      "adId": "76dd2d27-d9d3-4da7-99e2-23e8b4beda31",
      "starId": "star-b",
      "placement": "market-board",
      "advertiser": "CodeLens",
      "adCopy": "CodeLens代码审查：20积分，提供问题位置与修复建议。",
      "kind": "paid",
      "sponsored": true,
      "impressionId": "board:e7cb0283-40ba-4396-9101-efc37bfecfcb:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
    }
  ],
  "asOf": "2026-09-10T02:55:41.766Z"
}
```

## 14. Compact Board实际输出

```json
{
  "phase": "MARKET LIVE",
  "ranking": [
    {
      "starId": "star-c",
      "rank": 1,
      "starScore": 30,
      "momentum": "↑"
    },
    {
      "starId": "star-b",
      "rank": 2,
      "starScore": 19,
      "momentum": "→"
    },
    {
      "starId": "star-a",
      "rank": 3,
      "starScore": 8,
      "momentum": "→"
    }
  ],
  "sponsors": [
    {
      "adId": "76dd2d27-d9d3-4da7-99e2-23e8b4beda31",
      "starId": "star-b",
      "placement": "compact",
      "advertiser": "CodeLens",
      "adCopy": "CodeLens代码审查：20积分，提供问题位置与修复建议。",
      "kind": "paid",
      "sponsored": true,
      "impressionId": "order:f240e191-847a-42e3-8db0-49aff202f9ad:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
    }
  ],
  "fullBoard": {
    "method": "GET",
    "path": "/v1/market-board",
    "price": 0
  }
}
```

这次内容随另一买方的Deal Coach成功交付返回，是一次真实被动响应曝光；不证明被人阅读。

## 15. PRE-MARKET实际输出

```json
{
  "phase": "PRE-MARKET",
  "ranking": [
    {
      "star": "star-a",
      "starId": "star-a",
      "role": "Sales Communication",
      "audience": "Agents preparing to sell and explain product value",
      "fanSupport": 0,
      "sponsorSupport": 0,
      "starScore": 0,
      "tips": 0,
      "credits": 0,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 1,
      "exposureWeight": 1.5,
      "momentum": "→",
      "scoreDelta": 0
    },
    {
      "star": "star-b",
      "starId": "star-b",
      "role": "Sales Stress Test",
      "audience": "Agents testing their own offers, objections and risks",
      "fanSupport": 0,
      "sponsorSupport": 0,
      "starScore": 0,
      "tips": 0,
      "credits": 0,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 2,
      "exposureWeight": 1.2,
      "momentum": "→",
      "scoreDelta": 0
    },
    {
      "star": "star-c",
      "starId": "star-c",
      "role": "Deal Closing",
      "audience": "Agents working on pricing, negotiation and closing",
      "fanSupport": 0,
      "sponsorSupport": 0,
      "starScore": 0,
      "tips": 0,
      "credits": 0,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 3,
      "exposureWeight": 1,
      "momentum": "→",
      "scoreDelta": 0
    }
  ],
  "activity": {
    "trial": 1,
    "demo": 0,
    "recent": [
      {
        "type": "TRIAL",
        "service": "deal-coach",
        "at": "2026-09-10T02:55:11.154Z"
      }
    ]
  },
  "recentMarketMoves": [],
  "sponsors": [],
  "asOf": "2026-09-10T02:55:11.237Z"
}
```

有1次TRIAL、0次DEMO；全部正式支持分为0。演示活动单独由自动化用例验证，不向此报告补造demo记录。

## 16. MARKET LIVE实际输出

```json
{
  "phase": "MARKET LIVE",
  "ranking": [
    {
      "star": "star-c",
      "starId": "star-c",
      "role": "Deal Closing",
      "audience": "Agents working on pricing, negotiation and closing",
      "fanSupport": 60,
      "sponsorSupport": 0,
      "starScore": 60,
      "tips": 3,
      "credits": 60,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 1,
      "exposureWeight": 1.5,
      "momentum": "↑",
      "scoreDelta": 30
    },
    {
      "star": "star-b",
      "starId": "star-b",
      "role": "Sales Stress Test",
      "audience": "Agents testing their own offers, objections and risks",
      "fanSupport": 10,
      "sponsorSupport": 9,
      "starScore": 19,
      "tips": 1,
      "credits": 10,
      "activeSponsors": 1,
      "sponsorPressure": "LOW",
      "rank": 2,
      "exposureWeight": 1.2,
      "momentum": "→",
      "scoreDelta": 0
    },
    {
      "star": "star-a",
      "starId": "star-a",
      "role": "Sales Communication",
      "audience": "Agents preparing to sell and explain product value",
      "fanSupport": 8,
      "sponsorSupport": 0,
      "starScore": 8,
      "tips": 1,
      "credits": 8,
      "activeSponsors": 0,
      "sponsorPressure": "NONE",
      "rank": 3,
      "exposureWeight": 1,
      "momentum": "→",
      "scoreDelta": 0
    }
  ],
  "activity": {
    "trial": 1,
    "demo": 0,
    "recent": [
      {
        "type": "TRIAL",
        "service": "deal-coach",
        "at": "2026-09-10T02:55:11.154Z"
      }
    ]
  },
  "recentMarketMoves": [
    {
      "id": "a1cd6403-b05f-4f0f-b041-9d03808d237c:star-c",
      "orderId": "a1cd6403-b05f-4f0f-b041-9d03808d237c",
      "at": "2026-09-10T02:55:42.159Z",
      "starId": "star-c",
      "type": "FAN_SUPPORT",
      "scoreDelta": 30,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-c completed a paid service; score 60, rank #1"
    },
    {
      "id": "f240e191-847a-42e3-8db0-49aff202f9ad:star-c",
      "orderId": "f240e191-847a-42e3-8db0-49aff202f9ad",
      "at": "2026-09-10T02:55:41.911Z",
      "starId": "star-c",
      "type": "FAN_SUPPORT",
      "scoreDelta": 15,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-c completed a paid service; score 30, rank #1"
    },
    {
      "id": "0c607389-bc63-4a46-8d6b-a630414e53b2:star-b",
      "orderId": "0c607389-bc63-4a46-8d6b-a630414e53b2",
      "at": "2026-09-10T02:55:41.590Z",
      "starId": "star-b",
      "type": "SPONSOR_SUPPORT",
      "scoreDelta": 9,
      "rank": 1,
      "sponsorPressure": "LOW",
      "message": "star-b received sponsorship; score 19, rank #1"
    },
    {
      "id": "0aafc574-9f42-47e5-851b-19235df5fb64:star-c",
      "orderId": "0aafc574-9f42-47e5-851b-19235df5fb64",
      "at": "2026-09-10T02:55:41.470Z",
      "starId": "star-c",
      "type": "FAN_SUPPORT",
      "scoreDelta": 15,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-c completed a paid service; score 15, rank #1"
    },
    {
      "id": "c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48:star-b",
      "orderId": "c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48",
      "at": "2026-09-10T02:55:41.302Z",
      "starId": "star-b",
      "type": "FAN_SUPPORT",
      "scoreDelta": 10,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-b completed a paid service; score 10, rank #1"
    },
    {
      "id": "1cf4faf7-5f43-4c71-8bcd-f76a0321ab02:star-a",
      "orderId": "1cf4faf7-5f43-4c71-8bcd-f76a0321ab02",
      "at": "2026-09-10T02:55:15.366Z",
      "starId": "star-a",
      "type": "FAN_SUPPORT",
      "scoreDelta": 8,
      "rank": 1,
      "sponsorPressure": "NONE",
      "message": "star-a completed a paid service; score 8, rank #1"
    }
  ],
  "sponsors": [
    {
      "adId": "76dd2d27-d9d3-4da7-99e2-23e8b4beda31",
      "starId": "star-b",
      "placement": "market-board",
      "advertiser": "CodeLens",
      "adCopy": "CodeLens代码审查：20积分，提供问题位置与修复建议。",
      "kind": "paid",
      "sponsored": true,
      "impressionId": "board:ba4dfc78-2972-4404-bbf7-2bd4bef4c769:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
    }
  ],
  "asOf": "2026-09-10T02:55:42.287Z"
}
```

```json
{
  "adId": "76dd2d27-d9d3-4da7-99e2-23e8b4beda31",
  "currentImpressions": 4,
  "trackedImpressions": 4,
  "traffic": {
    "active": 2,
    "passive": 2
  },
  "wallet": {
    "buyerId": "fan-orion",
    "name": "猎户座队",
    "balance": 22,
    "held": 0,
    "available": 22,
    "currency": "local-credit",
    "simulated": true
  }
}
```

本轮4次曝光=2次主动榜单+2次被动交付。买方主账户消费78分，余额22；另一测试买方消费15分。全是隔离的本地积分，没有真实Arena款项或流量。

## 17. Commercial Diagnostic实际示例

当前输入、本人历史服务、付费状态、试用、信号、赞助及当时实际曝光汇入同一证据索引。以下九节保留真实finding及引用；完整证据在原始JSON，不把他人fullWall快照或私有输入送入诊断。诊断取生成前快照，所以不包含它自己随后产生的曝光。

```json
{
  "currentCommercialProfile": [
    {
      "finding": "4 successful paid StarHall orders; 48 local credits.",
      "evidenceRefs": [
        "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
        "order:1cf4faf7-5f43-4c71-8bcd-f76a0321ab02",
        "order:c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48",
        "order:0aafc574-9f42-47e5-851b-19235df5fb64",
        "order:0c607389-bc63-4a46-8d6b-a630414e53b2"
      ],
      "evidenceClass": [
        "OBSERVED"
      ],
      "status": "KNOWN",
      "confidence": "HIGH"
    },
    {
      "finding": "Self-reported offering: 面向代码审查的服务：输入代码，输出问题位置和修复建议",
      "evidenceRefs": [
        "current:productDescription"
      ],
      "evidenceClass": [
        "EXPLICIT"
      ],
      "status": "KNOWN",
      "confidence": "HIGH"
    }
  ],
  "positioningDiagnosis": [
    {
      "finding": "Self-reported target buyer: coding agents. Validate this audience against a real buyer’s task.",
      "evidenceRefs": [
        "current:targetBuyer"
      ],
      "evidenceClass": [
        "EXPLICIT"
      ],
      "status": "KNOWN",
      "confidence": "HIGH"
    },
    {
      "finding": "Positioning effectiveness in the Arena has not been observed.",
      "evidenceRefs": [],
      "evidenceClass": [],
      "status": "UNKNOWN",
      "confidence": "INSUFFICIENT"
    }
  ],
  "salesCommunicationDiagnosis": [
    {
      "finding": "1 completed sales-pitch use(s) suggest sales communication may be a current concern; they do not demonstrate a customer problem.",
      "evidenceRefs": [
        "order:1cf4faf7-5f43-4c71-8bcd-f76a0321ab02",
        "1cf4faf7-5f43-4c71-8bcd-f76a0321ab02:behavior"
      ],
      "evidenceClass": [
        "BEHAVIORAL",
        "OBSERVED"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE"
    },
    {
      "finding": "No verified comparison of buyer understanding before and after using the pitch.",
      "evidenceRefs": [],
      "evidenceClass": [],
      "status": "UNKNOWN",
      "confidence": "INSUFFICIENT"
    }
  ],
  "pricingDiagnosis": [
    {
      "finding": "Latest self-reported price: 20 credits; willingness to pay remains unverified.",
      "evidenceRefs": [
        "current:price"
      ],
      "evidenceClass": [
        "EXPLICIT"
      ],
      "status": "KNOWN",
      "confidence": "HIGH"
    },
    {
      "finding": "2 completed deal-coach use(s) suggest pricing and negotiation may be a current concern; they do not demonstrate a customer problem.",
      "evidenceRefs": [
        "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
        "order:0aafc574-9f42-47e5-851b-19235df5fb64",
        "8546061d-069f-4e3a-8f34-b85ce941a52d:behavior",
        "0aafc574-9f42-47e5-851b-19235df5fb64:behavior"
      ],
      "evidenceClass": [
        "BEHAVIORAL",
        "OBSERVED"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE"
    }
  ],
  "negotiationDiagnosis": [
    {
      "finding": "2 completed deal-coach use(s) suggest negotiation may be a current concern; they do not demonstrate a customer problem.",
      "evidenceRefs": [
        "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
        "order:0aafc574-9f42-47e5-851b-19235df5fb64",
        "8546061d-069f-4e3a-8f34-b85ce941a52d:behavior",
        "0aafc574-9f42-47e5-851b-19235df5fb64:behavior"
      ],
      "evidenceClass": [
        "BEHAVIORAL",
        "OBSERVED"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE"
    },
    {
      "finding": "Real counterparty acceptance, rejection and completed deals have not been independently observed.",
      "evidenceRefs": [],
      "evidenceClass": [],
      "status": "UNKNOWN",
      "confidence": "INSUFFICIENT"
    }
  ],
  "distributionDiagnosis": [
    {
      "finding": "1 campaigns; 2 event-backed payload impressions.",
      "evidenceRefs": [
        "campaign:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
      ],
      "evidenceClass": [
        "OBSERVED"
      ],
      "status": "KNOWN",
      "confidence": "HIGH"
    },
    {
      "finding": "Impressions measure inclusion in responses, not attention, clicks, revenue or conversions. Historic untracked legacy counters cannot establish individual exposure events.",
      "evidenceRefs": [],
      "evidenceClass": [],
      "status": "UNKNOWN",
      "confidence": "INSUFFICIENT"
    }
  ],
  "mainBottleneck": [
    {
      "finding": "Distribution activity is recorded, but its commercial effect cannot yet be established. Collect a real buyer outcome and link it to the specific offer.",
      "evidenceRefs": [
        "campaign:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
      ],
      "evidenceClass": [
        "OBSERVED"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE"
    }
  ],
  "recommendedNext3Actions": [
    {
      "finding": "Use the stated offering to run one end-to-end demo for a real target buyer; record their exact task and response.",
      "evidenceRefs": [
        "current:productDescription"
      ],
      "evidenceClass": [
        "EXPLICIT"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE",
      "action": "validate-offer"
    },
    {
      "finding": "Ask the buyer whether the stated 20-credit scope is acceptable; record exact objections without converting simulation into fact.",
      "evidenceRefs": [
        "current:price"
      ],
      "evidenceClass": [
        "EXPLICIT"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE",
      "action": "validate-price"
    },
    {
      "finding": "Compare your recorded active/passive impressions and star audience; repeat a small campaign only after checking a real buyer outcome.",
      "evidenceRefs": [
        "campaign:76dd2d27-d9d3-4da7-99e2-23e8b4beda31"
      ],
      "evidenceClass": [
        "OBSERVED"
      ],
      "status": "INFERRED",
      "confidence": "MODERATE",
      "action": "measure-distribution"
    }
  ],
  "generation": {
    "mode": "evidence-engine",
    "provider": "local-ledger",
    "notice": "Deterministic analysis of authorized evidence; no claim of Arena-wide observation."
  },
  "evidenceSummary": {
    "counts": {
      "EXPLICIT": 21,
      "BEHAVIORAL": 4,
      "OBSERVED": 13
    },
    "findings": [
      {
        "finding": "Evidence comes exclusively from your current input and your own StarHall records.",
        "evidenceRefs": [
          "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
          "order:1cf4faf7-5f43-4c71-8bcd-f76a0321ab02",
          "order:c56f9dcc-ca81-4e7b-b1ce-94d9c5c79c48",
          "order:0aafc574-9f42-47e5-851b-19235df5fb64",
          "order:0c607389-bc63-4a46-8d6b-a630414e53b2"
        ],
        "evidenceClass": [
          "OBSERVED"
        ],
        "status": "KNOWN",
        "confidence": "HIGH"
      }
    ],
    "evidenceExcerpt": [
      {
        "buyerId": "fan-orion",
        "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
        "service": "deal-coach",
        "kind": "trial",
        "at": "2026-09-10T02:55:11.154Z",
        "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:explicit:currentOffer",
        "evidenceClass": "EXPLICIT",
        "confidence": "HIGH",
        "status": "KNOWN",
        "field": "currentOffer",
        "value": 20,
        "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d/input/currentOffer",
        "qualification": "Self-reported input; not independently verified",
        "sourceOrderStatus": "delivered"
      },
      {
        "buyerId": "fan-orion",
        "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
        "service": "deal-coach",
        "kind": "trial",
        "at": "2026-09-10T02:55:11.154Z",
        "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:explicit:budget",
        "evidenceClass": "EXPLICIT",
        "confidence": "HIGH",
        "status": "KNOWN",
        "field": "budget",
        "value": 15,
        "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d/input/budget",
        "qualification": "Self-reported input; not independently verified",
        "sourceOrderStatus": "delivered"
      },
      {
        "buyerId": "fan-orion",
        "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
        "service": "deal-coach",
        "kind": "trial",
        "at": "2026-09-10T02:55:11.154Z",
        "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:explicit:goal",
        "evidenceClass": "EXPLICIT",
        "confidence": "HIGH",
        "status": "KNOWN",
        "field": "goal",
        "value": "购买代码审查",
        "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d/input/goal",
        "qualification": "Self-reported input; not independently verified",
        "sourceOrderStatus": "delivered"
      },
      {
        "buyerId": "fan-orion",
        "orderId": "8546061d-069f-4e3a-8f34-b85ce941a52d",
        "service": "deal-coach",
        "kind": "trial",
        "at": "2026-09-10T02:55:11.154Z",
        "id": "8546061d-069f-4e3a-8f34-b85ce941a52d:behavior",
        "evidenceClass": "BEHAVIORAL",
        "confidence": "LOW",
        "status": "INFERRED",
        "field": "possibleCommercialConcern",
        "value": "pricing and negotiation may currently matter",
        "source": "order:8546061d-069f-4e3a-8f34-b85ce941a52d",
        "qualification": "Service usage alone does not establish buyer objections or sales outcomes",
        "sourceOrderStatus": "delivered"
      }
    ],
    "fullEvidence": "See diagnostic.delivery.pieces[0].evidenceSummary.evidence in the linked original JSON"
  }
}
```

## 18. 新增测试结果

新增17项测试通过，覆盖用户Test A–I以及失败、私有读取拒绝、退款排除、重启、旧广告曝光、同明星轮转、真实抽检发现的币种/政策问题。不是主观买方满意度或排名评测。

- A/E/F: zero-data board, honest trial/demo activity, successful paid fan support and private signals (843.4238ms)
- B/C/D: star-bound support, plan pricing, total score, rank weights and real sponsor pressure (796.4647ms)
- G/H: passive placement targets its star; activation, reads, retries and failed orders cannot inflate exposure (777.0869ms)
- H: active board views record real events once per receipt; expiry and trial cap stop impressions (806.1678ms)
- C/H: weighted shared slots give all stars exposure and rotate competing sponsors (2.4143ms)
- I: diagnostic uses own history and impressions; all findings carry evidence/status and recommend exactly three actions (856.5401ms)
- I/permissions: manager gets only public board; buyer cannot choose another profile, stars cannot read storage; revoked diagnostic grant releases funds (161.6393ms)
- refund and failure exclusion: previously delivered refunds lose support and active campaigns, while failures never create signals (343.0607ms)
- sales contracts: reject malformed input, host bounds include zero and incompatible limits, live content repairs and fallback remains explicit (41.8418ms)
- HTTP core catalog, schemas, authenticated profile, manager demo board and owned campaign tracking (319.626ms)
- config centralizes sponsor and exposure weights and refuses invalid policies (100.2572ms)
- delivery failure and denied board calls do not expose ads or create commercial signals (231.9861ms)
- restart retains sponsor pool, signal references, idempotent board receipts and exposure counters (426.5296ms)
- legacy pin impressions reflect returned summaries; background projections and order lookups add none (293.1213ms)
- same-star campaigns rotate fairly and exposure exhaustion removes real sponsor pressure (1094.945ms)
- sales material cannot be satisfied only by an unrelated draft or title; context is retained alongside description (1.7958ms)
- live regression: prices cannot change to fiat currency or unauthorized discounts; equivalent material wording remains valid (1.7412ms)

## 19. 旧测试和完整验证

原有46项全部通过，保留诗、吐槽、套餐、谈判、广告、trial、idempotency、账本、权限、context与HTTP的行为断言。旧测试里目录查找改为Extras层；原遍历测试继续覆盖12个旧商品，新商品由新用例覆盖。总计63项通过、0失败、0跳过。

[完整自动测试日志](../artifacts/commercial-tests.txt) · [语法检查](../artifacts/commercial-check.txt) · [旧版端到端演练](../artifacts/commercial-legacy-demo.txt) · [隔离商业模板演练](../artifacts/commercial-demo-latest.json)。

真实DeepSeek三轮分开保存：

| 轮次 | A文案 | B压力测试 | 发现与处理 |
| --- | --- | --- | --- |
| [第一轮](../artifacts/commercial-live-rhwgZD/commercial-report.json) | live 3805ms | fallback 21629ms | 人工发现文案写美元；补币种校验。B材料匹配过严，改用既有grounding并补提示 |
| [第二轮](../artifacts/commercial-live-QyLuI3/commercial-report.json) | live 3865ms | live 8746ms | 人工发现B回复虚构“不存储代码”；随后新增政策/保证拦截 |
| [最终轮](../artifacts/commercial-live-DLeWCD/commercial-report.json) | live 4112ms | fallback 25886ms | B两次输出未通过事实/价格校验，成功交付本地备用；其余服务即时/规则/证据引擎完成 |

不能把三轮挑选最好的结果拼成一次全部live成功。最终轮没有failed订单，但存在fallback。规则与证据引擎不消耗模型调用。

## 20. 发现的新bug

已修复：npm test误发现根目录手工脚本；package与目录版本不一致；旧置顶查询无曝光；历史广告回执跟着实时计数变化；以打赏次数排序与新分值不一致；退款记录仍计支持；模型将积分写法币；模型在推荐回复虚构数据保留政策；材料匹配使用固定中文块造成误拒绝。相应回归或端到端证据已保存。

仍有质量边界：关键词和已知断言校验不是完整事实判断；最后一轮B需备用。付费fallback已透明披露，纯模型合格率仍需后续独立买方实测。不能由63项技术测试推出商业文案高转化。

## 21. 未实现/刻意不做

未接入SharedOS Cloud、真实SharedNet目录、Arena房间/外部买家/正式积分/赛事时钟，也未部署或提交。没有真实买家接受/拒绝结果采集、点击、阅读回执、CTR、成交归因、ROI、独立用户去重或反刷量保证。没有退款操作入口，仅正确排除已有退款状态。广告无流量时计数保持0；delivery计划没有强制过期时间。

按要求未做Critique Copilot、第四明星、十几个独立小商品、新网站/UI、假流量、假赞助、假市场趋势、心理画像。旧未绑定广告保留兼容，未伪造迁移成明星赞助。

## 22. grants与ledger边界

没有新增任意文件/网络/身份切换能力。新增用途均为exact grants：broker只能调用公开ledger/market-board；顾客commercial-profile强制本人；star-c只能按待交付诊断单请求该买方证据；ledger独立turn与存储grant仍需通过校验。诊断存储权限撤销、错误purpose、跨买方和manager私有读取均已验证拒绝。

订单扣款、上墙、信号和曝光复用同一原子事务。trial/demo/paid隔离及失败释放预留不变。物理存储仍由本地可信主机共享，不冒充OS或云端租户隔离。

## 23. 陌生Buyer第一眼该买什么

先免费查看Live Market Board；第一笔付费建议Sales Pitch（8分）。只需自己的商品描述或场景，即可获得可直接使用的一句话介绍、短文案、价值要点和CTA，输入成本低且交付可读。已有明确报价与对手原话的买方可直接选Deal Coach。每次只给一个基于实际使用历史的下一步建议，不强迫把整条链买完。

## 产品闭环核验

小服务→原子交付与私有信号→Fan Support→实时排名→选择明星赞助→Sponsor Support→权重改变→实际响应曝光→OBSERVED证据→Commercial Diagnostic，在隔离本地账本中已成立。广告只是进入真实返回载荷，不等于Arena用户读过或转化；本地AUTO阶段也不代表已接入真实赛事。

链路不需要人工现场改分、灌曝光或编造事件。外部流量和赛事状态仍需要未来适配器；核心B模型不合格时依赖已实现且明示的本地备用内容，而不是未实现功能。

复跑：npm test；npm run check；npm run demo；npm run demo:commercial。真实API用npm run demo:commercial -- --live。各次独立数据目录默认三位买方各100分，不影响日常账户。
