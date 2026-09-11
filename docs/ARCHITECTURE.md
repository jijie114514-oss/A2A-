# 0.5.0 增量架构

新增commercial-catalog、sales、market、signals四个模块，复用原store、app、kernel和HTTP路由。ledger提交事务原子完成扣款、交付、上墙、商业信号、分数事件与实际广告附入；排名从合格历史订单计算，不用虚构种子。私有档案与诊断仅访问当前授权买方。星C诊断走独立commercial-analysis-read turn，再由ledger独立turn读取证据；没有新增通用文件接口。

经纪人仅新增ledger/market-board invoke grant，purpose=market-board-read；仍无summary、full-wall、私有档案或storage权限。ledger新增storage-market-board写（只生成响应和曝光）、storage-analysis读（买方证据）、storage-summary-exposure写（旧置顶曝光）。原精确授权和审计保留。完整规则见[商业API](COMMERCIAL-API.md)，验证见[升级报告](COMMERCIAL-UPGRADE.md)。下文兼容路径中的“经纪人仅有演示入口”需结合此处新公共行情授权阅读。

---

# 本地实现与边界

## 调用链

```text
HTTP / CLI
  → Bearer 令牌认证，服务器推导 caller 身份和 purpose
  → SharedOSKernel.authorize 检查服务访问权
  → 原子预留订单额度
  → SharedOSKernel.invokeTool 调用对应服务，再次检查权限
  → SharedOSExecutor / StandardRuntime 以明星身份开启独立 turn
       → 明星自己的 memory 工具（内核检查）
       → 明星自己的 generate 工具（内核检查）
       → 套餐：星B → 星A collaboration 服务 → 星A独立 turn
  → 明星以 ledger-update 调用账本入口（内核检查）
  → 账本以 ledger 身份开启独立 turn
       → 账本 commit 工具（内核检查）
       → 扣积分 + 作品交付 + 上墙 + 粉丝记忆原子提交
  → 返回作品与完整打赏墙快照
```

`src/kernel.js` 注册服务器持有的 capability grants、工具和 SharedOS 的 escalation affordance。每个接收身份通过 `agentExecutionCapability` 获得独立执行权限；grantSource 按 namespace、subject 和 issuer 限定来源。请求正文和模型输出都不能签发或修改 grants。

