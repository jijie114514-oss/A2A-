# 经纪人作战室：启动、使用、关闭

这是现有 StarHall 的增量本地适配。`broker-agent.md` 管人格与行为，`src/broker.js` 管外部记忆与核对；工具不调用模型、不试用、不采购、不发言、不提交排名。产品服务与作战室共用 HTTP 进程，但作战室使用独立命名的状态区，不改变销售账本、明星排名或顾客钱包。

经纪人启动时还须读取 [面向AI买家的宣传与销售手册](SELLER-PLAYBOOK.md)：第一轮帮助真实试用与回应异议，第二轮根据需求和预算推荐付费，包含商品交付、话术及承诺边界。

## 最简单的启动与关闭

PowerShell 中进入项目目录：

```powershell
cd "D:\Documents\A2A黑客松"
npm start
```

默认地址 `http://127.0.0.1:4317`（以启动输出为准）。如果旧版服务正在运行，先在它的终端按 Ctrl+C，再运行 npm start，以加载新增路由。服务不会自动运行经纪人。

本地经纪人演练推荐独立环境，另开终端运行：

```powershell
cd "D:\Documents\A2A黑客松"
npm run sandbox
```

默认使用4318端口，输出全新数据目录和 `connection.json` 所在目录；三位买家和模拟外部市场均从100分开始。每次 sandbox 启动都会创建新目录；旧数据不清除。

在第二个终端，用上一步**实际输出的文件路径**初始化并查看：

```powershell
$brokerConnection = "D:\Documents\A2A黑客松\artifacts\sandbox-实际目录\connection.json"
npm run broker -- init-rehearsal rehearsal-001 "$brokerConnection"
npm run broker -- status rehearsal-001 "$brokerConnection"
npm run broker -- watch rehearsal-001 "$brokerConnection"
```

`init-rehearsal` 从当前时刻安排10分钟试用轮、随后60分钟市场轮。不要用它恢复原会话，因为它会生成新的时间配置；恢复直接用 status/watch。要快速练习接口而不等待时段，改用 `npm run broker -- init examples/broker-session.json "$brokerConnection"`，runId 为 `fixture-freeform-001`；该示例无倒计时，会一直提示未配置赛程。

作战室命令也可省略 connection.json，届时连接 `.env` 配置的常规服务与 data 目录。sandbox 必须显式传连接文件，避免误用常规身份。

关闭分三件事：

1. 对正在执行的 agent 说“停止经纪人演练，保存已完成动作的回执并报告未决订单”；必要时使用其运行界面的停止操作。
2. 在 watch 终端按 Ctrl+C，停止监看；这不会关闭服务或 agent。
3. 在 npm start / sandbox 的终端按 Ctrl+C，正常关闭 HTTP 服务并释放数据锁。关闭服务不会撤销已经发生的外部购买，重启也不会让本地记录归零。

不要手动删除 data、state.json 或运行中进程的锁文件。正式托管 agent 的终止方式须在接入主办方运行环境后补齐。

## 让当前 agent 开始或恢复演练

在打开本项目的 Codex 中发送下面的指令，把路径换成真实路径：

> 现在担任 StarHall 经纪人，读取 broker-agent.md 和 docs/BROKER-RUNBOOK.md。仅在本地模拟市场演练，runId=rehearsal-001，connection.json=实际绝对路径。先读作战室状态；自己选择试用、异议、排名和购买，逐笔保存证据并记账。不得操作真实市场。中断恢复沿用该 runId。

