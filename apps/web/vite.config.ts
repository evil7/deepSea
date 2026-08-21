import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // 监听 127.0.0.1：本地 OAuth 回调 DEEPSEA_BASE=127.0.0.1:5174
    // 明确 host，避免直接 `pnpm dev` 时默认 localhost 导致回调域名不匹配
    host: "127.0.0.1",
    // 允许通过 localhost 与 127.0.0.1 访问（Vite 默认 DNS rebinding 保护会拦截
    // 非 localhost 的 Host，需显式放行 127.0.0.1）
    allowedHosts: ["127.0.0.1", "localhost"],
    // 本地开发：/auth/* 与 /api/* 代理到 Cloudflare Worker（wrangler dev，8787 端口）
    // OAuth 回调 deepc.cn/auth/callback → 本地 DEEPSEA_BASE=127.0.0.1:5174
    // 走 vite 代理转发到 worker，cookie 落在 5174（浏览器同源）
    proxy: {
      "/auth": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      // 信令 WebSocket（DO 信号房）：dev 主站 WS 同源连 5174，代理到 8787（含 ws 升级）。
      "/ws": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    // three.js 海面视觉让主包偏大，属预期
    chunkSizeWarningLimit: 900,
  },
})
