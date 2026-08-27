import { useEffect, useMemo, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  BookMarked,
  Bug,
  CircleDot,
  Download,
  ExternalLink,
  FolderGit2,
  GitFork,
  Home,
  RefreshCw,
  Star,
} from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import DOMPurify from "dompurify"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import remarkGfm from "remark-gfm"
// GitHub 官方 Markdown 排版（变量驱动 base 版，随站点浅色/深色主题自动切换）
import "github-markdown-css/github-markdown.css"

import {
  fetchRepoInfo,
  fetchRepoReadme,
  fetchRepoRelease,
  resolveReadmeAssetUrl,
} from "@/lib/github/repo"
import type { RepoInfo, RepoReadme, RepoRelease } from "@/lib/github/types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePageEnter } from "@/components/showcase/page-enter"
import { PageHeader } from "@/components/layout/page-header"
import { InstallCommand } from "@/components/home/install-command"

// ---------------------------------------------------------------------------
// /plugin/:owner/:repo —— 插件详情页
//   左侧：README 渲染（react-markdown + GFM，相对图片转 raw 地址）
//   右侧：仓库 about 信息（描述/star/fork/语言/主题/时间线等）
// ---------------------------------------------------------------------------

function formatStars(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(n)
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) {
    return "-"
  }
  const loc = locale.startsWith("zh") ? "zh-CN" : "en-US"
  return new Date(iso).toLocaleDateString(loc, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
}

/**
 * 从 README markdown 提取安装命令（严格匹配 dsh 真实 CLI 子命令）
 *
 * dsh 真实命令（官方 deepseek-harness apps/cli/src/args.ts）：
 *   `dsh plugin --profile <name> add <package>`  —— plugin 是子命令，
 *   `--profile <name>` 是必填项，之后转发 pnpm 参数（add/remove/why...）。
 *   ⚠️ 没有 `dsh skill add`（skill 是内部包，非 CLI 子命令）；
 *   ⚠️ `dsh plugin add xxx` 缺 --profile 是错误写法。
 *
 * <package> 支持 git/npm/tarball 渠道：github:owner/repo#tag、git+https://...、
 *   包名、./xxx.tgz 等。
 *
 * 仅当 README 明确给出有效安装命令时返回该命令；否则返回 null（调用方不显示）。
 */
