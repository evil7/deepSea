import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { animate } from "animejs"
import { ArrowUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// PageHeader —— 二级功能页共享页头（统一面包屑 / 标题 / 描述 / 操作区的视觉）
//   · 四个子页面（插件生态、插件详情、社区、讨论详情）共用，杜绝各自手写
//     页头造成的字号 / 间距 / 结构不一致
//   · sticky 顶部固定：滚动越过页头后吸附在 topbar（h-16=64px）之下，
//     由「标题 + 描述（多行）」压缩为「标题 + 操作（单行）」，
//     面包屑与描述隐藏，标题字号收缩
//   · 用 sentinel + IntersectionObserver 检测 sticky 状态（rootMargin 顶部
//     收缩 64px 与 top-16 对齐），stuck 后切换样式，全程 CSS transition
//
// 用法：
//   <PageHeader
//     breadcrumb={<>首页<span>/</span>插件生态</>}   // 可选
//     title="插件生态"                               // 可选（主标题）
//     description={<Badge>…</Badge>}                 // 可选（标题下方）
//     actions={<Button>…</Button>}                   // 可选（右侧操作区）
//   />
// ---------------------------------------------------------------------------

interface PageHeaderProps {
  /** 面包屑（标题上方，sticky 后隐藏） */
  breadcrumb?: ReactNode
  /** 主标题（sticky 后收缩字号、保持单行） */
  title?: ReactNode
  /** 标题下方描述 / 徽章区（sticky 后隐藏） */
  description?: ReactNode
  /** 右侧操作按钮区（sticky 后保留、与标题同排单行） */
  actions?: ReactNode
  /** 是否启用 sticky 顶部固定（默认 true） */
  sticky?: boolean
  /** sticky 时是否显示 [↑ Top] 返回顶部按钮（默认 true） */
  showTopButton?: boolean
  /** 透传到 header 的额外类名 */
  className?: string
}

/** topbar 高度（h-16 = 64px）：sticky 吸附位置与 sentinel 判定边界统一 */
const TOPBAR_H = 64

/** animejs 平滑滚动到顶（数值动画 + onUpdate 写 scrollY） */
function smoothScrollToTop() {
  const obj = { y: window.scrollY }
  animate(obj, {
    y: [obj.y, 0],
    duration: 600,
    ease: "outExpo",
    onUpdate: () => window.scrollTo(0, obj.y),
  })
}

export function PageHeader({
  breadcrumb,
  title,
  description,
  actions,
  sticky = true,
  showTopButton = true,
  className,
}: PageHeaderProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [stuck, setStuck] = useState(false)
  // 手机端不做 sticky：不吸附也不触发 stuck 收缩（页头保持完整展开）
  const isMobile = useIsMobile()
  const stickyEnabled = sticky && !isMobile

  useEffect(() => {
    if (!stickyEnabled) {
      return
    }
    const sentinel = sentinelRef.current
    if (!sentinel) {
      return
    }
    // rootMargin 顶部收缩 64px：sentinel 滚到 topbar 下边缘（即页头刚好吸附）
    // 时即判定 stuck，与 sticky top-16 精确对齐，无延迟
    const observer = new IntersectionObserver(
      ([entry]) => {
        setStuck(!entry.isIntersecting)
      },
      { rootMargin: `-${TOPBAR_H}px 0px 0px 0px`, threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [stickyEnabled])

  return (
    <>
      {/* sentinel：页头正上方 1px（文档流中），滚动离开视口顶部即 stuck。
          必须与 header 平级（不能包在 header 的绝对定位父容器里），否则 sticky
          的 containing block 高度 = 页头自身高度，吸附空间为零、sticky 失效 */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
      <header
        data-stuck={stuck ? "true" : "false"}
        className={cn(
          // -mx/px：抵消父容器 padding，让 sticky 背景/边框横跨到 max-w 边缘
          // sticky 仅桌面启用（手机端 stickyEnabled=false，不吸附）
          // group：供 actions 内子按钮用 group-data-[stuck=true]: 在吸附时隐藏
          "group z-20 -mx-4 px-4 transition-all duration-200 sm:-mx-6 sm:px-6",
          stickyEnabled && "sticky top-16",
          stuck
            ? "border-b border-border bg-background/85 py-2 backdrop-blur-md"
            : "border-b border-transparent pb-6",
          className
        )}
      >
        {breadcrumb && (
          <nav
            className={cn(
              "mb-1 flex items-center gap-1.5 text-xs text-muted-foreground transition-all duration-200",
              stuck && "hidden"
            )}
          >
            {breadcrumb}
          </nav>
        )}

        {/* 标题 + 操作（sticky 前后始终单行横向排列） */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1
            className={cn(
              "min-w-0 font-semibold tracking-tight text-foreground transition-all duration-200",
              stuck ? "truncate text-base" : "text-2xl"
            )}
          >
            {title}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {showTopButton && (
              <Button
                type="button"
                onClick={smoothScrollToTop}
                aria-label="返回顶部"
                variant="ghost"
                className={stuck ? "inline-flex" : "hidden"}
              >
                <ArrowUp className="size-4" />
                Top
              </Button>
            )}
          </div>
        </div>

        {description && (
          <div
            className={cn(
              "mt-2 transition-all duration-200",
              stuck && "hidden"
            )}
          >
            {description}
          </div>
        )}
      </header>
    </>
  )
}
