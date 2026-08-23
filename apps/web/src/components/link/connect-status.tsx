// ---------------------------------------------------------------------------
// ConnectStatus —— chatUI sidebar 底部「极简连接状态点」。
//
// 需求：连接信息只需最简靠右显示（设置按钮为主）。故渲染为：
//   · 一个小圆点（颜色表达状态：绿=已连接/金=重连/红=错误/灰=未连接）
//   · connected 时在圆点右侧附「连接时长」微型文本（hover 时隐藏）
// 交互（对齐 /links 设备删除 confirm→执行）：
//   1. hover：圆点变为「断开连接」提示（rose 强调），title 提示。
//   2. 点击：二次确认态（"确认断开？"）；再点执行断开；3s 未操作回退。
// 仅 connected / reconnecting 允许断开；其余 render 为纯状态点（disabled）。
// ---------------------------------------------------------------------------

import { useState } from "react"

import { cn } from "@/lib/utils"
import type { ClientState } from "@/lib/deepc-link/client"

const STATE_DOT: Record<ClientState, { label: string; color: string; pulse: boolean }> = {
  idle: { label: "未连接", color: "bg-slate-400", pulse: false },
  connecting: { label: "连接中…", color: "bg-sky-400", pulse: true },
  connected: { label: "已连接", color: "bg-emerald-400", pulse: false },
  reconnecting: { label: "重连中…", color: "bg-amber-400", pulse: true },
  error: { label: "连接失败", color: "bg-rose-500", pulse: false },
  disconnected: { label: "已断开", color: "bg-slate-400", pulse: false },
}

/** 秒 → 可读时长（`Xh Ym` / `Xm Ys` / `Xs`）。 */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`
}

export function ConnectStatus({
  state,
  elapsed,
  onDisconnect,
}: {
  state: ClientState
  /** 连接时长（秒），仅 connected 时有效。 */
  elapsed: number
  onDisconnect: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const disconnectable = state === "connected" || state === "reconnecting"
  const meta = STATE_DOT[state]
  // 常态文案：connected 显示时长；否则显示状态文字（未连接/连接中/重连中/连接失败/已断开）。
  const normalLabel = state === "connected" ? formatDuration(elapsed) : meta.label

  return (
    <button
      type="button"
      disabled={!disconnectable}
      title={confirm ? "确认断开？" : disconnectable ? "断开连接" : meta.label}
      onClick={() => {
        if (confirm) {
          setConfirm(false)
          onDisconnect()
        } else {
          setConfirm(true)
          setTimeout(() => setConfirm(false), 3000)
        }
      }}
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] leading-none transition-colors",
        disconnectable ? "hover:bg-muted/60" : "cursor-default"
      )}
    >
      {confirm ? (
        <span className="text-[11px] leading-none text-emerald-400">确认断开？</span>
      ) : (
        <>
          {/* 状态圆点 */}
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              meta.color,
              meta.pulse && "animate-pulse",
              disconnectable && "group-hover:bg-rose-400 group-hover:animate-none"
            )}
          />
          {/* 状态文字（未连接/时长/重连等）；hover 时切为「断开」 */}
          {disconnectable ? (
            <>
              <span className="text-muted-foreground group-hover:hidden">{normalLabel}</span>
              <span className="hidden text-rose-400 group-hover:inline">断开</span>
            </>
          ) : (
            <span className="text-muted-foreground">{normalLabel}</span>
          )}
        </>
      )}
    </button>
  )
}
