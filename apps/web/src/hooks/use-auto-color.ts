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
  // 初始状态由 src 派生（无图即 ready）；effect 内 setState 均放宏任务
  // （React Compiler set-state-in-effect lint）。
  const [result, setResult] = useState<AutoColorResult>({
    colors: null,
    status: src ? "loading" : "ready",
  })

  useEffect(() => {
    let alive = true
    // setTimeout 宏任务：避免 effect 同步路径 setState。首次挂载 state 已是
    // 初始值，宏任务延迟一拍无感；清理时连带取消，避免已卸载后 setState。
    const id = window.setTimeout(() => {
      if (!src) {
        setResult({ colors: null, status: "ready" })
        return
      }
      setResult({ colors: null, status: "loading" })

      const img = new Image()
      img.crossOrigin = "anonymous"
      img.src = src
      img.addEventListener("load", () => {
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
      })
      img.addEventListener("error", () => {
        if (alive) setResult({ colors: null, status: "error" })
      })
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [src])

  return result
}
