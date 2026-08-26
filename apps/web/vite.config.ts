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
    // 固定 5174：插件「开发模式」的 DEV_MODE_BASE = http://127.0.0.1:5174
    //（vite 代理收敛本地 worker），端口漂移会导致插件连不到主站。
    port: 5174,
    strictPort: true,
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
    rolldownOptions: {
      output: {
        // 手动分块：把体积大 / 使用频繁的依赖拆成独立 chunk，改善缓存与首屏加载。
        // 优先级高的 group 先匹配，模块命中后从低优先级 group 中移除。
        // pnpm 下真实路径形如 `node_modules/.pnpm/pkg@x/node_modules/pkg/...`，
        // 故用 `node_modules[\\/]pkg[\\/]` 匹配（兼容 `/` 与 `\` 分隔符）。
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "three",
              test: /node_modules[\\/]three[\\/]/,
              priority: 25,
            },
            {
              name: "charts",
              test: /node_modules[\\/](recharts|victory-vendor|d3-)[\\/]/,
              priority: 20,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-|rehype-|unified|micromark|mdast-|hast-|unist-|vfile)[\\/]/,
              priority: 15,
            },
            {
              name: "swiper",
              test: /node_modules[\\/]swiper[\\/]/,
              priority: 10,
            },
            {
              // 其余第三方依赖兜底合并
              name: "vendor",
              test: /node_modules/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
})
