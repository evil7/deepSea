// ---------------------------------------------------------------------------
// 生成 apps/web/public/sitemap.xml（构建前运行：web build 已自动串联）
//
//   策略：仅收录「稳定的主要页面」，不收录动态数据页。
//     · 社区帖子（/community/dpc/:number、/community/dsh/:number）：
//       URL 集合随 GitHub Discussions 频繁变动，静态 sitemap 无法及时同步
//       （每次数据同步需重新构建部署），易产生死链/遗漏 → 排除。
//       帖子靠 /community/* 列表页内链 + 详情页 canonical + GitHub 原生 URL 被发现。
//     · 插件详情（/plugin/:owner/:repo）：同理数据驱动、生态动态 → 排除。
//
//   输出：public/sitemap.xml（仅主要页面）
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SITE = "https://deepc.cn"
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, "../apps/web/public")

/** 主要静态页面（changefreq / priority 提示爬虫抓取节奏） */
const STATIC_PATHS = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/plugins", changefreq: "daily", priority: "0.9" },
  { path: "/community/dpc", changefreq: "daily", priority: "0.8" },
  { path: "/community/dsh", changefreq: "daily", priority: "0.8" },
]

const urls = STATIC_PATHS.map(
  (s) => `  <url>
    <loc>${SITE}${s.path}</loc>
    <changefreq>${s.changefreq}</changefreq>
    <priority>${s.priority}</priority>
  </url>`
)

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`

mkdirSync(publicDir, { recursive: true })
writeFileSync(join(publicDir, "sitemap.xml"), xml, "utf-8")
console.log(
  `[sitemap] ${SITE}/sitemap.xml：${urls.length} 个 URL（仅稳定主要页面，动态数据页不入站地图）`
)
