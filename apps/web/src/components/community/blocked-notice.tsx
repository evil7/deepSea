// ---------------------------------------------------------------------------
// BlockedNotice —— 统一「低质贴」折叠条（collapse 模式占位）
//   用户屏蔽 / 踩贴过滤命中时统一归类为「低质贴」折叠展示，不再区分原因横幅。
//   点击「展开」查看原内容。
// ---------------------------------------------------------------------------

import { Eye, EyeOff, ThumbsDown } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** 折叠条：低质贴标签 + 展开/收起按钮（橙色弱化样式） */
export function BlockedNotice({
  open,
  onToggle,
  className,
}: {
  open: boolean
  onToggle: () => void
  className?: string
}) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-dashed border-orange-400/30 bg-orange-400/5 px-3.5 py-2.5 text-xs text-muted-foreground",
        className
      )}
    >
      <ThumbsDown className="size-3.5 shrink-0 text-orange-300" />
      <span className="font-medium text-orange-300/90">
        {t("community.lowQualityLabel")}
      </span>
      <span className="min-w-0 flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={onToggle}
      >
        {open ? (
          <>
            <EyeOff className="size-3" />
            {t("settings.blockedCollapse")}
          </>
        ) : (
          <>
            <Eye className="size-3" />
            {t("settings.blockedExpand")}
          </>
        )}
      </Button>
    </div>
  )
}
