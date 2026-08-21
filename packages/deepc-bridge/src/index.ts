import type { Context } from '@deepseek-ai/cordis'

/**
 * deepc-bridge node 端插件 —— S0 最小骨架。
 *
 * 空 apply 使 deepc-bridge 出现在 host Loader / `--dump-config` 的独立层，验证
 * 「一切皆插件」落地路径（bundle 可被 `dsh plugin add` 安装）。
 *
 * 后续阶段在此注入能力：
 * - `ctx.apiProxy`：dsh 本地功能网关，经 toFetchHandler 变成本地 API 处理器
 *   （操作互联的本地端点）
 * - node-datachannel：headless 场景的 WebRTC 端点（deepc-sonar-bridge 传输层）
 * - fs.watch：工作区变更检测（工程同步的增量来源）
 *
 * 所有注册都必须作为可回滚 effect（fiber dispose 时还原），保证零残留。
 */
export const name = 'deepc-bridge'

export function apply(_ctx: Context): void {
  // S0：仅证明 bundle 可挂载。后续阶段填充中间件与两大功能。
}
