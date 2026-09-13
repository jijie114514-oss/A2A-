# archive — 开发期快照（2026-09-09 ～ 09-11）

这里保存开发、调参与复测过程中产生的**一次性 API 返回快照、阶段报告和已被取代的临时脚本**。
它们不参与构建、部署和测试，只作为过程追溯材料保留；现行功能以 `src/`、`test/`、`scripts/` 为准。

| 目录 | 内容 |
| --- | --- |
| `early-runs/` | 早期（0.2–0.3）真实下单/目录/诊断的返回快照：`catalog3.json`、`diag1/2.json`、各服务订单 JSON |
| `v2-runs/` | v2 复盘脚本产生的订单快照（duet / idem / nego / pat / pred / rev） |
| `v3-runs/` | v3 复测快照与报告（`v3rev`、`v3roast`、`v3-test-report.txt`） |
| `v4-runs/` | v4 复测报告与临时脚本（`buyer-v4-*.mjs`，已被 `scripts/retest-buyers.js` 取代） |
| `v5-runs/` | v5 全量报告与临时脚本（`buyer-v5-test.mjs`，同上） |

去重说明：

- `idem.json` 与 `roast2.json` 内容完全相同，只保留后者（`early-runs/roast2.json`）。
- `v2tac.json` 与 `v2idem.json` 内容完全相同，只保留后者（`v2-runs/v2idem.json`）。

现行复测入口：`npm run test:buyers` / `npm run test:focused` / `npm run demo`，使用说明见根目录 `买方Agent测试脚本.md`。
