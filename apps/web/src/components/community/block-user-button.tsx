// ---------------------------------------------------------------------------
// BlockUserButton —— 用户屏蔽快捷按钮（评论 / 回复 / OP 卡片 / 侧栏）
//   点击将作者加入个人设置屏蔽列表（软屏蔽）；已屏蔽则解除并 toast 提示。
// ---------------------------------------------------------------------------

import { UserX } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useCommunityBlocks } from "@/hooks/use-community-blocks"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function BlockUserButton({
  login,
  className,
  size = "sm",
}: {
  login: string
  className?: string
  size?: "sm" | "icon"
}) {
  const { t } = useTranslation()
  const { blocks, blockUser, unblockUser } = useCommunityBlocks()
  const blocked = blocks.blockedUsers.some(
    (b) => b.toLowerCase() === login.toLowerCase()
  )

  const handleClick = () => {
    if (blocked) {
      unblockUser(login)
      toast.success(t("communityDetail.userUnblockedToast", { name: login }))
    } else {
      blockUser(login)
      toast.success(t("communityDetail.userBlockedToast", { name: login }))
    }
  }

  if (size === "icon") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleClick}
        title={blocked ? t("communityDetail.unblockUser", { name: login }) : t("communityDetail.blockUser", { name: login })}
        aria-label={blocked ? t("communityDetail.unblockUser", { name: login }) : t("communityDetail.blockUser", { name: login })}
        className={cn("size-6 rounded-md text-muted-foreground hover:text-foreground", className)}
      >
        <UserX className={blocked ? "size-3.5 text-rose-400" : "size-3.5"} />
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={handleClick}
      className={cn("gap-1 text-muted-foreground hover:text-foreground", className)}
    >
      <UserX className={blocked ? "size-3.5 text-rose-400" : "size-3.5"} />
      {blocked
        ? t("communityDetail.unblockUser", { name: login })
        : t("communityDetail.blockUser", { name: login })}
    </Button>
  )
}
