// ---------------------------------------------------------------------------
// /link/:nodeId —— deepc-link 已连接态 chatUI。
//
// 携带 nodeId 进入时自动连接该节点；断开 / 重连耗尽后回到 /links 设备列表。
// 页面主体为 ChatShell（左 sidebar + 中聊天区 + 输入框 + 设置面板）。
// 登录后注册主站控制端节点（console），在线状态由常驻 WS presence 体现。
// ---------------------------------------------------------------------------

import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ChatShell } from "@/components/link/chat-shell"
import { useDeepcLink } from "@/hooks/use-deepc-link"
import { useAuth } from "@/hooks/use-auth"
import { registerConsoleNode } from "@/lib/deepc-link/nodes"

export function LinkDetailPage() {
  const { nodeId: urlNodeId } = useParams<{ nodeId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { state, connectToNode, disconnect } = useDeepcLink()

  // 登录后注册主站控制端节点（多端直连发起方的 answer 收件箱）。
  // URL 携带 /link/:nodeId 时自动连接该节点；否则仅注册（不自动连）。
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void registerConsoleNode(user.id).then((id) => {
      if (cancelled) return
      if (urlNodeId) {
        void connectToNode(urlNodeId, id)
      }
    })
    return () => {
      cancelled = true
    }
  }, [user, urlNodeId, connectToNode])

  // 重连耗尽（error）或主动断开（disconnected）→ 回到设备列表（/links）。
  useEffect(() => {
    if ((state === "error" || state === "disconnected") && urlNodeId) {
      navigate("/links", { replace: true })
    }
  }, [state, urlNodeId, navigate])

  // 主动断开（sidebar 底部连接按钮 confirm 后触发）：只需调用 deepcClient.disconnect()
  // 置 state 为 disconnected，由上方 effect 统一导航回 /links。
  const handleDisconnect = () => {
    disconnect()
  }

  return <ChatShell onDisconnect={handleDisconnect} />
}
