import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { useNavigate } from "react-router-dom"
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
// CommunitySlide —— 首页「讨论交流」屏（双社区水波纹反色分割 + hover 推移）
//   左半「蓝鲸社区」（官方 deepseek-ai/deepseek-harness，只读） · 右半「浪尖酒馆」
//   （自家 evil7/deepSea，可互动）。
//   · 双水波纹分割：两条垂直随机摇曳的水波纹线 A（左）/ B（右），频率不同，
//     在基准线 pos 左右定量偏移；两线交汇区反色（负片）叠加两图。
//   · 负片规则：c1 自 A 线向右转负片、至 B 线渐隐；c2 自 B 线向左转负片、至 A 线渐隐。
//   · hover：基准线 pos 向对侧推移（被 hover 图占 4/5），A/B 两线随之整体移动。
//   · 左下角「蓝鲸社区」、右上角「浪尖酒馆」。
//   · 数据：两个社区 seed（登录用户由前端 worker 定时刷新自家社区）。
// ---------------------------------------------------------------------------

/** 分割线默认位置（居中，0~1 归一化 x） */
const CENTER = 0.5
/** hover 左图 → 基准线右移，左图占 4/5 */
const HOVER_LEFT = 0.8
/** hover 右图 → 基准线左移，右图占 4/5 */
const HOVER_RIGHT = 0.2
/** 双水波纹线相对基准线的左右定量偏移 */
const WAVE_GAP = 0.013
/** 水波纹线垂直采样点数（越多越平滑） */
const WAVE_STEPS = 36

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

/** 归一化坐标 → path 字符串（x y） */
function fmt(p: [number, number]): string {
  return `${p[0].toFixed(4)} ${p[1].toFixed(4)}`
}

/**
 * 构造两条随机摇曳的水波纹线 + 三块区域 clipPath（归一化坐标 0~1）。
 *   A 线（左，蓝鲸）= pos - WAVE_GAP + waveA(y, t)
 *   B 线（右，浪尖）= pos + WAVE_GAP + waveB(y, t)
 *   · waveA / waveB 频率不同 → 两线各自随机波动，交汇区宽度动态变化
 *   · clipLeft = A 线左侧、clipMid = A~B 交汇区、clipRight = B 线右侧
 *   · midA / midB = 两线基准 x（供负片 mask 渐变定位）
 */
