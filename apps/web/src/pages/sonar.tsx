import { Radio } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PageHeader } from "@/components/layout/page-header"

// ---------------------------------------------------------------------------
// /sonar —— 操作互联（deepc-bridge 远程控制 · 自实现 chatUI）
//
// 旧方案（寄生快照 + SW 静态壳 + 快照 iframe + patch fetch/WS 复刻官方前端）
// 已废弃，见 docs/deepsea-deepc-bridge-plan.md。
//
// 新方案规划中（S2 阶段）：deepc 主站自实现 chatUI，经 `deepc-sonar-bridge`
// 中间件（安全加密 + 自动分包 + 远程 RTC）调本地 dsh host 稳定 API。
// 本页为占位态，正式 chatUI 待实现。
// ---------------------------------------------------------------------------

export function SonarPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            操作互联
            <Badge
              variant="outline"
              className="border-sky-500/30 bg-sky-500/10 text-sky-300"
            >
              规划中
            </Badge>
          </span>
        }
        description="deepc-bridge · 远程控制（自实现 chatUI）+ 工程同步"
        sticky={false}
        showTopButton={false}
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="size-5 text-primary" />
            自实现 chatUI 远程控制
          </CardTitle>
          <CardDescription>
            不复刻官方 dsh 前端，deepc 主站自实现 chatUI，经加密 RTC 通道调用本地
            dsh host 的稳定 API。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            deepc-bridge 由两个语义正交的功能组成，共用一个
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              deepc-sonar-bridge
            </code>
            中间件（安全加密 + 自动分包 + 远程 RTC 通信）：
          </p>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong className="text-foreground">操作互联（远程控制）</strong>
              —— 主站自实现 chatUI，渲染会话列表 + 对话流 + 发送消息，经
              WebRTC DataChannel 调本地 dsh host API。
            </li>
            <li>
              <strong className="text-foreground">工程同步</strong>
              —— 登录后，把本地工作区 + 聊天记录经同一加密 RTC 通道实时传输，
              实现多端数据一致 / 备份 / 迁移。
            </li>
          </ul>
          <p className="text-xs text-muted-foreground/70">
            详细规划见{" "}
            <code className="font-mono">docs/deepsea-deepc-bridge-plan.md</code>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export default SonarPage
