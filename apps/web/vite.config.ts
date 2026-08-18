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
    // 本地开发：/auth/* 与 /api/* 代理到 Cloudflare Worker（wrangler dev，8787 端口）
    // OAuth 回调 deepc.cn/auth/callback → 本地 DEEPSEA_BASE=127.0.0.1:5174
    // 走 vite 代理转发到 worker，cookie 落在 5174（浏览器同源）
    proxy: {
      "/auth": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
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
