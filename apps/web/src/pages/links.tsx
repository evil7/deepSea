// ---------------------------------------------------------------------------
// /links —— 远端互联隧道节点卡片页（deepc-link 管理形态入口）。
//
// 三模式说明（见 docs/deepsea-tunnel-bridge-proposal.md）：
//   1. local   本地域内共享：插件 3081 鉴权代理（TOTP 2FA），局域网直接访问。
//   2. tunnel  CF Tunnel 暴露：匿名 Quick Tunnel / 自定义域。
//   3. managed 主站纳管：登录后插件上报最新 URL，本页列出（断链自动重连上报）。
//
// 主站只纳管 URL，不存任何 secret（TOTP 动态码由用户本地 2FA 应用生成）。
// 卡片「打开」= 新窗口打开节点 URL，进入 3081 鉴权页输入 2FA 码。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { PageHeader } from "@/components/layout/page-header"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import {
  listTunnels,
  deleteTunnel,
  type TunnelNodeView,
} from "@/lib/deepc-link/tunnels"
import {
  ExternalLink,
  Globe,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react"

export function LinksPage() {
  const { user } = useAuth()
  const [nodes, setNodes] = useState<TunnelNodeView[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    setLoaded(false)
    const rows = await listTunnels()
    setNodes(rows)
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (user) void refresh()
  }, [user, refresh])

  // WS 订阅 TunnelHub DO：node_online / node_deleted → 刷新列表
  useEffect(() => {
    if (!user) return
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/tunnel-events`,
      )
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as {
            type?: string
            nodeId?: string
          }
          if (
            msg.type === "node_online" ||
            msg.type === "node_offline" ||
            msg.type === "node_deleted"
          ) {
            void refresh()
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* WS 不可用则依赖手动刷新 */
    }
    return () => ws?.close()
  }, [user, refresh])

  const handleDelete = async (node: TunnelNodeView) => {
    await deleteTunnel(node.nodeId)
    void refresh()
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-10 sm:px-6">
      <PageHeader
        title="远端互联"
        description="三种方式自选：本地共享 / Tunnel 暴露 / 主站纳管。安全码由你本地 2FA 应用管理。"
        sticky={false}
        showTopButton={false}
      />

      <div className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">纳管节点</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        </div>

        {!user ? (
          <Empty className="border-none">
            <EmptyMedia variant="icon">
              <ShieldCheck />
            </EmptyMedia>
            <EmptyTitle>登录后管理节点</EmptyTitle>
            <EmptyDescription>
              登录 GitHub 账号后，可查看并管理同一账号下上报的 dsh 节点
            </EmptyDescription>
          </Empty>
        ) : !loaded ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载节点…
          </div>
        ) : nodes.length === 0 ? (
          <Empty className="border-none">
            <EmptyMedia variant="icon">
              <Laptop />
            </EmptyMedia>
            <EmptyTitle>暂无纳管节点</EmptyTitle>
            <EmptyDescription>
              在本地 dsh 安装 deepc-link 插件，选择「主站纳管」模式并登录后，
              节点会显示在这里
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <TunnelCard key={node.nodeId} node={node} onDelete={() => void handleDelete(node)} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

/** 从完整 URL 提取二级域名展示（去掉 https:// 前缀；主站仅显示可读子域）。 */
function prettyHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//, '')
  }
}

/** 隧道节点卡片：名称 + 状态 + 二级域名 + 打开(新窗口) + 删除。 */
function TunnelCard({
  node,
  onDelete,
}: {
  node: TunnelNodeView
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const host = prettyHost(node.url)
  const online = node.status === "connected"

  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Laptop className="size-4" />
          </div>
          <CardTitle className="truncate">{node.name}</CardTitle>
        </div>
        <Badge variant="outline" className="gap-1.5 font-normal">
          <span
            className={cn(
              "size-1.5 rounded-full",
              online ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
          {online ? "在线" : "离线"}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{host}</code>
        </div>

        <div className="flex items-center gap-2">
          <a href={node.url} target="_blank" rel="noreferrer" className="flex-1">
            <Button size="sm" className="w-full gap-1.5">
              <ExternalLink className="size-3.5" />
              打开节点
            </Button>
          </a>
          <Button
            variant={confirmDelete ? "destructive" : "ghost"}
            size={confirmDelete ? "sm" : "icon-sm"}
            className="shrink-0"
            onClick={() => {
              if (confirmDelete) {
                setConfirmDelete(false)
                onDelete()
              } else {
                setConfirmDelete(true)
                setTimeout(() => setConfirmDelete(false), 3000)
              }
            }}
          >
            {confirmDelete ? "确认" : <Trash2 />}
          </Button>
        </div>
      </CardContent>

      <CardFooter className="gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" />
        打开后输入你本地 2FA 应用中的动态码完成验证
      </CardFooter>
    </Card>
  )
}

export default LinksPage
