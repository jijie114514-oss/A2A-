/** 跨模块共享的运行上限：只放常量，不 import 任何业务模块，避免循环依赖。 */

/** 单笔交付硬预算（秒）。src/app.js 用它设置 AbortController；
 *  目录、agent card、MCP 工具描述里对外的承诺必须与它一致，
 *  否则就是承诺 290 秒、实际 115 秒就判失败。广告位不走模型，单独标 15 秒。 */
export const DELIVERY_BUDGET_SECONDS = 115;