function buildWaveGeometry(
  pos: number,
  t: number
): {
  lineA: string
  lineB: string
  clipLeft: string
  clipMid: string
  clipRight: string
  midA: number
  midB: number
} {
  const P = Math.PI
  const baseA = pos - WAVE_GAP
  const baseB = pos + WAVE_GAP
  // A、B 两线用不同频率/相位 → 晃动节奏不同，必然形成波动交汇区
  const waveA = (y: number) =>
    0.007 * Math.sin(y * 11 + t * P * 2 * 1.6) +
    0.004 * Math.sin(y * 27 - t * P * 2 * 0.9 + 1.7)
  const waveB = (y: number) =>
    0.009 * Math.sin(y * 15 + t * P * 2 * 0.8 + 0.6) +
    0.004 * Math.sin(y * 33 - t * P * 2 * 1.3 + 3.1)

  const ptsA: [number, number][] = []
  const ptsB: [number, number][] = []
  for (let i = 0; i <= WAVE_STEPS; i++) {
    const y = i / WAVE_STEPS
    ptsA.push([baseA + waveA(y), y])
    ptsB.push([baseB + waveB(y), y])
  }

  const lineA = ptsA.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p)}`).join(" ")
  const lineB = ptsB.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p)}`).join(" ")
  const seg = (pts: [number, number][]) =>
    pts.map((p) => `L ${fmt(p)}`).join(" ")

  // 左区：左边界 (0,0)(0,1) + A 线（上→下）
  const clipLeft = `M 0 0 ${seg(ptsA)} L 0 1 Z`
  // 交汇区：A 线（上→下）+ B 线（下→上）闭合条带
  const clipMid = `M ${fmt(ptsA[0])} ${seg(ptsA.slice(1))} ${seg(
    ptsB.slice().toReversed()
  )} Z`
  // 右区：B 线（上→下）+ 右边界 (1,0)(1,1)
  const clipRight = `M 1 0 ${seg(ptsB)} L 1 1 Z`

  return {
    lineA,
    lineB,
    clipLeft,
    clipMid,
    clipRight,
    midA: baseA,
    midB: baseB,
  }
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
        "pointer-events-none absolute flex flex-col gap-1.5",
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
  const navigate = useNavigate()
  const [own, setOwn] = useState<DiscussionSummary[] | null>(null)
  const [official, setOfficial] = useState<DiscussionSummary[] | null>(null)

  // 基准线 + 双水波纹：pos（0~1）驱动 A/B 线、clipPath、负片 mask
  const containerRef = useRef<HTMLDivElement>(null)
  const pathARef = useRef<SVGPathElement>(null)
  const pathBRef = useRef<SVGPathElement>(null)
  const clipLeftRef = useRef<SVGPathElement>(null)
  const clipMidRef = useRef<SVGPathElement>(null)
  const clipRightRef = useRef<SVGPathElement>(null)
  const c1InvertRef = useRef<HTMLDivElement>(null)
  const c2InvertRef = useRef<HTMLDivElement>(null)
  const leftNormalRef = useRef<HTMLDivElement>(null)
  const rightNormalRef = useRef<HTMLDivElement>(null)
  const posState = useRef({ pos: CENTER })
  const animRef = useRef<ReturnType<typeof animate> | null>(null)
  const filterAnimRef = useRef<ReturnType<typeof animate> | null>(null)
  const grayState = useRef({ l: 0, r: 0 })
  const waveRafRef = useRef<number>(0)
  const timeRef = useRef({ t: 0 })
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
      filterAnimRef.current?.pause()
      cancelAnimationFrame(waveRafRef.current)
    }
  }, [])

  // 水波纹摇曳：基于单调递增的连续时间驱动（rAF），波形是时间的连续函数，
  // 无循环边界跳变。若用 0→1 循环 + 非整数频率，循环回到 0 时相位不闭合会闪烁。
  useEffect(() => {
    const start = performance.now()
    // 归一化周期时长（秒）：t 每 +1 对应此秒数，保持与原先 4.8s 一循环的视觉节奏
    const WAVE_CYCLE_SECONDS = 4.8
    const tick = (now: number) => {
      timeRef.current.t = (now - start) / 1000 / WAVE_CYCLE_SECONDS
      applyGeometry()
      waveRafRef.current = requestAnimationFrame(tick)
    }
    waveRafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(waveRafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyGeometry 仅依赖 ref，闭包安全
  }, [])

  const initial = useMemo(() => buildWaveGeometry(CENTER, 0), [])

  /** 依据当前基准线 pos + 时间 t 更新水波纹几何（clipPath / 描边 / 负片 mask） */
  const applyGeometry = () => {
    const g = buildWaveGeometry(posState.current.pos, timeRef.current.t)
    pathARef.current?.setAttribute("d", g.lineA)
    pathBRef.current?.setAttribute("d", g.lineB)
    clipLeftRef.current?.setAttribute("d", g.clipLeft)
    clipMidRef.current?.setAttribute("d", g.clipMid)
    clipRightRef.current?.setAttribute("d", g.clipRight)
    // 负片 mask 渐变：c1 自 A→B 渐强；c2 自 B→A 渐强（交汇区反色叠加）
    const a = (g.midA * 100).toFixed(2)
    const b = (g.midB * 100).toFixed(2)
    const maskC1 = `linear-gradient(to right, transparent ${a}%, black ${b}%)`
    const maskC2 = `linear-gradient(to right, black ${a}%, transparent ${b}%)`
    if (c1InvertRef.current) {
      c1InvertRef.current.style.maskImage = maskC1
      c1InvertRef.current.style.webkitMaskImage = maskC1
    }
    if (c2InvertRef.current) {
      c2InvertRef.current.style.maskImage = maskC2
      c2InvertRef.current.style.webkitMaskImage = maskC2
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

  /** 未 hover 侧变黑白 + 变暗（hover 切换时；复位两侧恢复彩色） */
  const animateInactiveFilter = (side: "left" | "right" | null) => {
    const tl = side === "right" ? 1 : 0
    const tr = side === "left" ? 1 : 0
    filterAnimRef.current?.pause()
    filterAnimRef.current = animate(grayState.current, {
      l: tl,
      r: tr,
      duration: 600,
      ease: "outCubic",
      onUpdate: () => {
        const l = grayState.current.l
        const r = grayState.current.r
        if (leftNormalRef.current) {
          leftNormalRef.current.style.filter =
            l > 0.001
              ? `grayscale(${l}) brightness(${(1 - l * 0.35).toFixed(3)})`
              : "none"
        }
        if (rightNormalRef.current) {
          rightNormalRef.current.style.filter =
            r > 0.001
              ? `grayscale(${r}) brightness(${(1 - r * 0.35).toFixed(3)})`
              : "none"
        }
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
      onUpdate: () => applyGeometry(),
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
    // 5) 未 hover 侧变黑白 + 变暗
    animateInactiveFilter(side)
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

  /** 点击卡片：左半 → 官方社区（只读），右半 → 我们的社区（可互动） */
  const onCardClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    if (ratio < 0.5) {
      navigate("/community?source=official&replyEnable=false")
    } else {
      navigate("/community?source=own")
    }
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
          04 · COMMUNITY
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
        onClick={onCardClick}
        className="slide-reveal-item relative w-full cursor-pointer overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40 backdrop-blur-sm"
        style={{ height: "clamp(420px, 64vh, 760px)" }}
      >
        {/* clipPath 定义：左区 / 交汇区 / 右区（objectBoundingBox 坐标 0~1） */}
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <defs>
            <clipPath id="wave-left" clipPathUnits="objectBoundingBox">
              <path ref={clipLeftRef} d={initial.clipLeft} />
            </clipPath>
            <clipPath id="wave-mid" clipPathUnits="objectBoundingBox">
              <path ref={clipMidRef} d={initial.clipMid} />
            </clipPath>
            <clipPath id="wave-right" clipPathUnits="objectBoundingBox">
              <path ref={clipRightRef} d={initial.clipRight} />
            </clipPath>
          </defs>
        </svg>

        {/* 左图 c1 正常区（A 线左侧，蓝鲸社区） */}
        <div
          ref={leftNormalRef}
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: "url(#wave-left)" }}
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
          {/* 左下角名称：蓝鲸社区（官方·沉稳上浮），随本半区 clipPath 裁剪 */}
          <CornerLabel
            title="蓝鲸社区"
            stat={`${officialCount} 帖 · ${officialComments} 讨论`}
            corner="bottom-left"
            tone="cyan"
            variant="rise"
            active={hoverSide === "left"}
          />
        </div>

        {/* 右图 c2 正常区（B 线右侧，浪尖酒馆） */}
        <div
          ref={rightNormalRef}
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: "url(#wave-right)" }}
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
          {/* 右上角名称：浪尖酒馆（我们·轻快溅落），随本半区 clipPath 裁剪 */}
          <CornerLabel
            title="浪尖酒馆"
            stat={`${ownCount} 帖 · ${ownComments} 讨论`}
            corner="top-right"
            tone="amber"
            variant="splash"
            active={hoverSide === "right"}
          />
        </div>

        {/* 交汇区负片：c1 反色（A→B 渐强） */}
        <div
          ref={c1InvertRef}
          className="absolute inset-0"
          style={{
            clipPath: "url(#wave-mid)",
            filter: "invert(1)",
            maskImage: `linear-gradient(to right, transparent ${(initial.midA * 100).toFixed(2)}%, black ${(initial.midB * 100).toFixed(2)}%)`,
            WebkitMaskImage: `linear-gradient(to right, transparent ${(initial.midA * 100).toFixed(2)}%, black ${(initial.midB * 100).toFixed(2)}%)`,
          }}
        >
          <img
            src="/c1.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* 交汇区负片：c2 反色（B→A 渐强） */}
        <div
          ref={c2InvertRef}
          className="absolute inset-0"
          style={{
            clipPath: "url(#wave-mid)",
            filter: "invert(1)",
            maskImage: `linear-gradient(to right, black ${(initial.midA * 100).toFixed(2)}%, transparent ${(initial.midB * 100).toFixed(2)}%)`,
            WebkitMaskImage: `linear-gradient(to right, black ${(initial.midA * 100).toFixed(2)}%, transparent ${(initial.midB * 100).toFixed(2)}%)`,
          }}
        >
          <img
            src="/c2.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* 两条水波纹描边线（透明度渐变：中间实、上下两端渐隐） */}
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="wave-grad-a"
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="rgb(103,232,249)" stopOpacity="0" />
              <stop offset="30%" stopColor="rgb(103,232,249)" stopOpacity="0.5" />
              <stop offset="50%" stopColor="rgb(103,232,249)" stopOpacity="0.65" />
              <stop offset="70%" stopColor="rgb(103,232,249)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="rgb(103,232,249)" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id="wave-grad-b"
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="rgb(251,191,36)" stopOpacity="0" />
              <stop offset="30%" stopColor="rgb(251,191,36)" stopOpacity="0.5" />
              <stop offset="50%" stopColor="rgb(251,191,36)" stopOpacity="0.65" />
              <stop offset="70%" stopColor="rgb(251,191,36)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="rgb(251,191,36)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            ref={pathARef}
            d={initial.lineA}
            fill="none"
            stroke="url(#wave-grad-a)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            ref={pathBRef}
            d={initial.lineB}
            fill="none"
            stroke="url(#wave-grad-b)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

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
