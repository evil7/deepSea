import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // 惰性初始化：挂载即按视口宽度判定（避免 effect 同步 setState，
  // React Compiler set-state-in-effect lint）。
  const [isMobile, setIsMobile] = React.useState(
    () => window.innerWidth < MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
