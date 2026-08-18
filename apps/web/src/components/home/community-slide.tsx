import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { animate } from "animejs"

import { useSlideReveal } from "@/components/showcase/slide-reveal"
import {
  loadDiscussionsSeed,
  loadOfficialDiscussionsSeed,
  subscribeDiscussions,
  type DiscussionSummary,
} from "@/lib/github/discussions"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// CommunitySlide —— 首页「讨论交流」屏（双社区撕纸分割 + hover 推移）
//   左半「蓝鲸社区」（自家 evil7/deepSea，可互动） · 右半「浪尖酒馆」
//   （官方 deepseek-ai/deepseek-harness，只读）。
//   · 撕纸分割线：接近垂直、稍作偏移（轻微右上→左下），SVG clipPath 左右分割。
//   · hover 动效（animejs）：鼠标进入某半区 → 分割线向对侧推移，被 hover 的
//     图扩至 4/5，未 hover 的图渐变为灰白；移出容器 → 分割线复位居中。
//   · 本版为版面占位：左右半区为渐变底色（后续填充背景图），无内部卡片、无 VS。
//   · 左下角「蓝鲸社区」、右上角「浪尖酒馆」。
//   · 数据：两个社区 seed（登录用户由前端 worker 定时刷新自家社区）。
// ---------------------------------------------------------------------------

/** 撕纸线锯齿段数（越多越碎） */
const TORN_TEETH = 14
/** 分割线默认位置（居中，0~1 归一化 x） */
const CENTER = 0.5
/** hover 左图 → 分割线右移，左图占 4/5 */
const HOVER_LEFT = 0.8
/** hover 右图 → 分割线左移，右图占 4/5 */
const HOVER_RIGHT = 0.2
/** 斜线偏移量（顶部相对底部右移 = 轻微右上→左下，接近垂直） */
const TILT = 0.04

/** 分割线推移缓动：弹性回弹（撕裂感） */
const TORN_EASE = "outElastic(1, 0.55)"
/** 图片缩放景深缓动（轻微回弹） */
const ZOOM_EASE = "outCubic"
/** 图片缩放跟进的延迟（ms，时序错拍：裂缝先动、图后动） */
const ZOOM_DELAY = 80
/** 漂浮呼吸幅度（px） */
const FLOAT_AMP = 10
/** 左右漂浮周期（ms，异步错拍） */
const FLOAT_PERIOD_LEFT = 10000
const FLOAT_PERIOD_RIGHT = 7000
/** hover 放大 / 后撤缩放 */
const ZOOM_ACTIVE = 1.05
const ZOOM_IDLE = 0.94

/** 数值裁剪到 [0,1] */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 归一化坐标 → path 字符串（x y） */
function fmt(p: [number, number]): string {
  return `${p[0].toFixed(4)} ${p[1].toFixed(4)}`
}

/**
 * 构造接近垂直、稍作偏移的不规则撕纸分割线（归一化坐标 0~1）。
 *   · pos —— 分割线顶部 x（0~1），底部 = pos - TILT（轻微倾斜）
 *   · stroke    —— 描边用（撕纸裂缝线）
 *   · leftClip  —— 线左侧 clipPath（蓝鲸社区）
 *   · rightClip —— 线右侧 clipPath（浪尖酒馆）
 * 锯齿沿水平方向（法线）交替偏移，制造不规则毛边。
 */
