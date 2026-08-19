import { useLayoutEffect, useRef } from "react"
import { animate } from "animejs"

// ---------------------------------------------------------------------------
// usePageEnter —— 二级功能页进入过渡（animejs，仅用于展示/落地页）
//   · 页面挂载时对整个宿主容器做「上浮 + 淡入」（translateY distance→0）
//   · 用 useLayoutEffect 在首次绘制前设置初始态，杜绝可见闪烁
//   · 与首页 useSlideReveal 的区别：后者按「进入视口」触发（可重复），
//     这里按「页面挂载」触发（一次性，路由切换即进入）
//
// 用法：
//   const pageRef = usePageEnter<HTMLDivElement>()
//   <div ref={pageRef} className="...">...</div>
// ---------------------------------------------------------------------------

interface PageEnterOptions {
  /** 上浮起始距离（px，默认 24） */
  distance?: number
  /** 动画时长（ms，默认 520） */
  duration?: number
  /** animejs v4 缓动（默认 easeOutExpo） */
  ease?: string
}

export function usePageEnter<T extends HTMLElement>({
  distance = 24,
  duration = 520,
  ease = "easeOutExpo",
}: PageEnterOptions = {}) {
  const ref = useRef<T | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 首次绘制前设置初始态（避免 flash 一帧可见内容）
    el.style.opacity = "0"
    el.style.transform = `translateY(${distance}px)`
    animate(el, {
      translateY: [distance, 0],
      opacity: [0, 1],
      duration,
      ease,
      // 动画结束清除 inline transform/opacity：残留的 transform 会创建新的
      // containing block，导致其子元素（如 sticky 页头）失效
      onComplete: () => {
        el.style.transform = ""
        el.style.opacity = ""
      },
    })
  }, [distance, duration, ease])

  return ref
}
