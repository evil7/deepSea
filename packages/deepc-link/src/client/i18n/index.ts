/**
 * deepc-link browser 端 i18n —— 跟随 dsh 配置的语言选项（locale.preference）自适应。
 *
 * 设计：
 *   · 每语言单文件（zh-CN.json / en-US.json），随 esbuild bundle 打包（无异步加载）；
 *   · 同步初始化（initImmediate:false）：host-ui 用 createRoot 在 dsh 运行时挂载，
 *     等不起异步 init 竞态；
 *   · 不引 i18next-browser-languagedetector：语言完全由 dsh 设置决定（见
 *     client/index.ts apply 中从 settingsScope mirror 读取 locale.preference）。
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

export const PLUGIN_LANGUAGES = ['zh-CN', 'en-US'] as const
export type PluginLanguage = (typeof PLUGIN_LANGUAGES)[number]

/** 将 dsh locale 值映射为插件语言（zh* → zh-CN，en* → en-US，未知/缺失回退 zh-CN）。 */
export function normalizeLocale(locale: unknown): PluginLanguage {
  const raw = String(locale ?? '').toLowerCase()
  if (raw.startsWith('zh')) return 'zh-CN'
  if (raw.startsWith('en')) return 'en-US'
  return 'zh-CN'
}

let initialized = false

/**
 * 初始化（幂等）。detectedLang 由调用方从 dsh locale.preference 解析；
 * 若已初始化且语言变化（例如 apply 重入）则切换语言。
 */
export function initPluginI18n(detectedLang: string): typeof i18n {
  if (!initialized) {
    initialized = true
    void i18n
      .use(initReactI18next)
      .init({
        resources: {
          'zh-CN': { translation: zhCN },
          'en-US': { translation: enUS },
        },
        lng: detectedLang,
        fallbackLng: 'zh-CN',
        supportedLngs: ['zh-CN', 'en-US'],
        // 同步初始化：资源随包，无需异步加载；host-ui 挂载前即可用 t()
        initAsync: false,
        interpolation: { escapeValue: false },
      })
  } else if (i18n.language !== detectedLang) {
    void i18n.changeLanguage(detectedLang)
  }
  return i18n
}

export default i18n