function buildTornGeometry(
  pos: number,
  teeth = TORN_TEETH
): {
  stroke: string
  leftClip: string
  rightClip: string
} {
  const topX = pos + TILT
  const bottomX = pos - TILT

  const pts: [number, number][] = []
  for (let i = 0; i <= teeth; i++) {
    const t = i / teeth
    const bx = topX + (bottomX - topX) * t
    const by = t
    // 水平方向锯齿（垂直于接近垂直的线），不规则幅度 + 交替方向
    const amp = 0.005 + (i % 3) * 0.004
    const sign = i % 2 === 0 ? 1 : -1
    pts.push([bx + amp * sign, by])
  }

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p)}`).join(" ")

  // 左半：左上 (0,0) → 线起点 → 沿线到底 → 左下 (0,1) → 闭合
  const leftClip = `M 0 0 L ${fmt(pts[0])} ${pts
    .slice(1)
    .map((p) => `L ${fmt(p)}`)
    .join(" ")} L 0 1 Z`
  // 右半：右上 (1,0) → 右下 (1,1) → 线终点 → 反沿线到起点 → 闭合
  const rightClip = `M 1 0 L 1 1 L ${fmt(pts[teeth])} ${pts
    .slice(0, teeth)
    .toReversed()
    .map((p) => `L ${fmt(p)}`)
    .join(" ")} Z`

  return { stroke: line, leftClip, rightClip }
}

/**
 * 逐字动画标题 —— 差异化风格：
 *   · rise   「蓝鲸社区」沉稳上浮：逐字从水下浮起 + 波浪错位 + outExpo，
 *            浮起后水中错落浮动（深海巨物的呼吸感）
 *   · splash 「浪尖酒馆」轻快溅落：逐字从上方迸溅 + 旋转错位 + outBounce，
 *            落下后轻微摇晃（浪花泡沫的弹跳感）
 */
function AnimatedTitle({
  text,
  variant,
  tone,
  active,
}: {
  text: string
  variant: "rise" | "splash"
  tone: "cyan" | "amber"
  active: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const playedRef = useRef(false)
  const loopsRef = useRef<ReturnType<typeof animate>[]>([])
  const activeAnimRef = useRef<ReturnType<typeof animate> | null>(null)

  // 进入视口 → 逐字动画 + 持续微动效
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chars = Array.from(el.querySelectorAll<HTMLSpanElement>(".title-char"))
    const isRise = variant === "rise"
    // 错位基线（rise 波浪 / splash 锯齿），4 字循环
    const offsets = isRise ? [0, -6, 4, -8] : [0, 5, -4, 7]

    const play = () => {
      chars.forEach((c, i) => {
        const base = offsets[i % offsets.length]
        const startLoop = () => {
          const loop = isRise
            ? animate(c, {
                translateY: [base, base + (i % 2 === 0 ? 6 : -6), base],
                duration: 3600 + i * 320,
                ease: "inOutSine",
                loop: true,
              })
            : animate(c, {
                rotate: [0, i % 2 === 0 ? 6 : -6, 0],
                translateY: [base, base + (i % 2 === 0 ? -3 : 3), base],
                duration: 3000 + i * 260,
                ease: "inOutSine",
                loop: true,
              })
          loopsRef.current.push(loop)
        }
        if (isRise) {
          animate(c, {
            translateY: [70 + base, base],
            scale: [0.6, 1],
            opacity: [0, 1],
            duration: 1200,
            ease: "outExpo",
            delay: i * 150,
            onComplete: startLoop,
          })
        } else {
          animate(c, {
            translateY: [-90 + base, base],
            rotate: [i % 2 === 0 ? -20 : 20, 0],
            opacity: [0, 1],
            duration: 1050,
            ease: "outBounce",
            delay: i * 120,
            onComplete: startLoop,
          })
        }
      })
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !playedRef.current) {
            playedRef.current = true
            play()
          }
        }
      },
      { threshold: 0.3 }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      loopsRef.current.forEach((a) => a.pause())
      loopsRef.current = []
      activeAnimRef.current?.pause()
    }
  }, [variant])

  // hover 对应半区 → 标题放大强调（角标自角往外扩）
  useEffect(() => {
    const el = ref.current
    if (!el || !playedRef.current) return
    activeAnimRef.current?.pause()
    activeAnimRef.current = animate(el, {
      scale: active ? 1.12 : 1,
      duration: 520,
      ease: active ? "outBack(2.5)" : "outCubic",
    })
  }, [active])

  const isRise = variant === "rise"
  return (
    <div
      ref={ref}
      className={cn(
        "flex",
        isRise ? "origin-bottom-left tracking-wide" : "origin-top-right tracking-normal"
      )}
    >
      {[...text].map((c, i) => (
        <span
          // eslint-disable-next-line react/no-array-index-key -- 静态字符数组，索引即稳定标识
          key={`${c}-${i}`}
          className={cn(
            "title-char inline-block text-4xl font-black opacity-0 sm:text-6xl",
            tone === "cyan"
              ? "text-cyan-200 drop-shadow-[0_0_22px_rgba(34,211,238,0.6)]"
              : "text-amber-200 drop-shadow-[0_0_22px_rgba(251,191,36,0.55)]",
            !isRise && (i % 2 === 0 ? "-rotate-3" : "rotate-2")
          )}
          style={{ transformOrigin: "center bottom" }}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

/** 半区名称角标（对角定位：左下「蓝鲸社区」/ 右上「浪尖酒馆」） */
function CornerLabel({
  title,
  stat,
  corner,
  tone,
  variant,
  active,
}: {
  title: string
  stat: string
  corner: "bottom-left" | "top-right"
  tone: "cyan" | "amber"
  variant: "rise" | "splash"
  active: boolean
}) {
  const isLeft = corner === "bottom-left"
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-30 flex flex-col gap-1.5",
        isLeft ? "bottom-[2%] left-[2%] items-start" : "right-[2%] top-[2%] items-end"
      )}
    >
      <AnimatedTitle
        text={title}
        variant={variant}
        tone={tone}
        active={active}
      />
      <span className="font-mono text-xs text-white/60">{stat}</span>
    </div>
  )
}

export function CommunitySlide() {
  const sectionRef = useSlideReveal<HTMLDivElement>()
  const [own, setOwn] = useState<DiscussionSummary[] | null>(null)
  const [official, setOfficial] = useState<DiscussionSummary[] | null>(null)

  // 分割线动画：pos（0~1）驱动 clipPath + 描边 + 半区灰度
  const containerRef = useRef<HTMLDivElement>(null)
  const leftHalfRef = useRef<HTMLDivElement>(null)
  const rightHalfRef = useRef<HTMLDivElement>(null)
  const strokePathRef = useRef<SVGPathElement>(null)
  const leftClipRef = useRef<SVGPathElement>(null)
  const rightClipRef = useRef<SVGPathElement>(null)
  const posState = useRef({ pos: CENTER })
  const animRef = useRef<ReturnType<typeof animate> | null>(null)
  // 当前悬停侧（mousemove 判定，避免 clip 边缘抖动）
  const hoverSideRef = useRef<"left" | "right" | null>(null)
  // 悬停侧 state（驱动标题 active 联动强调）
  const [hoverSide, setHoverSide] = useState<"left" | "right" | null>(null)

  // 漂浮呼吸层 + 景深缩放层 + 纸屑层
  const floatLeftRef = useRef<HTMLDivElement>(null)
  const floatRightRef = useRef<HTMLDivElement>(null)
  const zoomLeftRef = useRef<HTMLDivElement>(null)
  const zoomRightRef = useRef<HTMLDivElement>(null)
  const particleLayerRef = useRef<HTMLDivElement>(null)
  const zoomAnimLeftRef = useRef<ReturnType<typeof animate> | null>(null)
  const zoomAnimRightRef = useRef<ReturnType<typeof animate> | null>(null)
  // 全屏虚化背景层（hover 后对应图淡入铺满作为氛围背景）
  const bgC1Ref = useRef<HTMLImageElement>(null)
  const bgC2Ref = useRef<HTMLImageElement>(null)
  const bgAnimRef = useRef<ReturnType<typeof animate> | null>(null)

  // 加载两社区 seed（自家订阅定时刷新；官方静态 seed）
  useEffect(() => {
    let alive = true
    const load = () => {
      loadDiscussionsSeed().then((data) => {
        if (alive) setOwn(data)
      })
      loadOfficialDiscussionsSeed().then((data) => {
        if (alive) setOfficial(data)
      })
    }
    load()
    const unsubscribe = subscribeDiscussions(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 驻留态异步漂浮呼吸 + 卸载时清理所有动画
  useEffect(() => {
    const l = floatLeftRef.current
    const r = floatRightRef.current
    const floatL = l
      ? animate(l, {
          translateY: [-FLOAT_AMP, FLOAT_AMP],
          duration: FLOAT_PERIOD_LEFT,
          ease: "inOutSine",
          alternate: true,
          loop: true,
        })
      : null
    const floatR = r
      ? animate(r, {
          translateY: [FLOAT_AMP, -FLOAT_AMP],
          duration: FLOAT_PERIOD_RIGHT,
          ease: "inOutSine",
          alternate: true,
          loop: true,
        })
      : null
    return () => {
      floatL?.pause()
      floatR?.pause()
      animRef.current?.pause()
      zoomAnimLeftRef.current?.pause()
      zoomAnimRightRef.current?.pause()
      bgAnimRef.current?.pause()
    }
  }, [])

  const initial = useMemo(() => buildTornGeometry(CENTER), [])

  /** 依据当前 pos 更新 clipPath / 描边 / 半区灰度（灰白 + 变暗） */
  const applyGeometry = (p: number) => {
    const g = buildTornGeometry(p)
    strokePathRef.current?.setAttribute("d", g.stroke)
    leftClipRef.current?.setAttribute("d", g.leftClip)
    rightClipRef.current?.setAttribute("d", g.rightClip)
    // 未 hover 侧随分割线推移渐变为灰白 + 变暗（hover 侧保持彩色）
    const leftGray = clamp01((CENTER - p) / (CENTER - HOVER_RIGHT))
    const rightGray = clamp01((p - CENTER) / (HOVER_LEFT - CENTER))
    if (leftHalfRef.current) {
      const g2 = leftGray
      leftHalfRef.current.style.filter =
        g2 > 0.001
          ? `grayscale(${g2}) brightness(${(1 - g2 * 0.35).toFixed(3)})`
          : "none"
    }
    if (rightHalfRef.current) {
      const g2 = rightGray
      rightHalfRef.current.style.filter =
        g2 > 0.001
          ? `grayscale(${g2}) brightness(${(1 - g2 * 0.35).toFixed(3)})`
          : "none"
    }
  }

  /** 沿裂缝迸发纸屑（撕纸点睛） */
  const burstConfetti = (originX: number) => {
    const layer = particleLayerRef.current
    if (!layer) return
    const count = 5
    for (let i = 0; i < count; i++) {
      const piece = document.createElement("span")
      const size = 3 + Math.random() * 5
      piece.className = "absolute rounded-[1px]"
      piece.style.width = `${size}px`
      piece.style.height = `${size}px`
      piece.style.background =
        i % 2 === 0 ? "rgba(255,255,255,0.75)" : "rgba(186,230,253,0.65)"
      piece.style.left = `${originX * 100}%`
      piece.style.top = `${20 + Math.random() * 60}%`
      layer.appendChild(piece)
      animate(piece, {
        x: (Math.random() - 0.5) * 140,
        y: -18 - Math.random() * 70,
        rotate: (Math.random() - 0.5) * 360,
        opacity: [1, 0],
        duration: 550 + Math.random() * 450,
        ease: "outCubic",
        onComplete: () => piece.remove(),
      })
    }
  }

  /** hover 侧对应的图淡入铺满为全屏虚化背景（氛围层）；移出则全淡出 */
  const animateBackground = (side: "left" | "right" | null) => {
    const c1 = bgC1Ref.current
    const c2 = bgC2Ref.current
    if (!c1 || !c2) return
    const bgState = {
      o1: Number(c1.style.opacity || 0),
      o2: Number(c2.style.opacity || 0),
    }
    bgAnimRef.current?.pause()
    bgAnimRef.current = animate(bgState, {
      o1: side === "left" ? 1 : 0,
      o2: side === "right" ? 1 : 0,
      duration: 520,
      ease: "outCubic",
      onUpdate: () => {
        c1.style.opacity = String(bgState.o1)
        c2.style.opacity = String(bgState.o2)
      },
    })
  }

  /** 动画分割线到目标位置（弹性回弹）；图片延迟错拍缩放（景深）；迸发纸屑 */
  const animatePos = (target: number, side: "left" | "right" | null) => {
    // 1) 裂缝先行：分割线用弹性缓动回弹裂开
    animRef.current?.pause()
    animRef.current = animate(posState.current, {
      pos: target,
      duration: 850,
      ease: TORN_EASE,
      onUpdate: () => applyGeometry(posState.current.pos),
    })
    // 2) 图滞后跟进：被 hover 图放大、未 hover 图后撤（景深）；复位时两侧归 1
    const leftZoom = side === "left" ? ZOOM_ACTIVE : side === "right" ? ZOOM_IDLE : 1
    const rightZoom = side === "right" ? ZOOM_ACTIVE : side === "left" ? ZOOM_IDLE : 1
    zoomAnimLeftRef.current?.pause()
    zoomAnimRightRef.current?.pause()
    if (zoomLeftRef.current) {
      zoomAnimLeftRef.current = animate(zoomLeftRef.current, {
        scale: leftZoom,
        duration: 650,
        delay: ZOOM_DELAY,
        ease: ZOOM_EASE,
      })
    }
    if (zoomRightRef.current) {
      zoomAnimRightRef.current = animate(zoomRightRef.current, {
        scale: rightZoom,
        duration: 650,
        delay: ZOOM_DELAY,
        ease: ZOOM_EASE,
      })
    }
    // 3) 纸屑沿裂缝迸发
    if (side !== null) {
      burstConfetti(target)
    }
    // 4) 全屏虚化背景：被 hover 图淡入铺满作为氛围背景（移出全淡出）
    animateBackground(side)
  }

  /** 鼠标在容器内移动：以分割线当前位置为界判定左右，跨线才切换（更跟手） */
  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const side: "left" | "right" =
      ratio < posState.current.pos ? "left" : "right"
    if (side !== hoverSideRef.current) {
      hoverSideRef.current = side
      setHoverSide(side)
      animatePos(side === "left" ? HOVER_LEFT : HOVER_RIGHT, side)
    }
  }

  /** 移出容器 → 分割线复位居中，恢复彩色 */
  const onMouseLeave = () => {
    if (hoverSideRef.current === null) return
    hoverSideRef.current = null
    setHoverSide(null)
    animatePos(CENTER, null)
  }

  const ownCount = own?.length ?? 0
  const ownComments = own?.reduce((sum, d) => sum + d.comments, 0) ?? 0
  const officialCount = official?.length ?? 0
  const officialComments =
    official?.reduce((sum, d) => sum + d.comments, 0) ?? 0

  return (
    <div
      ref={sectionRef}
      className="relative mx-auto flex h-full w-full max-w-7xl flex-col justify-center px-4 pt-4 pb-8 sm:px-6"
    >
      {/* 全屏虚化背景：hover 后对应社区图淡入铺满整个视口（撕裂卡片后方的整屏氛围） */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <img
          ref={bgC1Ref}
          src="/c1.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl"
          style={{ opacity: 0 }}
        />
        <img
          ref={bgC2Ref}
          src="/c2.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl"
          style={{ opacity: 0 }}
        />
      </div>

      {/* 标题区：仅保留代号 + 英文 + 大标题（上移，为下方图片腾出画幅） */}
      <div className="slide-reveal-title mb-4">
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-300/90">
          04 · DISCUSSIONS
        </p>
        <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-white">
          讨论交流
        </h2>
      </div>

      {/* 双社区撕纸分割主体（hover 推移） */}
      <div
        ref={containerRef}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        className="slide-reveal-item relative w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40 backdrop-blur-sm"
        style={{ height: "clamp(420px, 64vh, 760px)" }}
      >
        {/* clipPath 定义（objectBoundingBox：path 坐标 0~1 自适应容器） */}
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <defs>
            <clipPath id="torn-left" clipPathUnits="objectBoundingBox">
              <path ref={leftClipRef} d={initial.leftClip} />
            </clipPath>
            <clipPath id="torn-right" clipPathUnits="objectBoundingBox">
              <path ref={rightClipRef} d={initial.rightClip} />
            </clipPath>
          </defs>
        </svg>

        {/* 左半：蓝鲸社区（c1 背景图，三层：漂浮呼吸 / 景深缩放 / 图片） */}
        <div
          ref={leftHalfRef}
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: "url(#torn-left)" }}
        >
          <div ref={floatLeftRef} className="absolute inset-[-3%]">
            <div ref={zoomLeftRef} className="absolute inset-0">
              <img
                src="/c1.png"
                alt="蓝鲸社区"
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-linear-to-br from-cyan-950/25 to-transparent" />
            </div>
          </div>
        </div>

        {/* 右半：浪尖酒馆（c2 背景图，三层：漂浮呼吸 / 景深缩放 / 图片） */}
        <div
          ref={rightHalfRef}
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: "url(#torn-right)" }}
        >
          <div ref={floatRightRef} className="absolute inset-[-3%]">
            <div ref={zoomRightRef} className="absolute inset-0">
              <img
                src="/c2.png"
                alt="浪尖酒馆"
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-linear-to-tl from-amber-950/25 to-transparent" />
            </div>
          </div>
        </div>

        {/* 撕纸裂缝线：白色半透明描边，非缩放线宽保持清晰 */}
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          aria-hidden="true"
        >
          <path
            ref={strokePathRef}
            d={initial.stroke}
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* 左下角名称：蓝鲸社区（沉稳上浮） · 右上角名称：浪尖酒馆（轻快溅落） */}
        <CornerLabel
          title="蓝鲸社区"
          stat={`${ownCount} 帖 · ${ownComments} 讨论`}
          corner="bottom-left"
          tone="cyan"
          variant="rise"
          active={hoverSide === "left"}
        />
        <CornerLabel
          title="浪尖酒馆"
          stat={`${officialCount} 帖 · ${officialComments} 讨论`}
          corner="top-right"
          tone="amber"
          variant="splash"
          active={hoverSide === "right"}
        />

        {/* 纸屑粒子层（hover 切换时沿裂缝迸发） */}
        <div
          ref={particleLayerRef}
          className="pointer-events-none absolute inset-0 z-40"
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
