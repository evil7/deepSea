import { useEffect, useState } from "react"

import {
  extractThemeColors,
  type ThemeColors,
} from "@/lib/theme/auto-color"

// ---------------------------------------------------------------------------
// useImageThemeColor —— 加载背景图并自动提取主题色（autoColor 入口）
//   · 加载 <img> → 缩小绘制到 <canvas>（100×100）→ extractThemeColors 纯函数
//   · 图片加载失败 / 污染画布时返回 null（调用方回退到默认配色）
//   · 仅对同源 /public/* 图片安全；远程图需服务器返回 CORS 头
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 100

export interface AutoColorResult {
  /** 提取到的主题色；失败或加载中为 null */
  colors: ThemeColors | null
  status: "loading" | "ready" | "error"
}

export function useImageThemeColor(src?: string | null): AutoColorResult {
  const [result, setResult] = useState<AutoColorResult>({
    colors: null,
    status: src ? "loading" : "ready",
  })

  useEffect(() => {
    if (!src) {
      setResult({ colors: null, status: "ready" })
      return
    }
    let alive = true
    setResult({ colors: null, status: "loading" })

    const img = new Image()
    img.crossOrigin = "anonymous"
    img.src = src
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = SAMPLE_SIZE
        canvas.height = SAMPLE_SIZE
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("no 2d context")
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
        const colors = extractThemeColors(data, SAMPLE_SIZE, SAMPLE_SIZE)
        if (alive) setResult({ colors, status: "ready" })
      } catch {
        // 画布污染（跨域）或解码失败 → 回退默认配色
        if (alive) setResult({ colors: null, status: "error" })
      }
    }
    img.onerror = () => {
      if (alive) setResult({ colors: null, status: "error" })
    }
    return () => {
      alive = false
    }
  }, [src])

  return result
}