function extractInstallCommand(markdown: string): string | null {
  // --profile 必须在 plugin 之后、add/install 之前（commander requiredOption 顺序）
  const re =
    /dsh\s+plugin\s+--profile\s+(\S+)\s+(add|install)\s+([^\s`"<>\\|]+)/i
  const m = markdown.match(re)
  if (!m?.[1] || !m[3]) {
    return null
  }
  return `dsh plugin --profile ${m[1]} ${m[2].toLowerCase()} ${m[3]}`
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready"
      info: RepoInfo
      readme: RepoReadme | null
      release: RepoRelease | null
    }

export function PluginDetailPage() {
  const { t, i18n } = useTranslation()
  const { owner = "", repo = "" } = useParams()
  const [state, setState] = useState<DetailState>({ status: "loading" })

  const load = () => {
    setState({ status: "loading" })
    Promise.all([
      fetchRepoInfo(owner, repo),
      fetchRepoReadme(owner, repo),
      fetchRepoRelease(owner, repo),
    ])
      .then(([info, readme, release]) => {
        setState({ status: "ready", info, readme, release })
      })
      .catch((err) => {
        setState({
          status: "error",
          message:
            err.status === 404
              ? t("plugin.repoNotFound")
              : err.status === 403 || err.status === 429
                ? t("plugin.rateLimited")
                : t("plugin.loadFailed"),
        })
      })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo])

  // 安装命令：README 加载后严格提取 `dsh plugin --profile <name> add <pkg>`；
  // 未命中返回 null（header 不显示安装提示）
  const installCommand = useMemo(() => {
    if (state.status === "ready" && state.readme) {
      return extractInstallCommand(state.readme.markdown)
    }
    return null
  }, [state])

  const pageRef = usePageEnter<HTMLDivElement>()

  return (
    <div
      ref={pageRef}
      className="relative z-10 mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-7xl px-4 py-10 sm:px-6"
    >
      {/* 页头：面包屑 + 仓库标题（共享 PageHeader） */}
      <PageHeader
        breadcrumb={
          <>
            <Link
              to="/"
              className="flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <Home className="size-3.5" />
              {t("plugin.breadcrumbHome")}
            </Link>
            <span>/</span>
            <Link
              to="/plugins"
              className="transition-colors hover:text-foreground"
            >
              {t("plugin.breadcrumbEcosystem")}
            </Link>
          </>
        }
        title={
          <span className="font-mono">
            {owner}/{repo}
          </span>
        }
        actions={
          installCommand ? <InstallCommand command={installCommand} inline /> : undefined
        }
      />

      {state.status === "loading" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Skeleton className="h-10 w-64 bg-muted" />
            <Skeleton className="h-4 w-full bg-muted" />
            <Skeleton className="h-4 w-3/4 bg-muted" />
            <Skeleton className="h-64 w-full bg-muted" />
          </div>
          <Skeleton className="h-80 rounded-xl bg-muted" />
        </div>
      )}

      {state.status === "error" && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
          <p className="text-lg font-medium text-foreground">{t("plugin.errorTitle")}</p>
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            className="mt-2 border-border bg-card text-foreground hover:bg-accent"
          >
            <RefreshCw className="size-3.5" />
            {t("common.retry")}
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* 左侧：README（移动端单列时排第二，桌面端 order-1 在左） */}
          <div className="min-w-0 order-2 rounded-xl border border-border bg-card lg:order-1">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <BookMarked className="size-4 text-cyan-300" />
                README
              </div>
              {state.readme && (
                <a
                  href={state.readme.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t("common.viewOnGitHub")}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <div className="p-5 sm:p-8">
              {state.readme ? (
                <MarkdownBody
                  markdown={state.readme.markdown}
                  owner={owner}
                  repo={repo}
                  branch={state.info.default_branch}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t("plugin.noReadme")}</p>
              )}
            </div>
          </div>

          {/* 右侧：about 信息（sticky 固定，滚动不消失）
              top-34.5(138px) = topbar 64 + stuck header ~58 + 间隔 16，
              视觉间隔与未滚动时（header pb-6=24px）一致，不重叠不挤兑。
              移动端单列时 order-1 排最前（about 优先于 README） */}
          <aside className="order-1 space-y-4 lg:order-2 lg:sticky lg:top-34.5 lg:self-start">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <img
                  src={state.info.owner.avatar_url}
                  alt={state.info.owner.login}
                  className="size-11 rounded-full border border-border"
                  loading="lazy"
                />
                <div className="min-w-0">
                  {/* 标题：repo 名（同 GitHub 主页般可点击跳转） */}
                  <a
                    href={state.info.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-mono text-base font-bold text-foreground transition-colors hover:text-cyan-300"
                  >
                    {repo}
                  </a>
                  <a
                    href={`https://github.com/${state.info.owner.login}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-cyan-300/80 hover:text-cyan-200"
                  >
                    @{state.info.owner.login}
                  </a>
                </div>
              </div>

              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                {state.info.description || t("common.noDescription")}
              </p>

              {/* 统计 */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Stat
                  icon={<Star className="size-3.5 text-amber-300" />}
                  value={formatStars(state.info.stargazers_count)}
                  label="Stars"
                />
                <Stat
                  icon={<GitFork className="size-3.5 text-cyan-300" />}
                  value={formatStars(state.info.forks_count)}
                  label="Forks"
                />
                <Stat
                  icon={<CircleDot className="size-3.5 text-emerald-300" />}
                  value={String(state.info.open_issues_count)}
                  label="Issues"
                />
              </div>

              {/* 元信息 */}
              <dl className="mt-5 space-y-2.5 text-xs">
                <MetaRow label={t("plugin.language")}>{state.info.language ?? "-"}</MetaRow>
                <MetaRow label={t("plugin.license")}>{state.info.license ?? "-"}</MetaRow>
                <MetaRow label={t("plugin.defaultBranch")}>
                  <span className="font-mono">{state.info.default_branch}</span>
                </MetaRow>
                <MetaRow label={t("plugin.repoSize")}>
                  {`${(state.info.size / 1024).toFixed(1)} MB`}
                </MetaRow>
                <MetaRow label={t("plugin.createdAt")}>
                  {formatDate(state.info.created_at, i18n.language)}
                </MetaRow>
                <MetaRow label={t("plugin.pushedAt")}>
                  {formatDate(state.info.pushed_at, i18n.language)}
                </MetaRow>
              </dl>

              {/* 主题标签 */}
              {state.info.topics.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {state.info.topics.slice(0, 8).map((topic) => (
                    <span
                      key={topic}
                      className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {topic}
                    </span>
                  ))}
                </div>
              )}

              {/* 最新发布（与 about 卡片一体、直接平铺不嵌套，避免空间局促；无 release 则隐藏） */}
              {state.release && (
                <div className="mt-5 border-t border-border pt-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Download className="size-3.5 text-cyan-300" />
                    {t("plugin.latestRelease")}
                  </div>
                  <a
                    href={state.release.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 flex items-center justify-between gap-2 py-1 transition-colors hover:text-cyan-300"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-semibold text-foreground">
                        {state.release.tag_name}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {state.release.name || state.release.tag_name}
                        {state.release.published_at
                          ? ` · ${formatDate(state.release.published_at, i18n.language)}`
                          : ""}
                      </p>
                    </div>
                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                  </a>
                  {state.release.assets.length > 0 && (
                    <div className="mt-1.5 flex flex-col">
                      {state.release.assets.slice(0, 3).map((asset) => (
                        <a
                          key={asset.download_url}
                          href={asset.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between gap-2 py-1 transition-colors hover:text-cyan-300"
                        >
                          <span className="truncate font-mono text-[11px] text-foreground/80">
                            {asset.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-[10px] text-cyan-300">
                            <Download className="size-3" />
                            {(asset.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 操作 */}
              <div className="mt-5 flex flex-col gap-2">
                <Button asChild size="sm" className="w-full">
                  <a
                    href={state.info.html_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FolderGit2 className="size-4" />
                    {t("plugin.githubHome")}
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="w-full border-border bg-muted text-foreground hover:bg-accent"
                >
                  <a
                    href={`https://github.com/${state.info.owner.login}/${repo}/issues/new`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Bug className="size-4" />
                    {t("plugin.reportIssue")}
                  </a>
                </Button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: string
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg bg-muted py-2.5">
      <span className="text-base font-bold text-foreground">{value}</span>
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        {label}
      </span>
    </div>
  )
}

function MetaRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground">{children}</dd>
    </div>
  )
}

// —— README markdown 渲染（DOMPurify 安全净化 + 直接渲染）——
// 方案（比 iframe 更优：内容随文档流、无内部滚动条/高度同步、无 postMessage）：
//   · react-markdown + remark-gfm + rehype-raw 解析（含 GitHub README 常用
//     raw HTML：<picture>/<div align>/<details>/<kbd>/<video> 等）
//   · renderToStaticMarkup 生成 HTML 字符串
//   · DOMPurify.sanitize 白名单净化（默认禁 script/style/事件属性/javascript:
//     等危险内容；补充 GitHub 常用标签/属性）→ dangerouslySetInnerHTML 渲染
//   · 相对图片/链接 → raw.githubusercontent 绝对地址；危险协议再剔除（双保险）
//   · 排版以 github-markdown-css（dark）为官方基础，仅对背景/字体/链接色/
//     图片缩放做高优先级覆盖（.readme-body.markdown-body 作用域，不污染全局）
//   · 图片透传 width/height/align 属性（DOM 尺寸控制）+ height:auto 等比缩放

/** DOMPurify 配置：默认白名单之上扩展 GitHub README 常用标签/属性 */
const README_PURIFY_CONFIG = {
  // 默认白名单已含大部分排版标签；这里显式扩展 GitHub README 常用结构
  ADD_TAGS: ["picture", "source", "video", "kbd", "details", "summary"],
  ADD_ATTR: [
    "width",
    "height",
    "align",
    "target",
    "rel",
    "controls",
    "autoplay",
    "loop",
    "muted",
    "poster",
    "type",
  ],
}

/** README 覆盖样式：以 github-markdown-css（dark）为基础，
 *  仅对关键颜色/背景做高优先级覆盖（.readme-body.markdown-body 特异性更高，
 *  且 <style> 注入在 import css 之后），其余排版完全遵循官方行为 */
const README_BODY_CSS = `
  /* 背景透明：融入站点玻璃卡片（官方 dark 为 #0d1117 实底） */
  .readme-body.markdown-body {
    background-color: transparent;
    /* 站点字体与字号（官方为系统 sans 16px） */
    font-family: inherit;
    font-size: 14px;
    line-height: 1.7;
    /* 主题变量接管：github-markdown-css（变量驱动 base 版）的
       --fgColor-* / --bgColor-* / --borderColor-* → 站点 shadcn token，
       使 markdown 排版随站点浅色/深色主题（html.dark）自动切换 */
    --fgColor-default: var(--foreground);
    --fgColor-muted: var(--muted-foreground);
    --fgColor-accent: var(--primary);
    --fgColor-attention: var(--primary);
    --fgColor-danger: var(--foreground);
    --fgColor-success: var(--foreground);
    --fgColor-done: var(--foreground);
    --bgColor-default: transparent;
    --bgColor-muted: var(--muted);
    --bgColor-neutral-muted: var(--muted);
    --bgColor-attention-muted: var(--muted);
    --borderColor-default: var(--border);
    --borderColor-muted: var(--border);
    --borderColor-accent-emphasis: var(--primary);
    --borderColor-attention-emphasis: var(--border);
    --borderColor-danger-emphasis: var(--border);
    --borderColor-done-emphasis: var(--border);
    --borderColor-success-emphasis: var(--border);
  }
  /* 链接用站点主色（浅色深蓝 / 深色海洋青） */
  .readme-body.markdown-body a { color: var(--primary); }
  .readme-body.markdown-body a:hover { color: color-mix(in oklab, var(--primary) 72%, var(--foreground)); }
  /* 图片：保留 DOM 尺寸控制（width/height 属性生效），
     height:auto 保证等比缩放不拉伸（官方前端渲染行为）；
     display:inline 覆盖 Tailwind preflight 的 block，badge 才能横排（官方行为） */
  .readme-body.markdown-body img {
    display: inline;
    vertical-align: baseline;
    height: auto;
  }
  .readme-body.markdown-body video { max-width: 100%; height: auto; }
  .readme-body.markdown-body picture { display: block; }
  /* 代码块背景对齐站点 muted token（浅/深自动切换） */
  .readme-body.markdown-body pre { background-color: var(--muted); }
`

/** 过滤危险协议（javascript:/data:/vbscript:）与相对路径 → raw 绝对地址 */
function sanitizeUrl(
  url: string,
  owner: string,
  repo: string,
  branch: string
): string {
  const trimmed = url.trim()
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return "#"
  }
  if (/^(https?:)?\/\//.test(trimmed)) {
    return trimmed
  }
  return resolveReadmeAssetUrl(owner, repo, branch, trimmed)
}

function MarkdownBody({
  markdown,
  owner,
  repo,
  branch,
}: {
  markdown: string
  owner: string
  repo: string
  branch: string
}) {
  // 渲染静态 HTML（无事件）→ DOMPurify 白名单净化（剔除 script/事件属性/
  // javascript: 协议）→ dangerouslySetInnerHTML 直接渲染（随文档流，无滚动条）
  // react-markdown 必须在渲染时动态构造 components（依赖 owner/repo/branch），
  // 无法提到组件外；且只用于 renderToStaticMarkup 字符串化，无交互成本
  /* oxlint-disable react/no-unstable-nested-components */
  const html = useMemo(() => {
    const body = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeRaw, {}]]}
        components={{
          img: (props) => (
            // 透传 width/height/align 等 DOM 尺寸控制属性（官方行为）
            <img
              {...props}
              src={
                props.src
                  ? sanitizeUrl(props.src, owner, repo, branch)
                  : undefined
              }
              alt={props.alt ?? ""}
              loading="lazy"
            />
          ),
          a: (props) => {
            const href = props.href
            return (
              <a
                {...props}
                href={href ? sanitizeUrl(href, owner, repo, branch) : "#"}
                target="_blank"
                rel="noreferrer noopener"
              />
            )
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    )
    return DOMPurify.sanitize(body, README_PURIFY_CONFIG)
  }, [markdown, owner, repo, branch])
  /* oxlint-enable react/no-unstable-nested-components */

  return (
    <>
      <style>{README_BODY_CSS}</style>
      <div
        className="readme-body markdown-body max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  )
}
