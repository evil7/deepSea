// ---------------------------------------------------------------------------
// /link/:nodeId —— deepc-link 已连接态 chatUI。
//
// 携带 nodeId 进入时自动连接该节点；断开 / 重连耗尽后回到 /links 设备列表。
// 页面主体为 ChatShell（左 sidebar + 中聊天区 + 输入框 + 设置面板）。
// 登录后注册主站控制端节点（console），在线状态由常驻 WS presence 体现。
//
// 【重要】本页只做「连接触发 + 导航」，**不要调用 useDeepcLink()**——
// 它会 register on("downstream") 监听器，而 ChatShell 内部又调用一次 useDeepcLink()，
// 同一 downstream 帧会被两个监听器各处理一次 → 消息完整重复两次。
// 连接层统一走 deepcClient 单例，消息渲染交给 ChatShell 唯一实例。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ChatShell } from "@/components/link/chat-shell"
import { deepcClient, type ClientState } from "@/lib/deepc-link/client"
import { useAuth } from "@/hooks/use-auth"
import { registerConsoleNode } from "@/lib/deepc-link/nodes"

export function LinkDetailPage() {
  const { nodeId: urlNodeId } = useParams<{ nodeId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [state, setState] = useState<ClientState>(deepcClient.state)

  // 监听连接状态（仅此一次，用于 error/disconnected → 导航回设备列表）。
  useEffect(() => {
    const off = deepcClient.on("state", (s) => setState(s))
    return () => off()
  }, [])

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
  }, [user, urlNodeId])

  // 重连耗尽（error）或主动断开（disconnected）→ 回到设备列表（/links）。
  useEffect(() => {
    if ((state === "error" || state === "disconnected") && urlNodeId) {
      navigate("/links", { replace: true })
    }
  }, [state, urlNodeId, navigate])

  // 主动断开（sidebar 底部连接按钮 confirm 后触发）：只需调用 deepcClient.disconnect()
  // 置 state 为 disconnected，由上方 effect 统一导航回 /links。
  const handleDisconnect = () => {
    deepcClient.disconnect()
  }

  return <ChatShell onDisconnect={handleDisconnect} />
}

/** 连接指定节点（供上方 useEffect 使用）。 */
async function connectToNode(targetNodeId: string, selfNodeId: string): Promise<void> {
  await deepcClient.connectToNode(targetNodeId, selfNodeId)
}
