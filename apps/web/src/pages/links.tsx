// ---------------------------------------------------------------------------
// /links —— 操作互联设备列表页（deepc-link 多端直连入口）。
//
// 列出同账号已登录的 DSH 节点；点击「连接」导航到 /link/:nodeId 建立 RTC。
// 设备列表 + 在线状态由常驻 WS `/ws/api-link` 节点注册表快照/变更帧刷新：
//   · connect 时 DO 推 nodes-snapshot（全量）
//   · 节点增/删/改名/上下线时 DO 推 nodes-changed（全量）
// 登录后注册主站控制端节点（console）用于发起连接。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/layout/page-header"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import {
  registerConsoleNode,
  removeNode,
  isConsoleNode,
  type NodeView,
} from "@/lib/deepc-link/nodes"
import { createWsLinkClient } from "@/lib/deepc-link/ws-signaling"
import { Laptop, Link2, Loader2, RefreshCw, Trash2 } from "lucide-react"

export function LinksPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [nodes, setNodes] = useState<NodeView[]>([])
  const [nodesLoaded, setNodesLoaded] = useState(false)
  const [consoleNodeId, setConsoleNodeId] = useState<string | null>(null)

  // 登录后注册主站控制端节点（多端直连发起方）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void registerConsoleNode(user.id).then((id) => {
      if (!cancelled) setConsoleNodeId(id)
    })
    return () => {
      cancelled = true
    }
  }, [user])

  // 设备列表源 = WS 节点注册表快照/变更（无 HTTP /auth/node/list）。
  const wsRef = useRef<ReturnType<typeof createWsLinkClient> | null>(null)

  // 登录后常驻 WS（DO 信号房）：connect 时收 nodes-snapshot，此后任何节点增/删/改名/
  // 上下线收 nodes-changed（全量）。统一处理：过滤掉主站自身控制端节点后覆写列表。
  useEffect(() => {
    if (!user || !consoleNodeId) return
    const ws = createWsLinkClient()
    wsRef.current = ws
    let disposed = false
    const applyNodes = (all: NodeView[]): void => {
      setNodes(all.filter((n) => !isConsoleNode(n)))
      setNodesLoaded(true)
    }
    const offSnapshot = ws.onNodesSnapshot(applyNodes)
    const offChanged = ws.onNodesChanged(applyNodes)
    void ws.connect(consoleNodeId).then((ok) => {
      if (!ok && !disposed) {
        // 连接失败：标记已加载（空列表），避免无限 loading。
        setNodesLoaded(true)
      }
    })
    return () => {
      disposed = true
      offSnapshot()
      offChanged()
      ws.disconnect()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [user, consoleNodeId])

  // 「刷新」按钮：主动向 DO 请求一次 nodes-snapshot（服务器回推全量）。
  const refreshNodes = useCallback(() => {
    setNodesLoaded(false)
    wsRef.current?.refreshNodes()
    // 兜底：若 WS 未就绪，稍后快照到达会置 nodesLoaded。此处若超时仍空列表则兜底。
  }, [])

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-10 sm:px-6">
      <PageHeader
        title="操作互联"
        description="连接同账号DSH节点，实现远程控制、多端管理"
        sticky={false}
        showTopButton={false}
      />

      {/* 设备卡片网格 */}
      <div className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">已登录设备</h2>
          <Button variant="ghost" size="sm" onClick={() => void refreshNodes()} className="gap-1.5 text-xs">
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        </div>

        {!user ? (
          <Card className="border-dashed">
            <CardContent className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              登录 GitHub 账号后，可查看并连接同一账号下的所有设备
            </CardContent>
          </Card>
        ) : !nodesLoaded ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载设备…
          </div>
        ) : nodes.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Laptop className="size-8 opacity-40" />
              暂无已登录设备
              <p className="text-xs text-muted-foreground/70">
                在本地 dsh 的 deepc 侧栏登录并注册设备后，会显示在这里
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <NodeCard
                key={node.nodeId}
                node={node}
                onConnect={() => {
                  if (consoleNodeId) {
                    navigate(`/link/${node.nodeId}`)
                  }
                }}
                onRemove={() => {
                  void removeNode(node.nodeId).then(() => refreshNodes())
                }}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

/** 设备卡片（SSH 多端管理风格）。 */
function NodeCard({
  node,
  onConnect,
  onRemove,
}: {
  node: NodeView
  onConnect: () => void
  onRemove: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <Laptop className="size-5 shrink-0 text-primary" />
            <CardTitle className="truncate text-base">{node.name}</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 border-transparent",
                node.online
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-slate-500/20 text-slate-400"
              )}
            >
              {node.online ? "在线" : "离线"}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "shrink-0 gap-1 px-1.5 transition-all",
                confirmRemove
                  ? "text-rose-400 hover:text-rose-300"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                if (confirmRemove) {
                  setConfirmRemove(false)
                  onRemove()
                } else {
                  setConfirmRemove(true)
                  setTimeout(() => setConfirmRemove(false), 3000)
                }
              }}
            >
              <Trash2 className="size-3.5" />
              {confirmRemove && <span>确认删除？</span>}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="truncate font-mono text-xs text-muted-foreground">
          {node.nodeId}
        </p>
        {node.lastSeen && (
          <p className="text-xs text-muted-foreground">
            最后活跃 {relativeTime(node.lastSeen)}
          </p>
        )}
        <Button
          onClick={onConnect}
          disabled={!node.online}
          variant="outline"
          size="sm"
          className="w-full gap-2"
        >
          <Link2 className="size-3.5" />
          连接
        </Button>
      </CardContent>
    </Card>
  )
}

/** 相对时间（复刻官方「X分钟/X小时/X天」）。 */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  const day = Math.floor(hr / 24)
  return `${day}天`
}

export default LinksPage
