# 豆包 / 火山方舟 Responses 接入

本机 `.env` 已使用用户提供的方舟凭据；文档和示例不保存密钥。

```dotenv
LLM_PROVIDER=ark-responses
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
LLM_MODEL=doubao-seed-2-0-lite-260428
LLM_API_KEY=你的方舟密钥
LLM_JSON_OUTPUT=true
LLM_THINKING=disabled
LLM_TIMEOUT_MS=45000
LLM_FALLBACK=true
```

实际地址为 `https://ark.cn-beijing.volces.com/api/v3/responses`。也允许在base URL中直接填写完整responses地址，配置层会去重末尾路径。密钥通过Bearer发送，只进入发往该模型端点的请求头。

当前StarHall产品都是文字交付，适配器把原系统提示及本单文字材料放进 `input` 的 `input_text`。用户示例中的图片只是接口演示图片，没有加入每笔订单，也没有新增图片服务。

请求使用 `max_output_tokens=2200`，JSON模式使用 `text.format.type=json_object`，思考开关使用 `thinking.type`。`store=false`，不关联previous_response_id，保持现有各买方/订单的本地上下文管理。此参数不等于对服务商日志或保留政策作保证。

只提取completed响应中的assistant/output_text；reasoning、工具调用、refusal、incomplete、failed及空输出均不会作为成功作品交付。原来的结构校验、最多一次修复、45秒生成总预算和配置化备用逻辑继续使用。`LLM_TOKEN_LIMIT_FIELD`是Chat Completions配置，Responses不使用它。

星A、星B及星C旧版谈判服务共用新的模型配置。Deal Coach仍是本地价格规则，Commercial Diagnostic仍是本地证据引擎；账本、广告和榜单不调用模型。

启动或重启本地服务：

```powershell
Set-Location 'D:\Documents\A2A黑客松'
npm start
```

若原服务器仍在运行，先在原终端Ctrl+C，再执行npm start；Node启动时加载.env，运行中的旧进程不会自动更新。

真实验证（三个明星、隔离数据、关闭fallback，不占用日常账户余额）：

```powershell
node --env-file=.env scripts/verify-provider.js
```

每次报告保存至新建的 `artifacts/provider-check-*/report.json`。只有实际live交付才算接入验证成功；服务商拒绝请求时只保存脱敏错误信息，不保存请求头或密钥。真实验证消耗模型API额度。

协议依据：[方舟Responses快速开始](https://www.volcengine.com/docs/82379/1795150)、[方舟返回消息示例](https://www.volcengine.com/docs/82379/1958524?lang=zh)。

接入验收（2026-09-10）：三个真实模型调用均一次通过且为live；Sales Pitch 8688ms、Sales Stress Test 15213ms、星C tactics 8809ms。验证关闭fallback；只使用独立测试账户。原始[验收报告](../artifacts/provider-check-Hz22Su/report.json)保留请求状态和脱敏诊断，未保存密钥。88项自动测试全部通过，见[测试记录](../artifacts/ark-tests.txt)；另已通过JavaScript语法检查。
