import { useEffect } from "react"

/**
 * 页面级 SEO（SPA 路由切换时更新 <head>）：
 *   · document.title
 *   · meta[name=description] / og:description / twitter:description
 *   · meta[name=robots]（noindex 页面屏蔽收录）
 *   · link[rel=canonical]（不存在时自动创建）
 *
 * 用法：在页面组件内调用，或集中在 App 路由层按 pathname 映射调用。
 * 注意：Google/Bing 等现代爬虫会执行 JS 并读取动态更新的 <head>，
 * 但静态兜底 meta 仍在 index.html 中（保证非 JS 环境的首屏可读性）。
 */
export function usePageMeta(meta: {
  title: string
  description?: string
  canonical?: string
  noindex?: boolean
}) {
  useEffect(() => {
    document.title = meta.title

    if (meta.description) {
      upsertMeta("name", "description", meta.description)
      upsertMeta("property", "og:description", meta.description)
      upsertMeta("name", "twitter:description", meta.description)
    }
    upsertMeta("property", "og:title", meta.title)
    upsertMeta("name", "twitter:title", meta.title)

    // canonical：站点统一主域名 https://deepc.cn，避免查询参数/重复路径分散权重
    if (meta.canonical) {
      let link = document.head.querySelector<HTMLLinkElement>(
        'link[rel="canonical"]'
      )
      if (!link) {
        link = document.createElement("link")
        link.rel = "canonical"
        document.head.appendChild(link)
      }
      link.href = meta.canonical
    }

    // robots：/links、/device-login 等工具页不需要被收录
    upsertMeta("name", "robots", meta.noindex ? "noindex, nofollow" : "index, follow")
  }, [meta.title, meta.description, meta.canonical, meta.noindex])
}

/** 更新或创建 meta 标签（attr 为 name 或 property）。 */
function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(
    `meta[${attr}="${key}"]`
  )
  if (!el) {
    el = document.createElement("meta")
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute("content", content)
}
