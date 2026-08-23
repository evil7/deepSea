// ---------------------------------------------------------------------------
// ConnectStatus —— chatUI sidebar 底部「时长 + 状态」按钮。
//
// 三态交互（对齐 /links 设备删除的 confirm→执行 模式）：
//   1. 常态：显示连接时长 + 连接状态（未连接/已连接/连接中/重连中/连接失败）。
//   2. hover：切换为「断开」按钮（红色强调）。
//   3. 点击：切换为「确认断开？」二次确认态；再次点击执行断开；3s 未操作回退。
// 仅 connected/reconnecting 时允许断开；其余状态渲染为纯状态展示（disabled）。
// ---------------------------------------------------------------------------

import { useState } from "react"
import { Check, Unplug } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ClientState } from "@/lib/deepc-link/client"

const STATE_META: Record<ClientState, { label: string; tone: string }> = {
  idle: { label: "未连接", tone: "text-slate-300" },
  connecting: { label: "连接中…", tone: "text-sky-300" },
  connected: { label: "已连接", tone: "text-emerald-300" },
  reconnecting: { label: "重连中…", tone: "text-amber-300" },
  error: { label: "连接失败", tone: "text-rose-300" },
  disconnected: { label: "已断开", tone: "text-slate-300" },
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
  // 仅 connected/reconnecting 允许「断开」；其余状态渲染为纯状态展示。
  const disconnectable = state === "connected" || state === "reconnecting"
  const meta = STATE_META[state]

  // 常态文案：时长 + 状态（连接中/失败等无时长）。
  const label =
    state === "connected"
      ? `${formatDuration(elapsed)} · ${meta.label}`
      : meta.label

  return (
    <button
      type="button"
      disabled={!disconnectable}
      title={disconnectable ? "断开连接" : meta.label}
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
        "group flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs transition-colors",
        !disconnectable && "cursor-default"
      )}
    >
      {confirm ? (
        // 确认断开态（绿色 emerald 强调，复用设备删除的确认语义）
        <span className="flex w-full items-center gap-2 text-emerald-300">
          <Check className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">确认断开？</span>
        </span>
      ) : disconnectable ? (
        <>
          {/* 常态：时长 + 状态（hover 时隐藏） */}
          <span className="flex w-full items-center gap-2 text-muted-foreground group-hover:hidden">
            <Unplug className="size-3.5 shrink-0" />
            <span className={cn("min-w-0 flex-1 truncate", meta.tone)}>{label}</span>
          </span>
          {/* hover：断开按钮（常时隐藏，hover 显示） */}
          <span className="hidden w-full items-center gap-2 text-rose-400 group-hover:flex hover:text-rose-300">
            <Unplug className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">断开</span>
          </span>
        </>
      ) : (
        // 不可断开态：纯状态展示（无 hover 切换）
        <span className="flex w-full items-center gap-2 opacity-70">
          <Unplug className="size-3.5 shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", meta.tone)}>{label}</span>
        </span>
      )}
    </button>
  )
}