根目录 AGENTS.md 在明确经纪人任务时引导读取行为文件。Codex 的项目说明文件在运行开始时加载；已有任务可按上面的提示显式读取，新任务会按项目说明发现规则加载。[官方 AGENTS.md 说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。Pi 或其他托管 agent 需要使用各自运行环境的说明文件入口，不能假定也会自动读取 AGENTS.md。

工具只报告所记录的事实。watch 每15秒在当前终端输出一次，不发送房间消息，不启动系统定时任务，也不会唤醒已关闭的 Codex。持续参赛需要 agent 运行环境保持在线，并按行为文件主动检查时间。

## HTTP 工具与记录格式

所有作战室接口都需要 **broker 本地身份**的 Bearer token。CLI从连接文件指向的 credentials.json 内读取，不输出token。明星、普通买家和匿名访问均无权限。SharedOS purpose 为 `broker-tracking`，只授予五个精确作战室工具权限，不授予原始账本权限。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | /broker/session | 创建不可覆盖的 runId，原样重发幂等 |
| GET | /broker/status?runId=... | 金额、不同队伍、倒计时、清单、历史记录 |
| GET | /broker/next?runId=... | 确定性的一句话建议与警报 |
| POST | /broker/receipt | 记录交付、失败或全额退款回执 |
| POST | /broker/checklist | 记录已发生的试用、异议、排名确认 |

每个请求必须明确 runId，不存在隐含的“当前会话”，以免多个 agent 或多轮测试串账。会话的 source、己方teamId和赛程创建后不可修改，同runId配置冲突返回409；新演练使用新runId。实际收支以赛事钱包为准，作战室余额是100减去有效成功消费。

会话 JSON（正式赛程请填写真实值，以下仅描述字段）：

```json
{
  "runId": "唯一比赛或演练ID",
  "source": "arena",
  "ownTeamId": "主办方目录中的己方teamId",
  "schedule": {
    "trialStart": "2026-09-10T10:00:00+08:00",
    "trialEnd": "2026-09-10T10:20:00+08:00",
    "marketStart": "2026-09-10T10:20:00+08:00",
    "marketEnd": "2026-09-10T11:20:00+08:00"
  }
}
```

上面日期只是格式示例，**不是已确认赛程**。`arena` 强制要求赛程，仍然只是手动记录模式，不会连接正式比赛。source 必须与每笔记录一致，fixture 不能混入 arena。

购买成功后保存 receipt.json，再运行 `npm run broker -- receipt receipt.json "$brokerConnection"`：

```json
{
  "runId": "rehearsal-001",
  "receiptId": "对方原始订单或回执ID",
  "teamId": "对方官方teamId",
  "amount": 30,
  "service": "购买的产品ID",
  "status": "delivered",
  "source": "fixture",
  "occurredAt": "2026-09-10T02:30:00.000Z",
  "evidenceRef": "evidence/order-001.json",
  "note": "实际验收结果、值得记住的承诺或偏好"
}
```

时间和证据路径必须替换为真实值。成功消费只统计正整数积分、外队、delivered、发生于市场轮内的订单。同队同receiptId重发同内容不重复计账；同ID改价/改产品返回409。全额退款使用同teamId、receiptId、原金额、`status: refunded`、退款实际时间和证据路径；先记原单，再记退款。退款后旧交付重发不会恢复消费。部分退款目前没有适配，正式接入须按官方净支出规则补齐，不能自行改写金额。

免费、failed、refunded订单保留可查但不计金额/队伍数；超预算如实入账并警报，不把错误收支藏起来。各服务即使名称不同，teamId相同也只算一家。

购买策略更新：硬指标是至少3件产品、3家外队、消费80–100分；偏好是尽量恰好80分、单价≤30、每个卖方累计≤30，同等可行支出优先4家及以上并均摊。已满足硬指标后，不为凑第4家追加消费。超过单价30仅在没有其他可行选择时由agent决定，并把理由与替代选择写入原回执note。

status和watch新增产品数、每个卖方累计额；status另返回purchasePolicy。purchaseCount为有效成功订单数，productCount按teamId+service去重；重复买同一产品不凑3件，套餐保守算一件。退款会重算产品数、外队数和卖方累计额。ABOVE_PREFERRED_TOTAL、HIGH_PRICE_PURCHASE、SELLER_SPEND_CONCENTRATED分别提示超80分目标、高价单和支出集中；这些偏好警报不否定已交付回执，也不拒绝记账。单价判断依赖目前每张回执对应一个目录产品的格式，不支持自行合并多个商品再称为单价。

购买前agent读取sellerSpend，自己评估候选单价与购买后卖方累计额。作战室不选品、不获取公开销量；避开高销量卖方的偏好由agent结合可比较、带来源和观察时间的市场证据执行，未知销量不能当0。完整策略见broker-agent.md。

打卡事件保存 event.json，运行 `npm run broker -- checklist event.json "$brokerConnection"`。公共字段：

```json
{
  "runId": "rehearsal-001",
  "eventId": "唯一事件ID",
  "kind": "trial",
  "teamId": "对方teamId",
  "service": "试用产品ID",
  "source": "fixture",
  "occurredAt": "2026-09-10T02:05:00.000Z",
  "evidenceRef": "evidence/trial-001.json"
}
```

- 试用：kind=trial，加teamId和service，保存实际试用输出。
- 异议：kind=objection，加teamId和text，保存实际发言/点评接收凭证；该队必须已有试用记录。不能仅在草稿里写一句就记成已提交。
- 排名：kind=ranking，加teams数组和accepted=true，保存平台确认；不需要teamId/service。至少包含3家不同外队，并涵盖已试用队伍。新增试用/异议晚于已提交排名时，ranked会失效，须重新提交并记录新的eventId。

`checklist.objections3` 要求至少3家且所有已试用队伍均有异议。超出试用轮时间的事件保留，但不算按时完成。evidenceRef只是证据引用，工具不会打开网页、验证签名或代替平台接受确认，所以始终返回 `evidenceMode: agent-reported`、`qualificationConfirmed: false`、`arenaConnected: false`。

## 演练入口与证据

sandbox 的 `/v1/test-market/catalog` 提供四家虚构外队；GET wallet、POST try/orders/rankings 的用法见目录。使用broker身份获取其独立100分模拟钱包。排名接口接收ranking和reviews，一并模拟接收异议；购买接口需要原始Idempotency-Key。

fixture 钱包只活到该服务进程结束，作战室记录则保存在当前数据目录的 **state.json → brokerRooms**，使用既有串行事务与原子写入。重启恢复的是记录，不是fixture钱包；重启后如需继续模拟采购，开新的独立sandbox和runId，不能把重置的钱包当续赛余额。正式恢复必须核对平台钱包。

快速验证工具链：

```powershell
npm run demo:broker
npm test
npm run check
```

demo:broker 无模型、无真实采购，在独立临时数据目录运行固定fixture测试：四家试用与异议、排名确认、30/25/15/10购买、每张收据重复记录、检查消费80分且钱包20分，保存 report.json 与原始 trace.json 后自动关闭。为快速验证它不绑定赛程；倒计时、越权、退款和重启恢复由自动化测试覆盖。这个固定脚本不是参赛agent，也不能证明agent漏项率降低。

若比较“纯说明”和“说明+工具”：用两个全新sandbox分别让真实经纪agent演练，采用相同模型、赛程和市场任务，各自保存原始日志；最后统计遗漏强制项数、跨队数、有效支出、超时动作。没有两份真实日志前，不发布漏项率结论。`npm run demo` / `rehearseArena` 同样仅是旧的固定模拟测试。

## 正式比赛仍需补齐

当前完成的是可移植行为文件、本地记账工具和本地调用入口。上传这些文件不会把当前Codex会话变成已托管参赛节点。需提供主办方接入文档、正式赛程、身份/认证和托管环境后，才能实现真实外队发现、钱包/回执核验、房间工具、排名提交，以及托管进程的启动/暂停/终止。详见 CLOUD-NEXT.md；不要上传.env和credentials.json作为公开材料。
