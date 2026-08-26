/**
 * host-ui React hooks。
 */

import { useEffect, useState } from 'react'
import { browserTotpCode, formatDuration, qrDataUrl } from './api'

/** 6 位 TOTP 动态码 + 30s 倒计时（本地即 2FA 客户端）。secret 为 null 时显示占位。 */
export function useTotpCode(secret: string | null): {
  code: string
  remainSec: number
  expiring: boolean
  progress: number
} {
  const [code, setCode] = useState('------')
  const [remainSec, setRemainSec] = useState(0)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (!secret) {
        setCode('------')
        setRemainSec(0)
        setProgress(0)
        return
      }
      const now = Date.now()
      const stepMs = 30_000
      const remainingMs = stepMs - (now % stepMs)
      const remain = Math.ceil(remainingMs / 1000)
      const c = await browserTotpCode(secret, now)
      if (cancelled) return
      setCode(c)
      setRemainSec(remain)
      setProgress((remainingMs / stepMs) * 100)
    }
    void tick()
    const iv = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [secret])

  return { code, remainSec, expiring: remainSec <= 5, progress }
}

/** 生成 otpauth URI 的二维码 data URL（本地生成，异步；uri 为 null 时返回空串）。 */
export function useQrDataUrl(uri: string | null | undefined): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!uri) {
      setUrl('')
      return
    }
    void qrDataUrl(uri).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [uri])
  return url
}

/** 连接时长（每秒刷新，仅用于远端单行）。connectedAt 为 null 时返回占位。 */
export function useConnectedDuration(
  connectedAt: number | null | undefined,
  connected: boolean,
): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  if (connectedAt) return formatDuration(now - connectedAt)
  return connected ? '已连接' : '未连接'
}
