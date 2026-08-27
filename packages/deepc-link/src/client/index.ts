/**
 * deepc-link browser 端插件 —— 跑在本地 dsh 前端（浏览器）。
 *
 * 经 dsh 的 `dsh.client` 声明 + `exports["./client"]` 被 `dsh-client-modules`
 * 发现，注入 `__DSH_BOOT__` entry graph，随官方前端一起 boot。
 *
 * apply 里：
 *   1) 安装 monkey-patch 统一介入层（远端能力接管：settings mirror / 目录选择器等）；
 *   2) 注入「deepSea 互联」悬浮球（右下角 deepSea 图标）+ 卡片式 Sheet。
 *
 * 注意：browser 端的 entry id 由 `window.__ModuleLoader__.load({ id })` 提供
 * （= package name `deepc-link`），此处 `name` 仅作客户端 cordis runtime
 * 的服务名，不参与 entry 发现。
 */

import { bootstrapHostUi } from './host-ui'
import { installMonkeyPatches, type MonkeyPatchCtx } from './monkey-patch'
import { initPluginI18n, normalizeLocale } from './i18n'

export const name = 'deepc-link'

/**
 * 依赖：slots（目录流 shadow）、connection（覆盖 isLoopback）、settingsScope（切换 mirror）。
 * 声明 settingsScope 依赖确保 apply 在 dsh-client-ui-settings 提供 mirror 之后执行，
 * 从而能拿到并纠正 mirror 的持久化模式。
 */
export const inject: string[] = ['slots', 'connection', 'settingsScope']

/**
 * cordis Context 事件面（运行时真实存在；本地宽松声明避免引入 dsh 类型）。
 * dsh-client-locale 在语言实际切换时 emit 'locale/change'，payload 为 locale snapshot
 * （含 active: "zh" | "en"）。
 */
interface EventCtx {
  on: (event: string, listener: (payload?: unknown) => void) => () => void
}

/**
 * dsh locale 设置在 settings 的 `locale` namespace 下（scope value 形状
 * `{ preference: "zh" | "en" }`，字段见 dsh-client-locale 的
 * LOCALE_SETTINGS_NAMESPACE / LOCALE_PREFERENCE_FIELD）。语言 ID 是 "zh"/"en"，
 * 经 normalizeLocale 映射到 zh-CN / en-US。
 */
const LOCALE_NS = 'locale'
const LOCALE_FIELD = 'preference'

/** 应用 dsh locale 值到插件 i18n（纯函数，不捕获父作用域）。 */
function applyLocale(raw: unknown): void {
  if (!raw) return
  initPluginI18n(normalizeLocale(raw))
}

export function apply(ctx: MonkeyPatchCtx & EventCtx): void {
  // i18n：跟随 dsh 配置的语言选项（locale.preference）自适应。
  // 读取路径：settingsScope.bind({ namespace: 'locale' }).getSnapshot().value.preference
  // 监听：① dsh 的 'locale/change' 事件（实际切换时 emit）；② scope 快照订阅（设置文档
  // 更新/首次就绪）；③ 异步 ensure 后补读一次（我们的 apply 可能早于 locale 插件执行）。
  //
  // 兜底初始化：dsh 的 provisional 语义 —— 无显式 preference 时跟随浏览器语言；
  // 之后 preference 到达（同步快照/事件/异步补读）再覆盖。
  initPluginI18n(normalizeLocale(detectBrowserLocale()))

  const scope = ctx.settingsScope?.bind?.({ namespace: LOCALE_NS })

  // 1) 同步快照：scope 已就绪时直接读（status=ready 且 value 已接受）。
  const pref = scope?.getSnapshot?.()?.value?.[LOCALE_FIELD]
  if (pref) applyLocale(pref)

  // 2) 'locale/change' 事件：用户切换语言 → 插件即时跟随（订阅随页面生命周期存活）。
  ctx.on?.('locale/change', (payload) => {
    const active = (payload as { active?: unknown } | undefined)?.active
    if (active) applyLocale(active)
  })

  // 3) scope 快照订阅：settings 文档更新（首次就绪 / 写回）时重读。
  scope?.subscribe?.(() => {
    const v = scope.getSnapshot()?.value?.[LOCALE_FIELD]
    if (v) applyLocale(v)
  })

  // 4) 异步补读：settings 文档尚未就绪（describe 未返回）时 ensure/load 后重读。
  void (async () => {
    try {
      const describe = ctx.settingsScope?.describe?.()
      if (!describe) return
      const face = describe as {
        ensure?: () => Promise<void>
        load?: () => Promise<unknown>
      }
      if (typeof face.ensure === 'function') await face.ensure()
      else if (typeof face.load === 'function') await face.load()
      const v = scope?.getSnapshot?.()?.value?.[LOCALE_FIELD]
      if (v) applyLocale(v)
    } catch {
      /* settings 不可用（远端 memory 模式等）→ 保持初始语言 */
    }
  })()

  // monkey-patch 统一介入层：远端能力接管（settings mirror / 目录选择器等）。
  installMonkeyPatches(ctx)
  // deepSea 互联悬浮球 + Sheet（三模式 UI + 2FA 二维码）。
  bootstrapHostUi()
}

/** 浏览器语言（dsh provisional 语义：浏览器语言优先于 fallback，直到显式 preference 到达）。 */
function detectBrowserLocale(): string {
  try {
    return navigator.language ?? ''
  } catch {
    return ''
  }
}
