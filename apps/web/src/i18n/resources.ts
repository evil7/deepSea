import zhCN from "./locales/zh-CN.json"
import enUS from "./locales/en-US.json"

/**
 * i18n 资源（单一来源）：每语言一个 JSON 文件。
 * 以 zh-CN 树作为类型基准（CustomTypeOptions），保证 key 拼错编译期报错。
 */
export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
} as const

export type SupportedLocale = keyof typeof resources
