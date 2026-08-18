import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import type { ReactNode, Ref } from "react"

import { cn } from "@/lib/utils"

export interface FullscreenSlide {
  id: string
  /** 进度点悬停提示 / 无障碍标签 */
  label?: string
  node: ReactNode
  /** 遮罩类：覆盖默认 contentOverlay 样式（分级虚化：越深雾越浓） */
  overlayClassName?: string
}

/** 默认内容屏遮罩（无自定义 overlayClassName 时使用） */
const DEFAULT_OVERLAY_CLASS = "bg-slate-950/60 backdrop-blur-md"

export interface FullscreenSlidesHandle {
  /** 跳转到指定屏（索引） */
  goTo: (index: number) => void
  /** 跳到下一屏 */
  next: () => void
  /** 回到上一屏 */
  prev: () => void
}

interface FullscreenSlidesProps {
  /** 每屏内容（按顺序渲染） */
  slides: FullscreenSlide[]
  /** 每屏高度类：默认 h-dvh；有 sticky 顶部导航时传 calc 类 */
  heightClass?: string
  /** 首页之后的屏添加半透明深色背景遮罩（内容页避免文字被海洋背景干扰） */
  contentOverlay?: boolean
  /** 外部控制跳转（如「探索更多」按钮） */
  ref?: Ref<FullscreenSlidesHandle>
  /** 当前屏变化回调（index；用于把屏与海洋状态统一绑定） */
  onActiveChange?: (index: number) => void
}

/**
 * 全屏幻灯展示（fullscreen slides）
 *   · 每屏固定占满视口（w-full + 指定高度），宽度恒定，滚动切换不变形
 *   · 左侧进度点：当前屏高亮（IntersectionObserver 跟踪），点击平滑跳转
 *   · 不用 scroll-snap：避免打断依赖原生滚动的动画（如滚动潜入海底）
 *   · contentOverlay：首页保持透明（海洋全景），后续内容页盖半透明深色遮罩
 */
export function FullscreenSlides({
  slides,
  heightClass = "h-dvh",
  contentOverlay = false,
  ref,
  onActiveChange,
}: FullscreenSlidesProps) {
  const [active, setActive] = useState(0)
  const sectionRefs = useRef<(HTMLElement | null)[]>([])
  // 回调放 ref：observer 只建立一次，避免依赖变化重建
  const onActiveChangeRef = useRef(onActiveChange)
  useEffect(() => {
    onActiveChangeRef.current = onActiveChange
  }, [onActiveChange])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = sectionRefs.current.indexOf(
              entry.target as HTMLElement
            )
            if (index >= 0) {
              setActive(index)
              onActiveChangeRef.current?.(index)
            }
          }
        }
      },
      // 屏占据视口一半以上视为当前屏
      { threshold: 0.5 }
    )
    for (const el of sectionRefs.current) {
      if (el) {
        observer.observe(el)
      }
    }
    return () => observer.disconnect()
  }, [slides.length])

  const goTo = useCallback((index: number) => {
    sectionRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    })
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      goTo,
      next: () => goTo(Math.min(active + 1, slides.length - 1)),
      prev: () => goTo(Math.max(active - 1, 0)),
    }),
    [active, slides.length, goTo]
  )

  return (
    <>
      {/* 左侧进度点：当前屏高亮，点击跳转 */}
      <nav
        aria-label="页面进度"
        className="fixed top-1/2 left-5 z-40 hidden -translate-y-1/2 flex-col items-center gap-3 sm:flex"
      >
        {slides.map((slide, index) => (
          <button
            key={slide.id}
            type="button"
            onClick={() => goTo(index)}
            aria-label={`前往${slide.label ?? `第 ${index + 1} 屏`}`}
            aria-current={index === active}
            title={slide.label}
            className={cn(
              "h-2.5 w-2.5 rounded-full transition-all duration-300",
              index === active
                ? "scale-125 bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)]"
                : "bg-white/35 hover:bg-white/70"
            )}
          />
        ))}
      </nav>

      {/* 每屏：固定占满视口 */}
      {slides.map((slide, index) => {
        // 首页透明；后续内容页盖半透明深色遮罩（字体可读）
        // 每屏可传 overlayClassName 覆盖默认遮罩 → 分级虚化（越深雾越浓）
        const overlay =
          contentOverlay && index > 0
            ? (slide.overlayClassName ?? DEFAULT_OVERLAY_CLASS)
            : null
        return (
          <section
            key={slide.id}
            id={slide.id}
            ref={(el) => {
              sectionRefs.current[index] = el
            }}
            className={cn(
              "w-full scroll-mt-16",
              heightClass,
              overlay && "relative"
            )}
          >
            {overlay && (
              <div
                aria-hidden="true"
                className={cn("absolute inset-0 z-0", overlay)}
              />
            )}
            {/* 内容屏统一收拢：左侧避让固定进度点（left-5 ≈30px），右侧对称收拢一丁点。
                包装 div 无条件 h-full：第一屏（无 overlay）也需占满 section 高度，
                否则内部 slide node 的 h-full / 百分比定位会塌陷为 0 */}
            <div
              className={cn(
                "h-full",
                overlay && "relative z-10 px-4 sm:px-12 lg:px-16"
              )}
            >
              {slide.node}
            </div>
          </section>
        )
      })}
    </>
  )
}