本地实现使用 SDK 的嵌入式内核，参照 [SharedOS Quickstart](https://www.sharedos.ai/docs/quickstart)。`broker`、三个明星和 `ledger` 是不同的本地 agent ID；并未注册云端 node ID。内核检查和审计真实执行，但都在本机。

## 有意保留的拒绝

- 经纪人只能调用星A的 `arena-demo` 入口，无付费购买或账本访问权限。
- 未消费顾客不能读取 full-wall，顾客不能写账本。
- 明星只能读取自己的粉丝记忆，不能读取其他明星或经纪人的资源。
- `market-tip`、`arena-demo`、`ledger-update` 和 `escalation-review` 不能互换。
- 账本自己还需拥有读写存储的 grants；仅有明星的调用授权不足以完成写入。

内部工具不是通用任意文件读写接口。所有文件路径由主机确定，模型只返回经校验的作品 JSON，不获得进程、文件或网络工具。物理存储由可信主机共享，并非操作系统级隔离。这与云端资源授权、节点注册和远程执行是不同层次的工作。

## 交易状态

```text
有效请求 → pending（预留额度） → delivered（原子扣款、作品、上墙、记忆）
                              ↘ failed（释放预留，不扣款）
```

`state.json` 是唯一权威文件。每次事务先在内存副本修改，写临时文件、fsync，再同目录 rename，最后替换内存状态。所有事务在单一队列中串行提交。不同订单的生成过程可并发；额度预留仍然串行，不会因并发而超支。

幂等键按买家隔离，指纹覆盖服务、规范化后的输入和留言。同一订单进行中时共享执行 Promise，已完成时返回保存的结果。已失败键仍指向失败订单，新一次尝试需使用新键。订单一旦已经持久化为 delivered，即使随后返回或审计失败，也不能回滚已交付交易。

服务自身无法确认模型输出真实有效的业务价值；live 输出校验覆盖结构、必要字段、总大小、五回合数量、输入词汇覆盖、已知跨业务跑题、占位符及部分谈判约束。grounding.js 从输入提取原文要点，从实际正文生成匹配证据，不信任模型自报的理解结果。关键词检查仍有误判与漏判，文案质量、事实、完整语义和风格仍需阅读实际作品验收。

0.3.0 的试用复用上述服务授权与结算路径，由受信任路由设置 kind=trial 和0价；客户端不能自报 kind/price。按买家、服务限制一次成功试用，限额检查与订单创建在同一事务，幂等键按买家和试用/付费类别隔离。试用也写墙，但不计付费销量、营收、置顶感谢或会员权限。存档未带kind的旧付费记录保持兼容。

经纪人演示走 broker → star-a 生成 → star-a ledger/record-demo → ledger storage-demo，后两层都有独立内核授权；经纪人没有账本读写grant。记录明确标demo、0分、自家演示，与外部试用trial和付费paid分开。

## 文件与恢复

| 文件 | 用途 |
| --- | --- |
| `state.json` | 账户哈希、余额、订单、墙、粉丝记忆、练习状态和交易事件 |
| `credentials.json` | 本地测试账户访问令牌；仅 CLI / 主机读取 |
| `process.lock` | 单进程数据目录锁；存活进程占用时拒绝第二个实例 |
| `audit.jsonl` | SDK授权、工具调用、turn结束、升级和产品策略决策 |
| `ledger/summary.json` | 可重建的基础榜导出 |
| `ledger/wall.json` | 可重建的完整墙导出 |
| `stars/{star}/memory.json` | 可重建的每位明星粉丝记忆 |
| `stars/{star}/works/{orderId}.json` | 可重建的作品文件 |

启动时遗留 pending 订单标记为 failed，释放预留额度，不自动重复调用模型。已交付订单及消费会员资格保留。导出文件每次成功交付后和正常关闭时重建；在线 API 直接读取权威 state，不依赖导出文件是否及时生成。导出失败时 health 变为 degraded，已提交订单仍然有效。重新生成导出不会再次扣款。

损坏的 JSON 存档或凭据不匹配时拒绝启动，不会悄悄创建一套新余额。遇到此类错误应保留原文件，用备份恢复。测试/演练应使用独立数据目录，不要手工重置日常存档来“修复”错误。

审计单独顺序追加，保留 SDK event 字段，附 `hostMode: local`。交易和审计不是跨文件 ACID 事务；交易自身的状态变更事件与订单一起持久化。SDK检测到副作用后的审计写入失败时，服务拒绝后续结算并在 health 标记异常。目录锁与原子替换适用于本地单进程演练，不声称实现多机账本或断电级完整审计保障。

## 时间和服务可用性

每份作品首次生成最多25秒。先做格式归一化，只有内容/结构错误才允许一次最多20秒的重新生成，两次合计不超过配置的45秒（可调小）；网络或认证错误不重复请求。套餐串行生成两份作品。订单总截止115秒，内部 turn 默认110秒，HTTP读取请求120秒。超过模型时限或修复仍失败时，默认降级为明确标记的本地备用作品；禁止降级时失败并释放额度。基础榜免费且无需调用模型。模型输入不再包含历史购买主题，避免新订单被旧主题污染；粉丝问候仍由主机从独立记忆中生成。

客户端网络断开不等于取消订单。服务器可以继续完成交付，买家应使用原幂等键或订单ID查询。执行层收到真正的 AbortSignal 时，不会以备用作品继续结算。

本地数据量增长会增加 JSON 重写和导出成本。参赛云端版应由平台支付回执和持久化存储承担最终交易一致性，并按实际限流、超时和并发容量做测试。
