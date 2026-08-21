import { useEffect, useImperativeHandle, useRef } from "react"
import type { ReactNode, Ref } from "react"
import { Swiper, SwiperSlide } from "swiper/react"
import type { Swiper as SwiperInstance } from "swiper"
import { Keyboard, Mousewheel, Pagination } from "swiper/modules"
import "swiper/css"
import "swiper/css/pagination"

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
  /** 首页之后的屏添加半透明深色背景遮罩（内容页避免文字被海洋背景干扰） */
  contentOverlay?: boolean
  /** 外部控制跳转（如「探索更多」按钮） */
  ref?: Ref<FullscreenSlidesHandle>
  /** 当前屏变化回调（index；用于把屏与海洋状态统一绑定） */
  onActiveChange?: (index: number) => void
}

/**
 * 全屏幻灯展示（Swiper 垂直翻页封装）
 *   · direction="vertical" + slidesPerView=1：每屏占满容器，滚轮/键盘/触屏翻页
 *   · 左侧进度点：Swiper pagination（自定义样式对齐原进度点视觉）
 *   · onSlideChange 上报当前屏 index（进入第二屏/回第一屏 → 驱动海洋下潜/上浮）
 *   · contentOverlay：首页保持透明（海洋全景），后续内容页盖半透明深色遮罩
 */
export function FullscreenSlides({
  slides,
  contentOverlay = false,
  ref,
  onActiveChange,
}: FullscreenSlidesProps) {
  const swiperRef = useRef<SwiperInstance | null>(null)
  // 回调放 ref：onSlideChange 只绑定一次，避免 Swiper 实例依赖变化重建
  const onActiveChangeRef = useRef(onActiveChange)
  useEffect(() => {
    onActiveChangeRef.current = onActiveChange
  }, [onActiveChange])

  useImperativeHandle(
    ref,
    () => ({
      goTo: (index: number) => swiperRef.current?.slideTo(index),
      next: () => swiperRef.current?.slideNext(),
      prev: () => swiperRef.current?.slidePrev(),
    }),
    []
  )

  return (
    <Swiper
      direction="vertical"
      slidesPerView={1}
      speed={700}
      mousewheel={{ thresholdDelta: 30 }}
      keyboard={{ enabled: true }}
      pagination={{ clickable: true }}
      modules={[Mousewheel, Keyboard, Pagination]}
      onSwiper={(swiper) => {
        swiperRef.current = swiper
      }}
      onSlideChange={(swiper) => {
        onActiveChangeRef.current?.(swiper.activeIndex)
      }}
      className="h-full w-full"
    >
      {slides.map((slide, index) => {
        // 首页透明；后续内容页盖半透明深色遮罩（字体可读）
        // 每屏可传 overlayClassName 覆盖默认遮罩 → 分级虚化（越深雾越浓）
        const overlay =
          contentOverlay && index > 0
            ? (slide.overlayClassName ?? DEFAULT_OVERLAY_CLASS)
            : null
        return (
          <SwiperSlide
            key={slide.id}
            id={slide.id}
            className="relative overflow-hidden"
          >
            {overlay && (
              <div
                aria-hidden="true"
                className={cn("absolute inset-0 z-0", overlay)}
              />
            )}
            {/* 内容层：无条件 h-full 撑满 slide（第一屏无 overlay 也需占满，
                否则内部 node 的 h-full / 百分比定位会塌陷为 0） */}
            <div
              className={cn(
                "relative h-full",
                overlay && "z-10 px-4 sm:px-12 lg:px-16"
              )}
            >
              {slide.node}
            </div>
          </SwiperSlide>
        )
      })}
    </Swiper>
  )
}
