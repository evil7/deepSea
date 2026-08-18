import { useEffect, useRef } from "react"
import { animate, stagger } from "animejs"

// ---------------------------------------------------------------------------
// useSlideReveal —— 首页全屏板块进入动画（animejs，仅用于展示/落地页）
//   · 监听宿主元素是否进入视口（IntersectionObserver，threshold 0.5）
//   · 激活时对「标题」与「卡片组」做 stagger 上浮淡入（translateY 28→0）
//   · 离开时 revert 回到初始态（translateY 28 + opacity 0），重进再播
//   · 与 FullscreenSlides 的进度点/海洋状态同源（同一视口判定），零冲突
//
// 用法：
//   const sectionRef = useSlideReveal<HTMLElement>({
//     titleSelector: ".slide-reveal-title",
//     itemSelector: ".slide-reveal-item",
//   })
//   <section ref={sectionRef}>...</section>
// ---------------------------------------------------------------------------

interface SlideRevealOptions {
  /** 标题/眉题选择器（整块上浮淡入，先于卡片） */
  titleSelector?: string
  /** 卡片组选择器（stagger 逐个上浮淡入） */
  itemSelector?: string
  /** 进入视口判定比例（默认 0.5，与 FullscreenSlides 一致） */
  threshold?: number
}

const DEFAULT_DURATION = 700
const DEFAULT_STAGGER = 80
const DEFAULT_EASING = "easeOutExpo"

/** 元素进入视口时触发 animejs stagger 进入动画；离开时 revert 重置 */
export function useSlideReveal<T extends HTMLElement>({
  titleSelector = ".slide-reveal-title",
  itemSelector = ".slide-reveal-item",
  threshold = 0.5,
}: SlideRevealOptions = {}) {
  const hostRef = useRef<T | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    // 初始态：标题/卡片全部上浮 28px + 透明（仅对标记元素，不干扰布局）
    const titleEls = host.querySelectorAll<HTMLElement>(titleSelector)
    const itemEls = host.querySelectorAll<HTMLElement>(itemSelector)
    const allEls = [...titleEls, ...itemEls]
    if (allEls.length === 0) {
      return
    }
    for (const el of allEls) {
      el.style.opacity = "0"
      el.style.transform = "translateY(28px)"
    }

    // 进入动画：标题先上浮，卡片组 stagger 跟进
    const play = () => {
      if (titleEls.length > 0) {
        animate(titleEls, {
          translateY: [28, 0],
          opacity: [0, 1],
          duration: DEFAULT_DURATION,
          easing: DEFAULT_EASING,
        })
      }
      if (itemEls.length > 0) {
        animate(itemEls, {
          translateY: [28, 0],
          opacity: [0, 1],
          duration: DEFAULT_DURATION,
          delay: stagger(DEFAULT_STAGGER, {
            start: titleEls.length > 0 ? 220 : 0,
          }),
          easing: DEFAULT_EASING,
        })
      }
    }

    // 离开动画：revert 回到初始态（重进再播）
    const reset = () => {
      for (const el of allEls) {
        el.style.opacity = "0"
        el.style.transform = "translateY(28px)"
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            play()
          } else {
            reset()
          }
        }
      },
      { threshold }
    )
    observer.observe(host)
    return () => {
      observer.disconnect()
      for (const el of allEls) {
        el.style.opacity = ""
        el.style.transform = ""
      }
    }
  }, [titleSelector, itemSelector, threshold])

  return hostRef
}
