import i18n from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"

import { resources } from "./resources"

/**
 * 站点 i18n 初始化。
 * 检测顺序：?lang= → localStorage['deepsea.lang'] → navigator.language → zh-CN。
 * useSuspense:false —— 资源随包打包本就同步可得，避免首屏挂起。
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "deepsea.lang",
      caches: ["localStorage"],
    },
    // 每语言单文件：默认命名空间即 "translation"，无需 defaultNS 配置
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
  })

// 语言切换 → 同步 <html lang>（SEO / 无障碍）
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng
})

export default i18n
