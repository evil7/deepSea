import zhCN from './locales/zh-CN.json'

/**
 * i18next 类型增强：以 zh-CN 资源树约束 t() 的 key，
 * key 拼错 / 插值参数名写错均在编译期报错。
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof zhCN
    }
  }
}
