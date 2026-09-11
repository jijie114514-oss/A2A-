# DeepSeek V4 Pro 接入

项目根目录 `.env` 已配置为 DeepSeek；已有密钥在本次修复中保留。新安装时填写自己的 LLM_API_KEY，密钥未填写时启动报配置缺失是预期行为。

```dotenv
LLM_PROVIDER=openai-compatible
LLM_API_KEY=填写你的实际密钥
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-pro
LLM_TOKEN_LIMIT_FIELD=max_tokens
LLM_JSON_OUTPUT=true
LLM_THINKING=disabled
LLM_TIMEOUT_MS=45000
LLM_FALLBACK=true
```

模型名需要保留全部连字符：`deepseek-v4-pro`。程序会自动把 `/chat/completions` 拼到基础地址后。三位明星共用这个模型和密钥，账本不调用模型。

采用 DeepSeek 的 [JSON 输出模式](https://api-docs.deepseek.com/guides/json_mode/)，请求发送 `response_format: {type: "json_object"}`、`max_tokens`，并在提示词中提供 JSON 示例。项目继续校验作品结构。

DeepSeek [思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)说明默认开启思考。为了首次验证和短时作品交付，本项目显式发送 `thinking: {type: "disabled"}`。可改为 `enabled`，但目前2200 token输出预算和45秒时限主要面向短作品，开启思考后需重新验证是否足够；`default` 表示不发送该参数，采用平台默认值。其他 OpenAI 兼容服务商未必支持 thinking 参数。

保存 `.env` 后在项目终端执行 `npm start`；已有服务先 Ctrl+C 停止再重启。在另一个终端执行：

```powershell
npm run cli -- demo
```

这会由经纪人调用星A生成一首诗。StarHall本地积分不扣，但真实模型请求会消耗服务商的 API 用量。返回 `generation.mode: live` 和 `model: deepseek-v4-pro` 表示这次使用了真实 API。

`npm run demo` 固定运行离线模板演练，不用于检查真实 API。当前默认打开兜底，模型输出经过结构归一化与至多一次修复仍失败时，返回 mode 为 fallback 的备用作品；只有 mode 为 live 才代表真实模型作品。诊断时可临时设 LLM_FALLBACK=false，但不应忘记这会关闭产品的备用交付承诺。

现已用 DeepSeek V4 Pro 执行三种买家画像的真实API回归，详见 [交付修复与复测](DELIVERY-FIXES.md)。重复测试使用 `npm run test:buyers -- --live`，会创建新数据目录，不消耗日常模拟账户余额。
